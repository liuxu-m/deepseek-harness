//! Windows containment tests for the bundled host process tree.
//!
//! Each test spawns a real suspended child process (a copy of this test binary
//! running as a fixture), assigns it to a kill-on-close Job Object, and proves
//! the tree is reclaimed when the Job closes. Fixtures are selected by an
//! environment variable so a spawned copy of the test binary runs only the
//! `fixture_dispatcher` test and acts as the controlled child.
//!
//! This file is gated to Windows: the whole crate is empty on other targets so
//! the rest of the repository still builds unchanged.

#![cfg(windows)]

use std::io::{BufRead, BufReader, Read, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use deepseek_harness_desktop_lib::identity::{HomeKind, RuntimeIdentity};
use deepseek_harness_desktop_lib::instance::InstanceQueue;
use deepseek_harness_desktop_lib::paths::DesktopPaths;
use deepseek_harness_desktop_lib::supervisor::{DesktopError, HostSupervisor, ShutdownOutcome};
use deepseek_harness_desktop_lib::window::{
    AppSupervisorPort, DesktopController, ExitPort, OpenerPort, SupervisorPort, WindowPort,
};
use deepseek_harness_desktop_lib::windows_job::{
    create_kill_on_close_job, create_process_suspended, assign_to_job, InheritedPipes,
    OwnedProcess, Win32Procs,
};

use windows::core::Result as WinResult;
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{
    OpenProcess, TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const FIXTURE_VAR: &str = "DSH_FIXTURE_MODE";
/// A shutdown frame large enough to cover the multi-second wait but bounded so
/// a hung child fails the test instead of stalling it.
const TIMEOUT: Duration = Duration::from_secs(30);

/// A record of injected Win32 calls, in order, so the assignment-failure test
/// can prove the suspended child is terminated before its handles close.
static CALLS: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());

// ---------------------------------------------------------------------------
// Fixture process: this test binary re-executes itself as a controlled child.
// ---------------------------------------------------------------------------

/// The command line used to re-execute this test binary as a fixture. libtest
/// runs exactly one test (`fixture_dispatcher`) in the child so the fixture
/// logic does not race the suite, and `--nocapture` lets the fixture write its
/// grandchild report straight to the inherited stdout pipe.
fn fixture_command(_mode: &str) -> (PathBuf, String) {
    let exe = std::env::current_exe().expect("current_exe is readable");
    (
        exe,
        "--exact fixture_dispatcher --nocapture --test-threads=1".to_string(),
    )
}

/// Spawn `mode` as a suspended-then-resumed child assigned to a kill-on-close
/// job, returning the owned process plus its stdout reader.
fn spawn_fixture(mode: &str) -> std::io::Result<OwnedFixture> {
    let (exe, args) = fixture_command(mode);
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    env.push((FIXTURE_VAR.to_string(), mode.to_string()));
    let mut process = OwnedProcess::spawn(
        exe.to_string_lossy().as_ref(),
        &args,
        None,
        Some(&env),
    )
    .map_err(std::io::Error::other)?;
    let stdout = process
        .take_stdout()
        .expect("fixture stdout is present before take_stdout");
    Ok(OwnedFixture { process, stdout })
}

/// An owned fixture: the child plus the read end of its stdout pipe.
struct OwnedFixture {
    process: OwnedProcess,
    stdout: Box<dyn Read + Send>,
}

impl OwnedFixture {
    fn pid(&self) -> u32 {
        self.process.pid()
    }

    /// Read the fixture's stdout until it reports `GRANDCHILD=<pid>` and return
    /// the grandchild's pid. Fails if the report never arrives within `timeout`.
    fn wait_for_reported_grandchild(&mut self, timeout: Duration) -> std::io::Result<u32> {
        use std::sync::mpsc::{RecvTimeoutError, channel};
        let (tx, rx) = channel();
        let stdout = std::mem::replace(&mut self.stdout, Box::new(std::io::empty()));
        let mut reader = BufReader::new(stdout);
        std::thread::spawn(move || {
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => {
                        let _ = tx.send(None);
                        return;
                    }
                    Ok(_) => {
                        let _ = tx.send(Some(std::mem::take(&mut line)));
                    }
                }
            }
        });
        let deadline = Instant::now() + timeout;
        loop {
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(line)) => {
                    let trimmed = line.trim();
                    if let Some(pos) = trimmed.find("GRANDCHILD=") {
                        let rest = &trimmed[pos + "GRANDCHILD=".len()..];
                        let pid = rest.trim().parse::<u32>().map_err(|e| {
                            std::io::Error::new(std::io::ErrorKind::InvalidData, e)
                        })?;
                        return Ok(pid);
                    }
                }
                Ok(None) => {
                    return Err(std::io::Error::other(
                        "fixture stdout closed before a grandchild report",
                    ));
                }
                Err(RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::TimedOut,
                            "timed out waiting for a grandchild report",
                        ));
                    }
                }
                Err(RecvTimeoutError::Disconnected) => {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "fixture stdout reader stopped",
                    ));
                }
            }
        }
    }

    /// Read and drain any buffered stdout/stderr so the fixture's pipe never
    /// fills and blocks the child while it is still alive.
    fn drain(&mut self) {
        let mut buf = [0u8; 4096];
        let _ = self.stdout.read(&mut buf);
    }
}

