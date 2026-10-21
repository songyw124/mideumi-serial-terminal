// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod serial;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remembers window size/position/monitor between runs
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(serial::SerialState::default())
        .invoke_handler(tauri::generate_handler![
            serial::list_ports,
            serial::connect,
            serial::disconnect,
            serial::send,
            serial::save_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
