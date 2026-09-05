//! Rimeward: one window on https://frostdev.io/dash, and a tunnel back to
//! the server so browser wards can egress from — or run on — this machine
//! (tunnel.rs). Everything desktop-only sits under `cfg(desktop)` so the
//! mobile targets compile against the same crate later.

mod chromium;
mod commands;
mod tunnel;

use tauri::{AppHandle, Manager, RunEvent, WindowEvent};

#[cfg(desktop)]
use tauri::menu::MenuItem;

/// The tray's status line; the tunnel task rewrites it.
#[cfg(desktop)]
struct TrayStatus(MenuItem<tauri::Wry>);

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));
    let app = builder
        .invoke_handler(tauri::generate_handler![commands::ward_browser, commands::ward_touch])
        .setup(|app| {
            #[cfg(desktop)]
            setup_tray(app.handle())?;
            // The dashboard's origin is the one Chrome will let onto a ward's
            // DevTools socket — the page inside this window drives it directly.
            let origin = app
                .config()
                .app
                .windows
                .first()
                .and_then(|w| match &w.url {
                    tauri::WebviewUrl::External(u) => Some(u.origin().ascii_serialization()),
                    _ => None,
                })
                .unwrap_or_default();
            let (shared, changes) = chromium::Chromium::new(app.path().app_data_dir()?, origin);
            app.manage(shared.clone());
            app.manage(changes);
            tauri::async_runtime::spawn(chromium::reap_loop(shared));
            tauri::async_runtime::spawn(tunnel::run(app.handle().clone()));
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close = hide: the tunnel only helps while the app is alive.
            #[cfg(desktop)]
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
            #[cfg(not(desktop))]
            let _ = (window, event);
        })
        .build(tauri::generate_context!())
        .expect("error while building Rimeward");
    app.run(|app, event| match event {
        // macOS: the dock icon brings a hidden window back.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => show_main(app),
        RunEvent::Exit => {
            let shared = app.state::<chromium::Shared>().inner().clone();
            tauri::async_runtime::block_on(chromium::shutdown(&shared));
        }
        _ => {}
    });
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// The tray's status line (a no-op off desktop).
pub fn set_status(app: &AppHandle, text: &str) {
    #[cfg(desktop)]
    if let Some(t) = app.try_state::<TrayStatus>() {
        let _ = t.0.set_text(text);
    }
    #[cfg(not(desktop))]
    let _ = (app, text);
}

#[cfg(desktop)]
fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, Menu};
    use tauri::tray::TrayIconBuilder;
    use tauri_plugin_autostart::ManagerExt;

    let status = MenuItem::with_id(app, "status", "Home route: starting", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Rimeward", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "Start at login",
        true,
        app.autolaunch().is_enabled().unwrap_or(false),
        None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Quit Rimeward", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &autostart, &quit])?;
    app.manage(TrayStatus(status));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().cloned().expect("bundle icon"))
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => show_main(app),
            "autostart" => {
                let launch = app.autolaunch();
                let _ = if launch.is_enabled().unwrap_or(false) { launch.disable() } else { launch.enable() };
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .build(app)?;
    Ok(())
}