/// The fixture entry point. When spawned by a test (detected by the fixture env
/// var), it runs the selected mode and exits; in a plain `cargo test` run it is
/// a no-op so the harness carries it as one passing test.
#[test]
fn fixture_dispatcher() {
    let Some(mode) = std::env::var(FIXTURE_VAR).ok().filter(|m| !m.is_empty()) else {
        return;
    };
    run_fixture(&mode);
    std::process::exit(0);
}

/// Run one fixture mode to completion.
fn run_fixture(mode: &str) {
    match mode {
        "normal-exit" => {}
        "wait-frame" => wait_for_control_frame(),
        "ignore-frame" => wait_forever(),
        "spawn-grandchild" => spawn_grandchild_and_report(),
        "sleep-forever" => wait_forever(),
        "early-exit" => std::process::exit(1),
        "host-graceful" => run_host_fixture(HostIdentity::Compatible, HostThen::WaitForFrame),
        "host-forced" => run_host_fixture(HostIdentity::Compatible, HostThen::WaitForever),
        "host-identity-mismatch" => run_host_fixture(HostIdentity::Incompatible, HostThen::WaitForever),
        "host-malformed-url" => run_host_fixture(HostIdentity::MalformedUrl, HostThen::WaitForever),
        "host-timeout" => run_host_fixture(HostIdentity::Silent, HostThen::WaitForever),
        other => {
            eprintln!("unknown fixture mode: {other}");
            std::process::exit(2);
        }
    }
}

/// Read one UTF-8 line (the shutdown frame) from stdin, then return so the 0
/// exit code cleans the fixture process up normally. The frame ends in a
/// newline; seeing the newline is enough to treat the frame as delivered.
fn wait_for_control_frame() {
    let mut input = std::io::stdin();
    let mut buf = [0u8; 4096];
    loop {
        match input.read(&mut buf) {
            Ok(0) => std::process::exit(3), // EOF before a frame
            Ok(n) => {
                if buf[..n].windows(1).any(|b| b == b"\n") {
                    return;
                }
            }
            Err(_) => std::process::exit(4),
        }
    }
}

