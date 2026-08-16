//! DeepSeek Harness desktop shell entry point.
//!
//! This tray-hosted shell (Tasks 6..10) owns the Tauri builder and wires
//! discovery/supervision (Tasks 7-9) into a single `main` window and system
//! tray. After the [`HostSupervisor`] starts a host, the window loads the
//! resolved `http://127.0.0.1:<port>/` origin with a navigation policy that
//! only allows that origin (or the local startup-error page) and routes every
//! other http(s) link to the system browser, so the Host web content never
//! gains shell or filesystem capability. Closing the window hides it to the
//! tray; the tray drives Open / Open in browser / View logs / Exit. A second
//! process launch is handled by the single-instance plugin. A failed host
//! startup opens the local startup-error page (or a system message box when
//! WebView creation is impossible, e.g. the WebView2 runtime is missing), from
//! which Retry re-runs discovery only after the failed owned tree is confirmed
//! dead.

pub mod discovery;
pub mod identity;
pub mod instance;
pub mod paths;
pub mod tray;
pub mod window;

#[cfg(windows)]
pub mod host_log;

#[cfg(windows)]
pub mod supervisor;

#[cfg(windows)]
pub mod windows_job;

pub use discovery::{discover, Discovery};

#[cfg(windows)]
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg(windows)]
use crate::window::{AppExitPort, AppOpenerPort, AppSupervisorPort, AppWindowPort, OpenerPort};

/// The label of the single main webview window.
pub const MAIN_WINDOW_LABEL: &str = "main";

/// How long a startup-error Retry waits for the previously failed owned tree to
/// be confirmed dead before re-running discovery. The supervisor already
/// reclaims a failed owned tree before returning an error, so this is a
/// defensive backstop against a slow Job teardown.
#[cfg(windows)]
const RETRY_TREE_DEAD_WAIT: std::time::Duration = std::time::Duration::from_secs(5);

/// Run the desktop shell. This is Windows-only: supervision, the tray, and the
/// Host window all depend on the native Windows process and WebView pieces.
#[cfg(windows)]
pub fn run() {
    run_windows();
}

/// A non-Windows build has no host, tray, or window; report loudly rather than
/// presenting a hollow shell.
#[cfg(not(windows))]
pub fn run() {
    eprintln!("the DeepSeek Harness desktop shell is Windows-only");
}

#[cfg(windows)]
fn run_windows() {
    type SupervisorState = Arc<Mutex<supervisor::HostSupervisor>>;
    type ControllerState = Arc<Mutex<window::DesktopController>>;
    type QueueState = Arc<Mutex<instance::InstanceQueue>>;
    type OriginState = Arc<Mutex<Option<String>>>;

    // The single-instance queue is created here so the plugin callback and the
    // controller share one instance before the app state exists.
    let queue: QueueState = Arc::new(Mutex::new(instance::InstanceQueue::new()));
    let queue_for_plugin = queue.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(move |app, _argv, _cwd| {
            // A second launch only shows and focuses the first instance; it
            // carries no URL payload.
            if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
                window_focus_existing(&window);
            } else if let Ok(mut queue) = queue_for_plugin.lock() {
                // Startup still in progress: remember and focus after creation.
                queue.remember();
            }
        }))
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<ControllerState>() {
                    if let Ok(mut controller) = state.inner().lock() {
                        controller.handle_close_requested(|| api.prevent_close());
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            startup_error_reset,
            startup_error_open_logs,
            startup_error_exit
        ])
        .setup(|app| -> Result<(), Box<dyn std::error::Error>> {
            let handle = app.handle().clone();

            let paths = paths::DesktopPaths::from_environment(&handle)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })?;

            let supervisor: SupervisorState =
                Arc::new(Mutex::new(supervisor::HostSupervisor::new(paths.clone())));
            app.manage(supervisor.clone());

            let origin: OriginState = Arc::new(Mutex::new(None));
            app.manage(origin.clone());

            app.manage(queue);

            // Start the host and create the window (the live Host page, or —
            // when the host failed to start — the local startup-error page).
            let window = run_initial_startup(app, &paths, &supervisor, &origin)?;

            // Wire the shell around the window: controller, tray, and the
            // single-instance focus handoff.
            frame_shell(app, &paths, &supervisor, &origin, window)?;

            Ok(())
        })
        .build(tauri::generate_context!());

    match builder {
        Ok(app) => app.run(run_event),
        Err(error) => eprintln!("desktop shell failed to start: {error}"),
    }
}

