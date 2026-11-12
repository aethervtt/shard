# 0111 — Desktop shells (Tauri and Electron), with the game server as a sidecar

- **Status:** accepted (revised: the developer owns the shell)
- **Packages:** `apps/cli`, `@aethervtt/shard-platform-tauri`, `@aethervtt/shard-platform-electron`
  (new), `@aethervtt/shard-node`, `crates/tauri-plugin-shard` (new)
- **Depends on:** 0064, 0090, 0091, 0092, 0110

## Context

0110 exports a game as a page plus data (`build.json` and packs) read through `buildFs`, and a
multiplayer game's dedicated server as `server.mjs`. A desktop game is the page in a webview, with
three differences: data comes from the app's own files instead of a web server, saves belong in
the app's data folder (not the webview's IndexedDB, which a webview reset clears and Steam Cloud
can't sync), and a game may want its server on the player's machine: to host a match for friends
on the LAN, or to play offline against the server's logic.

A shipped game's shell isn't Shard's to generate each time. Its `src-tauri/` holds the developer's
bundle identifier, icons and signing, window settings, capabilities, their own Rust commands,
plugins (Steamworks, an updater, deep links) and sidecars. Projects already shaped like this build
their sidecars with a script into `src-tauri/binaries/<name>-<triple>`, name them in
`externalBin`, and don't commit the binaries (lumtake). So Shard owns what an export produces and
the glue the game needs at run time; the developer owns the app around it.

Real multiplayer projects don't run `shard server` either. yugioh, my-hotel and risen each have an
`apps/server` of their own on `Bun.serve`: the game headless as the authority, from source
(`loadHeadlessCode({ code: 'source' })`), next to their API (collections, auth, Postgres). A
desktop sidecar may be that server, so the sidecar is a contract any server can meet, and those
servers need a way to open the game from an export instead of from source.

## Goals

- **The developer owns `src-tauri/`.** `shard export --target tauri --init` scaffolds one when it's
  missing; after that, no export writes there except the sidecar binary, into `binaries/`.
- **`tauri-plugin-shard`**, one line in the app (`.plugin(tauri_plugin_shard::init())`): the
  `shard://` protocol serving the game's data with `Range` from the app's resources, file storage
  in the app data folder, and starting and stopping the game server sidecar.
- **Two output folders**, which the app's `tauri.conf.json` points at once: the page
  (`frontendDist`, small, compiled into the binary) and the data (`bundle.resources`, on disk,
  read by range).
- **The game server as a sidecar**: `--sidecar` compiles a server with Bun into
  `src-tauri/binaries/<name>-<triple>`. The server is the generated one (0110) or the project's
  own (`export.server.entry`); either meets one launch contract.
- **Custom servers open exports**: `openExportGame` in `@aethervtt/shard-node/serve` gives a
  project's own server the game's authority from an export, as `loadHeadlessCode` does from
  source.
- **Electron gets the same split**: the developer owns the main process; Shard ships helpers.

## Non-goals

- Installers, code signing, notarization, store uploads: the developer's `tauri.conf.json` and the
  platform's own tools.
- Cross-compiling the app. Each OS builds its own (CI uses a matrix); the sidecar is compiled for
  the host's triple, matching the app built beside it.
- Mobile (Tauri mobile follows separately, M9).
- Desktop-only game code (a module only the desktop build imports, to call the developer's own
  commands). It needs its own design across web, server and desktop entries; until then, game code
  that calls Tauri APIs breaks that game's web export.

## Design

### Command

```sh
shard export --target tauri [--init] [--sidecar] [--app src-tauri] [--out dist/tauri] [--json]
shard export --target server --compile         # the server alone, as one executable (a Linux VM)
shard export --target electron [--init] [--sidecar] [--out dist/electron] [--json]
```

```jsonc
// shard.json
"export": {
  "app": { "title": "Coin Rush", "id": "com.example.coinrush" },   // --init's identifier
  "tauri": { "app": "src-tauri" },                 // the app's folder: ../desktop/src-tauri in a monorepo
  "server": { "entry": "../server/src/main.ts" },  // a custom server for --sidecar (else server.mjs)
  "net": { "url": "local" }                        // this build's own server (below); or wss://…, a lobby
}
```

### Tauri: what each side owns

