// Prevent a console window from attaching to the GUI subsystem in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    deepseek_harness_desktop_lib::run();
}
