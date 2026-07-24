mod apt;
mod recorder;

use recorder::RecorderState;
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(RecorderState::default())
        .invoke_handler(tauri::generate_handler![
            recorder::start_recording,
            recorder::stop_recording
        ])
        .on_window_event(|window, event| {
            // Release the SDR if the user closes the window mid-pass.
            if matches!(event, tauri::WindowEvent::Destroyed) {
                recorder::abort_on_exit(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