```
dist/tauri/                      written by every export, never edited
  page/                          → "frontendDist": index.html, the code chunks (0110 web)
  data/                          → "bundle.resources" as game/: build.json, packs, loose
                                    WebGL2 translations and shader bake; server.json (sidecar)
src-tauri/                       the developer's; --init scaffolds it once
  binaries/<name>-<triple>       written by --sidecar (not committed, as lumtake does)
  Cargo.toml                     tauri-plugin-shard = "<engine version>"
  tauri.conf.json                frontendDist, resources, externalBin pointing at the above
  src/lib.rs                     .plugin(tauri_plugin_shard::init())
```

- The data is packed by default (`export.pack: auto` packs everything but the web): a few files
  beside the binary, read by range. Nothing gets `.br`/`.gz` copies.
- The app's folder is `export.tauri.app` (default `src-tauri`, from the project), or `--app`.
- `--init` writes it only when it doesn't exist (`apps/cli/src/tauri.ts`): `Cargo.toml` (tauri,
  tauri-plugin-shard by path inside this repository and by git tag `v<engine>` outside it, and
  serde/serde_json, which `generate_context!` uses; a `[workspace]` of its own so it builds inside
  a monorepo), `build.rs`, `src/main.rs` and `src/lib.rs` (the plugin registered), a
  `tauri.conf.json` from `export.app` and the manifest's window (`frontendDist`, `resources`
  mapping the data to `game/`, and with `--sidecar` `externalBin` and `plugins.shard.server`), a
  capability granting `core:default` and `shard:default`, a placeholder icon and a `.gitignore`.
- Every export checks the app and never edits it (`export/tauri-mismatch`, naming what's off):
  `frontendDist` and the resources mapping point at the export, `Cargo.toml` depends on
  `tauri-plugin-shard` at this engine's version (outside this repository), `src/` registers it,
  and with `--sidecar` the `externalBin` entry and `plugins.shard.server` name the server.
- `--build` is left out on purpose: the developer runs `tauri build` (or their `bun run bundle`),
  as for any Tauri app.

### `tauri-plugin-shard` (`crates/tauri-plugin-shard`)

- **`shard://`**: serves `<resource_dir>/game/` with `Range` (206, 416), never outside it
  (`..`, encoded characters), with CORS headers so the page's origin can read it. Answered on a
  thread of its own, so a whole-pack read never blocks the app. On Windows and Android Tauri
  serves custom schemes at `http://shard.localhost/`; the `base` command gives the page the right
  one, so it never guesses per OS.
- **Storage**: `storage_read` (raw bytes back), `storage_write` (raw bytes, the key in a
  `shard-key` header; a temp file, then a rename), `storage_list`, `storage_delete`, under
  `<app_data_dir>/storage/`.
- **Sidecar**: `server_start` starts the server named by `plugins.shard.server` from beside the
  app's executable (where Tauri puts `externalBin`, in `tauri dev` too), under the launch
  contract with `SHARD_DIR` = the resources' `game/`, `SHARD_DATA` = `<app_data_dir>/server/` and
  `HOST` = `plugins.shard.host` (default 127.0.0.1; 0.0.0.0 lets the LAN join), waits up to 30 s
  for its ready line, and returns `{ url, http }`; a second call returns the running one.
  `server_stop` and the app's exit send SIGTERM (Windows: terminate). It spawns with
  `std::process` rather than `tauri-plugin-shell`, whose kill can't send SIGTERM.
- Settings: `"plugins": { "shard": { "server": "coin-rush-server", "host": "127.0.0.1" } }`. The
  commands' permissions are generated (`build.rs`); `shard:default` grants all of them.

It's a Rust crate (`crates/tauri-plugin-shard`, in the repository's Cargo workspace) versioned with
the engine. Its pure parts (responses, storage, the ready line, starting and stopping) are tested
without a Tauri runtime.

### The page in a shell: `platform-tauri`'s game mode

`createTauriGamePlatform()` reads through `buildFs` over the web file system at the plugin's
`shard://` base (so packs read by range as on the web, 0110), with the plugin's storage, and
`localServer` when a sidecar is bundled:

```ts
interface LocalServer {
  /** Starts the game's server on this machine; resolves when it accepts players. */
  start(): Promise<{ url: string; http: string }>
  stop(): Promise<void>
}
// Platform gains: readonly localServer?: LocalServer
```

