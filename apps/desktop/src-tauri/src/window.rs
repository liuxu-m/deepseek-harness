//! Main-window lifecycle for the desktop shell: WebView creation, close-to-tray,
//! and the testable controller that routes tray commands and lifecycle events.
//!
//! The controller holds only injectable ports ([`WindowPort`], [`OpenerPort`],
//! [`SupervisorPort`], [`ExitPort`]) so every lifecycle decision is unit-testable
//! without a running Tauri runtime. Production wiring lives in `lib.rs`, which
//! binds the ports to the real Tauri window, opener plugin, and supervisor state.
//!
//! Navigation policy: the live Host window may navigate only within the resolved
//! `http://127.0.0.1:<port>/` origin (plus the local app-asset page used for the
//! startup-error screen). Any other http(s) navigation is opened in the system
//! browser and canceled in the webview; non-http(s) navigation is blocked. The
//! Host web content therefore never gains shell or filesystem capability.

use tauri::Url;

use crate::instance::InstanceQueue;
use crate::supervisor::ShutdownOutcome;

/// The operations a main window must expose for the controller and its
/// close-to-tray and focus behaviors. Implementations wrap the real Tauri
/// `WebviewWindow`; tests use recording fakes.
pub trait WindowPort: Send {
    /// Hide the window (close-to-tray).
    fn hide(&self);
    /// Show the window.
    fn show(&self);
    /// Restore the window from a minimized state.
    fn unminimize(&self);
    /// Bring the window to the foreground.
    fn set_focus(&self);
    /// Navigate the window to the live Host page at `base_url` (used by Retry).
    fn navigate_live(&self, base_url: &str);
}

/// The operations the host metadata and the opener plugin expose.
pub trait OpenerPort: Send {
    /// Open `url` in the system browser.
    fn open_url(&self, url: &str) -> Result<(), String>;
    /// Open `path` (a directory) with the system handler.
    fn open_path(&self, path: &str) -> Result<(), String>;
}

/// The bounded shutdown surface the controller may drive.
///
/// The production implementation wraps the `HostSupervisor`; `shutdown` is
/// bounded (a five-second Host grace plus a bounded Job wait) and never blocks
/// beyond it. An attached host reports `Detached` and touches no process.
pub trait SupervisorPort: Send {
    /// Run the bounded host shutdown, reporting the outcome.
    fn shutdown(&mut self) -> Result<ShutdownOutcome, String>;
    /// The live Host base URL, if a session is established.
    fn base_url(&self) -> Option<String>;
}

/// The app-exit surface. Production binds to the Tauri `AppHandle::exit`.
pub trait ExitPort: Send {
    /// Ask the app to exit with `code`.
    fn exit(&self, code: i32);
}

/// Routes close-to-tray and tray/lifecycle commands over injectable ports and
/// tracks the single-instance focus handoff.
pub struct DesktopController {
    window: Box<dyn WindowPort>,
    opener: Box<dyn OpenerPort>,
    supervisor: Box<dyn SupervisorPort>,
    exit: Box<dyn ExitPort>,
    /// Guards `exit` so a repeat action (double tray click, a race between the
    /// menu handler and the run-event handler) cannot shut down twice.
    exiting: bool,
    instances: std::sync::Arc<std::sync::Mutex<InstanceQueue>>,
}

impl DesktopController {
    /// The tray/lifecycle controller over the given ports. `instances` is the
    /// shared single-instance queue also held by the single-instance plugin
    /// callback, so a startup-time second launch is remembered before the
    /// controller exists and focused by it after the window is created.
    pub fn new(
        window: Box<dyn WindowPort>,
        opener: Box<dyn OpenerPort>,
        supervisor: Box<dyn SupervisorPort>,
        exit: Box<dyn ExitPort>,
        instances: std::sync::Arc<std::sync::Mutex<InstanceQueue>>,
    ) -> Self {
        Self {
            window,
            opener,
            supervisor,
            exit,
            exiting: false,
            instances,
        }
    }