/// Never read stdin and never exit; the owning job must reclaim the process.
fn wait_forever() {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Spawn a grandchild that stays alive (itself, in `sleep-forever` mode), report
/// its pid, then also wait forever so the Job must reclaim both on close.
fn spawn_grandchild_and_report() {
    let (exe, args) = fixture_command("sleep-forever");
    let child = Command::new(&exe)
        .args(args.split(' '))
        .env(FIXTURE_VAR, "sleep-forever")
        .spawn()
        .unwrap_or_else(|e| {
            eprintln!("failed to spawn grandchild: {e}");
            std::process::exit(5);
        });
    println!("GRANDCHILD={}", child.id());
    std::io::Write::flush(&mut std::io::stdout()).ok();
    // Deliberately never reap the grandchild: both this fixture and the
    // grandchild must stay alive until the owning Job closes and reclaims them.
    std::mem::forget(child);
    wait_forever();
}

// ---------------------------------------------------------------------------
// Supervisor fixtures: the test binary simulates a bundled web host.
// ---------------------------------------------------------------------------

/// How a host-mode fixture presents its readiness signal.
enum HostIdentity {
    /// Print a valid loopback URL and answer the identity probe compatibly.
    Compatible,
    /// Print a valid loopback URL but answer the identity probe incompatibly.
    Incompatible,
    /// Print a line that is not a loopback readiness URL at all.
    MalformedUrl,
    /// Print nothing (the host never signals readiness).
    Silent,
}

/// What a host-mode fixture does after printing its readiness signal.
enum HostThen {
    /// Read a shutdown frame from stdin, then exit 0.
    WaitForFrame,
    /// Ignore stdin and never exit; the owning Job must reclaim it.
    WaitForever,
}

/// A host-mode fixture: bind a loopback listener, serve the identity endpoint,
/// print the `dsh web:` URL line, then wait for a frame or forever. This
/// stands in for the bundled CLI/web host so a test can drive readiness and
/// shutdown without a real deployable runtime (Task 11).
fn run_host_fixture(identity: HostIdentity, then: HostThen) {
    let listener = match TcpListener::bind("127.0.0.1:0") {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("fixture failed to bind a loopback listener: {error}");
            std::process::exit(6);
        }
    };
    let port = listener.local_addr().unwrap().port();

    match identity {
        HostIdentity::Silent => {
            // Never print the URL line; the supervisor must time out.
        }
        HostIdentity::MalformedUrl => {
            // libtest writes `test fixture_dispatcher ... ` (no newline) before
            // the body, so a leading newline keeps the URL the start of its own
            // line the way the real web host prints it.
            println!("\ndsh web: not-a-loopback-url");
            let _ = std::io::Write::flush(&mut std::io::stdout());
        }
        HostIdentity::Compatible | HostIdentity::Incompatible => {
            println!("\ndsh web: http://127.0.0.1:{port}");
            let _ = std::io::Write::flush(&mut std::io::stdout());
            let incompatible = matches!(identity, HostIdentity::Incompatible);
            thread::spawn(move || serve_identity_loop(listener, incompatible));
        }
    }

    match then {
        HostThen::WaitForFrame => wait_for_control_frame(),
        HostThen::WaitForever => wait_forever(),
    }
}

/// Accept identity probes in a loop, responding with a compatible or
/// incompatible runtime identity every time. The fixture keeps serving until
/// its process is reclaimed, so a slow readiness poll is still answered.
fn serve_identity_loop(listener: TcpListener, incompatible: bool) {
    for stream in listener.incoming() {
        let Ok(mut sock) = stream else { return };
        let mut request = [0u8; 2048];
        let _ = sock.read(&mut request);
        let body = if incompatible {
            r#"{"product":"deepseek-harness","desktopProtocol":2,"version":"0.1.0-test","instanceId":"fixture-incompatible","homeKind":"default"}"#
        } else {
            r#"{"product":"deepseek-harness","desktopProtocol":1,"version":"0.1.0-test","instanceId":"fixture-compatible","homeKind":"default"}"#
        };
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = sock.write_all(response.as_bytes());
        let _ = sock.flush();
    }
}

