# 0110 — Export (web builds, asset packs, server builds)

- **Status:** accepted
- **Packages:** `apps/cli`, `@aethervtt/shard-node`, `@aethervtt/shard-project`,
  `@aethervtt/shard-core`, `@aethervtt/shard-platform`, `@aethervtt/shard-platform-web`,
  `@aethervtt/shard-procgen`, `@aethervtt/shard-net-websocket`, `bench/size`
- **Depends on:** 0009, 0014, 0056, 0064, 0071, 0072, 0086, 0090, 0091, 0092, 0093

## Context

A Shard game only runs through the CLI. `shard dev` serves the project folder through Vite, bundles
the project with the engine left external and stitched together by an import map, and keeps the
protocol hub, capture hooks and hot reload in the page. `shard server` runs the project from
source. Nothing produces files you can upload to itch.io, wrap in a desktop app, or deploy to a VM.

Most of the runtime is already there. The web platform is a read-only file system over `fetch`
with `readRange`. On hosts that can't list files, the asset server reads `.shard/catalog.json`, and
every artifact is a content-hashed file under `.shard/cache`. Shader variants can be baked (0056),
WebGL2 translations too (0064), and `buildApp({ display: false })` runs a project with no GPU
(0092). An export bakes all of that ahead of time, keeps what the game can reach, and puts it next
to a production bundle. One web build then runs everywhere: static hosting, a desktop webview, or
behind the game's own server.

## Goals

- `shard export --target web|server`, with settings in `shard.json` under `export`. Desktop
  shells (`tauri`, `electron`) wrap the same web build and follow in 0111.
- **web**: plain static files any host serves, with content-hashed names and brotli and gzip
  pre-compressed copies. It runs with no server-side code.
- **server**: a Node bundle that runs with `node server.mjs` and nothing else installed. It runs
  the project's dedicated server (0092), and can also serve a web export on the same port.
- **Asset packs**: `--pack` puts assets in `.shardpak` files read by range, for desktop, server,
  and hosts with file-count limits.
- An export proves itself: run headless, it prints the same world hash as the source project.

## Non-goals

- Desktop shells (0111) and mobile.
- Protecting assets. A pack is a container, not encryption.
- Matchmaking, fleets, autoscaling. The server export is one process; orchestration is the
  game's.
- Streaming. Region bundles for 0072's cells, 0071's terrain pages by HTTP `Range`, and 0073's
  proxies get their own spec. The pack format allows several packs per build for them. So do the
  server's extras for streaming: one response for everything entering range, and terrain pages by
  key. The client never requires those extras; it falls back to plain files when the server
  doesn't advertise them.

## Design

### Command and settings

```sh
shard export --target web [--out dist/web] [--pack] [--sourcemap] [--dry-run] [--json]
shard export --target server [--static]       # --static: also export web into public/
```

```jsonc
// shard.json
"export": {
  "include": ["assets/levels/**"],       // project files only computed paths reach
  "exclude": ["assets/dev/**"],
  "bakeFrames": 60,                      // frames each scene settles for the shader bake; 0 skips it
  "app": { "title": "Star Explorer" },   // the page title; 0111 adds id and icon
  "pack": false,                         // stage 3. Default per target: web false, server true
  "net": { "url": "wss://play.example.com/net", "lobby": "wss://lobby.example.com" }  // stage 2
}
```

Globs: `**` crosses folders, `*` and `?` stay in one.

Its schema is part of `manifestJsonSchema()`, so `shard validate` checks it and `shard docs`
writes it out.

### Pipeline

1. **Prepare.** Import (with stale terrains baked, as `shard import` does), then validate. Any
   error fails with `export/validate-failed` and the full list. The export never imports at run
   time.
