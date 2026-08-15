//! DeepSeek Harness desktop shell entry point.
//!
//! This tray-hosted shell (Task 6..10) owns the Tauri builder and the local
//! startup-error page. Task 6 installs only the opener and single-instance
//! plugins and registers the error-page commands; window creation and host
//! supervision land in later tasks.

pub mod paths;

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
                let _ = window.set_focus();
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

/// Open the desktop logs directory for the startup-error page.
#[tauri::command]
fn startup_error_open_logs(app: tauri::AppHandle) {
    let logs = match paths::DesktopPaths::from_environment(&app) {
        Ok(paths) => paths.logs,
        Err(error) => {
            eprintln!("failed to derive logs path: {error}");
            return;
        }
    };
    if let Err(error) = app.opener().open_path(logs.to_string_lossy().into_owned(), None::<&str>) {
        eprintln!("failed to open log directory: {error}");
    }
}

/// Exit the desktop shell for the startup-error page.
#[tauri::command]
fn startup_error_exit(app: tauri::AppHandle) {
    app.exit(1);
}