/// Poll whether a process (by pid) has terminated, up to `timeout`. Returns
/// true once the process no longer reports `STILL_ACTIVE`.
fn wait_until_dead(pid: u32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        let alive = unsafe { process_alive(pid) };
        if !alive {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

/// Whether a process (by pid) still exists and has not exited. A terminated but
/// not-yet-reaped process is no longer "alive": its exit code is no longer
/// `STILL_ACTIVE`, even if a handle to it is still open.
unsafe fn process_alive(pid: u32) -> bool {
    use windows::Win32::System::Threading::GetExitCodeProcess;
    match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
        Ok(handle) => {
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code).is_ok();
            let _ = CloseHandle(handle);
            ok && code == 259 // STILL_ACTIVE
        }
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

#[test]
fn a_normal_exit_child_is_reaped() {
    let mut owned = spawn_fixture("normal-exit").unwrap();
    let status = owned
        .process
        .wait(TIMEOUT)
        .unwrap()
        .expect("normal-exit child should exit on its own");
    assert_eq!(status.code(), Some(0));
    owned.drain();
}

#[test]
fn a_shutdown_frame_makes_the_child_exit() {
    let mut owned = spawn_fixture("wait-frame").unwrap();
    let frame = b"{\"type\":\"shutdown\",\"protocol\":1}\n";
    owned.process.write_control_frame(frame).unwrap();
    let status = owned
        .process
        .wait(TIMEOUT)
        .unwrap()
        .expect("wait-frame child should exit after the shutdown frame");
    assert_eq!(status.code(), Some(0));
    owned.drain();
}

#[test]
fn closing_the_job_kills_a_child_that_ignores_the_frame() {
    let mut owned = spawn_fixture("ignore-frame").unwrap();
    let frame = b"{\"type\":\"shutdown\",\"protocol\":1}\n";
    owned.process.write_control_frame(frame).unwrap();
    // The child never reads stdin, so it must still be alive shortly after.
    assert!(
        owned.process.wait(Duration::from_millis(500)).unwrap().is_none(),
        "an ignore-frame child must not exit on its own"
    );
    let pid = owned.pid();
    owned.process.terminate_tree();
    assert!(wait_until_dead(pid, TIMEOUT), "ignore-frame child survived its job close");
    owned.drain();
}

#[test]
fn closing_the_job_reclaims_child_and_grandchild() {
    let mut owned = spawn_fixture("spawn-grandchild").unwrap();
    let child = owned.pid();
    let grandchild = owned.wait_for_reported_grandchild(TIMEOUT).unwrap();
    drop(owned);
    assert!(wait_until_dead(child, TIMEOUT), "child survived its job close");
    assert!(wait_until_dead(grandchild, TIMEOUT), "grandchild survived its job close");
}

#[test]
fn spawning_with_an_existing_working_directory_succeeds() {
    let (exe, args) = fixture_command("normal-exit");
    let cwd = std::env::current_dir().expect("test working directory is readable");
    assert!(cwd.is_dir(), "test working directory must exist: {cwd:?}");

    let process = OwnedProcess::spawn(
        exe.to_string_lossy().as_ref(),
        &args,
        Some(Path::new(&cwd)),
        None,
    );

    assert!(
        process.is_ok(),
        "CreateProcessW rejected an existing working directory: {process:?}"
    );
}

// ---------------------------------------------------------------------------
// Assignment-failure handling (injected Win32 table).
// ---------------------------------------------------------------------------

/// A failing AssignProcessToJobObject that records the call.
unsafe fn injected_fail_assign(_job: HANDLE, _process: HANDLE) -> WinResult<()> {
    CALLS.lock().unwrap().push("assign");
    Err(windows::core::Error::from_win32())
}

/// A TerminateProcess that records the call, then forwards to the real one.
unsafe fn injected_rec_terminate(process: HANDLE, code: u32) -> WinResult<()> {
    CALLS.lock().unwrap().push("terminate");
    TerminateProcess(process, code)
}

/// A CloseHandle that records the call, then forwards to the real one.
unsafe fn injected_rec_close(handle: HANDLE) -> WinResult<()> {
    CALLS.lock().unwrap().push("close");
    CloseHandle(handle)
}

#[test]
fn assignment_failure_terminates_the_suspended_child_before_closing_handles() {
    *CALLS.lock().unwrap() = Vec::new();

    let procs = Win32Procs {
        assign_process_to_job: injected_fail_assign,
        terminate_process: injected_rec_terminate,
        close_handle: injected_rec_close,
    };

    let job = create_kill_on_close_job().unwrap();
    let pipes = InheritedPipes::create().unwrap();
    let (exe, args) = fixture_command("normal-exit");
    let mut suspended = create_process_suspended(
        exe.to_string_lossy().as_ref(),
        &args,
        None,
        None,
        &pipes,
    )
    .unwrap();
    let pid = suspended.pid();

    let error = assign_to_job(&procs, job.handle(), &mut suspended).unwrap_err();
    assert!(
        error.is_assignment(),
        "expected an assignment error, got {error:?}"
    );

    // The failure handler must terminate the suspended child before either
    // handle closes: assign, then terminate, then the two closes.
    let calls = CALLS.lock().unwrap();
    assert_eq!(calls.len(), 4, "unexpected call sequence: {calls:?}");
    assert_eq!(calls[0], "assign");
    assert_eq!(calls[1], "terminate");
    assert!(calls[2].starts_with("close"));
    assert!(calls[3].starts_with("close"));

    // The suspended child was never resumed, but the failure path must kill it
    // before the test returns.
    assert!(
        wait_until_dead(pid, TIMEOUT),
        "the suspended child survived assignment failure"
    );
}

// ---------------------------------------------------------------------------
// Supervisor lifecycle: discovery, spawn, readiness, and shutdown.
// ---------------------------------------------------------------------------

use deepseek_harness_desktop_lib::Discovery;

/// A short startup deadline so never-ready fixtures fail fast instead of
/// waiting the full 120-second production window.
const STARTUP_SHORT: Duration = Duration::from_secs(3);

/// A scratch logs directory for one supervisor, cleaned before use.
fn scratch_logs(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir()
        .join("dsh-supervisor-tests")
        .join(format!("{}-{}", tag, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// A `DesktopPaths` whose logs land in the scratch directory `tag`.
fn test_paths(tag: &str) -> DesktopPaths {
    let logs = scratch_logs(tag);
    let mut paths = DesktopPaths::from_roots(
        std::path::Path::new(r"C:\Portable\DeepSeek Harness\DeepSeek Harness.exe"),
        std::path::Path::new(r"C:\Users\Ada"),
        std::path::Path::new(r"C:\Users\Ada\AppData\Local"),
    )
    .unwrap();
    paths.logs = logs;
    paths
}

/// A supervisor for tests with a short startup deadline.
fn supervisor(tag: &str) -> HostSupervisor {
    HostSupervisor::new(test_paths(tag)).with_startup_deadline(STARTUP_SHORT)
}

/// A compatible runtime identity ready to attach to.
fn compatible_identity_typed() -> RuntimeIdentity {
    RuntimeIdentity {
        product: "deepseek-harness".into(),
        desktop_protocol: 1,
        version: "0.1.0-test".into(),
        instance_id: "fixture-compatible".into(),
        home_kind: HomeKind::Default,
    }
}

/// Spawn `mode` as an owned host under `supervisor`, returning the reported URL.
fn spawn_supervised(supervisor: &mut HostSupervisor, mode: &str) -> Result<String, DesktopError> {
    let (exe, args) = fixture_command(mode);
    let mut env: Vec<(String, String)> = std::env::vars().collect();
    env.push((FIXTURE_VAR.to_string(), mode.to_string()));
    supervisor.spawn_with(exe.to_string_lossy().as_ref(), &args, None, Some(&env))
}

#[test]
fn attached_shutdown_is_detached_and_touches_no_process() {
    let mut supervisor = supervisor("attached");
    let discovery = Discovery::Attach {
        base_url: "http://127.0.0.1:3080".into(),
        identity: compatible_identity_typed(),
    };
    let url = supervisor.start_from(&discovery).unwrap();
    assert_eq!(url, "http://127.0.0.1:3080");
    assert_eq!(supervisor.base_url(), Some("http://127.0.0.1:3080"));
    assert_eq!(
        supervisor.shutdown().unwrap(),
        ShutdownOutcome::Detached
    );
    // Shutting down again is still a no-op.
    assert_eq!(
        supervisor.shutdown().unwrap(),
        ShutdownOutcome::Detached
    );
    assert_eq!(supervisor.owned_pid(), None, "attach must never spawn a process");
}

#[test]
fn owned_host_shuts_down_gracefully() {
    let mut supervisor = supervisor("graceful");
    let url = spawn_supervised(&mut supervisor, "host-graceful").unwrap();
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "expected a loopback URL, got {url}"
    );
    assert_eq!(
        supervisor.identity().unwrap().instance_id,
        "fixture-compatible"
    );
    let pid = supervisor.owned_pid().expect("an owned process is running");
    assert_eq!(supervisor.shutdown().unwrap(), ShutdownOutcome::Graceful);
    assert!(wait_until_dead(pid, TIMEOUT), "graceful child survived shutdown");
}

#[test]
fn owned_host_that_ignores_the_frame_is_forced() {
    let mut supervisor = supervisor("forced");
    let _url = spawn_supervised(&mut supervisor, "host-forced").unwrap();
    let pid = supervisor.owned_pid().expect("an owned process is running");
    assert_eq!(supervisor.shutdown().unwrap(), ShutdownOutcome::Forced);
    assert!(wait_until_dead(pid, TIMEOUT), "forced child survived its job close");
}

#[test]
fn host_that_exits_before_ready_errors_and_leaves_no_process() {
    let mut supervisor = supervisor("early-exit");
    let error = spawn_supervised(&mut supervisor, "early-exit").unwrap_err();
    assert!(
        matches!(error, DesktopError::Readiness(_)),
        "expected a readiness error, got {error:?}"
    );
    let pid = supervisor.owned_pid().expect("the early-exit child was spawned");
    assert!(wait_until_dead(pid, TIMEOUT), "early-exit child survived");
}

#[test]
fn host_that_never_signals_ready_times_out_and_is_reclaimed() {
    let mut supervisor = supervisor("timeout");
    let error = spawn_supervised(&mut supervisor, "host-timeout").unwrap_err();
    assert!(
        matches!(error, DesktopError::ReadinessTimeout(_)),
        "expected a readiness timeout, got {error:?}"
    );
    let pid = supervisor.owned_pid().expect("the silent host was spawned");
    assert!(wait_until_dead(pid, TIMEOUT), "timeout child survived its job close");
}

#[test]
fn host_with_a_malformed_url_line_errors_and_is_reclaimed() {
    let mut supervisor = supervisor("malformed-url");
    let error = spawn_supervised(&mut supervisor, "host-malformed-url").unwrap_err();
    assert!(
        matches!(error, DesktopError::MalformedUrl(_)),
        "expected a malformed-url error, got {error:?}"
    );
    let pid = supervisor.owned_pid().expect("the malformed host was spawned");
    assert!(wait_until_dead(pid, TIMEOUT), "malformed-url child survived its job close");
}

#[test]
fn host_with_an_incompatible_identity_fails_readiness_and_is_reclaimed() {
    let mut supervisor = supervisor("identity-mismatch");
    let error = spawn_supervised(&mut supervisor, "host-identity-mismatch").unwrap_err();
    assert!(
        matches!(error, DesktopError::ReadinessTimeout(_))
            || matches!(error, DesktopError::Readiness(_)),
        "expected a readiness failure, got {error:?}"
    );
    let pid = supervisor.owned_pid().expect("the mismatched host was spawned");
    assert!(wait_until_dead(pid, TIMEOUT), "identity-mismatch child survived its job close");
}

// ---------------------------------------------------------------------------
// Real DesktopController over a real supervisor and child (tray Exit path).
// ---------------------------------------------------------------------------

/// A no-op window port for controller tests: only the supervisor shutdown and
/// the exit code are observable here.
#[derive(Default)]
struct NoopWindow;

impl WindowPort for NoopWindow {
    fn hide(&self) {}
    fn show(&self) {}
    fn unminimize(&self) {}
    fn set_focus(&self) {}
    fn navigate_live(&self, _base_url: &str) {}
}

/// A no-op opener port for controller tests.
#[derive(Default)]
struct NoopOpener;

impl OpenerPort for NoopOpener {
    fn open_url(&self, _url: &str) -> Result<(), String> {
        Ok(())
    }
    fn open_path(&self, _path: &str) -> Result<(), String> {
        Ok(())
    }
}

/// A recording exit port shared by reference so the test can inspect the code.
#[derive(Clone, Default)]
struct RecordExit {
    code: std::sync::Arc<std::sync::Mutex<Option<i32>>>,
}

impl RecordExit {
    fn code(&self) -> Option<i32> {
        *self.code.lock().unwrap()
    }
}

impl ExitPort for RecordExit {
    fn exit(&self, code: i32) {
        *self.code.lock().unwrap() = Some(code);
    }
}

/// A supervisor shared behind the same `Arc<Mutex<_>>` the production
/// `AppSupervisorPort` wraps, so the tray Exit path drives the real bounded
/// shutdown against a real child.
fn shared_supervisor(tag: &str) -> std::sync::Arc<std::sync::Mutex<HostSupervisor>> {
    std::sync::Arc::new(std::sync::Mutex::new(supervisor(tag)))
}

#[test]
fn controller_exit_shuts_down_a_real_owned_host_before_exiting() {
    let supervisor = shared_supervisor("controller-exit");
    let url = {
        let mut supervisor = supervisor.lock().unwrap();
        spawn_supervised(&mut supervisor, "host-graceful").unwrap()
    };
    assert!(
        url.starts_with("http://127.0.0.1:"),
        "expected a loopback URL, got {url}"
    );
    let pid = supervisor
        .lock()
        .unwrap()
        .owned_pid()
        .expect("an owned host is running");

    let exit = RecordExit::default();
    let mut controller = DesktopController::new(
        Box::new(NoopWindow::default()),
        Box::new(NoopOpener::default()),
        Box::new(AppSupervisorPort::new(supervisor.clone())),
        Box::new(exit.clone()),
        std::sync::Arc::new(std::sync::Mutex::new(InstanceQueue::new())),
    );

    assert_eq!(controller.exit(), 0, "tray Exit must report success");
    assert!(
        wait_until_dead(pid, TIMEOUT),
        "the owned host survived tray Exit"
    );
    assert_eq!(
        exit.code(),
        Some(0),
        "tray Exit must ask the app to exit only after the host shutdown"
    );
}

#[test]
fn controller_exit_detaches_an_attached_host_without_touching_a_process() {
    let supervisor = shared_supervisor("controller-attached");
    let url = supervisor
        .lock()
        .unwrap()
        .start_from(&Discovery::Attach {
            base_url: "http://127.0.0.1:3080".into(),
            identity: compatible_identity_typed(),
        })
        .unwrap();
    assert_eq!(url, "http://127.0.0.1:3080");
    // An attached host is external; the controller Exit must detach it without
    // ever claiming a process to kill.
    assert_eq!(
        supervisor.lock().unwrap().owned_pid(),
        None,
        "attach must never spawn a process"
    );

    let exit = RecordExit::default();
    let mut controller = DesktopController::new(
        Box::new(NoopWindow::default()),
        Box::new(NoopOpener::default()),
        Box::new(AppSupervisorPort::new(supervisor.clone())),
        Box::new(exit.clone()),
        std::sync::Arc::new(std::sync::Mutex::new(InstanceQueue::new())),
    );

    assert_eq!(controller.exit(), 0);
    assert_eq!(
        supervisor.lock().unwrap().owned_pid(),
        None,
        "an attached host must never be owned or terminated"
    );
    assert_eq!(exit.code(), Some(0));
}
