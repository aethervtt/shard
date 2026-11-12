# 0111 — Desktop shells (Tauri and Electron exports)

- **Status:** accepted
- **Packages:** `apps/cli`, `@aethervtt/shard-platform-tauri`,
  `@aethervtt/shard-platform-electron` (new)
- **Depends on:** 0064, 0110

## Context

0110 exports a game as static web files that read through `buildFs`. A desktop game is that
build in a webview, with two differences: assets come from the app's own files instead of a web
server, and saves belong in the app's data folder, not the webview's IndexedDB, which a webview
reset clears and Steam Cloud can't sync. This spec adds `--target tauri` and `--target electron`
as thin shells around the 0110 web build.

## Goals

- `shard export --target tauri|electron` writes a project that the shell's own tools build and
  run, with the web export inside, packed by default (0110).
- Assets served over a `shard://` custom protocol with `Range` support, so `buildFs` reads packs
  as it does on the web.
- Saves and settings in files under the app's data folder.

## Non-goals

- Installers, code signing, notarization, store uploads. Signing settings in `export.app` pass
  through to the shell's config untouched.
- Cross-compiling. Each OS builds its own; CI uses a matrix.
- Mobile (Tauri mobile follows separately, M9).
- A listen server in Electron's main process. Players host through 0091's in-page host over a
  lobby, as on the web.

## Design

### Tauri

`src-tauri/` (`tauri.conf.json` from `export.app`, `main.rs`) and the web export in `dist/`.
`main.rs` registers a `shard://` URI scheme that serves the resources folder with `Range`
support. The page boots as on the web (0110's `startExport`), with
`createWebPlatform({ baseUrl: 'shard://localhost/' })`, and swaps `storage` for `platform-tauri`'s
file storage in the app data folder. `--build` runs `tauri build` when the Tauri CLI and Rust are
on the path, and fails with `export/missing-tool` naming them otherwise.

The webview is the OS's, so the render tier depends on the OS: WebView2 on Windows is Chromium,
WKWebView has WebGPU on the macOS versions a game supports, and WebKitGTK on Linux runs the
WebGL2 tier (0064). A Mac whose WKWebView lacks WebGPU takes the WebGL2 tier through the same
probe, so the shell needs nothing per version. Implementation records the tier each OS ran
here.

### Electron

`main.mjs`, `preload.mjs`, a `package.json`, and the web export. `main.mjs` serves `shard://`
with `protocol.handle` (Range included) and runs the window with `contextIsolation` on.
`@aethervtt/shard-platform-electron` (only a `platform-*` package may import `electron`) provides
file storage over IPC for the page and the main-process handlers. Chromium ships with the app, so
WebGPU is the same on every OS, Linux included. `--build` runs `@electron/packager` when it's
installed.

### Multiplayer

A desktop shell has no origin to default a server URL to (0110, "Multiplayer clients"). A
multiplayer project needs `export.net.url` (or `export.net.lobby`). Without one, the export fails
with `export/net-url-missing`. `config.json` ships inside the app and can still be edited before
packaging.

### Agent surface

`shard export --target tauri|electron --json` reports as 0110 does. Errors: `export/missing-tool`,
`export/net-url-missing`.

## Decisions

- **The shells wrap the web build.** One boot and one test path, plus a small native template per
  shell. The difference between shells is the renderer, not the game.
- **Tauri first.** `platform-tauri` and Studio already exist, and Tauri builds are a fraction of
  Electron's size. Electron is the answer when a game needs the full tier on Linux.
- **`@electron/packager`, not `electron-builder`.** Installers are a non-goal; packager makes the
  app folder that a game's own `electron-builder` config can take from there.
- **File storage, not the webview's.** Saves survive a webview reset, and cloud sync works on a
  folder.

## Acceptance criteria

- [ ] The `shard://` handlers (Rust and Electron) answer whole-file and `Range` requests in their
      tests.
- [ ] The generated Tauri project passes `cargo check` in CI on macOS and Windows.
- [ ] A multiplayer project without `export.net.url` fails with `export/net-url-missing`.
- [ ] Checked by hand: star-explorer runs from the Tauri build on macOS, Windows and Linux, and
      from the Electron build on one OS. A save survives a restart in both.

## Open questions

None.
