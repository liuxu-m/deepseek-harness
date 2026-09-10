//! Android remote client shell.
//!
//! The Android target deliberately owns no DSH Host process. It starts a local
//! setup page that navigates the WebView to a user-supplied computer URL, so the
//! phone remains a client and all agent, filesystem, and shell capabilities stay
//! on the remote machine.

use crate::MAIN_WINDOW_LABEL;

/// Run the Android client shell and open the remote-URL setup page.
#[tauri::mobile_entry_point]
pub fn run() {
    let app = tauri::Builder::default()
        .setup(|app| {
            tauri::WebviewWindowBuilder::new(
                app,
                MAIN_WINDOW_LABEL,
                tauri::WebviewUrl::App("mobile-client.html".into()),
            )
            .title("DeepSeek Harness")
            .on_navigation(|url| url.scheme() == "https" || url.host_str() == Some("tauri.localhost"))
            .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Android client shell");

    app.run(|_, _| {});
}