2. **Reach.** The roots are every `*.scene.json` and the start scene, every prefab, string table
   and generator, every project data asset (`<project>/<Type>`), and `export.include`. From there
   a reference is any string equal to a catalog source's path or guid (with or without a `#label`
   or `/label`), in scenes, in JSON artifacts, and as a string literal in the project's scripts,
   plus each asset's import dependencies. `export.exclude` wins. The report lists every shipped
   file and what reached it, plus the asset sources left out. Scenes stay roots because games
   load them by path from code, which an export can't trace; a literal path in a script is
   traced.
3. **Plugins.** The engine plugins come from the manifest (`resolvePlugins`, below). A scene or
   prefab whose component belongs to a plugin that isn't resolved fails with
   `export/plugin-missing`, naming the plugin and the file.
4. **Code.** Generated sources in `.shard/export/web` (`index.html`, `web.ts`, `headless.ts`,
   `procgen-worker.ts`), bundled by Vite as `pnpm size` builds its fixtures: minified,
   `target: es2023`, chunks split at `import()` boundaries (feature plugins, `src/baseline/`, WESL,
   naga, codecs), WASM and workers emitted next to the chunks they're named from. Engine and
   project share one module graph, so there's no import map; the generated entries resolve engine
   packages from the CLI's own dependencies. The page and `headless.ts` (below) are one build, so
   they share their chunks. The procgen worker is a second build that keeps every module it
   imports (`treeshake.moduleSideEffects`), as `shard dev`'s worker bundle does: a worker runs no
   plugins whose `provides` could keep definitions alive. `modulePreload` is off: Vite's preload
   helper reads `document`, which a headless run doesn't have. Source maps only with
   `--sourcemap`.
5. **Shaders.** With `render` enabled: before bundling, `shard shaders bake` translates the
   shipped scenes' shaders for WebGL2 (0064). After, the shader bake runs the built export itself
   (its headless entry, on Dawn): each shipped scene settles `bakeFrames` frames (awaiting shader
   linking and pipelines between frames), once on a full-tier device and once on the baseline
   tier, and `library.bake()` of both merges into `.shard/export/shaders.bake.json`. Without a GPU
   adapter the export warns `export/no-shader-bake` and ships without one: WESL then loads on the
   first variant, which is correct but larger (0056). Project shaders (`shaders/**/*.wesl`) ship
   as `.shard/export/project-shaders.json`, the list the dev page fetches.
6. **Write.** Code keeps Vite's names under `assets/`. Data goes to `f/<hash><ext>`: the trimmed
   catalog (`.shard/catalog.json`, only shipped sources), scenes and included files, the shipped
   sources' artifacts, and the known cache files: each shipped terrain's `.shard/cache/terrain/<guid>`,
   `.shard/cache/nav/tiles.bin`, `.shard/shaders/webgl2.json`. A file of 1 KB or more gets `.br`
   and `.gz` copies when they're at least 10% smaller. `build.json` maps it all, and a
   `package.json` (`"type": "module"`) lets Node import the chunks.
7. **Report.** `--json` prints `{ target, out, build, files, bytes: { raw, gzip, brotli }, code:
   { entry, lazy, worker, wasm }, chunks, included, excluded, warnings }`. `code` is brotli bytes:
   `entry` the page's entry chunk and everything it imports statically (loaded at startup),
   `lazy` what it reaches through `import()`, `worker` the procgen worker, `wasm` the binaries.
   Each chunk lists its packages with their rendered bytes. Chunks only `headless.ts` reaches
   aren't counted. `--dry-run` stops after step 3 and prints the same report without writing
   anything.

### Plugins without importing every plugin

`buildApp` used to import every engine plugin, so a bundle through it carried all of them. The
table is now its own module, `@aethervtt/shard-project/plugins`:

