//! Host supervisor: readiness, log drains, and graceful shutdown (Windows-only).
//!
//! `HostSupervisor` runs [`crate::discovery::discover_default`], then either
//! attaches to a compatible external host or spawns the bundled web host as an
//! [`OwnedProcess`]. It drains the child's stdout/stderr into `host.log`, parses
//! the `dsh web: http://127.0.0.1:<port>` readiness line, revalidates the
//! runtime identity, and records its own lifecycle events in `desktop.log`.
//!
//! Ownership matters on shutdown:
//! - `Attached` holds only a URL + identity and never touches a process;
//!   [`HostSupervisor::shutdown`] reports [`ShutdownOutcome::Detached`].
//! - `Owned` writes the parent-control shutdown frame, waits a bounded grace
//!   window for the child to exit, and only then closes the Job (killing the
//!   tree) if the child is still alive. A child that already exited on its own
//!   is reaped and its exit code reported instead of being force-terminated.
//!
//! Env: the child receives the desktop process env with secret-named entries
//! removed and `DSH_HOME` / `DSH_PARENT_CONTROL` / `DSH_TELEMETRY_DISABLED`
//! added. Neither env contents nor identity response bodies are ever written to
//! a log.

use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use thiserror::Error;
use windows::Win32::System::SystemInformation::GetLocalTime;

use crate::discovery::{discover, Discovery, DiscoveryError, DESKTOP_DEFAULT_PORT};
use crate::identity::{RuntimeIdentity, DSH_RUNTIME_IDENTITY_PATH};
use crate::paths::DesktopPaths;
use crate::windows_job::{JobError, OwnedProcess};

/// The parent-control shutdown frame the CLI (Task 2 / `DSH_PARENT_CONTROL`)
/// reads from stdin.
const SHUTDOWN_FRAME: &[u8] = b"{\"type\":\"shutdown\",\"protocol\":1}\n";
/// How long an owned host gets from spawn to become ready.
const STARTUP_DEADLINE: Duration = Duration::from_secs(120);
/// How long shutdown waits for a graceful exit before forcing the tree closed.
const SHUTDOWN_GRACE: Duration = Duration::from_secs(5);
/// The readiness/poll non-blocking wait between deadline checks.
const POLL_INTERVAL: Duration = Duration::from_millis(100);
/// The size at which `host.log` rotates to `host.log.1`.
const HOST_LOG_ROTATE_BYTES: u64 = 5 * 1024 * 1024;
/// The bundled CLI under the extraction root, relative to the node binary.
const HOST_HEADLESS_ARGS: &str = "--profile web --port";

/// Whether the bundled host is owned by this desktop (spawned and contained in
/// a Job) or external (discovered already running and merely attached).
#[derive(Debug)]
pub enum HostSession {
    /// An external compatible host already listening; never touch a process.
    Attached {
        /// The verified base URL of the external host.
        base_url: String,
        /// The external host's verified runtime identity.
        identity: RuntimeIdentity,
    },
    /// A bundled host this desktop spawned and contains in a kill-on-close Job.
    Owned {
        /// The ready base URL of the child host.
        base_url: String,
        /// The child host's verified runtime identity.
        identity: RuntimeIdentity,
        /// The contained child process; its stdio was moved to log drains.
        process: OwnedProcess,
    },
}

use HostSession::{Attached, Owned};

/// The result of a graceful shutdown opportunity.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShutdownOutcome {
    /// No owned process: either already shut down or only attached.
    Detached,
    /// The owned host exited within the grace window after the shutdown frame.
    Graceful,
    /// The owned host ignored the frame and was reclaimed by closing the Job.
    Forced,
}

