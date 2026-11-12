//! Shard games in Tauri apps (spec 0111). One line in the app, `.plugin(tauri_plugin_shard::init())`:
//!
//! - `shard://` serves the game's data (`<resources>/game`, what `shard export --target tauri`
//!   writes to `dist/tauri/data`) with byte ranges, which its packs are read by;
//! - saves and settings are files in the app data folder;
//! - the game server, bundled as an `externalBin` sidecar, starts and stops on the page's request
//!   (and stops with the app).
//!
//! Settings come from `tauri.conf.json`: `"plugins": { "shard": { "server": "coin-rush-server" } }`.

mod files;
mod server;

pub use files::respond;
pub use server::{Ready, ready_line};

use serde::Deserialize;
use std::path::PathBuf;
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::plugin::{Builder, TauriPlugin};
use tauri::{AppHandle, Manager, RunEvent, Runtime, State};

/// `plugins.shard` in `tauri.conf.json`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The sidecar's name in `bundle.externalBin` (without its folder and triple):
    /// `coin-rush-server`. Without it, `server_start` fails.
    pub server: Option<String>,
    /// Where the server listens: 127.0.0.1 (default) for this machine, 0.0.0.0 to let the LAN
    /// join a match the player hosts.
    pub host: Option<String>,
}

struct Shard {
    config: Config,
    server: Mutex<Option<(Child, server::Ready)>>,
}

fn data_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("game"))
}

fn storage_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("storage"))
}

/// The page's base URL for the game's data: `shard://localhost/`, or on Windows and Android, where
/// custom schemes are served over http, `http://shard.localhost/`.
#[tauri::command]
fn base() -> &'static str {
    if cfg!(any(windows, target_os = "android")) {
        "http://shard.localhost/"
    } else {
        "shard://localhost/"
    }
}

/// A stored value's bytes, raw; an error when there's none (the page reads that as undefined).
#[tauri::command]
fn storage_read<R: Runtime>(app: AppHandle<R>, key: String) -> Result<Response, String> {
    match files::storage::read(&storage_dir(&app)?, &key)? {
        Some(bytes) => Ok(Response::new(bytes)),
        None => Err("not-found".into()),
    }
}

/// Raw bytes in the body, the key in the `shard-key` header.
#[tauri::command]
fn storage_write<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<(), String> {
    let key = request
        .headers()
        .get("shard-key")
        .and_then(|v| v.to_str().ok())
        .ok_or("no shard-key header")?;
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("storage_write takes raw bytes".into());
    };
    files::storage::write(&storage_dir(&app)?, key, bytes)
}

#[tauri::command]
fn storage_list<R: Runtime>(app: AppHandle<R>, prefix: String) -> Result<Vec<String>, String> {
    files::storage::list(&storage_dir(&app)?, &prefix)
}

#[tauri::command]
fn storage_delete<R: Runtime>(app: AppHandle<R>, key: String) -> Result<(), String> {
    files::storage::delete(&storage_dir(&app)?, &key)
}

/// Starts the game server sidecar (once: a second call returns the running one) and resolves when
/// it accepts players.
#[tauri::command]
async fn server_start<R: Runtime>(
    app: AppHandle<R>,
    shard: State<'_, Shard>,
) -> Result<server::Ready, String> {
    if let Some((_, ready)) = shard.server.lock().unwrap().as_ref() {
        return Ok(ready.clone());
    }
    let name = shard.config.server.as_deref().ok_or(
        "no game server: set plugins.shard.server in tauri.conf.json to the sidecar's name",
    )?;
    let program = server::sidecar_path(name)?;
    let data = data_dir(&app)?;
    let saves = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("server");
    let host = shard
        .config
        .host
        .clone()
        .unwrap_or_else(|| "127.0.0.1".into());
    let (child, ready) = tauri::async_runtime::spawn_blocking(move || {
        server::start(server::Launch {
            program: &program,
            data: &data,
            saves: &saves,
            host: &host,
            timeout: Duration::from_secs(30),
        })
    })
    .await
    .map_err(|e| e.to_string())??;
    let mut running = shard.server.lock().unwrap();
    if let Some((_, existing)) = running.as_ref() {
        // Another call started one meanwhile: keep that one.
        let existing = existing.clone();
        drop(running);
        server::stop(child, Duration::from_secs(5));
        return Ok(existing);
    }
    *running = Some((child, ready.clone()));
    Ok(ready)
}

/// Stops the game server, which stores every connected player first.
#[tauri::command]
async fn server_stop(shard: State<'_, Shard>) -> Result<(), String> {
    let running = shard.server.lock().unwrap().take();
    if let Some((child, _)) = running {
        tauri::async_runtime::spawn_blocking(move || server::stop(child, Duration::from_secs(10)))
            .await
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// The plugin, configured from `plugins.shard` in `tauri.conf.json`.
pub fn init<R: Runtime>() -> TauriPlugin<R, Option<Config>> {
    Builder::<R, Option<Config>>::new("shard")
        .invoke_handler(tauri::generate_handler![
            base,
            storage_read,
            storage_write,
            storage_list,
            storage_delete,
            server_start,
            server_stop
        ])
        .register_asynchronous_uri_scheme_protocol("shard", |ctx, request, responder| {
            let root = data_dir(ctx.app_handle());
            std::thread::spawn(move || {
                let response = match root {
                    Ok(root) => {
                        let range = request
                            .headers()
                            .get("range")
                            .and_then(|v| v.to_str().ok())
                            .map(str::to_owned);
                        files::respond(
                            &root,
                            request.method().as_str(),
                            request.uri().path(),
                            range.as_deref(),
                        )
                    }
                    Err(_) => tauri::http::Response::builder()
                        .status(500)
                        .body(Vec::new())
                        .unwrap(),
                };
                responder.respond(response);
            });
        })
        .setup(|app, api| {
            let config = api.config().as_ref().map(|c| Config {
                server: c.server.clone(),
                host: c.host.clone(),
            });
            app.manage(Shard {
                config: config.unwrap_or_default(),
                server: Mutex::new(None),
            });
            Ok(())
        })
        .on_event(|app, event| {
            if let RunEvent::Exit = event
                && let Some((child, _)) = app.state::<Shard>().server.lock().unwrap().take()
            {
                server::stop(child, Duration::from_secs(10));
            }
        })
        .build()
}
