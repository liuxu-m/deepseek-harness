//! Native process-tree containment for the bundled host (Windows-only).
//!
//! The desktop process owns a Windows Job Object configured with
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Every bundled host process is created
//! suspended, assigned to that job before its primary thread resumes, and then
//! resumed. Because every process in a job — including grandchildren it later
//! spawns — is killed when the job's last handle closes, closing the job handle
//! in `OwnedProcess` is the crash backstop that guarantees the bundled host tree
//! cannot outlive the desktop.
//!
//! `OwnedProcess::spawn` builds the whole containment boundary: a kill-on-close
//! job, inherited stdio pipes with only the child ends inheritable, a suspended
//! spawn, assign-before-resume, and the retained process/job handles needed to
//! reap the tree. The assignment step is injectable ([`Win32Procs`]) so a test
//! can force `AssignProcessToJobObject` to fail and prove a suspended child is
//! terminated before its handles close.
//!
//! This module compiles only on Windows; `lib.rs` gates the declaration with
//! `#[cfg(windows)]`.

use std::fs::File;
use std::io::{self, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::os::windows::process::ExitStatusExt;
use std::path::Path;
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{
    CloseHandle, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CreateProcessW, GetExitCodeProcess, OpenProcess, ResumeThread, TerminateProcess,
    CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, PROCESS_CREATION_FLAGS,
    PROCESS_INFORMATION, PROCESS_QUERY_LIMITED_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOW,
};
use windows::Win32::Security::SECURITY_ATTRIBUTES;

use thiserror::Error;

/// The exit code `TerminateProcess` uses when reclaiming a suspended child whose
/// job assignment or resume failed.
const FAILURE_TERMINATE_CODE: u32 = 1;
/// `GetExitCodeProcess` reports this virtual code while a process is alive.
const STILL_ACTIVE: u32 = 259;
/// How long `OwnedProcess::wait` sleeps between exit probes.
const WAIT_PROBE_INTERVAL: Duration = Duration::from_millis(20);
/// How long `terminate_tree` waits for the process to wind down after the job
/// close.
const TERMINATE_GRACE: Duration = Duration::from_secs(5);
/// The pipe buffer size passed to `CreatePipe`.
const PIPE_BUFFER_SIZE: u32 = 256 * 1024;
/// The largest control frame `write_control_frame` accepts.
const STDIN_MAX_WRITE: usize = 1024;

/// Errors raised while building or activating the containment boundary.
#[derive(Debug, Error)]
pub enum JobError {
    /// Creating the kill-on-close job object failed.
    #[error("creating the kill-on-close job object failed: {0}")]
    CreateJob(#[source] windows::core::Error),
    /// Creating a stdio pipe failed.
    #[error("creating an inherited pipe failed: {0}")]
    CreatePipe(#[source] windows::core::Error),
    /// Enabling the kill-on-close limit failed.
    #[error("enabling JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE failed: {0}")]
    SetLimit(#[source] windows::core::Error),
    /// Marking a stdio handle inheritable failed.
    #[error("marking a stdio handle inheritable failed: {0}")]
    HandleFlags(#[source] windows::core::Error),
    /// `CreateProcessW` failed while spawning the suspended host.
    #[error("CreateProcessW failed: {0}")]
    Spawn(#[source] windows::core::Error),
    /// Assigning the suspended process to the job failed.
    #[error("assigning the process to the job failed: {0}")]
    Assignment(#[source] windows::core::Error),
    /// Resuming the suspended primary thread failed.
    #[error("resuming the suspended primary thread failed")]
    Resume,
}

impl JobError {
    /// Whether this error came from assigning the process to its job.
    pub fn is_assignment(&self) -> bool {
        matches!(self, JobError::Assignment(_))
    }
}

/// The injectable Win32 entry points the assignment-failure path uses. Tests
/// swap in recording/failing stand-ins to prove a suspended child is terminated
/// before its handles close; the real bindings back [`Win32Procs::real`].
pub struct Win32Procs {
    /// `AssignProcessToJobObject(hjob, hprocess)`; zero return maps to `Err`.
    pub assign_process_to_job: unsafe fn(HANDLE, HANDLE) -> windows::core::Result<()>,
    /// `TerminateProcess(hprocess, exitcode)`.
    pub terminate_process: unsafe fn(HANDLE, u32) -> windows::core::Result<()>,
    /// `CloseHandle(hobject)`.
    pub close_handle: unsafe fn(HANDLE) -> windows::core::Result<()>,
}

impl Win32Procs {
    /// The production function table backed by the real `windows` bindings.
    pub fn real() -> Self {
        Win32Procs {
            assign_process_to_job: AssignProcessToJobObject,
            terminate_process: TerminateProcess,
            close_handle: CloseHandle,
        }
    }
}

/// A Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set.
///
/// [KillOnCloseJob::handle] returns the underlying handle and [KillOnCloseJob::into_handle]
/// moves it out so [`OwnedProcess`] can own it. Dropping without `into_handle`
/// closes the handle, which kills every process in the job.
pub struct KillOnCloseJob {
    handle: Option<HANDLE>,
}

impl KillOnCloseJob {
    /// The raw job object handle.
    pub fn handle(&self) -> HANDLE {
        self.handle.expect("job handle is present")
    }

    /// Take the raw handle out so the caller owns its closure.
    pub fn into_handle(&mut self) -> HANDLE {
        self.handle.take().expect("job handle is present")
    }
}

impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = unsafe { CloseHandle(handle) };
        }
    }
}

/// A child process already spawned suspended, not yet assigned or resumed.
///
/// Its handles are closed explicitly by the activation paths (or moved into an
/// owner), so it carries no `Drop`.
pub struct SuspendedProcess {
    process: HANDLE,
    thread: HANDLE,
    pid: u32,
}

impl SuspendedProcess {
    /// The raw process handle (the suspended child).
    pub fn handle(&self) -> HANDLE {
        self.process
    }

    /// The raw primary-thread handle (used to resume, then closed).
    fn thread_handle(&self) -> HANDLE {
        self.thread
    }

    /// The OS process id of the suspended child.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Terminate the suspended child with `code`.
    fn terminate(&self, procs: &Win32Procs, code: u32) {
        let _ = unsafe { (procs.terminate_process)(self.process, code) };
    }

    /// Close both the process and thread handles.
    fn close_thread_and_process(&self, procs: &Win32Procs) {
        let _ = unsafe { (procs.close_handle)(self.process) };
        let _ = unsafe { (procs.close_handle)(self.thread) };
    }

    /// Resume the suspended primary thread, returning the suspend count before
    /// the resume (`u32::MAX` on failure).
    fn resume_primary_thread(&self) -> u32 {
        unsafe { ResumeThread(self.thread) }
    }

    /// Move the process handle and pid out. The handles are Copy and
    /// `SuspendedProcess` implements no `Drop`, so the source is dropped as-is.
    fn into_process(self) -> (HANDLE, u32) {
        (self.process, self.pid)
    }
}

/// Create a Windows Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` set.
pub fn create_kill_on_close_job() -> Result<KillOnCloseJob, JobError> {
    let handle = unsafe { CreateJobObjectW(None, None) }.map_err(JobError::CreateJob)?;
    if handle.is_invalid() {
        return Err(JobError::CreateJob(windows::core::Error::from_win32()));
    }
    let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            handle,
            JobObjectExtendedLimitInformation,
            &info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const core::ffi::c_void,
            core::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    }
    .map_err(JobError::SetLimit)?;
    Ok(KillOnCloseJob { handle: Some(handle) })
}

/// stdio pipe pairs for a spawned child. Only the three child ends are
/// inheritable, so the child receives exactly those handles and no other
/// desktop handle leaks into it.
pub struct InheritedPipes {
    child_stdin: HANDLE,
    child_stdout: HANDLE,
    child_stderr: HANDLE,
    parent_stdin: File,
    parent_stdout: File,
    parent_stderr: File,
}

impl InheritedPipes {
    /// Create one stdin/stdout/stderr pipe pair each. Pipe creation is wrapped
    /// so a mid-way failure closes every pipe already created. The child ends
    /// are then marked inheritable.
    pub fn create() -> Result<Self, JobError> {
        let non_inheritable = SECURITY_ATTRIBUTES {
            nLength: core::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: core::ptr::null_mut(),
            bInheritHandle: windows::core::BOOL(0), // FALSE
        };

        let mut child_stdin = HANDLE::default();
        let mut parent_stdin = HANDLE::default();
        unsafe { CreatePipe(&mut child_stdin, &mut parent_stdin, Some(&non_inheritable), PIPE_BUFFER_SIZE) }
            .map_err(JobError::CreatePipe)?;

        let mut child_stdout = HANDLE::default();
        let mut parent_stdout = HANDLE::default();
        if let Err(error) = unsafe { CreatePipe(&mut parent_stdout, &mut child_stdout, Some(&non_inheritable), PIPE_BUFFER_SIZE) } {
            let _ = unsafe { CloseHandle(child_stdin) };
            let _ = unsafe { CloseHandle(parent_stdin) };
            return Err(JobError::CreatePipe(error));
        }

        let mut child_stderr = HANDLE::default();
        let mut parent_stderr = HANDLE::default();
        if let Err(error) = unsafe { CreatePipe(&mut parent_stderr, &mut child_stderr, Some(&non_inheritable), PIPE_BUFFER_SIZE) } {
            let _ = unsafe { CloseHandle(child_stdin) };
            let _ = unsafe { CloseHandle(parent_stdin) };
            let _ = unsafe { CloseHandle(child_stdout) };
            let _ = unsafe { CloseHandle(parent_stdout) };
            return Err(JobError::CreatePipe(error));
        }

        // Mark only the child ends inheritable, so the child receives exactly
        // the three stdio handles and nothing else.
        fn mark_inherit(handle: HANDLE) -> windows::core::Result<()> {
            unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT.0, HANDLE_FLAG_INHERIT) }
        }
        // A mid-way failure closes every handle created so far, exactly once,
        // like the CreatePipe error paths above.
        let close_all = || {
            let _ = unsafe { CloseHandle(child_stdin) };
            let _ = unsafe { CloseHandle(parent_stdin) };
            let _ = unsafe { CloseHandle(child_stdout) };
            let _ = unsafe { CloseHandle(parent_stdout) };
            let _ = unsafe { CloseHandle(child_stderr) };
            let _ = unsafe { CloseHandle(parent_stderr) };
        };
        if let Err(error) = mark_inherit(child_stdin) {
            close_all();
            return Err(JobError::HandleFlags(error));
        }
        if let Err(error) = mark_inherit(child_stdout) {
            close_all();
            return Err(JobError::HandleFlags(error));
        }
        if let Err(error) = mark_inherit(child_stderr) {
            close_all();
            return Err(JobError::HandleFlags(error));
        }

        Ok(InheritedPipes {
            child_stdin,
            child_stdout,
            child_stderr,
            parent_stdin: unsafe { File::from_raw_handle(parent_stdin.0) },
            parent_stdout: unsafe { File::from_raw_handle(parent_stdout.0) },
            parent_stderr: unsafe { File::from_raw_handle(parent_stderr.0) },
        })
    }

    /// Close the parent's copies of the child ends, which the child now holds
    /// through its own inherited handles.
    fn close_child_ends(&self) {
        let _ = unsafe { CloseHandle(self.child_stdin) };
        let _ = unsafe { CloseHandle(self.child_stdout) };
        let _ = unsafe { CloseHandle(self.child_stderr) };
    }
}

/// Build a UTF-16 environment block for `CREATE_UNICODE_ENVIRONMENT`, or `None`
/// to inherit the parent's environment. The entries are sorted case-insensitively
/// by name because Windows searches a Unicode block with a binary search.
fn build_env_block(env: Option<&[(String, String)]>) -> Option<Vec<u16>> {
    let mut entries: Vec<(&str, &str)> = env?
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    entries.sort_by_key(|(key, _)| key.to_lowercase());
    let mut block = Vec::new();
    for (key, value) in entries {
        for unit in format!("{key}={value}").encode_utf16() {
            block.push(unit);
        }
        block.push(0);
    }
    // The block is terminated by a final extra null.
    block.push(0);
    Some(block)
}

/// Spawn `command` with `args` suspended, wiring the inherited pipes as its
/// standard I/O. The child runs detached (`CREATE_NO_WINDOW`) and, when `env` is
/// supplied, receives it through `CREATE_UNICODE_ENVIRONMENT`.
pub fn create_process_suspended(
    command: &str,
    args: &str,
    cwd: Option<&Path>,
    env: Option<&[(String, String)]>,
    pipes: &InheritedPipes,
) -> Result<SuspendedProcess, JobError> {
    let mut application: Vec<u16> = command.encode_utf16().collect();
    application.push(0);

    let mut command_line: Vec<u16> = args.encode_utf16().collect();
    command_line.push(0);

    let env_block = build_env_block(env);
    let environment_ptr = env_block
        .as_ref()
        .map(|block| block.as_ptr() as *const core::ffi::c_void);

    let mut flags = PROCESS_CREATION_FLAGS(CREATE_SUSPENDED.0 | CREATE_NO_WINDOW.0);
    if env.is_some() {
        flags.0 |= CREATE_UNICODE_ENVIRONMENT.0;
    }

    let startup = STARTUPINFOW {
        cb: core::mem::size_of::<STARTUPINFOW>() as u32,
        dwFlags: STARTF_USESTDHANDLES,
        hStdInput: pipes.child_stdin,
        hStdOutput: pipes.child_stdout,
        hStdError: pipes.child_stderr,
        ..Default::default()
    };
    let mut process_info = PROCESS_INFORMATION::default();

    let current_dir = cwd.map(|p| p.as_os_str().encode_wide().collect::<Vec<u16>>());
    let current_dir_ptr = current_dir
        .as_ref()
        .map(|w| windows::core::PCWSTR(w.as_ptr()))
        .unwrap_or_else(windows::core::PCWSTR::null);

    let result = unsafe {
        CreateProcessW(
            windows::core::PCWSTR(application.as_ptr()),
            Some(windows::core::PWSTR(command_line.as_mut_ptr())),
            None,
            None,
            true, // bInheritHandles: the child must inherit the stdio pipes
            flags,
            environment_ptr,
            current_dir_ptr,
            &startup,
            &mut process_info,
        )
    };
    // The child has its own inherited copies of the pipe ends; the parent's
    // copies close now on both the success and error paths.
    pipes.close_child_ends();
    result.map_err(JobError::Spawn)?;

    Ok(SuspendedProcess {
        process: process_info.hProcess,
        thread: process_info.hThread,
        pid: process_info.dwProcessId,
    })
}

/// Assign a suspended process to the kill-on-close job, then resume it.
///
/// On assignment or resume failure the suspended child is terminated before its
/// handles close (via `procs`), so a failed build never leaks a live process.
pub fn assign_to_job(
    procs: &Win32Procs,
    job: HANDLE,
    suspended: &mut SuspendedProcess,
) -> Result<(), JobError> {
    if let Err(error) = unsafe { (procs.assign_process_to_job)(job, suspended.handle()) } {
        suspended.terminate(procs, FAILURE_TERMINATE_CODE);
        suspended.close_thread_and_process(procs);
        return Err(JobError::Assignment(error));
    }

    // The thread handle is no longer needed once the process is running.
    let suspend_count = suspended.resume_primary_thread();
    let _ = unsafe { (procs.close_handle)(suspended.thread_handle()) };
    if suspend_count == u32::MAX {
        // Resume failed and the child is still suspended; reclaim the process.
        suspended.terminate(procs, FAILURE_TERMINATE_CODE);
        let _ = unsafe { (procs.close_handle)(suspended.handle()) };
        return Err(JobError::Resume);
    }
    Ok(())
}

/// A child process owned by the desktop: its job, stdio pipes, and the handle
/// used to reap it.
pub struct OwnedProcess {
    pid: u32,
    process: HANDLE,
    job: HANDLE,
    stdin: File,
    stdout: Option<File>,
    stderr: Option<File>,
    reaped: bool,
}

impl core::fmt::Debug for OwnedProcess {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.debug_struct("OwnedProcess")
            .field("pid", &self.pid)
            .field("reaped", &self.reaped)
            .finish_non_exhaustive()
    }
}