```ts
/** The manifest's plugins plus everything they imply (sprite → render/forward → render…). */
export function resolvePlugins(manifest: ManifestValue, options?: { display?: boolean }): Set<string>

/** One engine plugin: its manifest name (or `always`), its component namespaces, how it's added. */
export interface EnginePlugin {
  name: string
  always?: boolean
  namespaces?: readonly string[]
  add(app: App, ctx: PluginContext, names: ReadonlySet<string>): void
}
export const engineSprite: EnginePlugin   // one export per row: enginePluginExport('sprite')
export const enginePlugins: readonly EnginePlugin[]   // every row, in the order a host adds them

/** Adds the `always` rows and the rows `names` has, in order. */
export function addEnginePlugins(app, rows, names, ctx): void
```

`buildApp` is `addEnginePlugins(app, enginePlugins, resolvePlugins(manifest), options)` plus the
project. An export's generated entries import only the rows they need, by name, and pass them to
`startExport` in table order. Every row is a separate binding in a side-effect-free package, so
the bundler drops the rows, and the packages, nothing imports. One table drives both, so an export
can't drift from what `shard dev` runs. `namespaces` is how the plugin check (step 3) maps a
component like `sprite/Sprite` to the plugin that brings it.

### `build.json`

```jsonc
{
  "version": 1,
  "build": "f3c21985c45e9de9a9e9",      // hash of every chunk and file below
  "engine": "0.x",
  "project": { "name": "star-explorer", "version": "0.1.0" },
  "manifest": { … },                    // the manifest without its export section
  "entry": "assets/index-Dh8Smd9q.js",  // the page's entry chunk
  "headless": "assets/headless-Ccy5suui.js",
  "generators": { "star-explorer/Rock": "4f1c…" },   // code hashes, as shard dev sets them
  "workers": { "procgen": "assets/procgen-worker-B1x….js" },
  "shaders": {                          // keys of files
    "bake": ".shard/export/shaders.bake.json",
    "project": ".shard/export/project-shaders.json",
    "webgl2": ".shard/shaders/webgl2.json"
  },
  "files": {
    "scenes/main.scene.json": { "url": "f/54e202a326f3e235aae9.json", "size": 2148, "hash": "54e2…" },
    ".shard/cache/artifacts/53/53cb….json": { "url": "f/53cb4d3674509e67ddc6.json", "size": 412, "hash": "53cb…" }
  }
}
```

Stage 3 adds `packs`, and `pack`, `offset`, `length` and `encoding` on packed files.

The keys of `files` are the project paths the runtime already asks for. The project path doesn't
change, so the asset server, the scene loader, terrain and nav read the export without knowing
it's one.

### Reading an export: `buildFs`

```ts
// @aethervtt/shard-platform
/** A read-only file system over an export: project paths to hashed URLs or pack ranges. */
export function buildFs(base: PlatformFileSystem, files: BuildFiles): PlatformFileSystem
// @aethervtt/shard-platform-web: createWebPlatform({ files }) reads through it.
```

- A loose file reads `base.readBytes(entry.url)`. A path the export lacks fails with
  `platform/fs-not-found`, whose hint names `export.include`.
- A packed file reads `base.readRange(pack, offset, length)` and inflates `deflate` entries with
  `DecompressionStream('deflate-raw')`, which browsers, webviews and Node all have.
- `readRange` on a packed raw entry maps to a sub-range of the pack. Terrain reads by range keep
  working.
- `exists` answers from `files` with no request. `resolveUrl` returns the loose URL, and (stage 3)
  for a packed file a `blob:` URL made on first use (audio and image decoders that want a URL).

### Pack format (`.shardpak`)

Magic `SHPK`, a `u32` version, a `u32` index length, the index (the `files` entries of that pack
as JSON), then blobs aligned to 16 bytes. The index is repeated in `build.json`, so a reader never
fetches the header. Already-compressed formats (KTX2, PNG, JPEG, OGG, MP3, GLB) are stored raw,
everything else as `deflate`. A pack is never larger than 1 GiB; past that the export starts the
next one.

### Targets

**web.** `index.html`, `assets/` (chunks, workers, WASM), `f/` (data), `build.json`. The page:

