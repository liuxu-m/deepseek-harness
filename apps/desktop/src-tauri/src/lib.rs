//! DeepSeek Harness desktop shell entry point.
//!
//! This tray-hosted shell (Task 6..10) owns the Tauri builder and the local
//! startup-error page. Task 6 installs only the opener and single-instance
//! plugins and registers the error-page commands; window creation and host
//! supervision land in later tasks.

pub mod discovery;
pub mod identity;
pub mod paths;

#[cfg(windows)]
pub mod windows_job;

pub use discovery::{discover, Discovery};

use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

/// Run the desktop shell. Installs opener and single-instance plugins and the
/// startup-error page commands, then enters the Tauri event loop.
pub fn run() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch focuses the existing window instead of spawning
            // another process. The window appears in a later task.
            if let Some(window) = app.get_webview_window("main") {
                if let Err(error) = window.set_focus() {
                    eprintln!("failed to focus the existing window: {error}");
                }
            }
        }))
        .invoke_handler(tauri::generate_handler![
            startup_error_reset,
            startup_error_open_logs,
            startup_error_exit
        ])
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!("desktop shell failed to start: {error}");
    }
}

/// Retry hook for the startup-error page. Task 6 owns no supervisor or window,
/// so this is a no-op shell; discovery/supervision lands in Tasks 7-10.
#[tauri::command]
fn startup_error_reset(_app: tauri::AppHandle) {}

/// Open the desktop logs directory for the startup-error page. Reports the
/// failure reason to the page so it never shows a false success.
#[tauri::command]
fn startup_error_open_logs(app: tauri::AppHandle) -> Result<(), String> {
    let logs = paths::DesktopPaths::from_environment(&app)
        .map_err(|error| format!("failed to derive logs path: {error}"))?
        .logs;
    app.opener()
        .open_path(logs.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|error| format!("failed to open log directory: {error}"))
}

/// Exit the desktop shell for the startup-error page.
#[tauri::command]
fn startup_error_exit(app: tauri::AppHandle) {
    app.exit(1);
}
