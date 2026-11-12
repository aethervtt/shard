//! The game's files: `shard://` responses over its data folder (with byte ranges), and saves as
//! files. Plain functions over paths, so they're tested without a Tauri runtime.

use std::fs::{self, File};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Component, Path, PathBuf};

/// A path under `root` for a request or storage key, or None when it would leave `root` (`..`,
/// an absolute path, an encoded character).
fn inside(root: &Path, relative: &str) -> Option<PathBuf> {
    let relative = relative.trim_start_matches('/');
    if relative.contains('%') || relative.contains('\\') {
        return None;
    }
    let mut out = root.to_path_buf();
    for part in Path::new(relative).components() {
        match part {
            Component::Normal(p) => out.push(p),
            _ => return None,
        }
    }
    Some(out)
}

fn content_type(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "ktx2" => "image/ktx2",
        _ => "application/octet-stream",
    }
}

/// `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes: the first and last byte,
/// or None when it asks for nothing the file has.
fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    let (from, to) = spec.split_once('-')?;
    let (start, end) = match (from.trim(), to.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (size.saturating_sub(n), size.checked_sub(1)?)
        }
        (a, "") => (a.parse().ok()?, size.checked_sub(1)?),
        (a, b) => (
            a.parse().ok()?,
            b.parse::<u64>().ok()?.min(size.checked_sub(1)?),
        ),
    };
    (start <= end && start < size).then_some((start, end))
}

/// Every response allows the page's origin, which differs from `shard://`'s, to read it by range.
fn base() -> tauri::http::response::Builder {
    tauri::http::Response::builder()
        .header("Access-Control-Allow-Origin", "*")
        .header("Access-Control-Allow-Headers", "Range")
        .header("Access-Control-Allow-Methods", "GET, HEAD")
        .header(
            "Access-Control-Expose-Headers",
            "Content-Range, Content-Length, Accept-Ranges",
        )
}

fn empty(code: u16) -> tauri::http::Response<Vec<u8>> {
    base().status(code).body(Vec::new()).unwrap()
}

/// The response to a `shard://` request for `path` (the URL's path) under `root`: the file, a
/// range of it (206), 416 for a range it doesn't have, 404 for anything else.
pub fn respond(
    root: &Path,
    method: &str,
    path: &str,
    range: Option<&str>,
) -> tauri::http::Response<Vec<u8>> {
    if method == "OPTIONS" {
        return empty(204);
    }
    let Some(file) = inside(root, path).filter(|p| p.is_file()) else {
        return empty(404);
    };
    let Ok(size) = fs::metadata(&file).map(|m| m.len()) else {
        return empty(404);
    };
    let builder = base()
        .header("Content-Type", content_type(&file))
        .header("Accept-Ranges", "bytes");
    let (start, end, code) = match range {
        None => (0, size.saturating_sub(1), 200),
        Some(header) => match parse_range(header, size) {
            Some((start, end)) => (start, end, 206),
            None => {
                return builder
                    .status(416)
                    .header("Content-Range", format!("bytes */{size}"))
                    .body(Vec::new())
                    .unwrap();
            }
        },
    };
    let length = if size == 0 { 0 } else { end - start + 1 };
    let builder = builder.status(code).header("Content-Length", length);
    let builder = if code == 206 {
        builder.header("Content-Range", format!("bytes {start}-{end}/{size}"))
    } else {
        builder
    };
    if method == "HEAD" {
        return builder.body(Vec::new()).unwrap();
    }
    let mut body = vec![0; length as usize];
    let read = File::open(&file).and_then(|mut f| {
        f.seek(SeekFrom::Start(start))?;
        f.read_exact(&mut body)
    });
    match read {
        Ok(()) => builder.body(body).unwrap(),
        Err(_) => empty(500),
    }
}

/// Saves and settings as files under `dir`, keyed by relative path (`saves/slot1.json`).
pub mod storage {
    use super::*;

    fn path(dir: &Path, key: &str) -> Result<PathBuf, String> {
        inside(dir, key)
            .filter(|_| !key.is_empty())
            .ok_or_else(|| format!("bad storage key {key:?}"))
    }