```ts
const build = (await (await fetch(new URL('build.json', document.baseURI))).json()) as BuildJson
const platform = createWebPlatform({ files: build.files, storageName: `shard:${build.project.name}` })
const { app } = await startExport({
  build, platform, plugins: [engineGltf, engineCoreTransform, engineRender, …], project, canvas,
  backend, tier,                        // ?backend=webgpu|webgl2, ?tier=baseline (0064)
  inputSource: createDomInputSource(canvas),
  audio: platform.audio,                // only when an audio plugin is enabled
  procgenWorker: new URL(build.workers.procgen, document.baseURI).href,
})
app.markUsable()
app.setRunner(animationFrameRunner())
```

`startExport` (`@aethervtt/shard-project/export`) sets the generators' code hashes and the procgen
worker, adds the given rows and the project, inits, then loads nav, project shaders, assets,
strings and the start scene, as `openProject` does from the project folder. The dev page keeps its
own boot (hot reload, protocol, capture are woven through it) and shares `registerProjectShaders`
with it. Without `?backend` the page probes WebGPU and falls back to WebGL2 (0064). It needs no
COOP/COEP headers: cross-origin isolation is only for the profiler (0074), which an export doesn't
include. Stage 2 adds the net plugin from configuration (below).

**server.** `server.mjs` (one ESM bundle for `platform: 'node'`, with `ws` bundled in), `build.json`
and packs, a `package.json` with `"type": "module"` and `engines.node`, and a `Dockerfile`
(`node:22-slim`, copy, `CMD ["node", "server.mjs"]`). It has no dependencies to install.

```sh
node server.mjs [--port 7000] [--host 0.0.0.0] [--data ./data] [--static ./public] [--json]
# env: PORT, HOST, SHARD_DATA, SHARD_STATIC; flags win
```

- It opens the project as `shard server` does (0092): `buildApp({ display: false })`, the net
  plugin as server, `intervalRunner`, no start scene. On SIGINT/SIGTERM it disposes the app,
  which saves every player (0090), then exits 0. `--data` is the node platform's `dataDir`.
- It reads assets through `buildFs` over the node file system: the same set as the client, read
  lazily. A display-free server never loads textures or audio, so they cost disk, not memory.
- One HTTP server per process. `GET /healthz` returns `{ build, players, uptime }`. The game
  WebSocket upgrades at `/net`. This needs `webSocketServer({ server })` in `net-websocket`,
  which attaches to an existing `http.Server` instead of opening its own port.
- `--static <dir>` serves a web export from the same port: `.br`/`.gz` by `Accept-Encoding`,
  `Cache-Control: immutable` on hashed files, `no-cache` on `index.html`, `build.json` and
  `config.json`, and `Range` support. `shard export --target server --static` writes the web
  export to `public/` and defaults `--static` to it.
- A project without `project.net` fails `--target server` with `project/not-multiplayer`, as
  `shard server` does.
- The lobby (0091) has no project, so it doesn't need an export: `npx @aethervtt/shard-cli lobby`
  deploys as is.

### Multiplayer clients

Where a client connects is configuration, not code, so one build works against staging and
production. The page reads, in order: query parameters (`?connect`, `?lobby`, `?host`, `?join`,
the same as `shard dev`), then `config.json` next to `index.html` (`{ "net": { "url", "lobby" } }`,
written from `export.net` and editable after export), then a default. For a web export, the
default is the page's own origin at `/net` (`wss:` on `https:`), which is the `--static` server's
endpoint. Desktop shells have no origin and need `export.net.url` (0111).

The client and server of one export share `build`. A client from another build is already
refused with `net/schema-mismatch` (0086) when their schemas differ. When they agree, the server
admits it, which is correct: replication is the same.

### Running an export headless

