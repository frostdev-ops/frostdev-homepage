//! The tunnel's app side. One websocket to `<origin>/api/tunnel`,
//! authenticated with the session cookie read out of the webview; the
//! server opens streams over it and this side dials them at home.
//! Frames: [u32 BE stream id][u8 op][payload] — src/lib/tunnel.ts is the
//! other half, byte for byte.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{lookup_host, TcpStream};
use tokio::sync::mpsc;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

use crate::chromium::{self, Changes, Shared};

pub const OPEN: u8 = 1;
pub const OPENED: u8 = 2;
pub const DATA: u8 = 3;
pub const CLOSE: u8 = 4;
pub const STATUS: u8 = 5;
pub const HELLO: u8 = 6;

const COOKIE: &str = "frost_session";
const CHUNK: usize = 64 * 1024;
const CONNECT_MS: u64 = 20_000;

type Ws = WebSocketStream<MaybeTlsStream<TcpStream>>;

pub fn frame(id: u32, op: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + payload.len());
    v.extend_from_slice(&id.to_be_bytes());
    v.push(op);
    v.extend_from_slice(payload);
    v
}

pub fn parse(buf: &[u8]) -> Option<(u32, u8, &[u8])> {
    if buf.len() < 5 {
        return None;
    }
    Some((u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]), buf[4], &buf[5..]))
}

/// The server's own table (src/lib/net-guard.ts), so what home resolves a
/// name to is vetted the same way the VPS vets what it resolves to.
pub fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(a == 0
                || a == 10
                || a == 127
                || (a == 172 && (16..=31).contains(&b))
                || (a == 192 && b == 168)
                || (a == 169 && b == 254)
                || (a == 100 && (64..=127).contains(&b)))
        }
        IpAddr::V6(v6) => {
            if let Some(m) = v6.to_ipv4_mapped() {
                return is_public(IpAddr::V4(m));
            }
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_unique_local() || v6.is_unicast_link_local())
        }
    }
}

pub(crate) fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

enum Fail {
    Http(u16),
    Other(String),
}

/// Forever: find the window, read the cookie, hold a session, back off, again.
pub async fn run(app: AppHandle) {
    let mut backoff = 5;
    loop {
        let (page, cookie) = match credentials(&app) {
            Ok(c) => c,
            Err(Wait::Window) => {
                sleep(Duration::from_secs(2)).await;
                continue;
            }
            Err(Wait::Cookie) => {
                crate::set_status(&app, "Home route: sign in to connect");
                sleep(Duration::from_secs(10)).await;
                continue;
            }
        };
        let wait = match session(&app, &page, &cookie).await {
            Ok(()) => {
                backoff = 5;
                crate::set_status(&app, "Home route: reconnecting");
                5
            }
            Err(Fail::Http(401)) => {
                crate::set_status(&app, "Home route: sign in to connect");
                30
            }
            Err(Fail::Http(409)) => {
                crate::set_status(&app, "Home route: connected from another computer");
                60
            }
            Err(Fail::Http(code)) => {
                crate::set_status(&app, &format!("Home route: server said {code}"));
                backoff = (backoff * 2).min(60);
                backoff
            }
            Err(Fail::Other(e)) => {
                eprintln!("[tunnel] {e}");
                crate::set_status(&app, "Home route: offline");
                backoff = (backoff * 2).min(60);
                backoff
            }
        };
        sleep(Duration::from_secs(wait)).await;
    }
}

enum Wait {
    Window,
    Cookie,
}

/// The page's URL is the one source of truth (tauri.dev.conf.json only swaps
/// the window URL, and everything else follows), and its cookie jar holds
/// the session — HttpOnly included, which is the point of asking the webview.
fn credentials(app: &AppHandle) -> Result<(url::Url, String), Wait> {
    let w = app.get_webview_window("main").ok_or(Wait::Window)?;
    let url = w.url().map_err(|_| Wait::Window)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(Wait::Window);
    }
    let cookies = w.cookies_for_url(url.clone()).map_err(|_| Wait::Cookie)?;
    let cookie = cookies
        .iter()
        .find(|c| c.name() == COOKIE)
        .map(|c| c.value().to_string())
        .ok_or(Wait::Cookie)?;
    Ok((url, cookie))
}