/// Start the host and create the `main` window. On a successful host start the
/// window loads the resolved loopback origin; on a recoverable host failure it
/// loads the local startup-error page with the error text and log path. A
/// genuinely fatal WebView creation failure shows a system message box and
/// returns an error, because no window can ever be shown.
#[cfg(windows)]
fn run_initial_startup(
    app: &tauri::App,
    paths: &paths::DesktopPaths,
    supervisor: &Arc<Mutex<supervisor::HostSupervisor>>,
    origin: &Arc<Mutex<Option<String>>>,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    use crate::window::build_main_window;

    let startup = supervisor
        .lock()
        .map_err(|_| -> Box<dyn std::error::Error> { "supervisor lock poisoned".into() })?
        .start();

    match startup {
        Ok(base_url) => {
            *origin
                .lock()
                .map_err(|_| -> Box<dyn std::error::Error> { "origin lock poisoned".into() })? =
                Some(base_url.clone());
            let live = tauri::WebviewUrl::External(
                base_url
                    .parse()
                    .map_err(|error: url::ParseError| -> Box<dyn std::error::Error> {
                        format!("host base URL {base_url} is not a valid URL: {error}").into()
                    })?,
            );
            build_main_window(app, live, origin.clone(), external_opener(app)).map_err(Into::into)
        }
        Err(error) => {
            // Record the startup failure in the desktop log before showing the
            // error page: the page carries only a summary, so the log is the
            // only place the full reason survives.
            if let Ok(mut supervisor) = supervisor.lock() {
                supervisor.log_startup_error(&error);
            }
            let (title, detail) = startup_error_texts(&error, &paths.logs);
            let page = crate::window::startup_error_url(&title, &detail);
            // WebView creation may itself be impossible (e.g. the WebView2
            // runtime is missing). No window can then be shown, so surface the
            // failure with a system message box and stop.
            match build_main_window(app, page, origin.clone(), external_opener(app)) {
                Ok(window) => Ok(window),
                Err(build_error) => {
                    show_fatal_message_box(&title, &format!("{detail}\n\n{build_error}"));
                    Err("WebView creation failed".into())
                }
            }
        }
    }
}

/// Build the rest of the shell around a freshly created window: the controller,
/// the tray with its menu, and the pending single-instance focus handoff.
#[cfg(windows)]
fn frame_shell(
    app: &tauri::App,
    paths: &paths::DesktopPaths,
    supervisor: &Arc<Mutex<supervisor::HostSupervisor>>,
    _origin: &Arc<Mutex<Option<String>>>,
    window: tauri::WebviewWindow,
) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();

    let controller = window::DesktopController::new(
        Box::new(AppWindowPort::new(window.clone())),
        Box::new(AppOpenerPort::new(handle.clone())),
        Box::new(AppSupervisorPort::new(supervisor.clone())),
        Box::new(AppExitPort::new(handle.clone())),
        app.state::<Arc<Mutex<instance::InstanceQueue>>>().inner().clone(),
    );
    let controller: Arc<Mutex<window::DesktopController>> = Arc::new(Mutex::new(controller));
    app.manage(controller.clone());

    let logs_dir = paths.logs.to_string_lossy().into_owned();
    tray::setup_tray(app, &controller, logs_dir)?;

    // A second launch that arrived while startup was in progress focuses the
    // freshly created window.
    if let Ok(mut controller) = controller.lock() {
        controller.focus_pending_instance();
    }

    Ok(())
}

/// Route an app exit (tray Exit, the startup-error Exit button, a Windows
/// session end) through the supervisor's bounded shutdown. The supervisor is
/// idempotent: a second shutdown on an already-detached host is a no-op.
#[cfg(windows)]
fn run_event(app: &tauri::AppHandle, event: RunEvent) {
    if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
        if let Some(state) = app.try_state::<Arc<Mutex<supervisor::HostSupervisor>>>() {
            if let Ok(mut supervisor) = state.inner().lock() {
                if let Err(error) = supervisor.shutdown() {
                    eprintln!("bounded host shutdown failed on exit: {error}");
                }
            }
        }
    }
}

