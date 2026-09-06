//! What the dashboard page inside this app may ask of it — the commands
//! an approved server's runtime capability exposes. The page uses
//! them to drive a ward's local Chromium directly (scripts/app/browser-cdp.ts),
//! so frames and input never leave this machine.

use serde::Serialize;
use tauri::State;

use crate::chromium::{self, Shared};

#[derive(Serialize)]
pub struct WardBrowser {
    /// The browser websocket, on this machine, for the page to speak CDP to.
    ws: String,
    platform: &'static str,
}

/// The ward's local Chromium, launched if needed. Rejects with the reason
/// ("downloading 42%") while the browser is not ready yet.
#[tauri::command]
pub async fn ward_browser(
    ward: String,
    window: tauri::WebviewWindow,
    shared: State<'_, Shared>,
) -> Result<WardBrowser, String> {
    if !chromium::allows_origin(&shared, &window.url().map_err(|e| e.to_string())?).await {
        return Err("This server is not the active browser route".into());
    }
    let (port, path) = chromium::acquire(&shared, &ward).await?;
    // The page's own socket is not a counted user (it cannot say goodbye
    // reliably); ward_touch keeps the instance off the reaper's list instead.
    chromium::release(&shared, &ward).await;
    Ok(WardBrowser {
        ws: format!("ws://127.0.0.1:{port}{path}"),
        platform: crate::tunnel::platform(),
    })
}

/// The page is still on it — resets the ward instance's idle clock.
#[tauri::command]
pub async fn ward_touch(
    ward: String,
    window: tauri::WebviewWindow,
    shared: State<'_, Shared>,
) -> Result<(), String> {
    if !chromium::allows_origin(&shared, &window.url().map_err(|e| e.to_string())?).await {
        return Err("This server is not the active browser route".into());
    }
    chromium::touch(&shared, &ward).await;
    Ok(())
}