    /// Intercept the main-window close request: prevent the close, then hide
    /// the window into the tray. `prevent_close` runs the event-scoped
    /// `CloseRequestApi` action provided by the window event.
    pub fn handle_close_requested<F: FnOnce()>(&mut self, prevent_close: F) {
        prevent_close();
        self.window.hide();
    }

    /// Show/unminimize/focus the main window (tray "Open" or a single-instance
    /// launch).
    pub fn open(&mut self) {
        self.window.show();
        self.window.unminimize();
        self.window.set_focus();
    }

    /// Open the live Host URL in the system browser (tray "Open in browser").
    pub fn open_browser(&mut self) {
        if let Some(url) = self.supervisor.base_url() {
            if let Err(error) = self.opener.open_url(&url) {
                // A failed external open is non-fatal; surface it loudly rather
                // than hiding that the action did not happen.
                eprintln!("failed to open the host in a browser: {error}");
            }
        }
    }

    /// Open `logs_dir` with the system handler (tray "View logs").
    pub fn view_logs(&mut self, logs_dir: &str) {
        if let Err(error) = self.opener.open_path(logs_dir) {
            eprintln!("failed to open the logs directory: {error}");
        }
    }

    /// Run the bounded supervisor shutdown, then exit the app. Repeat actions
    /// after the first are ignored so shutdown cannot run twice. Returns the
    /// exit code.
    pub fn exit(&mut self) -> i32 {
        if self.exiting {
            return 0;
        }
        self.exiting = true;
        // The supervisor shutdown is bounded; an attached host is detached
        // without touching a process. Whatever the outcome, the shell then asks
        // the app to exit.
        if let Err(error) = self.supervisor.shutdown() {
            eprintln!("host shutdown reported an error while exiting: {error}");
        }
        self.exit.exit(0);
        0
    }

    /// Whether an exit is already underway, so a Retry never re-enters
    /// discovery after shutdown began.
    pub fn is_exiting(&self) -> bool {
        self.exiting
    }

    /// A second launch arrived during startup; remember it for after creation.
    pub fn remember_second_instance(&mut self) {
        if let Ok(mut instances) = self.instances.lock() {
            instances.remember();
        }
    }

    /// After the main window is created, focus it if a startup-time second
    /// launch was remembered.
    pub fn focus_pending_instance(&mut self) {
        let pending = self
            .instances
            .lock()
            .map(|mut instances| instances.take_pending())
            .unwrap_or(false);
        if pending {
            self.window.set_focus();
        }
    }
}

/// The navigation policy decision for a window navigation attempt.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationDecision {
    /// Let the webview navigate.
    Allow,
    /// Open the URL in the system browser and cancel the webview navigation.
    OpenExternally(String),
    /// Cancel the navigation without opening anything.
    Block,
}

/// Decide how the main window should treat a navigation to `url`.
///
/// The allowed loopback origin is the resolved Host base URL, e.g.
/// `http://127.0.0.1:3080`. Local app-asset pages (the `tauri` custom protocol
/// and its `http(s)://tauri.localhost` host on Windows) are always allowed so the
/// startup-error screen loads. Any other http(s) URL opens in the system browser
/// and any non-http(s) URL is blocked.
pub fn decide_navigation(url: &Url, allowed_loopback: Option<&str>) -> NavigationDecision {
    if same_loopback_origin(url, allowed_loopback) || is_app_asset(url) {
        return NavigationDecision::Allow;
    }
    match (url.scheme(), url.host()) {
        ("http" | "https", Some(_)) => NavigationDecision::OpenExternally(url.to_string()),
        _ => NavigationDecision::Block,
    }
}

/// Whether `url` is `http://127.0.0.1:<port>` for the same port as the allowed
/// loopback base URL. Only the loopback literal is trusted; a hostname that
/// happens to resolve to 127.0.0.1 (e.g. `localhost`) is never allowed.
fn same_loopback_origin(url: &Url, allowed: Option<&str>) -> bool {
    let allowed = match allowed.and_then(|value| Url::parse(value).ok()) {
        Some(allowed) => allowed,
        None => return false,
    };
    url.scheme() == "http"
        && url.host() == allowed.host()
        && url.port() == allowed.port()
        && url.host_str() == Some("127.0.0.1")
}