async fn session(app: &AppHandle, page: &url::Url, cookie: &str) -> Result<(), Fail> {
    let mut ws_url = page.clone();
    let _ = ws_url.set_scheme(if page.scheme() == "https" { "wss" } else { "ws" });
    ws_url.set_path("/api/tunnel");
    ws_url.set_query(None);
    ws_url.set_fragment(None);
    let mut req = ws_url
        .as_str()
        .into_client_request()
        .map_err(|e| Fail::Other(e.to_string()))?;
    req.headers_mut().insert(
        "cookie",
        format!("{COOKIE}={cookie}")
            .parse()
            .map_err(|_| Fail::Other("bad cookie".into()))?,
    );
    let (ws, _) = connect_async(req).await.map_err(|e| match e {
        WsError::Http(resp) => Fail::Http(resp.status().as_u16()),
        e => Fail::Other(e.to_string()),
    })?;
    crate::set_status(app, "Home route: connected");

    // One writer owns the sink; every stream task and the reader send through
    // it. The reader may block on a full stream channel without ever
    // deadlocking the writer, which is why the halves are split.
    let (sink, stream) = ws.split();
    let (tx, rx) = mpsc::channel::<Vec<u8>>(32);
    let writer = tokio::spawn(write_loop(sink, rx));
    let shared = app.state::<Shared>().inner().clone();
    let status = tokio::spawn(status_loop(shared.clone(), app.state::<Changes>().0.clone(), tx.clone()));
    let result = read_loop(stream, &tx, &shared).await;
    status.abort();
    drop(tx);
    let _ = writer.await;
    result
}

/// STATUS now, and again on every Chromium state change (download progress,
/// ready, failed) — what the ward shows while it waits.
async fn status_loop(shared: Shared, mut changes: tokio::sync::watch::Receiver<u64>, tx: mpsc::Sender<Vec<u8>>) {
    loop {
        let json = shared.lock().await.status_json(platform());
        if tx.send(frame(0, STATUS, json.as_bytes())).await.is_err() {
            return;
        }
        if changes.changed().await.is_err() {
            return;
        }
    }
}

async fn write_loop(mut sink: SplitSink<Ws, Message>, mut rx: mpsc::Receiver<Vec<u8>>) {
    // The flush tick is what gets the auto-pongs out even while nothing else
    // is being written; the server drops us after two silent pings.
    let mut tick = tokio::time::interval(Duration::from_secs(10));
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                Some(b) => {
                    if sink.send(Message::Binary(b.into())).await.is_err() {
                        return;
                    }
                }
                None => {
                    let _ = sink.close().await;
                    return;
                }
            },
            _ = tick.tick() => {
                if sink.flush().await.is_err() {
                    return;
                }
            }
        }
    }
}