#[cfg(windows)]
fn window_focus_existing(window: &crate::window::WebviewWindow) {
    if let Err(error) = window.show() {
        eprintln!("failed to show the existing window: {error}");
    }
    if let Err(error) = window.unminimize() {
        eprintln!("failed to restore the existing window: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("failed to focus the existing window: {error}");
    }
}

/// A system-browser opener closure for the navigation-policy handler, so an
/// external link leaves the webview and opens with the default browser.
#[cfg(windows)]
fn external_opener(app: &tauri::App) -> Arc<dyn Fn(&str) + Send + Sync> {
    let port = AppOpenerPort::new(app.handle().clone());
    Arc::new(move |target: &str| {
        if let Err(error) = port.open_url(target) {
            eprintln!("failed to open external link in the browser: {error}");
        }
    })
}

/// The startup-error page summary: a short title and a detail carrying the
/// full error message and the per-user log directory.
#[cfg(windows)]
fn startup_error_texts(
    error: &supervisor::DesktopError,
    logs: &std::path::Path,
) -> (String, String) {
    (
        "DeepSeek Harness could not start the host".to_string(),
        format!("{error}\n\nLogs: {}", logs.display()),
    )
}

/// Show a blocking native message box (used only when no window can be shown,
/// because the WebView2 runtime itself is unavailable). The process stops
/// immediately after, so this modal is the last UI the user sees.
#[cfg(windows)]
fn show_fatal_message_box(title: &str, message: &str) {
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title: Vec<u16> = title.encode_utf16().chain(std::iter::once(0)).collect();
    let message: Vec<u16> = message.encode_utf16().chain(std::iter::once(0)).collect();
    let _ = unsafe {
        MessageBoxW(
            None,
            windows::core::PCWSTR(message.as_ptr()),
            windows::core::PCWSTR(title.as_ptr()),
            MB_OK | MB_ICONERROR,
        )
    };
}

/// Retry hook for the startup-error page: confirm the failed owned tree is dead,
/// re-run discovery/start, and either load the live host or refresh the error
/// page text in place. Reports the failure reason back to the page.
#[cfg(windows)]
#[tauri::command]
fn startup_error_reset(app: tauri::AppHandle) -> Result<(), String> {
    let supervisor = app
        .state::<Arc<Mutex<supervisor::HostSupervisor>>>()
        .inner()
        .clone();
    let origin = app
        .state::<Arc<Mutex<Option<String>>>>()
        .inner()
        .clone();
    let controller = app
        .state::<Arc<Mutex<window::DesktopController>>>()
        .inner()
        .clone();
    let window = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| "the main window is unavailable".to_string())?;

    // Never re-enter discovery while an exit is already underway.
    if controller.lock().map(|c| c.is_exiting()).unwrap_or(true) {
        return Ok(());
    }

    // Only re-run discovery once the previously failed owned tree is confirmed
    // dead (a failed owned start already reclaims it; wait defensively).
    if let Some(pid) = supervisor
        .lock()
        .map_err(|_| "the supervisor state is poisoned".to_string())?
        .owned_pid()
    {
        crate::windows_job::wait_until_dead(pid, RETRY_TREE_DEAD_WAIT);
    }

    // Re-run discovery and start the host once (the guard is stored so the
    // borrow-release destructor cannot outlive the Arc clone below).
    let started = supervisor
        .lock()
        .map_err(|_| "the supervisor state is poisoned".to_string())?
        .start();
    match started {
        Ok(base_url) => {
            *origin
                .lock()
                .map_err(|_| "the origin state is poisoned".to_string())? =
                Some(base_url.clone());
            let url = base_url
                .parse()
                .map_err(|error: url::ParseError| format!("invalid host URL {base_url}: {error}"))?;
            window
                .navigate(url)
                .map_err(|error| format!("failed to load the host: {error}"))
        }
        Err(error) => {
            let paths = paths::DesktopPaths::from_environment(&app)
                .map_err(|error| format!("failed to derive logs path: {error}"))?;
            let (title, detail) = startup_error_texts(&error, &paths.logs);
            refresh_error_page(&window, &title, &detail)
        }
    }
}

/// Update the already-loaded startup-error page's title and detail in place,
/// escaping both values as JSON string literals so they cannot inject markup or
/// script into the page.
#[cfg(windows)]
fn refresh_error_page(window: &tauri::WebviewWindow, title: &str, detail: &str) -> Result<(), String> {
    let title = serde_json::to_string(title).map_err(|error| error.to_string())?;
    let detail = serde_json::to_string(detail).map_err(|error| error.to_string())?;
    let script = format!(
        "(function(){{var t=document.getElementById('title'),d=document.getElementById('detail'),m=document.getElementById('messages');if(t){{t.textContent={title};}}if(d){{d.textContent={detail};}}if(m){{m.textContent='';}}}})();"
    );
    window.eval(&script).map_err(|error| error.to_string())
}

/// Open the desktop logs directory for the startup-error page. Reports the
/// failure reason to the page so it never shows a false success.
#[cfg(windows)]
#[tauri::command]
fn startup_error_open_logs(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let logs = paths::DesktopPaths::from_environment(&app)
        .map_err(|error| format!("failed to derive logs path: {error}"))?
        .logs;
    app.opener()
        .open_path(logs.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("failed to open log directory: {error}"))
}

/// Exit the desktop shell for the startup-error page. The exit flows through
/// the bounded supervisor shutdown in [`run_event`].
#[cfg(windows)]
#[tauri::command]
fn startup_error_exit(app: tauri::AppHandle) {
    app.exit(1);
}