/// Whether `url` is a local app-asset page served by Tauri's custom protocol:
/// `tauri://localhost/...` or, on Windows, `http(s)://tauri.localhost/...`.
/// This is the startup-error screen; it must always load in the webview.
fn is_app_asset(url: &Url) -> bool {
    if url.scheme() == "tauri" {
        return true;
    }
    matches!(url.scheme(), "http" | "https") && url.host_str() == Some("tauri.localhost")
}

// ---------------------------------------------------------------------------
// Production ports and window building. These bind the controller and the
// navigation policy to the real Tauri runtime and are Windows-only like the
// supervisor they wrap.
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub use tauri::WebviewWindow;

#[cfg(windows)]
use tauri_plugin_opener::OpenerExt;

/// A real-Tauri main-window port; every operation surfaces failures loudly.
#[cfg(windows)]
pub struct AppWindowPort {
    window: WebviewWindow,
}

#[cfg(windows)]
impl AppWindowPort {
    /// Wrap a live `WebviewWindow`.
    pub fn new(window: WebviewWindow) -> Self {
        Self { window }
    }
}

#[cfg(windows)]
impl WindowPort for AppWindowPort {
    fn hide(&self) {
        handle_window_result(&self.window, WebviewWindow::hide, "hide");
    }
    fn show(&self) {
        handle_window_result(&self.window, WebviewWindow::show, "show");
    }
    fn unminimize(&self) {
        handle_window_result(&self.window, WebviewWindow::unminimize, "unminimize");
    }
    fn set_focus(&self) {
        handle_window_result(&self.window, WebviewWindow::set_focus, "set focus");
    }
    fn navigate_live(&self, base_url: &str) {
        match Url::parse(base_url) {
            Ok(url) => {
                handle_window_result(&self.window, |w| w.navigate(url), "navigate to live host")
            }
            Err(_) => eprintln!("retry produced a malformed host URL: {base_url}"),
        }
    }
}

/// Run one fallible `WebviewWindow` operation and surface its failure loudly.
#[cfg(windows)]
fn handle_window_result(
    window: &WebviewWindow,
    operation: impl FnOnce(&WebviewWindow) -> tauri::Result<()>,
    what: &str,
) {
    if let Err(error) = operation(window) {
        eprintln!("failed to {what} the main window: {error}");
    }
}

/// A real-Tauri opener-plugin port.
#[cfg(windows)]
pub struct AppOpenerPort {
    app: tauri::AppHandle,
}

#[cfg(windows)]
impl AppOpenerPort {
    /// Wrap the app handle; the opener plugin must be installed.
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(windows)]
impl OpenerPort for AppOpenerPort {
    fn open_url(&self, url: &str) -> Result<(), String> {
        self.app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|error| error.to_string())
    }
    fn open_path(&self, path: &str) -> Result<(), String> {
        self.app
            .opener()
            .open_path(path, None::<&str>)
            .map_err(|error| error.to_string())
    }
}

/// A real supervisor-state port. `shutdown` is bounded and attached hosts are
/// detached without touching a process.
#[cfg(windows)]
pub struct AppSupervisorPort {
    supervisor: std::sync::Arc<std::sync::Mutex<crate::supervisor::HostSupervisor>>,
}

#[cfg(windows)]
impl AppSupervisorPort {
    /// Wrap the shared supervisor state.
    pub fn new(supervisor: std::sync::Arc<std::sync::Mutex<crate::supervisor::HostSupervisor>>) -> Self {
        Self { supervisor }
    }
}