/// Why the supervisor failed to run, make the host ready, or shut it down.
#[derive(Debug, Error)]
pub enum DesktopError {
    /// Host discovery failed.
    #[error("host discovery failed: {0}")]
    Discovery(#[from] DiscoveryError),
    /// Starting the bundled host process failed.
    #[error("starting the bundled host failed: {0}")]
    Spawn(#[from] JobError),
    /// The host became ready with an unexpected identity or state.
    #[error("host readiness failed: {0}")]
    Readiness(String),
    /// The host took longer than the startup deadline to become ready.
    #[error("host did not become ready within {0:?}")]
    ReadinessTimeout(Duration),
    /// The host printed a `dsh web:` line that is not a loopback URL.
    #[error("host printed a malformed readiness URL: `{0}`")]
    MalformedUrl(String),
    /// Writing the shutdown frame failed.
    #[error("writing the shutdown frame failed: {0}")]
    ShutdownWrite(#[source] std::io::Error),
    /// Waiting for the child to exit during shutdown failed.
    #[error("waiting for the host to exit failed: {0}")]
    ShutdownWait(#[source] std::io::Error),
    /// Writing the control frame failed while the child was still alive.
    #[error("shutdown control fell through with the host still running: {0}")]
    ShutdownControl(#[source] std::io::Error),
}

/// A log that appends timestamped supervisor lifecycle events.
#[derive(Debug, Clone)]
struct DesktopLog {
    path: PathBuf,
}

impl DesktopLog {
    fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Append one timestamped `[kind] detail` line. Best-effort: a failed write
    /// is surfaced on stderr rather than failing the supervised operation.
    fn event(&self, kind: &str, detail: &str) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let line = format!("{} [{kind}] {detail}", local_now());
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .and_then(|mut f| writeln!(f, "{line}"))
        {
            Ok(()) => {}
            Err(error) => eprintln!("desktop log write failed: {error}"),
        }
    }
}

/// The machine-local civil time as an ISO-like `YYYY-MM-DDTHH:MM:SS` stamp.
fn local_now() -> String {
    let t = unsafe { GetLocalTime() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}",
        t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond
    )
}

/// A single-host log that rotates to `<path>.1` once it exceeds `max_size`; the
/// current file plus one rotated copy is the whole retained set (2 files).
///
/// Rotation renames the current file to `<path>.1`, discarding any older copy,
/// then reopens a fresh current file. Only the current file and its newest
/// rotated predecessor are kept.
#[derive(Debug)]
struct RotatingLog {
    path: PathBuf,
    file: Option<File>,
    max_size: u64,
}

impl RotatingLog {
    fn new(path: PathBuf, max_size: u64) -> Self {
        Self {
            path,
            file: None,
            max_size,
        }
    }

    /// Append `line` plus a newline, rotating first when the current file would
    /// exceed `max_size`.
    fn append(&mut self, line: &[u8]) -> std::io::Result<()> {
        if self.file.is_none() {
            if let Some(parent) = self.path.parent() {
                fs::create_dir_all(parent)?;
            }
            self.file = Some(
                OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&self.path)?,
            );
        }
        let current = self.file.as_ref().expect("log file is open").metadata()?.len();
        if current.saturating_add(line.len() as u64) > self.max_size {
            self.rotate()?;
        }
        let file = self.file.as_mut().expect("log file is open");
        file.write_all(line)?;
        file.write_all(b"\n")?;
        file.flush()
    }

    fn rotate(&mut self) -> std::io::Result<()> {
        self.file = None;
        let rotated = PathBuf::from(format!("{}.1", self.path.to_string_lossy()));
        let _ = fs::remove_file(&rotated);
        fs::rename(&self.path, &rotated)?;
        self.file = Some(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?,
        );
        Ok(())
    }
}

/// One readiness-relevant event from the stdout drain, or the drain's EOF.
#[derive(Debug)]
enum DrainEvent {
    /// A stdout line beginning with the `dsh web: ` readiness prefix.
    Url(String),
    /// The child's stdout closed without reaching the event end.
    Eof,
}

/// The bits a successful owned spawn returns before they are folded into a
/// session: the ready URL/identity and the still-live contained process.
struct OwnedReady {
    base_url: String,
    identity: RuntimeIdentity,
    process: OwnedProcess,
}

/// Supervises the bundled or external web host for the desktop shell.
#[derive(Debug)]
pub struct HostSupervisor {
    paths: DesktopPaths,
    session: Option<HostSession>,
    startup_deadline: Duration,
    host_log: Arc<Mutex<RotatingLog>>,
    desktop_log: DesktopLog,
    drains: Vec<std::thread::JoinHandle<()>>,
    /// The pid of the most recently spawned owned host, kept across a failed
    /// readiness so a caller can verify the tree was reclaimed.
    owned_pid: Option<u32>,
}

impl HostSupervisor {
    /// Create a supervisor for `paths`.
    pub fn new(paths: DesktopPaths) -> Self {
        let logs = paths.logs.clone();
        Self {
            paths,
            session: None,
            startup_deadline: STARTUP_DEADLINE,
            host_log: Arc::new(Mutex::new(RotatingLog::new(
                logs.join("host.log"),
                HOST_LOG_ROTATE_BYTES,
            ))),
            desktop_log: DesktopLog::new(logs.join("desktop.log")),
            drains: Vec::new(),
            owned_pid: None,
        }
    }

    /// Override the startup deadline. The production default is 120 seconds;
    /// tests shorten it so a never-ready fixture fails fast.
    pub fn with_startup_deadline(mut self, deadline: Duration) -> Self {
        self.startup_deadline = deadline;
        self
    }

    /// Run `discover_default` and then establish the session it implies.
    pub fn start(&mut self) -> Result<String, DesktopError> {
        let discovery = crate::discovery::discover_default()?;
        self.start_from(&discovery)
    }

    /// Establish the session implied by `discovery`. `Attach` merely holds the
    /// URL + identity; `StartDefault` / `StartDynamic` spawn the bundled host
    /// and wait for it to become ready. Returns the selected base URL.
    pub fn start_from(&mut self, discovery: &Discovery) -> Result<String, DesktopError> {
        match discovery {
            Discovery::Attach { base_url, identity } => {
                self.session = Some(Attached {
                    base_url: base_url.clone(),
                    identity: identity.clone(),
                });
                self.desktop_log
                    .event("start", &format!("ownership=attached url={base_url}"));
                Ok(base_url.clone())
            }
            Discovery::StartDefault => {
                let url = self.spawn_default(DESKTOP_DEFAULT_PORT)?;
                Ok(url)
            }
            Discovery::StartDynamic => {
                let url = self.spawn_default(0)?;
                Ok(url)
            }
        }
    }

    /// Spawn the bundled host and wait for readiness, or report an error.
    fn spawn_default(&mut self, port: u16) -> Result<String, DesktopError> {
        let command = self.paths.node.to_string_lossy().into_owned();
        let bin = runtime_bin(&self.paths);
        let args = format!(
            "{} {HOST_HEADLESS_ARGS} {port}",
            bin.to_string_lossy()
        );
        let cwd = self.paths.cwd.clone();
        let env = production_env(&self.paths);
        let base_url = self.spawn_with(&command, &args, Some(&cwd), Some(&env))?;
        Ok(base_url)
    }

    /// Spawn `command` with `args` as an owned host and wait for it to become
    /// ready. On success the owned session is stored and `base_url` returned;
    /// on any readiness failure the owned tree is terminated (best-effort, a
    /// no-op if the child already exited) before the error is returned.
    ///
    /// This is the core spawn path used by production and exercised in tests
    /// with a fixture binary standing in for the bundled CLI.
    pub fn spawn_with(
        &mut self,
        command: &str,
        args: &str,
        cwd: Option<&Path>,
        env: Option<&[(String, String)]>,
    ) -> Result<String, DesktopError> {
        let start = Instant::now();
        let ready = match self.establish_owned(command, args, cwd, env) {
            Ok(ready) => ready,
            Err(error) => return Err(error),
        };
        let readiness_ms = start.elapsed().as_millis();
        let base_url = ready.base_url.clone();
        self.desktop_log.event(
            "start",
            &format!(
                "ownership=owned url={base_url} readiness_ms={readiness_ms} protocol={} instance={}",
                ready.identity.desktop_protocol, ready.identity.instance_id
            ),
        );
        self.session = Some(Owned {
            base_url: ready.base_url,
            identity: ready.identity,
            process: ready.process,
        });
        Ok(base_url)
    }

    /// Spawn the child, start the log drains, and wait up to the startup
    /// deadline for a `dsh web: http://127.0.0.1:<port>` line whose loopback
    /// identity revalidates as a compatible host.
    ///
    /// On any failure the child is force-reclaimed and the log drains joined
    /// before the error returns, so no thread or process outlives the call.
    fn establish_owned(
        &mut self,
        command: &str,
        args: &str,
        cwd: Option<&Path>,
        env: Option<&[(String, String)]>,
    ) -> Result<OwnedReady, DesktopError> {
        let mut process = OwnedProcess::spawn(command, args, cwd, env).map_err(DesktopError::Spawn)?;
        let child_pid = process.pid();
        self.owned_pid = Some(child_pid);
        self.desktop_log.event("spawn", &format!("pid={child_pid}"));

        let stdout = process.take_stdout();
        let stderr = process.take_stderr();
        let (tx, rx) = channel();
        if let Some(out) = stdout {
            let log = Arc::clone(&self.host_log);
            let tx = tx.clone();
            self.drains.push(std::thread::spawn(move || {
                drain_output(out, log, Some(tx), true);
            }));
        }
        if let Some(errp) = stderr {
            let log = Arc::clone(&self.host_log);
            self.drains.push(std::thread::spawn(move || {
                drain_output(errp, log, None, false);
            }));
        }
        drop(tx);

        let deadline = Instant::now() + self.startup_deadline;
        let mut pending_base: Option<String> = None;

        loop {
            // Detect an early exit directly so readiness fails fast even when
            // the stdout EOF lags under load; the Eof DrainEvent is a fallback.
            match process.try_wait() {
                Ok(Some(_)) => {
                    // Child already exited; it reaped itself via try_wait, so no
                    // terminate is needed (try_wait would report it reaped).
                    self.join_drains();
                    self.desktop_log
                        .event("readiness", "outcome=child_exited_before_ready");
                    return Err(DesktopError::Readiness(
                        "the host exited before becoming ready".into(),
                    ));
                }
                Ok(None) => {}
                Err(error) => {
                    process.terminate_tree();
                    self.join_drains();
                    return Err(DesktopError::ShutdownWait(error));
                }
            }

            if let Some(base) = &pending_base {
                let endpoint = format!("{base}{DSH_RUNTIME_IDENTITY_PATH}");
                match discover(&endpoint) {
                    Ok(Discovery::Attach { base_url, identity }) => {
                        return Ok(OwnedReady {
                            base_url: base_url.clone(),
                            identity,
                            process,
                        });
                    }
                    Ok(_) => {
                        // Occupied but not yet a compatible host; probe again.
                    }
                    Err(error) => {
                        // A non-loopback candidate endpoint: unreachable in
                        // practice (the parse only yields loopback URLs), but
                        // fail loud rather than loop.
                        process.terminate_tree();
                        self.join_drains();
                        self.desktop_log
                            .event("readiness", "outcome=error identity_probe_failed");
                        return Err(DesktopError::Readiness(format!(
                            "identity probe failed for {endpoint}: {error}"
                        )));
                    }
                }
            }

            match rx.recv_timeout(POLL_INTERVAL) {
                Ok(DrainEvent::Url(line)) => match parse_web_url(&line) {
                    Some(base) => pending_base = Some(base),
                    None => {
                        process.terminate_tree();
                        self.join_drains();
                        self.desktop_log.event("readiness", "outcome=malformed_url");
                        return Err(DesktopError::MalformedUrl(line));
                    }
                },
                Ok(DrainEvent::Eof) => {
                    process.terminate_tree();
                    self.join_drains();
                    self.desktop_log
                        .event("readiness", "outcome=child_exited_before_ready");
                    return Err(DesktopError::Readiness(
                        "the host exited before becoming ready".into(),
                    ));
                }
                Err(RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        process.terminate_tree();
                        self.join_drains();
                        self.desktop_log.event("readiness", "outcome=timeout");
                        return Err(DesktopError::ReadinessTimeout(
                            self.startup_deadline,
                        ));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    process.terminate_tree();
                    self.join_drains();
                    return Err(DesktopError::Readiness(
                        "the host log drain stopped unexpectedly".into(),
                    ));
                }
            }
        }
    }

    /// Shut down the supervised host. An attached or absent host is detached; an
    /// owned host gets the shutdown frame, a bounded grace wait, then a Job
    /// close (tree kill) only if it is still alive.
    pub fn shutdown(&mut self) -> Result<ShutdownOutcome, DesktopError> {
        let outcome = match self.session.take() {
            Some(Attached { .. }) | None => {
                self.desktop_log.event("shutdown", "outcome=detached");
                ShutdownOutcome::Detached
            }
            Some(Owned { mut process, .. }) => {
                match process.write_control_frame(SHUTDOWN_FRAME) {
                    Ok(()) => match process.wait(SHUTDOWN_GRACE) {
                        Ok(Some(status)) => {
                            let code = status.code().unwrap_or(i32::MIN);
                            self.join_drains();
                            self.desktop_log.event(
                                "shutdown",
                                &format!("outcome=graceful exit_code={code}"),
                            );
                            ShutdownOutcome::Graceful
                        }
                        Ok(None) => {
                            process.terminate_tree();
                            self.join_drains();
                            self.desktop_log.event("shutdown", "outcome=forced");
                            ShutdownOutcome::Forced
                        }
                        Err(error) => {
                            process.terminate_tree();
                            self.join_drains();
                            self.desktop_log
                                .event("shutdown", "outcome=error waiting_for_exit");
                            return Err(DesktopError::ShutdownWait(error));
                        }
                    },
                    Err(error) => {
                        // The write can fail because the child already exited.
                        // Reap it and report the actual exit status rather than
                        // force-terminating a tree that is already gone.
                        match process.try_wait() {
                            Ok(Some(status)) => {
                                let code = status.code().unwrap_or(i32::MIN);
                                self.join_drains();
                                self.desktop_log.event(
                                    "shutdown",
                                    &format!("outcome=graceful early_exit_code={code}"),
                                );
                                ShutdownOutcome::Graceful
                            }
                            Ok(None) => {
                                // The write failed while the child is still
                                // alive; reclaim the tree so nothing leaks.
                                process.terminate_tree();
                                self.join_drains();
                                self.desktop_log
                                    .event("shutdown", "outcome=forced write_failed");
                                return Err(DesktopError::ShutdownControl(error));
                            }
                            Err(reap_error) => {
                                process.terminate_tree();
                                self.join_drains();
                                return Err(DesktopError::ShutdownWait(reap_error));
                            }
                        }
                    }
                }
            }
        };
        Ok(outcome)
    }

    /// The base URL of the supervised host, if a session is established.
    pub fn base_url(&self) -> Option<&str> {
        match &self.session {
            Some(Attached { base_url, .. }) | Some(Owned { base_url, .. }) => Some(base_url),
            None => None,
        }
    }

    /// The runtime identity of the supervised host, if a session is established.
    pub fn identity(&self) -> Option<&RuntimeIdentity> {
        match &self.session {
            Some(Attached { identity, .. }) | Some(Owned { identity, .. }) => Some(identity),
            None => None,
        }
    }

    /// The pid of the most recently spawned owned host. Retained across a failed
    /// readiness so a caller can confirm the tree was reclaimed.
    pub fn owned_pid(&self) -> Option<u32> {
        self.owned_pid
    }

    /// Wait for every active log drain to finish reading to EOF. Idempotent.
    fn join_drains(&mut self) {
        let handles = std::mem::take(&mut self.drains);
        for handle in handles {
            let _ = handle.join();
        }
    }
}

/// Join the log drains when the supervisor is dropped so a partially-supervised
/// owned host never leaves reader threads racing its teardown. An owned session
/// reached here was never explicitly shut down, so it is force-terminated first
/// (the Job close EOFs the pipes) before the drains are joined.
impl Drop for HostSupervisor {
    fn drop(&mut self) {
        if let Some(Owned { mut process, .. }) = self.session.take() {
            process.terminate_tree();
        }
        self.join_drains();
    }
}

/// The bundled CLI entry point under the extraction root implied by `paths.node`
/// (`<root>/node/node.exe` -> `<root>/runtime/node_modules/@deepseek-ai/dsh/lib/bin.js`).
fn runtime_bin(paths: &DesktopPaths) -> PathBuf {
    let extraction = paths
        .node
        .parent()
        .expect("desktop node path is under an extraction root")
        .parent()
        .expect("desktop node path is under an extraction root");
    extraction
        .join("runtime")
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js")
}

/// The child env for a spawned host: the desktop process env with secret-named
/// entries dropped, plus `DSH_HOME`, `DSH_PARENT_CONTROL=stdin-v1`, and
/// `DSH_TELEMETRY_DISABLED` when the parent carried it. Secret-named entries are
/// never forwarded to the child and never logged.
fn production_env(paths: &DesktopPaths) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = std::env::vars()
        .filter(|(key, _)| !is_secret_name(key))
        .collect();
    env.push(("DSH_HOME".to_string(), paths.home.to_string_lossy().into_owned()));
    env.push(("DSH_PARENT_CONTROL".to_string(), "stdin-v1".to_string()));
    if let Ok(value) = std::env::var("DSH_TELEMETRY_DISABLED") {
        env.push(("DSH_TELEMETRY_DISABLED".to_string(), value));
    }
    env
}

/// Whether an env var name carries a secret and must not reach a child or a log.
fn is_secret_name(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["KEY", "SECRET", "TOKEN", "PASSWORD"]
        .iter()
        .any(|needle| upper.contains(needle))
}

/// Parse the `dsh web:` readiness line into its loopback base URL, or `None`
/// when it does not match `^dsh web: (http://127\.0\.0\.1:\d+)(?: |$)` (the URL
/// may be followed by a ` (LAN: ...)` suffix or end-of-line).
fn parse_web_url(line: &str) -> Option<String> {
    let rest = line
        .strip_prefix("dsh web: ")?
        .strip_prefix("http://127.0.0.1:")?;
    let digits = rest.bytes().take_while(|b| b.is_ascii_digit()).count();
    if digits == 0 {
        return None;
    }
    match rest[digits..].chars().next() {
        None | Some(' ') => Some(format!("http://127.0.0.1:{}", &rest[..digits])),
        Some(_) => None,
    }
}

/// Read `reader` line by line, appending UTF-8-lossy lines to `log`. When
/// `send_urls`, forward every `dsh web: `-prefixed line to `tx` for readiness
/// parsing and send a final `Eof` once the pipe closes.
fn drain_output<R: Read + Send + 'static>(
    reader: R,
    log: Arc<Mutex<RotatingLog>>,
    tx: Option<Sender<DrainEvent>>,
    send_urls: bool,
) {
    let mut reader = BufReader::new(reader);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                trim_eol(&mut buf);
                let text = String::from_utf8_lossy(&buf);
                if let Ok(mut log) = log.lock() {
                    if log.append(text.as_bytes()).is_err() {
                        eprintln!("host log append failed");
                    }
                }
                if send_urls && text.starts_with("dsh web: ") {
                    if let Some(tx) = &tx {
                        let _ = tx.send(DrainEvent::Url(text.into_owned()));
                    }
                }
            }
        }
    }
    if send_urls {
        if let Some(tx) = tx {
            let _ = tx.send(DrainEvent::Eof);
        }
    }
}

