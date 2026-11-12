//! The game server as a sidecar (0111): started under the launch contract (SHARD_DIR, PORT, HOST,
//! SHARD_DATA, `--json`), ready when it prints its JSON line, stopped with SIGTERM so it stores
//! every connected player first, and by its stdin closing if this app dies without stopping it.

use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

/// What a server prints once it accepts players.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ready {
    /// The game's WebSocket.
    pub url: String,
    /// Its HTTP side (health, a page, an API).
    pub http: Option<String>,
}

/// The ready line among a server's output lines: the first JSON object with a `url`.
pub fn ready_line(line: &str) -> Option<Ready> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    serde_json::from_str::<Ready>(line).ok()
}

/// Where Tauri puts an `externalBin` sidecar: beside the app's executable, without the target
/// triple it was built with (`tauri dev` copies it there too).
pub fn sidecar_path(name: &str) -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("the app's executable has no folder")?;
    Ok(dir.join(format!("{name}{}", std::env::consts::EXE_SUFFIX)))
}

pub struct Launch<'a> {
    pub program: &'a Path,
    /// SHARD_DIR: the game's data (the app's resources/game).
    pub data: &'a Path,
    /// SHARD_DATA: player saves.
    pub saves: &'a Path,
    /// HOST: 127.0.0.1 for this machine, 0.0.0.0 to let the LAN join.
    pub host: &'a str,
    pub timeout: Duration,
}

/// Starts the server and waits for its ready line. Its output keeps draining afterwards, so a
/// chatty server never blocks on a full pipe.
pub fn start(launch: Launch<'_>) -> Result<(Child, Ready), String> {
    let mut child = Command::new(launch.program)
        .arg("--json")
        .env("SHARD_DIR", launch.data)
        .env("SHARD_DATA", launch.saves)
        .env("PORT", "0")
        .env("HOST", launch.host)
        // The watchdog: the server stops when its stdin closes, which the OS does when this app
        // dies, cleanly or not, so a crashed app never leaves its server running.
        .env("SHARD_SIDECAR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("couldn't start {}: {e}", launch.program.display()))?;
    let stdout = child.stdout.take().ok_or("no stdout")?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut sent = false;
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if !sent && let Some(ready) = ready_line(&line) {
                let _ = tx.send(ready);
                sent = true;
            }
        }
    });
    match rx.recv_timeout(launch.timeout) {
        Ok(ready) => Ok((child, ready)),
        Err(_) => {
            let _ = child.kill();
            Err(format!(
                "{} didn't print its ready line within {:?}",
                launch.program.display(),
                launch.timeout
            ))
        }
    }
}

/// SIGTERM (the server stores its players and exits), then a kill if it hasn't within `grace`.
/// Windows has no SIGTERM for a child: it's terminated.
pub fn stop(mut child: Child, grace: Duration) {
    #[cfg(unix)]
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let deadline = std::time::Instant::now() + grace;
    while std::time::Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_ready_line_among_others() {
        assert_eq!(ready_line("Serving coin-rush…"), None);
        assert_eq!(ready_line("{\"no\":1}"), None);
        assert_eq!(
            ready_line(
                r#"{"url":"ws://127.0.0.1:7000/net","http":"http://127.0.0.1:7000","port":7000}"#
            ),
            Some(Ready {
                url: "ws://127.0.0.1:7000/net".into(),
                http: Some("http://127.0.0.1:7000".into()),
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn starts_a_server_waits_for_it_and_stops_it_with_sigterm() {
        // A stand-in server: prints its ready line, then waits; SIGTERM ends it with 0.
        let dir = std::env::temp_dir().join(format!("shard-plugin-server-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("server.sh");
        std::fs::write(
            &script,
            "#!/bin/sh\ntrap 'exit 0' TERM\necho starting\necho \"{\\\"url\\\":\\\"ws://$HOST:1/net\\\",\\\"dir\\\":\\\"$SHARD_DIR\\\"}\"\nwhile true; do sleep 0.05; done\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::os::unix::fs::PermissionsExt::from_mode(0o755))
            .unwrap();
        let (child, ready) = start(Launch {
            program: &script,
            data: &dir,
            saves: &dir,
            host: "127.0.0.1",
            timeout: Duration::from_secs(10),
        })
        .unwrap();
        assert_eq!(ready.url, "ws://127.0.0.1:1/net");
        let pid = child.id();
        stop(child, Duration::from_secs(5));
        assert_ne!(
            unsafe { libc::kill(pid as libc::pid_t, 0) },
            0,
            "the server is gone"
        );
    }
}