`shard run --build <dir> [--scene p] [--frames n] [--seed s]` runs an export instead of the
project (`openBuild` in `@aethervtt/shard-node`). It imports the export's `headless` module, which
boots the export's own bundled engine and project through `startExport` over `buildFs` on the node
file system, on Dawn, with generator jobs on worker threads running the export's procgen worker,
as `shard run` runs them. Node's `fetch` can't read `file:` URLs, which the chunks use for their
WASM, so `openBuild` and the Node worker host let it. The hash comes from the export's own
`worldHashRows` (core), hashed in the CLI. That makes "the export is the project" one hash
comparison in `pnpm test`, with no browser.

### Stages

1. **web**: `resolvePlugins`/`enginePlugins`, `startExport`, reachability, `build.json`, `buildFs`
   (loose files), shader bake, `shard run --build`.
2. **server**: `server.mjs`, `webSocketServer({ server })`, `/healthz`, `--static`,
   `config.json`.
3. **packs**: `.shardpak`, `--pack`, and `buildFs` over packs.

### Agent surface

- `shard export … --json` and `--dry-run --json` report what ships, its size, and why each asset
  is included. An agent checks a size or an exclusion before building.
- `shard run --build <dir> --json` runs an export headless and prints its hash.
- MCP: the `export` tool runs `shard export` (`dryRun` for the report alone) and returns the
  report.
- The exported server's `GET /healthz`.
- `.shard/schemas/shard.schema.json` gains `export`. The `BuildJson` type in
  `@aethervtt/shard-project/export` describes `build.json`.
- Errors: `export/validate-failed`, `export/not-imported`, `export/plugin-missing`,
  `export/bundle-failed`, `export/two-engines`, `export/bad-out`, `export/unknown-target`,
  `export/not-a-build` (`run --build`),
  `project/not-multiplayer`. Warnings: `export/no-shader-bake`, `export/no-webgl2-bake`.

## Decisions

- **Project paths stay the API.** The export maps paths to hashed URLs or pack ranges inside
  `buildFs`. The asset server, the scene loader, terrain and nav don't change.
- **Loose files by default on the web, packs elsewhere.** With immutable hashed names and brotli,
  a CDN does better than a pack. On disk, packs mean fewer files and faster installs.
- **Every scene is a root.** Code loads scenes by path, so tracing from `startScene` alone would
  drop levels silently. `export.exclude` trims.
- **Net endpoints in `config.json`, not the bundle.** One build, many deployments.
- **One port for the static site and the game server.** The client gets a same-origin default
  and needs no CORS, and the build is one process to deploy.
- **Vite, not esbuild, bundles exports.** esbuild leaves `new URL('x.wasm', import.meta.url)`
  as it is, so the WASM never reaches the export; Vite emits it, bundles workers, and is what
  `pnpm size` measures and published consumers build with (0085).
- **The export tests itself by running.** The shader bake and `run --build` import the exported
  chunks, not the project's source, so a bundling mistake (a row the entry forgot, a definition
  tree-shaken away) fails the export or the hash instead of a player's first launch.
- **World hashes list components by name.** `worldHashRows` moved to core and sorts each row's
  components by name: a table's column order follows definition order, which differs once the
  engine is bundled. Hashes changed once; none were committed.
- **`shard run --scene` waits for the scene**, as the start scene and `screenshot --scene` do.
  Frames step synchronously, so without it prefabs and generator outputs never landed and the
  hash described a half-loaded scene.
- **procgen's previews load the protocol's image helpers with `import()`.** They were the only
  thing putting `shard-protocol` in a game's startup code.
- **No binary scene format.** JSON compresses well and parses fast. Revisit only if 0062's
  `coldStart.assets` shows parsing matters.
- **Generator outputs don't ship.** `.shard/cache/generated` holds whatever a dev session
  visited (16 MB in star-explorer), so shipping it would make two exports of the same source
  differ. The runtime already saves outputs in platform storage, so a player generates each one
  once. Generating chosen outputs fresh at export time (`export.pregenerate`) waits until 0062's
  cold-start numbers show a first launch is too slow.