/// Strip a trailing `\n` and `\r` so a line log is not duplicated by the pipe's
/// line endings.
fn trim_eol(line: &mut Vec<u8>) {
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_ready_url() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:40000"),
            Some("http://127.0.0.1:40000".to_string())
        );
    }

    #[test]
    fn parses_a_ready_url_with_a_lan_suffix() {
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:3080 (LAN: http://192.168.1.5:3080)"),
            Some("http://127.0.0.1:3080".to_string())
        );
    }

    #[test]
    fn rejects_non_loopback_or_malformed_ready_lines() {
        assert_eq!(parse_web_url("dsh web: not-a-url"), None);
        assert_eq!(parse_web_url("dsh web: http://localhost:3080"), None);
        assert_eq!(parse_web_url("dsh web: http://127.0.0.1:"), None);
        assert_eq!(parse_web_url("plain log line: http://127.0.0.1:1"), None);
        assert_eq!(
            parse_web_url("dsh web: http://127.0.0.1:3080x"),
            None
        );
    }

    #[test]
    fn an_env_name_with_a_secret_keyword_is_scrubbed() {
        assert!(is_secret_name("MY_API_KEY"));
        assert!(is_secret_name("access_token"));
        assert!(is_secret_name("DB_PASSWORD"));
        assert!(is_secret_name("clientSecret"));
        assert!(!is_secret_name("DSH_HOME"));
        assert!(!is_secret_name("PATH"));
    }

    #[test]
    fn rotation_keeps_the_current_file_and_one_predecessor() {
        use std::env::temp_dir;
        let dir = temp_dir().join(format!("dsh-rotate-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("host.log");
        let mut log = RotatingLog::new(path.clone(), 10);
        // 10-byte budget: each append of a larger line forces rotation.
        log.append(b"0123456789abc").unwrap();
        log.append(b"x").unwrap();
        log.append(b"0123456789abc").unwrap();
        assert!(path.exists(), "current file must exist");
        assert!(
            PathBuf::from(format!("{}.1", path.to_string_lossy())).exists(),
            "one rotated copy must be retained"
        );
        // Only two files are ever on disk.
        let files = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .count();
        assert_eq!(files, 2, "expected exactly the current file plus one rotated copy");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn runtime_bin_is_under_the_extraction_root() {
        let extraction = Path::new(r"C:\Portable\DeepSeek Harness");
        let paths = DesktopPaths::from_roots(
            &extraction.join("DeepSeek Harness.exe"),
            Path::new(r"C:\Users\Ada"),
            Path::new(r"C:\Users\Ada\AppData\Local"),
        )
        .unwrap();
        // paths.node = <extraction>\node\node.exe, so the CLI resolves under the
        // same extraction root.
        assert_eq!(paths.node, extraction.join("node").join("node.exe"));
        assert_eq!(
            runtime_bin(&paths),
            extraction
                .join("runtime")
                .join("node_modules")
                .join("@deepseek-ai")
                .join("dsh")
                .join("lib")
                .join("bin.js")
        );
    }
}