// SAFETY: `OwnedProcess` holds raw Win32 process/job handles and parent-side
// stdio `File`s. The handles are fully owned OS objects whose address-space
// residence does not depend on the thread that opened them, so moving the value
// to another thread is safe. The shell supervises at most one host and
// serializes all access to the supervisor (including the contained
// `OwnedProcess`) behind a `Mutex` (Tauri-managed state), so the handles are
// never used concurrently. Moving without that lock would be unsound; the lock
// is the invariant that makes this `Send` impl valid.
unsafe impl Send for OwnedProcess {}

impl OwnedProcess {
    /// Spawn `command` with `args`, contain it in a kill-on-close job with its
    /// stdio on inherited pipes, and resume it.
    pub fn spawn(
        command: &str,
        args: &str,
        cwd: Option<&Path>,
        env: Option<&[(String, String)]>,
    ) -> Result<Self, JobError> {
        let procs = Win32Procs::real();
        let mut job = create_kill_on_close_job()?;
        let pipes = InheritedPipes::create()?;
        let mut suspended = create_process_suspended(command, args, cwd, env, &pipes)?;
        assign_to_job(&procs, job.handle(), &mut suspended)?;
        let (process, pid) = suspended.into_process();
        let InheritedPipes {
            parent_stdin,
            parent_stdout,
            parent_stderr,
            ..
        } = pipes;
        Ok(OwnedProcess {
            pid,
            process,
            job: job.into_handle(),
            stdin: parent_stdin,
            stdout: Some(parent_stdout),
            stderr: Some(parent_stderr),
            reaped: false,
        })
    }