- **Schema descriptions stay.** An export has no protocol, so no agent reads them there, but
  removing them means a source transform over every `description:` literal (267 files) to save
  about 7 KB brotli (0056). Validation errors also use them as hints.

## Acceptance criteria

Stage 1, checked by `apps/cli/src/export.test.ts`, `apps/playground/src/export.test.ts`,
`packages/platform/src/build-fs.test.ts`, `packages/project/src/plugins.test.ts` and
`packages/core/src/ecs/hash.test.ts`. star-explorer's scenes (main, planet with terrain, rocks with
generator outputs), coin-rush and audio-lab were also compared by hand: equal hashes.

- [x] In maze-chase and star-explorer, `shard export --target web` followed by
      `shard run --build dist/web --frames 300 --seed 5 --json` prints the same hash as
      `shard run --frames 300 --seed 5 --json` in the project.
- [x] What maze-chase's page loads at startup has no `shard-protocol`, `shard-verify` or WESL
      modules (from the export's chunk report). Its size is the `export-maze-chase` fixture in
      `pnpm size`, budgeted at the first measurement (405.7 KiB entry, 633.4 KiB all JS, brotli),
      which also forbids `shard-verify` in any chunk.
- [x] A scene component whose plugin isn't in the manifest fails with `export/plugin-missing`,
      naming both.
- [x] An asset nothing references (one only a computed path reaches) is left out and reported as
      excluded. Listed in `export.include`, it ships; `export.exclude` wins over a reference.
- [x] Outside the repository, with the published packages (`pnpm release --cli-check`):
      coin-rush exports and `run --build` prints the project's hash. A bundle with one engine
      package from two installs (the CLI's and the project's at different versions) fails with
      `export/two-engines` instead of shipping two engines.
- [x] maze-chase runs from its web export in `browser.yml`, served as plain static files, on both
      backends: no console errors, the maze drawn, and neither WESL nor naga fetched.

Stage 2:
- [ ] In coin-rush, `shard export --target server`, then the exported folder copied outside the
      repository and run with `node server.mjs --port 0 --json`, prints its URL with no
      `node_modules` present.
- [ ] Two headless clients from the same export join over `/net` and converge as in 0092's
      criterion. A client from a build with a changed replicated component is refused with
      `net/schema-mismatch`.
- [ ] With `--static`: `GET /` with `Accept-Encoding: br` returns the brotli copy, hashed files
      carry `immutable`, a `Range` request returns 206, and `/healthz` returns the build hash.
- [ ] SIGTERM stores every connected player (0090) and exits 0.

Stage 3:
- [ ] `buildFs` over a pack returns every file byte-identical to its source, with `deflate` and
      raw entries, through `readBytes` and `readRange`.
- [ ] The stage 1 hash criterion passes with `--pack`.

## Open questions

None open. Deferred:

- **Import machinery.** The asset server's import and hot-reload code (about 39 KB, 0056) ships in
  exports until `AssetServer` splits a read-only core from it, in its own change.
  `export-maze-chase` shows what the split would save.
- **Code a game reaches but doesn't use.** maze-chase's startup chunk carries about 89 KB
  (rendered) of animation, audio and physics it never runs. Tree shaking keeps them because they
  are reached: the always-on glTF plugin registers the glTF importer, which imports animation's
  clip encoder; the always-on save plugin applies saved volumes through audio's buses; and
  nav/grid shares the navmesh plugin's `build`, which watches `Collider` and orders agents before
  `PhysicsSystems`. Each is an inversion in its own package (audio applies its own saved volumes,
  nav/grid touches physics only when it's there, importers split from loaders), measured by
  `export-maze-chase`.
- **Server asset set.** The server reads the same assets as the client. Leaving out display-only
  types (textures, audio, fonts) would only save disk.
- **Cache files.** Terrain, nav and WebGL2 caches are copied from a fixed list. If a fourth kind
  appears, packages declare their export files instead.
