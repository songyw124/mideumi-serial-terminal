// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(target_os = "macos")]
mod macos_menu;
mod serial;

#[tauri::command]
fn set_menu_state(
    app: tauri::AppHandle,
    connected: bool,
    busy: bool,
    saving: bool,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    macos_menu::set_state(&app, connected, busy, saving).map_err(|e| e.to_string())?;
    #[cfg(not(target_os = "macos"))]
    let _ = (app, connected, busy, saving);
    Ok(())
}

// Synchronous Tauri commands run on the UI thread, as required by AppKit.
#[tauri::command]
fn activate_menu_action(app: tauri::AppHandle, action: String) -> Result<bool, String> {
    #[cfg(target_os = "macos")]
    {
        macos_menu::activate(&app, &action).map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, action);
        Ok(false)
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Remembers window size/position/monitor between runs
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|_app| {
            #[cfg(target_os = "macos")]
            macos_menu::configure(_app)?;
            Ok(())
        })
        .manage(serial::SerialState::default())
        .invoke_handler(tauri::generate_handler![
            set_menu_state,
            activate_menu_action,
            serial::list_ports,
            serial::connect,
            serial::disconnect,
            serial::send,
            serial::save_text,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