async fn read_loop(mut stream: SplitStream<Ws>, tx: &mpsc::Sender<Vec<u8>>, shared: &Shared) -> Result<(), Fail> {
    let mut streams: HashMap<u32, mpsc::Sender<Vec<u8>>> = HashMap::new();
    while let Some(msg) = stream.next().await {
        match msg {
            Ok(Message::Binary(b)) => {
                let Some((id, op, payload)) = parse(&b) else { continue };
                match op {
                    OPEN => {
                        streams.retain(|_, s| !s.is_closed());
                        let (stx, srx) = mpsc::channel::<Vec<u8>>(32);
                        streams.insert(id, stx);
                        tokio::spawn(stream_task(id, String::from_utf8_lossy(payload).into_owned(), srx, tx.clone(), shared.clone()));
                    }
                    DATA => {
                        if let Some(s) = streams.get(&id) {
                            if s.send(payload.to_vec()).await.is_err() {
                                streams.remove(&id);
                            }
                        }
                    }
                    // Dropping the sender is the close: the task's recv ends, the socket drops.
                    CLOSE => {
                        streams.remove(&id);
                    }
                    HELLO => {
                        #[derive(serde::Deserialize)]
                        struct Hello {
                            chromium: chromium::Spec,
                        }
                        if let Ok(h) = serde_json::from_slice::<Hello>(payload) {
                            chromium::set_spec(shared, h.chromium).await;
                        }
                    }
                    _ => {}
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(e) => return Err(Fail::Other(e.to_string())),
        }
    }
    Ok(())
}

/// One TCP connection at home for one stream id, until either end hangs up.
async fn stream_task(id: u32, target: String, mut rx: mpsc::Receiver<Vec<u8>>, tx: mpsc::Sender<Vec<u8>>, shared: Shared) {
    let ward = target.strip_prefix("cdp:").map(str::to_string);
    let (tcp, opened) = match dial(&target, &shared).await {
        Ok(t) => t,
        Err(e) => {
            let _ = tx.send(frame(id, CLOSE, e.as_bytes())).await;
            return;
        }
    };
    if tx.send(frame(id, OPENED, opened.as_bytes())).await.is_err() {
        if let Some(w) = &ward {
            chromium::release(&shared, w).await;
        }
        return;
    }
    let (mut rd, mut wr) = tcp.into_split();
    let mut buf = vec![0u8; CHUNK];
    loop {
        tokio::select! {
            n = rd.read(&mut buf) => match n {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(frame(id, DATA, &buf[..n])).await.is_err() {
                        return;
                    }
                }
            },
            m = rx.recv() => match m {
                Some(b) => {
                    if wr.write_all(&b).await.is_err() {
                        break;
                    }
                }
                None => return,
            }
        }
    }
    let _ = tx.send(frame(id, CLOSE, b"")).await;
    if let Some(w) = &ward {
        chromium::release(&shared, w).await;
    }
}

/// `cdp:<ward>` is the one loopback dial this app ever makes — the DevTools
/// port of a Chromium it launched itself, answered with the browser websocket
/// path. `host:port` resolves here, refuses anything private, connects.
async fn dial(target: &str, shared: &Shared) -> Result<(TcpStream, String), String> {
    if let Some(ward) = target.strip_prefix("cdp:") {
        let (port, ws_path) = chromium::acquire(shared, ward).await?;
        return match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(tcp) => Ok((tcp, ws_path)),
            Err(e) => {
                chromium::release(shared, ward).await;
                Err(format!("Chromium: {e}"))
            }
        };
    }
    let (host, port) = target.rsplit_once(':').ok_or_else(|| "bad target".to_string())?;
    let host = host.trim_matches(|c| c == '[' || c == ']');
    let port: u16 = port.parse().map_err(|_| "bad port".to_string())?;
    if host.is_empty() || port == 0 {
        return Err("bad target".into());
    }
    let addrs: Vec<SocketAddr> = lookup_host((host, port))
        .await
        .map_err(|e| format!("{host} did not resolve: {e}"))?
        .collect();
    if addrs.is_empty() {
        return Err(format!("{host} did not resolve"));
    }
    for a in &addrs {
        if !is_public(a.ip()) {
            return Err(format!("refused: {host} resolves to the private address {}", a.ip()));
        }
    }
    let tcp = tokio::time::timeout(Duration::from_millis(CONNECT_MS), TcpStream::connect(&addrs[..]))
        .await
        .map_err(|_| format!("{host}:{port} timed out"))?
        .map_err(|e| format!("{host}:{port}: {e}"))?;
    Ok((tcp, String::new()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_round_trip() {
        let f = frame(0xdead_beef, DATA, &[1, 2, 3]);
        assert_eq!(f.len(), 8);
        let (id, op, payload) = parse(&f).unwrap();
        assert_eq!((id, op, payload), (0xdead_beef, DATA, &[1u8, 2, 3][..]));
        assert!(parse(&[1, 2, 3, 4]).is_none());
        assert_eq!(parse(&frame(7, OPENED, b"")).unwrap().2.len(), 0);
    }

    #[test]
    fn private_ranges_are_not_public() {
        for s in [
            "0.0.0.0", "10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
            "100.64.0.1", "100.127.255.255", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "::ffff:192.168.0.1",
        ] {
            assert!(!is_public(s.parse().unwrap()), "{s}");
        }
        for s in ["1.1.1.1", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700::1111", "::ffff:8.8.8.8"] {
            assert!(is_public(s.parse().unwrap()), "{s}");
        }
    }
}