    /// The OS process id of the child.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Write the parent-control shutdown frame to the child's stdin.
    pub fn write_control_frame(&mut self, frame: &[u8]) -> io::Result<()> {
        if frame.len() > STDIN_MAX_WRITE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "control frame exceeds the stdin budget",
            ));
        }
        self.stdin.write_all(frame)?;
        self.stdin.flush()
    }

    /// Take the read end of the child's stdout for a log drain.
    pub fn take_stdout(&mut self) -> Option<Box<dyn std::io::Read + Send>> {
        self.stdout
            .take()
            .map(|f| Box::new(f) as Box<dyn std::io::Read + Send>)
    }

    /// Take the read end of the child's stderr for a log drain.
    pub fn take_stderr(&mut self) -> Option<Box<dyn std::io::Read + Send>> {
        self.stderr
            .take()
            .map(|f| Box::new(f) as Box<dyn std::io::Read + Send>)
    }

    /// Non-blocking reap: `Some(status)` once the child has exited, `None` if it
    /// is still running. Once the child has exited, its process handle is closed
    /// so the parent holds no reference that keeps the process object alive.
    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        if self.reaped {
            return Ok(None);
        }
        let mut code: u32 = 0;
        unsafe { GetExitCodeProcess(self.process, &mut code) }?;
        if code == STILL_ACTIVE {
            return Ok(None);
        }
        self.reaped = true;
        close_handle(self.process);
        self.process = INVALID_HANDLE_VALUE;
        Ok(Some(std::process::ExitStatus::from_raw(code)))
    }

    /// Reap the child, blocking up to `timeout`; `None` if it is still alive.
    pub fn wait(&mut self, timeout: Duration) -> io::Result<Option<std::process::ExitStatus>> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait()? {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            std::thread::sleep(WAIT_PROBE_INTERVAL);
        }
    }

    /// Close the job first (killing the whole tree) then wait for the process to
    /// reach quiescence so no fixture process survives the call.
    pub fn terminate_tree(&mut self) {
        close_job(&mut self.job);
        let deadline = Instant::now() + TERMINATE_GRACE;
        while Instant::now() < deadline {
            if matches!(self.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(WAIT_PROBE_INTERVAL);
        }
    }
}

