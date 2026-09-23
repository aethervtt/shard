# 0014 — Asset database

- **Status:** accepted
- **Packages:** `@shard/assets` (new), `@shard/platform`, `@shard/render`, `@shard/scene`,
  `@shard/protocol`, `apps/cli`
- **Depends on:** 0002, 0009, 0010, 0011, 0012

## Context

Today every asset lives in memory. `AssetStore` in `@shard/render` hands out `mem:` guids, and scenes
can only point at `#inline` assets or `procedural:` meshes. A file path such as
`assets/ship.glb#Mesh/Hull` parses, then fails with `scene/asset-unavailable`.

glTF (0015), textures (0016), and everything after them need one system that turns files into
runtime objects. It has to give each asset an identity that survives edits, avoid repeating slow
imports, and notice when a file changes. It also has to work the same way in the CLI, in Studio,
and in a browser tab, and let an agent see what is loaded, what failed, and why.

## Goals

- Stable identity. Every asset has a GUID stored in a `.meta` sidecar next to its source file.
- Import settings come from a schema, so `.meta` files are validated, documented, and editable
  like components.
- Two stages. **Import** turns a source file into a cached artifact and runs only when its inputs
  change. **Load** turns an artifact into a runtime object.
- The cache is keyed by content, so a clean checkout and a warm cache give the same result.
- A dependency graph. Changing a file re-imports it and everything that was built from it.
- Hot reload. A changed asset swaps in place under the same GUID, and consumers see a version bump.
- Loading is async and scenes don't block on it. The renderer skips anything that isn't ready,
  and tools can wait until a scene is fully loaded.
- Assets nothing references get unloaded.
- Agents can list, inspect, re-import, and move assets through the protocol, the CLI, and MCP.

## Non-goals

- Specific formats. glTF is 0015 and textures are 0016. This spec ships only the JSON data-asset
  importer, which serves as the reference importer and makes material files work.
- Streaming, bundles, and per-platform compression presets (VISION "Later").
- Importing on worker threads. Heavy decoders (0016) can use workers inside their own importer.
- Prefabs. Scenes as referenceable assets come with the prefab spec.

## Design

### Files

```
assets/ship.glb
assets/ship.glb.meta          { "guid": "…", "importer": "gltf", "settings": { "scale": 1 } }
materials/hull.material.json  a data asset (see below); it gets a .meta like any source
materials/hull.material.json.meta
.shard/cache/index.json       guid → import record
.shard/cache/artifacts/ab/abcdef…   artifact bytes, named by key
```

- **GUID:** 32 lowercase hex characters (128 random bits). A `.meta` file is created the first
  time a source is seen on a writable host. It belongs in version control.
- **Sub-assets:** one source can produce several assets (a glTF holds meshes, materials, and
  nodes). A sub-asset's identity is `<guid>/<label>`, and its path is `<source>#<label>`
  (`assets/ship.glb#Mesh/Hull`). Labels come from the importer and must stay stable across imports.
- **Asset roots:** the manifest gains `assetRoots` (default `["assets", "materials", "data"]`).
  Nothing outside the roots is imported.

### Asset types and importers

```ts
export const MeshAsset = defineAssetType<Mesh>('Mesh', {
  load: (artifact, ctx) => decodeMesh(artifact.bytes),  // artifact → runtime object
})

export const JsonImporter = defineImporter({
  name: 'json-data',
  version: 1,                               // bump to invalidate every artifact it made
  extensions: ['.material.json'],
  settings: defineSchema('assets/JsonImportSettings', {}),
  async import(source, ctx) {
    const value = StandardMaterial.deserialize(JSON.parse(source.text()), ctx.schema)
    return { assets: [{ label: '', type: 'Material', json: StandardMaterial.serialize(value) }] }
  },
})
```