#[cfg(windows)]
impl SupervisorPort for AppSupervisorPort {
    fn shutdown(&mut self) -> Result<ShutdownOutcome, String> {
        self.supervisor
            .lock()
            .map_err(|_| "supervisor state lock poisoned".to_string())?
            .shutdown()
            .map_err(|error| error.to_string())
    }
    fn base_url(&self) -> Option<String> {
        self.supervisor
            .lock()
            .ok()
            .and_then(|state| state.base_url().map(str::to_string))
    }
}

/// A real app-exit port.
#[cfg(windows)]
pub struct AppExitPort {
    app: tauri::AppHandle,
}

#[cfg(windows)]
impl AppExitPort {
    /// Wrap the app handle.
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(windows)]
impl ExitPort for AppExitPort {
    fn exit(&self, code: i32) {
        self.app.exit(code);
    }
}

/// Build the single `main` window at `initial` with the shared navigation
/// policy. `allowed_origin` holds the current resolved loopback origin; `opener`
/// routes external http(s) links to the system browser. Navigation is allowed
/// only within that origin or the local app-asset page; everything else is
/// opened externally (http/https) or blocked.
#[cfg(windows)]
pub fn build_main_window(
    app: &tauri::App,
    initial: tauri::WebviewUrl,
    allowed_origin: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    opener: std::sync::Arc<dyn Fn(&str) + Send + Sync>,
) -> tauri::Result<WebviewWindow> {
    tauri::WebviewWindowBuilder::new(app, "main", initial)
        .title("DeepSeek Harness")
        .inner_size(1280.0, 820.0)
        .min_inner_size(900.0, 620.0)
        .on_navigation(move |url| {
            let origin = allowed_origin.lock().ok().and_then(|state| state.clone());
            match decide_navigation(url, origin.as_deref()) {
                NavigationDecision::Allow => true,
                NavigationDecision::OpenExternally(target) => {
                    opener(&target);
                    false
                }
                NavigationDecision::Block => false,
            }
        })
        .build()
}

