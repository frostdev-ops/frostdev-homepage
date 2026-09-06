//! Supervise the bundled backend. Secrets cross anonymous pipes, never argv or files.
use base64::Engine;
use std::{process::Stdio, sync::Arc};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, Command},
    sync::Mutex,
};

pub struct Runtime(pub Arc<Mutex<Option<Child>>>);
#[derive(Default)]
pub struct Workspace(pub Mutex<Option<(url::Url, String)>>);

/// Fixed loopback destination; the native token never reaches page JavaScript.
pub async fn workspace_request(
    app: &AppHandle,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let (origin, token) = app
        .state::<Workspace>()
        .0
        .lock()
        .await
        .clone()
        .ok_or("Local workspace is starting")?;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(25))
        .build()
        .map_err(|_| "Local connection failed")?;
    let endpoint = origin
        .join(if body.is_some() {
            "/api/dev/navigate"
        } else {
            "/api/dev/navigation"
        })
        .map_err(|_| "Invalid local address")?;
    let mut request = if let Some(body) = body {
        client
            .post(endpoint)
            .header("content-type", "application/json")
            .body(body.to_string())
    } else {
        client.get(endpoint)
    };
    request = request.header("x-rimeward-native-token", token);
    let response = request
        .send()
        .await
        .map_err(|_| "Local workspace is unavailable")?;
    let status = response.status();
    let value: serde_json::Value = serde_json::from_str(
        &response
            .text()
            .await
            .map_err(|_| "Local workspace disconnected")?,
    )
    .map_err(|_| "Invalid workspace response")?;
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .unwrap_or("Workspace request failed")
            .to_string());
    }
    Ok(value)
}
pub async fn local_url(app: &AppHandle, path: &str) -> Result<url::Url, String> {
    let state = app.state::<Workspace>();
    let workspace = state.0.lock().await;
    let (origin, _) = workspace.as_ref().ok_or("Local workspace is starting")?;
    origin
        .join(path)
        .map_err(|_| "Invalid local destination".to_string())
}