impl Drop for OwnedProcess {
    fn drop(&mut self) {
        // Signal any log drains (EOF) before killing the tree so the drain reads
        // terminate cleanly rather than racing the process kill.
        let _ = self.stdout.take();
        let _ = self.stderr.take();
        close_job(&mut self.job);
        // Release the process handle if it was never reaped; the child is already
        // terminated by the job close above.
        if !self.process.is_invalid() {
            close_handle(self.process);
            self.process = INVALID_HANDLE_VALUE;
        }
    }
}

/// Best-effort close of a handle; failures (already-closed or invalid) are
/// intentionally ignored.
fn close_handle(handle: HANDLE) {
    let _ = unsafe { CloseHandle(handle) };
}

/// Close a job handle if still open; `KILL_ON_JOB_CLOSE` then reclaims the tree.
fn close_job(job: &mut HANDLE) {
    if !job.is_invalid() {
        close_handle(*job);
        *job = INVALID_HANDLE_VALUE;
    }
}

/// Report whether the process `pid` is currently alive, best-effort.
///
/// Opens the process with query-limited rights and probes its exit code. A
/// handle that cannot be opened, or whose exit code is no longer `STILL_ACTIVE`,
/// means the process is dead for our purposes. A pid that was already reaped
/// reports not-alive.
fn process_is_alive(pid: u32) -> bool {
    let Ok(process) =
        (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) })
    else {
        return false;
    };
    let mut code: u32 = 0;
    let alive = unsafe { GetExitCodeProcess(process, &mut code) }.is_ok();
    close_handle(process);
    alive && code == STILL_ACTIVE
}

/// Wait up to `timeout` for `pid` to be confirmed dead, polling briefly. Used
/// by the startup-error Retry to confirm a previously failed owned tree is
/// reclaimed before discovery re-runs. Returns whether the process was observed
/// dead within the bound. Best-effort: it never blocks beyond `timeout`.
pub fn wait_until_dead(pid: u32, timeout: std::time::Duration) -> bool {
    let deadline = std::time::Instant::now() + timeout;
    loop {
        if !process_is_alive(pid) {
            return true;
        }
        if std::time::Instant::now() >= deadline {
            return false;
        }
        std::thread::sleep(WAIT_PROBE_INTERVAL);
    }
}