/// The startup-error page URL, carrying the escaped error title and detail as
/// query parameters (the page keeps `textContent`-minimal escaping, so the raw
/// values must be percent-encoded here to survive the query string).
#[cfg(windows)]
pub fn startup_error_url(title: &str, detail: &str) -> tauri::WebviewUrl {
    let query = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("title", title)
        .append_pair("detail", detail)
        .finish();
    tauri::WebviewUrl::App(format!("startup-error.html?{query}").into())
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex,
    };

    use crate::supervisor::ShutdownOutcome;

    use super::{DesktopController, ExitPort, OpenerPort, SupervisorPort, WindowPort};

    /// A recording window-port fake shared by reference so tests can inspect it.
    #[derive(Clone, Default)]
    struct FakeWindow {
        hidden: std::sync::Arc<std::sync::atomic::AtomicBool>,
        shown: std::sync::Arc<std::sync::atomic::AtomicBool>,
        unminimized: std::sync::Arc<std::sync::atomic::AtomicBool>,
        focused: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl FakeWindow {
        fn hidden(&self) -> bool {
            self.hidden.load(Ordering::SeqCst)
        }
        fn focused(&self) -> bool {
            self.focused.load(Ordering::SeqCst)
        }
    }

    impl WindowPort for FakeWindow {
        fn hide(&self) {
            self.hidden.store(true, Ordering::SeqCst);
        }
        fn show(&self) {
            self.shown.store(true, Ordering::SeqCst);
        }
        fn unminimize(&self) {
            self.unminimized.store(true, Ordering::SeqCst);
        }
        fn set_focus(&self) {
            self.focused.store(true, Ordering::SeqCst);
        }
        fn navigate_live(&self, _base_url: &str) {}
    }

    #[derive(Clone, Default)]
    struct FakeOpener {
        opened: std::sync::Arc<Mutex<Vec<String>>>,
    }

    impl OpenerPort for FakeOpener {
        fn open_url(&self, url: &str) -> Result<(), String> {
            self.opened.lock().unwrap().push(url.to_string());
            Ok(())
        }
        fn open_path(&self, _path: &str) -> Result<(), String> {
            Ok(())
        }
    }

    #[derive(Clone, Default)]
    struct FakeExit {
        exited_code: std::sync::Arc<std::sync::atomic::AtomicI32>,
    }

    impl FakeExit {
        fn exited_code(&self) -> i32 {
            self.exited_code.load(Ordering::SeqCst)
        }
    }

    impl ExitPort for FakeExit {
        fn exit(&self, code: i32) {
            self.exited_code.store(code, Ordering::SeqCst);
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum FakeMode {
        Attached,
        Owned,
    }

    #[derive(Clone)]
    struct FakeSupervisor {
        mode: FakeMode,
        shutdown_calls: std::sync::Arc<AtomicUsize>,
        terminate_calls: std::sync::Arc<AtomicUsize>,
        base_url: Option<String>,
    }

    impl FakeSupervisor {
        fn new(mode: FakeMode) -> Self {
            Self {
                mode,
                shutdown_calls: std::sync::Arc::new(AtomicUsize::new(0)),
                terminate_calls: std::sync::Arc::new(AtomicUsize::new(0)),
                base_url: Some("http://127.0.0.1:3080".to_string()),
            }
        }
        fn shutdown_calls(&self) -> usize {
            self.shutdown_calls.load(Ordering::SeqCst)
        }
        fn terminate_calls(&self) -> usize {
            self.terminate_calls.load(Ordering::SeqCst)
        }
    }

    impl SupervisorPort for FakeSupervisor {
        fn shutdown(&mut self) -> Result<ShutdownOutcome, String> {
            self.shutdown_calls
                .fetch_add(1, Ordering::SeqCst);
            match self.mode {
                // An attached host is only detached; nothing is terminated.
                FakeMode::Attached => Ok(ShutdownOutcome::Detached),
                // An owned host is reclaimed; the fake records the terminate.
                FakeMode::Owned => {
                    self.terminate_calls.fetch_add(1, Ordering::SeqCst);
                    Ok(ShutdownOutcome::Graceful)
                }
            }
        }
        fn base_url(&self) -> Option<String> {
            self.base_url.clone()
        }
    }

    fn controller(window: FakeWindow, supervisor: FakeSupervisor) -> (DesktopController, FakeExit) {
        let exit = FakeExit::default();
        let controller = DesktopController::new(
            Box::new(window),
            Box::new(FakeOpener::default()),
            Box::new(supervisor),
            Box::new(exit.clone()),
            std::sync::Arc::new(std::sync::Mutex::new(crate::instance::InstanceQueue::new())),
        );
        (controller, exit)
    }

    #[test]
    fn a_close_request_is_prevented_and_the_window_hidden() {
        let window = FakeWindow::default();
        let (mut controller, _exit) =
            controller(window.clone(), FakeSupervisor::new(FakeMode::Owned));

        let mut prevented = false;
        controller.handle_close_requested(|| prevented = true);

        assert!(prevented, "the close must be prevented");
        assert!(window.hidden(), "the window must hide instead of closing");
    }

    #[test]
    fn exit_shuts_down_the_supervisor_before_exiting() {
        let supervisor = FakeSupervisor::new(FakeMode::Owned);
        let (mut controller, exit) = controller(FakeWindow::default(), supervisor.clone());

        assert_eq!(controller.exit(), 0);
        assert_eq!(supervisor.shutdown_calls(), 1);
        assert_eq!(supervisor.terminate_calls(), 1);
        assert_eq!(exit.exited_code(), 0);
    }

    #[test]
    fn an_attached_host_never_terminates_a_child_on_exit() {
        let supervisor = FakeSupervisor::new(FakeMode::Attached);
        let (mut controller, exit) = controller(FakeWindow::default(), supervisor.clone());

        assert_eq!(controller.exit(), 0);
        assert_eq!(supervisor.shutdown_calls(), 1);
        assert_eq!(supervisor.terminate_calls(), 0, "an attached host is detached, never killed");
        assert_eq!(exit.exited_code(), 0);
    }

    #[test]
    fn a_repeat_exit_is_ignored() {
        let supervisor = FakeSupervisor::new(FakeMode::Owned);
        let (mut controller, _exit) = controller(FakeWindow::default(), supervisor.clone());

        controller.exit();
        controller.exit();

        assert_eq!(supervisor.shutdown_calls(), 1);
    }

    #[test]
    fn a_second_instance_during_startup_is_focused_after_window_creation() {
        let window = FakeWindow::default();
        let (mut controller, _exit) =
            controller(window.clone(), FakeSupervisor::new(FakeMode::Owned));

        controller.remember_second_instance();
        assert!(!window.focused(), "focus is deferred until the window exists");

        controller.focus_pending_instance();
        assert!(window.focused(), "the remembered launch focuses the window on creation");
    }

    #[test]
    fn no_pending_instance_does_not_grab_focus() {
        let window = FakeWindow::default();
        let (mut controller, _exit) =
            controller(window.clone(), FakeSupervisor::new(FakeMode::Owned));

        controller.focus_pending_instance();

        assert!(!window.focused());
    }

    #[test]
    fn open_in_browser_uses_the_active_host_url() {
        let opener = FakeOpener::default();
        let supervisor = FakeSupervisor::new(FakeMode::Owned);
        let exit = FakeExit::default();
        let mut controller = DesktopController::new(
            Box::new(FakeWindow::default()),
            Box::new(opener.clone()),
            Box::new(supervisor),
            Box::new(exit),
            std::sync::Arc::new(std::sync::Mutex::new(crate::instance::InstanceQueue::new())),
        );

        controller.open_browser();

        let opened = opener.opened.lock().unwrap();
        assert_eq!(opened.as_slice(), ["http://127.0.0.1:3080"]);
    }

    use tauri::Url;

    #[test]
    fn navigation_allows_the_resolved_loopback_origin() {
        let url = Url::parse("http://127.0.0.1:3080/some/page").unwrap();
        assert_eq!(
            super::decide_navigation(&url, Some("http://127.0.0.1:3080")),
            super::NavigationDecision::Allow
        );
    }

    #[test]
    fn navigation_blocks_a_hostname_that_resolves_to_loopback() {
        let url = Url::parse("http://localhost:3080/").unwrap();
        assert_eq!(
            super::decide_navigation(&url, Some("http://127.0.0.1:3080")),
            super::NavigationDecision::OpenExternally(url.to_string())
        );
    }

    #[test]
    fn navigation_blocks_a_different_loopback_port() {
        let url = Url::parse("http://127.0.0.1:9999/").unwrap();
        assert_eq!(
            super::decide_navigation(&url, Some("http://127.0.0.1:3080")),
            super::NavigationDecision::OpenExternally(url.to_string())
        );
    }

    #[test]
    fn navigation_keeps_external_links_in_the_system_browser() {
        let url = Url::parse("https://example.com/docs").unwrap();
        assert_eq!(
            super::decide_navigation(&url, Some("http://127.0.0.1:3080")),
            super::NavigationDecision::OpenExternally(url.to_string())
        );
    }

    #[test]
    fn navigation_blocks_non_http_schemes() {
        let url = Url::parse("file:///c:/Windows/System32/cmd.exe").unwrap();
        assert_eq!(
            super::decide_navigation(&url, Some("http://127.0.0.1:3080")),
            super::NavigationDecision::Block
        );
    }

    #[test]
    fn navigation_allows_the_startup_error_app_asset() {
        let tauri_scheme = Url::parse("tauri://localhost/startup-error.html").unwrap();
        assert_eq!(
            super::decide_navigation(&tauri_scheme, None),
            super::NavigationDecision::Allow
        );
        let windows_scheme = Url::parse("http://tauri.localhost/startup-error.html").unwrap();
        assert_eq!(
            super::decide_navigation(&windows_scheme, None),
            super::NavigationDecision::Allow
        );
    }
}