fn vault(service: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(service, "device-pairings")
}
fn encryption_key(service: &str) -> Result<String, Box<dyn std::error::Error + Send + Sync>> {
    let entry = keyring::Entry::new(service, "encryption-key")?;
    match entry.get_password() {
        Ok(key) => Ok(key),
        Err(keyring::Error::NoEntry) => {
            let mut bytes = [0u8; 32];
            getrandom::fill(&mut bytes).map_err(|e| std::io::Error::other(e.to_string()))?;
            let key = base64::engine::general_purpose::STANDARD.encode(bytes);
            entry.set_password(&key)?;
            Ok(key)
        }
        Err(e) => Err(e.into()),
    }
}
pub async fn launch(app: AppHandle) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let resources = app.path().resource_dir()?.join("runtime");
    let data = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data)?;
    let executable = std::env::current_exe()?;
    let node = executable
        .parent()
        .ok_or("missing executable directory")?
        .join(if cfg!(windows) {
            "rimeward-node.exe"
        } else {
            "rimeward-node"
        });
    let service = app.config().identifier.clone();
    let key = encryption_key(&service)?;
    // Keep loopback OAuth redirect URIs stable across application restarts.
    let port_file = data.join("runtime-port");
    let port = std::fs::read_to_string(&port_file)
        .ok()
        .and_then(|s| s.trim().parse::<u16>().ok())
        .filter(|p| *p > 0);
    let port = match port {
        Some(port) => port,
        None => {
            let socket = std::net::TcpListener::bind(("127.0.0.1", 0))?;
            let port = socket.local_addr()?.port();
            std::fs::write(port_file, port.to_string())?;
            port
        }
    };
    let mut command = Command::new(node);
    command
        .arg(resources.join("app/desktop-runtime.mjs"))
        .current_dir(resources.join("app"));
    command.env_clear();
    for name in [
        "HOME",
        "USERPROFILE",
        "USER",
        "USERNAME",
        "LOGNAME",
        "SHELL",
        "PATH",
        "PATHEXT",
        "SystemRoot",
        "SYSTEMROOT",
        "COMSPEC",
        "WINDIR",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "PROGRAMFILES(X86)",
        "TMP",
        "TEMP",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSH_AUTH_SOCK",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "DBUS_SESSION_BUS_ADDRESS",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn()?;
    let mut stdin = child.stdin.take().ok_or("missing runtime stdin")?;
    let stdout = child.stdout.take().ok_or("missing runtime stdout")?;
    let initial = serde_json::json!({"port":port,"key":key,"data":data.join("data"),"browsers":resources.join("browsers")});
    stdin.write_all(format!("{}\n", initial).as_bytes()).await?;
    // Keep stdin with the child so explicit exit can request graceful shutdown.
    child.stdin = Some(stdin);
    let state = app.state::<Runtime>().0.clone();
    *state.lock().await = Some(child);
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        let Ok(message) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        match message["type"].as_str() {
            Some("ready") => {
                if let Some(url) = message["url"].as_str() {
                    let bootstrap = url::Url::parse(url)?;
                    let token = bootstrap
                        .query_pairs()
                        .find(|(key, _)| key == "token")
                        .map(|(_, value)| value.into_owned())
                        .ok_or("Missing local credential")?;
                    let origin = bootstrap.join("/")?;
                    app.add_capability(
                        tauri::ipc::CapabilityBuilder::new("local-workspace")
                            .window("main")
                            .local(false)
                            .remote(format!("{}/*", origin.origin().ascii_serialization()))
                            .permission("allow-workspace-navigation")
                            .permission("allow-open-workspace"),
                    )?;
                    *app.state::<Workspace>().0.lock().await = Some((origin, token));
                    if let Some(window) = app.get_webview_window("main") {
                        window.navigate(bootstrap)?;
                    }
                    super::set_status(&app, "Local runtime running");
                }
            }
            Some("vault") => {
                let result = vault(&service).and_then(|v| {
                    if message["op"] == "set" {
                        v.set_password(message["value"].as_str().unwrap_or("[]"))
                            .map(|_| "[]".to_string())
                    } else {
                        match v.get_password() {
                            Err(keyring::Error::NoEntry) => Ok("[]".into()),
                            r => r,
                        }
                    }
                });
                let reply = match result {
                    Ok(value) => serde_json::json!({"id":message["id"],"value":value}),
                    Err(_) => serde_json::json!({"id":message["id"],"error":true}),
                };
                if let Some(child) = state.lock().await.as_mut() {
                    if let Some(input) = child.stdin.as_mut() {
                        input.write_all(format!("{}\n", reply).as_bytes()).await?;
                    }
                }
            }
            Some("desktop") => {
                let result = desktop_request(&app, &message).await;
                let reply = match result {
                    Ok(value) => serde_json::json!({"id":message["id"],"value":value}),
                    Err(error) => serde_json::json!({"id":message["id"],"error":error}),
                };
                if let Some(child) = state.lock().await.as_mut() {
                    if let Some(input) = child.stdin.as_mut() {
                        input.write_all(format!("{}\n", reply).as_bytes()).await?;
                    }
                }
            }
            _ => {}
        }
    }
    super::set_status(&app, "Local runtime stopped; reopen Rimeward to recover");
    Ok(())
}
async fn desktop_request(
    app: &AppHandle,
    message: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use tauri_plugin_dialog::DialogExt;
    use tauri_plugin_opener::OpenerExt;
    let value = &message["value"];
    match message["op"].as_str() {
        Some("local") => {
            let path = value["path"].as_str().ok_or("Missing local destination")?;
            if !(path == "/desktop/start?setup=1"
                || path == "/dash"
                || path.starts_with("/dash#p="))
            {
                return Err("Invalid local destination".into());
            }
            let url = local_url(app, path).await?;
            app.get_webview_window("main")
                .ok_or("Desktop window is unavailable")?
                .navigate(url)
                .map_err(|_| "Could not open workspace")?;
            Ok(serde_json::json!(true))
        }
        Some("folder") => {
            let app = app.clone();
            let selected = tauri::async_runtime::spawn_blocking(move || {
                app.dialog().file().blocking_pick_folder()
            })
            .await
            .map_err(|_| "Folder picker failed")?;
            Ok(serde_json::json!(selected.map(|p| p.to_string())))
        }
        Some("open-url") | Some("server") => {
            let url = url::Url::parse(value["url"].as_str().unwrap_or(""))
                .map_err(|_| "Invalid server address")?;
            if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
                return Err("Use an HTTPS Rimeward server".into());
            }
            if message["op"] == "open-url" {
                app.opener()
                    .open_url(url.as_str(), None::<&str>)
                    .map_err(|_| "Could not open your browser")?;
            } else {
                let window = app
                    .get_webview_window("main")
                    .ok_or("Desktop window is unavailable")?;
                let session = value["session"]
                    .as_str()
                    .ok_or("Server did not return a session")?;
                if session.len() > 200 {
                    return Err("Invalid server session".into());
                }
                let cookie = tauri::webview::Cookie::build(("rimeward_session", session))
                    .domain(url.host_str().ok_or("Invalid server")?)
                    .path("/")
                    .http_only(true)
                    .secure(true)
                    .build();
                window
                    .set_cookie(cookie)
                    .map_err(|_| "Could not sign in to the desktop window")?;
                let device = value["device"].as_str().ok_or("Missing paired device")?;
                crate::tunnel::start(app, url.clone(), session.to_string(), device.to_string())
                    .await?;
                window
                    .navigate(url)
                    .map_err(|_| "Could not open the server dashboard")?;
            }
            Ok(serde_json::json!(true))
        }
        _ => Err("Unknown desktop action".into()),
    }
}
pub async fn shutdown(app: &AppHandle) {
    let state = app.state::<Runtime>().0.clone();
    let child = state.lock().await.take();
    if let Some(mut child) = child {
        if let Some(input) = child.stdin.as_mut() {
            let _ = input.write_all(b"{\"type\":\"shutdown\"}\n").await;
        }
        if tokio::time::timeout(std::time::Duration::from_secs(40), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
}