    pub fn read(dir: &Path, key: &str) -> Result<Option<Vec<u8>>, String> {
        let file = path(dir, key)?;
        match fs::read(&file) {
            Ok(bytes) => Ok(Some(bytes)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Whole or not at all: a temp file, then a rename over the old one.
    pub fn write(dir: &Path, key: &str, bytes: &[u8]) -> Result<(), String> {
        let file = path(dir, key)?;
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = file.with_extension("tmp");
        fs::write(&temp, bytes).map_err(|e| e.to_string())?;
        fs::rename(&temp, &file).map_err(|e| e.to_string())
    }

    pub fn delete(dir: &Path, key: &str) -> Result<(), String> {
        match fs::remove_file(path(dir, key)?) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        }
    }

    /// Keys starting with `prefix`, sorted, without temp files.
    pub fn list(dir: &Path, prefix: &str) -> Result<Vec<String>, String> {
        fn walk(dir: &Path, key: &str, out: &mut Vec<String>) {
            let Ok(entries) = fs::read_dir(dir) else {
                return;
            };
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let child = if key.is_empty() {
                    name.clone()
                } else {
                    format!("{key}/{name}")
                };
                if entry.path().is_dir() {
                    walk(&entry.path(), &child, out);
                } else if !name.ends_with(".tmp") {
                    out.push(child);
                }
            }
        }
        let mut out = Vec::new();
        walk(dir, "", &mut out);
        out.retain(|k| k.starts_with(prefix));
        out.sort();
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("shard-plugin-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn serves_whole_files_and_ranges_and_nothing_outside() {
        let root = temp_dir("serve");
        fs::create_dir_all(root.join("f")).unwrap();
        fs::write(root.join("f/pack.shardpak"), b"0123456789").unwrap();
        fs::write(root.join("build.json"), b"{}").unwrap();
        fs::write(
            root.parent().unwrap().join("shard-plugin-secret.txt"),
            b"secret",
        )
        .unwrap();

        let whole = respond(&root, "GET", "/build.json", None);
        assert_eq!(whole.status(), 200);
        assert_eq!(whole.body(), b"{}");
        assert_eq!(whole.headers()["Access-Control-Allow-Origin"], "*");

        let part = respond(&root, "GET", "/f/pack.shardpak", Some("bytes=2-4"));
        assert_eq!(part.status(), 206);
        assert_eq!(part.body(), b"234");
        assert_eq!(part.headers()["Content-Range"], "bytes 2-4/10");
        assert_eq!(
            respond(&root, "GET", "/f/pack.shardpak", Some("bytes=-3")).body(),
            b"789"
        );
        assert_eq!(
            respond(&root, "GET", "/f/pack.shardpak", Some("bytes=7-")).body(),
            b"789"
        );
        assert_eq!(
            respond(&root, "GET", "/f/pack.shardpak", Some("bytes=20-30")).status(),
            416
        );

        assert_eq!(
            respond(&root, "GET", "/../shard-plugin-secret.txt", None).status(),
            404
        );
        assert_eq!(
            respond(&root, "GET", "/%2e%2e/shard-plugin-secret.txt", None).status(),
            404
        );
        assert_eq!(respond(&root, "GET", "/missing.json", None).status(), 404);
        assert_eq!(respond(&root, "OPTIONS", "/build.json", None).status(), 204);
    }

    #[test]
    fn storage_round_trips_through_a_temp_file() {
        let dir = temp_dir("storage");
        assert_eq!(storage::read(&dir, "saves/slot1.json").unwrap(), None);
        storage::write(&dir, "saves/slot1.json", b"{\"hp\":3}").unwrap();
        storage::write(&dir, "settings.json", b"{}").unwrap();
        assert_eq!(
            storage::read(&dir, "saves/slot1.json").unwrap().unwrap(),
            b"{\"hp\":3}"
        );
        assert!(!dir.join("saves/slot1.tmp").exists());
        assert_eq!(
            storage::list(&dir, "saves/").unwrap(),
            vec!["saves/slot1.json"]
        );
        assert_eq!(
            storage::list(&dir, "").unwrap(),
            vec!["saves/slot1.json", "settings.json"]
        );
        storage::delete(&dir, "saves/slot1.json").unwrap();
        storage::delete(&dir, "saves/slot1.json").unwrap();
        assert_eq!(storage::read(&dir, "saves/slot1.json").unwrap(), None);
        assert!(storage::write(&dir, "../escape.json", b"x").is_err());
    }
}