`--target tauri` generates the page's entry like 0110's web entry, fetching `build.json` from the
plugin's base and creating `createTauriGamePlatform` (`@aethervtt/shard-platform-tauri/game`, a
subpath, so a game never loads Studio's file-system plugin) in place of `createWebPlatform`, which
gained `storage` and `localServer` options for shells. Only `platform-tauri` imports
`@tauri-apps/*`. `openBuild` reads a desktop export's split layout, so `shard run --build
dist/tauri` and the shader bake work on it as on the web.

The webview is the OS's, so the render tier depends on the OS: WebView2 on Windows is Chromium,
WKWebView has WebGPU on the macOS versions a game supports, and WebKitGTK on Linux runs the
WebGL2 tier (0064). A Mac whose WKWebView lacks WebGPU takes the WebGL2 tier through the same
probe. Implementation records the tier each OS ran here.

### Multiplayer in a shell

A shell has no origin to fall back to (0110 probes its own `/healthz`). The page joins, in order:
query parameters (for testing), then `config.json`'s `net`:

- `"url": "local"`: this build's own server. In an app, `platform.localServer.start()`, then join
  its `url` (a player hosting a LAN match is this; friends join with the host's address). On the
  web, the server that serves the page (0110's `/healthz` probe), so one setting fits a game's
  web and desktop exports.
- `"url": "wss://…"`: a remote server, as on the web.
- `"lobby"`: peer-to-peer rooms (0091), as on the web.

Game code can also call `platform.localServer` itself (a "Host game" button). A multiplayer
project with none of these, or with `"local"` and no `--sidecar`, fails `--target tauri` with
`export/net-url-missing`.

### The sidecar

`--sidecar` exports the server (0110) into a temporary folder, puts its manifest beside the page's
data as `server.json` (the same packs, so no other file), and compiles a server with Bun for the
host's target (the triple from `rustc -vV`, or the usual one for this OS and CPU, mapped to Bun's
`bun-<os>-<arch>`) into `<app>/binaries/<project>-server-<triple>`. Without an app folder it fails
with `export/no-tauri-app` (`--init`); without Bun, `export/missing-tool`.

Bun embeds only files imported `with { type: "file" }`, and the engine names its WASM with
`new URL('./x.wasm', import.meta.url)`, which in a compiled executable points nowhere. The CLI's
`bun/compile.mjs` (shipped with it) runs `Bun.build({ compile })` with a plugin that turns every
such URL to an existing non-code file into an embedded import, in the server's code and the
engine's alike, so a custom server compiled from source and `node_modules` works too.
`--target server --compile` uses the same compiler for a server on its own: the executable finds
its data beside itself.

**The launch contract** (what the plugin, Electron's helper and any host rely on):

- The server reads its data from `SHARD_DIR` (or `--dir`; `server.json` there when present, else
  `build.json`), listens on `PORT` (0 picks a free port) and `HOST`, and keeps saves in
  `SHARD_DATA`.
- Started with `--json`, it prints one JSON line on stdout when it accepts players:
  `{ "url": "ws://…", "http": "…" }`.
- SIGTERM stops it after storing players, and it exits 0.
- With `SHARD_SIDECAR` set (the host started it, with a pipe on its stdin), it also stops that way
  when its stdin closes: the OS closes the pipe when the app dies, cleanly or not, so a crashed or
  force-quit app never leaves its server running. Checked with `kill -9` on the app.

0110's `serverMain` meets it: `--dir`/`SHARD_DIR` name the data, and inside a compiled executable,
where `import.meta.url` is virtual, it defaults to the executable's own folder. A custom server
meets it with `openExportGame`:

```ts
// @aethervtt/shard-node/serve
/** The game's authority from an export (0110): what loadHeadlessCode is from source. */
export async function openExportGame(options: {
  dir: string                          // SHARD_DIR
  project: Plugin
  plugins: readonly EnginePlugin[]     // a custom server passes enginePlugins (every definition)
  dataDir?: string                     // SHARD_DATA
  configure?(app: App): void | Promise<void>   // add netPlugin with the server's own transport
}): Promise<{ app: App; build: BuildJson; close(): Promise<void> }>
```

`plugins` is required so a generated `server.mjs`, which passes only its page's rows, never
bundles the rest. The app comes back initialized and running on `intervalRunner`; `close` stores
the players and waits for it. `apps/cli/fixtures/custom-server` is such a server, shaped like
risen's: its own `Bun.serve` API beside the game.

A server like risen's switches on `SHARD_DIR`: from the export when it's set, from source in dev.
`serveExport` becomes `openExportGame` plus its HTTP server, so both paths share one boot.

### Electron

The developer owns the main process too. `@aethervtt/shard-platform-electron` provides, for main,
`registerShardProtocol(session, dataDir)` (`protocol.handle`, Range included), storage handlers
over IPC, and `localServer` handlers spawning the sidecar under the same contract (as a child
process: Electron has no `externalBin`); for the page, a preload exposing them, and
`createElectronGamePlatform()`. `--init` scaffolds `main.mjs`, `preload.mjs` and a `package.json`
once. Chromium ships with the app, so WebGPU is the same on every OS, Linux included.

### Agent surface

- `shard export --target tauri|electron --json` reports as 0110 does, plus what `--init` wrote,
  the sidecar binary and its size, and the shell checks' warnings.
- Errors: `export/missing-tool` (Bun), `export/compile-failed`, `export/no-tauri-app`,
  `export/net-url-missing`; warning `export/tauri-mismatch`.

## Decisions

- **The developer owns the shell.** Every real app customizes it; an export that regenerates it
  would clobber that, or keep the app from being customized at all.
- **Shard's run-time side is a Tauri plugin.** One line to add, versioned with the engine, and it
  carries the protocol, storage and sidecar code that would otherwise be pasted into each app.
- **Page in the binary, data beside it.** `frontendDist` is compiled into the executable; a game's
  data can be hundreds of megabytes, which belongs in resources read by range.
- **One contract for every server.** The generated server and a project's own are interchangeable
  sidecars, so a game with its own API doesn't have to give it up to ship a desktop host.
- **Bun compiles the sidecar.** The projects already run their servers on Bun, and `bun build
  --compile` makes one binary per target with nothing to install (about 75 MB, Bun included).
- **A watchdog on stdin, not only SIGTERM.** A clean exit can stop the server; a crash can't. The
  pipe closing is the one signal every way of dying sends.
- **"local" means this build's server everywhere.** The sidecar in an app, the page's own server on
  the web: one `export.net` for both exports of a game.
- **`"url": "local"` in configuration, `localServer` in code.** Hosting is a deployment choice for
  a LAN game, and a menu choice for one with a "Host" button; both use the same start.
- **File storage, not the webview's.** Saves survive a webview reset, and cloud sync works on a
  folder.
- **Tauri first.** `platform-tauri` and Studio exist, and Tauri apps are a fraction of Electron's
  size. Electron is the answer when a game needs the full tier on Linux.

## Acceptance criteria

Tauri, checked by `apps/cli/src/export.test.ts`, `cargo test -p tauri-plugin-shard`, and CI's
desktop job (macOS, Windows: the plugin's tests, then coin-rush exported with `--init --sidecar`
and `cargo check`ed). By hand on macOS: coin-rush's app built with `tauri build --debug`, launched,
started its sidecar, drew the player and the coins from it; a second client joined that server
(two players); `kill -9` on the app stopped the server.

- [x] `shard export --target tauri --init` scaffolds the app; a second export leaves it
      byte-identical while rewriting `dist/tauri/` (maze-chase, `--app` in a temporary folder).
- [x] An export warns `export/tauri-mismatch` when `frontendDist` drifts, and changes nothing in
      the app.
- [x] `cargo test -p tauri-plugin-shard`: `shard://` answers whole-file and `Range` requests, 416
      for an impossible range, 204 to a preflight, nothing outside `game/`; storage round-trips
      through a temp file; a stand-in server is started, awaited and stopped with SIGTERM.
- [ ] The scaffolded project passes `cargo check` in CI on macOS and Windows (the job exists; it
      passed locally on macOS).
- [x] `--target server --compile` makes coin-rush's server one executable that, run from another
      folder, prints the ready line, takes a client, and stops when its stdin closes
      (`SHARD_SIDECAR`).
- [x] A custom server fixture (shaped like risen's: its own `Bun.serve` beside `openExportGame`)
      compiled from source meets the same contract: its API answers, a client joins, SIGTERM
      exits 0.
- [x] A multiplayer project set to `"local"` without `--sidecar` fails `--target tauri` with
      `export/net-url-missing`.
- [ ] Checked by hand on Windows and Linux; a save surviving a restart; a LAN client on another
      machine. macOS done as above.

Electron:

- [ ] `platform-electron`, `--target electron`, `--init`: not built yet.

## Open questions

None open. Deferred: desktop-only game code (Non-goals), and publishing `tauri-plugin-shard` to
crates.io (until then, a git or path dependency at the engine's tag).
