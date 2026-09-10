//! Tray command dispatch for the desktop shell.
//!
//! The shell shows a system-tray context menu with Open, Open in browser,
//! View logs, and Exit. Each menu item carries a stable string id; the
//! [`TrayCommand::parse`] mapping lets the menu-event handler route an id to
//! the matching [`DesktopController`] action without coupling the menu setup to
//! the controller.

use crate::window::DesktopController;

/// One distinct tray menu action.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrayCommand {
    /// Show and focus the main window.
    Open,
    /// Open the live host URL in the system browser.
    OpenBrowser,
    /// Open the desktop logs directory.
    ViewLogs,
    /// Shut the supervised host down and exit the shell.
    Exit,
}

impl TrayCommand {
    /// The stable menu-item id this command is dispatched under.
    pub const fn id(self) -> &'static str {
        match self {
            TrayCommand::Open => "open",
            TrayCommand::OpenBrowser => "browser",
            TrayCommand::ViewLogs => "logs",
            TrayCommand::Exit => "exit",
        }
    }

    /// Parse a menu-event id (`MenuEvent::id` text form) back into a command.
    /// `None` for an id this shell does not own.
    pub fn parse(id: &str) -> Option<TrayCommand> {
        match id {
            "open" => Some(TrayCommand::Open),
            "browser" => Some(TrayCommand::OpenBrowser),
            "logs" => Some(TrayCommand::ViewLogs),
            "exit" => Some(TrayCommand::Exit),
            _ => None,
        }
    }

    /// Dispatch this command to `controller`. `logs_dir` is the path ViewLogs
    /// opens; it is supplied at dispatch time because it derives from the
    /// per-user paths known only under Tauri.
    #[cfg(windows)]
    pub fn dispatch(self, controller: &mut DesktopController, logs_dir: &str) {
        match self {
            TrayCommand::Open => controller.open(),
            TrayCommand::OpenBrowser => controller.open_browser(),
            TrayCommand::ViewLogs => controller.view_logs(logs_dir),
            TrayCommand::Exit => {
                let _ = controller.exit();
            }
        }
    }
}

/// Install the system-tray icon and its context menu (Open, Open in browser,
/// View logs, Exit). Menu-event ids route through [`TrayCommand::parse`] to the
/// shared controller. `logs_dir` is captured for the View logs action; `icon`
/// is the embedded window icon.
#[cfg(windows)]
pub fn setup_tray(
    app: &tauri::App,
    controller: &std::sync::Arc<std::sync::Mutex<DesktopController>>,
    logs_dir: String,
) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let open = MenuItem::with_id(app, TrayCommand::Open.id(), "Open DeepSeek Harness", true, None::<&str>)?;
    let browser = MenuItem::with_id(app, TrayCommand::OpenBrowser.id(), "Open in browser", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, TrayCommand::ViewLogs.id(), "View logs", true, None::<&str>)?;
    let exit = MenuItem::with_id(app, TrayCommand::Exit.id(), "Exit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &browser, &logs, &exit])?;

    let controller = controller.clone();
    let mut builder = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("DeepSeek Harness")
        .show_menu_on_left_click(false)
        .on_menu_event(move |_app, event| {
            if let Some(command) = TrayCommand::parse(event.id().as_ref()) {
                let Ok(mut controller) = controller.lock() else {
                    eprintln!("tray menu event while the controller state was poisoned");
                    return;
                };
                command.dispatch(&mut controller, &logs_dir);
            }
        });
    if let Some(icon) = app.default_window_icon().cloned() {
        builder = builder.icon(icon);
    }
    builder.build(app)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::TrayCommand;

    #[test]
    fn parses_tray_command_ids() {
        assert_eq!(TrayCommand::parse("open"), Some(TrayCommand::Open));
        assert_eq!(TrayCommand::parse("browser"), Some(TrayCommand::OpenBrowser));
        assert_eq!(TrayCommand::parse("logs"), Some(TrayCommand::ViewLogs));
        assert_eq!(TrayCommand::parse("exit"), Some(TrayCommand::Exit));
        assert_eq!(TrayCommand::parse("unknown"), None);
    }

    #[test]
    fn ids_round_trip_through_parse() {
        let commands = [
            TrayCommand::Open,
            TrayCommand::OpenBrowser,
            TrayCommand::ViewLogs,
            TrayCommand::Exit,
        ];
        for command in commands {
            assert_eq!(TrayCommand::parse(command.id()), Some(command));
        }
    }
}