- An importer's `import(source, ctx)` gets the source bytes, the validated settings, and a
  context with `ctx.read(path)`, which records an **import dependency** (a glTF's `.bin`, say).
  It returns one artifact per asset (`bytes` or `json`) plus any **load dependencies**: refs the
  runtime object needs, such as a material that points at a texture.
- Importers are pure TypeScript and run on every host. The same code imports in the CLI, in Studio,
  and in a browser dev tab.
- **Data assets:** `defineDataAsset(type, schema, { extension })` registers a JSON importer for
  `*.<extension>.json`, validated by that schema. Material files are the first data asset. Scenes
  keep their inline `#assets` block as well.

### Import and the cache

For each source, the import key is `sha256(importer name + version, settings JSON, source hash,
hashes of every import dependency)`. The index records, for each GUID, the key, the type, the
sub-assets, both kinds of dependencies, and the source's size and mtime.

A scan walks the asset roots. For a source whose size and mtime match the index it does nothing,
so startup only stats files. Otherwise it hashes the source. It imports only when the key changes,
writes artifacts by key, and updates the index. Failed imports are recorded with their
`ShardError`, and the scan continues.

- Hashing uses `crypto.subtle.digest`, which exists on every host.
- The platform file system gains two optional capabilities: `list(dir)` and `stat(path)`. A host
  without them (a static web build) reads a prebuilt `.shard/catalog.json` instead of scanning.
  `shard import` writes that catalog. Export (M9) ships it with the artifacts.
- On a read-only host the cache lives in memory.

### The catalog and references

The `AssetCatalog` maps paths to GUIDs and GUIDs to paths, types, and state. Lookups are
synchronous, so `resolveAsset` in the schema context stays synchronous. Validation and scene load
don't change shape.

- Files reference assets by path (`{ "path": "assets/ship.glb#Mesh/Hull" }`) because paths are readable
  and agents write them. `{ "guid": "…" }` also works. Saves keep whatever form was authored (0010).
- **Moves:** `shard mv <from> <to>` and the `asset.move` method move the source and its `.meta`,
  then rewrite path references in scenes and data assets. If someone moves a source without its
  `.meta`, the next scan finds a new file whose hash matches one that just disappeared. It keeps
  the GUID and reports `assets/moved-without-meta` along with the references to fix.
- `procedural:` refs resolve through the catalog as virtual sources with GUID `proc:<key>`, which
  replaces the scene package's private cache. M7 generators plug in here.

### Load, readiness, and the frame

- `Assets<T>` stores (one per type) replace render's `AssetStore`. `get(ref)` stays one map lookup
  by GUID with no allocation. Runtime-made assets keep their `mem:` GUIDs.
- A ref is `unloaded`, `loading`, `loaded`, or `failed`. Loads run off the frame. Finished loads are
  queued and applied in `First`, so every system in a frame sees the same set of assets. Each
  change emits an `AssetEvent { guid, kind: 'loaded' | 'modified' | 'failed' | 'removed' }`.
- `loadScene` stays synchronous. It resolves refs through the catalog, spawns everything, and
  requests loads for the referenced GUIDs, following load dependencies. `whenSceneReady(world, id)`
  resolves once those loads have settled. `scene.load` in the protocol, `shard screenshot`, and
  `game.load` wait for it by default, so captures never show half-loaded scenes.
- The renderer skips draws whose mesh or material isn't loaded, counted like pipeline skips, and
  never throws. A failed asset shows up in `errors.recent` with its source path.

### Hot reload and invalidation

On hosts that can watch files, a change to a source or `.meta` under an asset root triggers a
re-import of that source, then of every source that listed it as an import dependency. If the key
changes, loaded assets reload in place: the store swaps the object under the same GUID and bumps its
`version`, and consumers compare versions the way `MaterialAsset` already does. A reload that fails
keeps the last good object and logs the error. That's the same policy as shader hot reload (0006).

### Unloading

This uses reachability, not reference counts. `assets.collect()` walks every `t.handle` column in
the world (the schema says which columns those are), adds pinned GUIDs (`assets.pin(ref, owner)`),
and follows load dependencies. Everything else unloads. It runs after `unloadScene` and
`reloadScene`, and when called explicitly. No per-frame work and no bookkeeping on spawn or despawn.

### API sketch

```ts
const assets = world.resource(AssetServer)
await assets.scan()                                   // import what changed
const ref = assets.catalog.resolve('assets/ship.glb#Mesh/Hull')   // { type: 'Mesh', guid, path }
await assets.load(ref)                                // resolves when loaded (or throws the error)
assets.state(ref)                                     // 'loaded'
assets.info(ref)       // { path, type, importer, settings, key, deps, dependents, error? }
await assets.reimport(ref, { settings: { scale: 0.01 } })   // writes .meta, re-imports
assets.pin(ref, 'hud'); assets.unpin('hud'); assets.collect()
world.resource(MeshAssets).get(ref)                   // Mesh | undefined, hot-path safe
```

### Agent surface

- **Protocol:** `asset.list { type?, prefix?, state? }`, `asset.get { ref }` (meta, settings with
  schema, state, dependencies and dependents, error), `asset.import { ref?, settings? }`
  (re-import one source or scan everything), and `asset.move { from, to }` (returns the
  references it rewrote).
- **MCP:** `list_assets`, `get_asset`, `reimport_asset`, `move_asset`.
  `shard://schemas/importers/<name>` publishes each importer's settings schema.
- **CLI:** `shard import [--force] [--json]` imports everything and lists each failure with its
  path. `shard mv <from> <to>` moves an asset. `shard validate` also checks `.meta` files and
  reports orphaned metas.
- **Errors:** `assets/import-failed`, `assets/unknown-importer`, `assets/invalid-meta` (with a
  pointer into the settings), `assets/not-found`, `assets/load-failed`, `assets/dependency-cycle`,
  `assets/moved-without-meta`.
- `shard docs` adds an asset catalog to `.agents/`: importers, their settings, and their file
  extensions.

## Decisions

- **Split import and load.** Imports are slow and cached. Loads are fast and repeatable. Hot
  reload, export, and read-only hosts all depend on the difference.
- **Keep paths in files and GUIDs underneath.** Agents read and write paths. GUIDs keep an asset's
  identity when it moves, and `shard mv` keeps references right.
- **Reachability instead of reference counting.** Components already hold refs in schema-typed
  columns, so the world is the reference graph. Counting would add bookkeeping to spawn, despawn,
  and every patch, and would drift. VISION's "handles with reference counting" changes to match.
- **Importers are pure TypeScript and run everywhere.** Browser dev and the CLI run the same code.
  Native tooling (M4+, Rust through Tauri) can still take over specific formats behind the same
  importer interface.
- **Finished loads apply in `First`.** A frame never sees an asset appear halfway through.
- **The key hashes content, not mtime.** mtime only lets a scan skip hashing. Two machines with
  the same sources and settings produce the same keys.

## Acceptance criteria

- [ ] A new source gets a `.meta` with a GUID on first scan. Moving source and `.meta` together
      keeps the GUID. Moving only the source keeps it too, and reports `assets/moved-without-meta`.
- [ ] Scanning 1,000 unchanged sources in Node stats them without hashing or importing and takes
      under 200 ms.
- [ ] Changing a source, its settings, its importer's version, or an import dependency re-imports
      exactly the affected sources. Nothing else re-imports.
- [ ] A `.material.json` data asset with an invalid field fails with a pointer into the file and
      doesn't stop other imports.
- [ ] A scene that references a material file by path loads, renders as authored (golden image), and
      saves the path back unchanged.
- [ ] Changing that material file while the app runs updates the rendered color within two frames
      and keeps the GUID. A broken edit keeps the last good material and logs the error.
- [ ] `whenSceneReady` resolves only after every referenced asset is loaded or failed, and
      `render.capture` after `scene.load` never shows missing meshes.
- [ ] After `unloadScene`, `collect()` unloads the scene's assets but keeps any asset another
      scene or a pin still references.
- [ ] `shard mv` moves an asset and rewrites references in scenes, and `shard validate` passes
      afterwards.
- [ ] `asset.list`, `asset.get`, `asset.import`, and `asset.move` work through the protocol and as
      MCP tools. `asset.get` shows dependents and the last import error.
- [ ] A host without `list` and `stat` loads assets from `.shard/catalog.json` and the cached
      artifacts.

## Open questions

- None blocking. Deferred: a shared cache across projects or machines (the keys already allow it)
  and importers written in Rust for Studio.
