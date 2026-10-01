# 0061 — Ownership and failure recovery

- **Status:** implemented
- **Packages:** `@aethervtt/shard-core`, `@aethervtt/shard-assets`, `@aethervtt/shard-render`, `@aethervtt/shard-gpu`, `@aethervtt/shard-runtime`,
  `@aethervtt/shard-scene`, `@aethervtt/shard-protocol`, `@aethervtt/shard-texture`, `@aethervtt/shard-text`, `apps/cli`
- **Depends on:** 0001, 0014, 0020, 0052

## Context

A host swaps scenes, reconnects, loads mods, and unmounts the table when a player leaves. Each of
those has to leave either a usable table or an explicit failure, never a blank canvas or a slow
leak. Two things are missing for that.

**Ownership.** Nothing in Shard records who made an entity or holds an asset. So when Aether leaves
a scene, or a mod is disabled, there is no way to remove exactly what belonged to it, GPU memory
included.

**Degrading instead of failing.** A texture that 404s, a GLB that doesn't parse, or a host-registered
material whose shader doesn't compile should each show a marked fallback and report it, and the rest
of the scene should keep drawing. Device loss already recovers (0005). This spec makes the rest
match, and gives the host one place to read the renderer's health.

`probeGraphics()` (`@aethervtt/shard-gpu`, 0064, built on `probeWebGpu`) is the up-front half: a
client without a usable GPU backend gets an honest reason before anything mounts.

## Goals

- Owners: entities, asset leases and the GPU objects behind them, released together by
  `owners.release(owner)`.
- Fallbacks for failed textures, meshes, GLBs and materials, each tagged so the host can show it,
  and retryable.
- Shader and pipeline failures fall back to the standard material, and never drop an object.
- `RenderHealth`: one resource that says `ok`, `degraded`, `lost` or `failed`, and why.
- Mount/leave cycles, scene switches and reconnects return every counter to its baseline.

## Non-goals

- The host's own policy: which mods exist, what they may load, and which assets are verified.
  Shard enforces the limits the host gives it and nothing more.
- Retrying the network. The host's asset source decides retries; `assets.retry` re-runs a load.
- Recovery UI. The host shows it from `RenderHealth`.

## Design

### Owners

```ts
const scene = world.owners.create('scene:abc')                       // an Owner: an object, not an id
const mod = world.owners.create('mod:lanterns', { parent: scene, limits: {
  entities: 256, triangles: 500_000, textures: 64, bytes: 64 << 20 } })
world.owners.spawn(mod, [Mesh3d, …], Transform)                     // the only way to own an entity
const handle = assets.lease(ref, mod)                                // counted per owner
world.owners.release(scene)                                          // → OwnerReleased
world.owners.describe(scene)  // { usage: { entities, triangles, textures, bytes }, limits, children, leases, gpu }
loadScene(world, json, { owner: scene })     // every entity in it belongs to `scene`
```

`OwnedBy { owner, inherited }` holds the owner's id; `world.owners.nameOf(entity)` reads its name
without a grant. A child spawned under an owned parent takes the parent's owner (`inherited`).
`world.owners.find(name)` gives host code that keeps names the object back.

**Ownership is a grant from host code, not authorable data.** An `Owner` is an unforgeable object
held by whoever called `create`, and only code holding it can spawn into it, lease for it, or
release it. `OwnedBy` is a component with `serialize: false` and host-only writes:

- scene files and prefabs never contain it, and loading one that does fails with
  `core/owner-not-authorable`;
- the protocol's `entity.patch` and `entity.spawn` refuse it with the same code, and `resource.set`
  refuses resources defined `hostOnly`;
- `world.spawn`, `add`, `set` and `remove` of `OwnedBy` work only through `owners.spawn` and
  `owners.adopt(owner, entity)`, which take the `Owner` object. A component defined `hostOnly` is
  never serialized, and the world refuses it outside the grant.

A scene that a host loads for an owner is spawned by `owners.spawn` on the host's side, so
everything in it belongs to the owner the host chose. A mod, a sandbox or a scene file can't name
another owner, or none. Children inherit their parent's owner unless the host gave them their own.

**Limits.** An owner created with `limits` refuses work past them: a spawn, a lease, or a GPU
allocation for its assets that would exceed a limit fails with `core/owner-quota`, naming the
limit, and nothing partial is created. A child owner's usage counts toward its parents' limits. This
enforces host policy in the engine too (for Aether, ADR-0060's bounded mod objects). The host's own
validation (verified GLB profiles, allowed asset sources) still runs before anything reaches Shard.

**Protocol exposure.** Embedding doesn't start the protocol server. A host that starts it passes the
methods it allows (`createProtocolServer(app, { allow })`; `methods` already means extra host
methods), and no method, `owners.*` and `subscribe` included, is reachable from hosted mods unless
the host forwards it. Shard's general entity and asset editing
surface is for agents and tools, and it isn't a mod API.

`release` does four things, in order:

1. despawns every entity owned by the owner or any of its child owners, with descendants;
2. drops its leases; an asset with no remaining lease from any owner, and that nothing else
   references, unloads;
3. frees the GPU objects created for those assets: the asset server tells `onUnload` listeners, and
   the renderer destroys its copies of the object (`owners.describe` lists them as `gpu`);
4. emits `OwnerReleased`.

Released owners are invalid, and using one throws `core/owner-released`. Assets loaded without an
owner belong to the app, as today.

**Leases and limits.** `assets.lease(ref, owner)` returns the ref and charges the asset's cost (each
asset type's `cost`: a mesh's triangles and bytes, a texture's one texture and bytes) against the
owner and its ancestors. An asset already loaded is checked exactly; one still loading is refused
only if the owner is already at a limit, and is charged on arrival, where a lease that no longer
fits is dropped and `core/owner-quota` logged. A scene loaded for an owner checks its entity count
before spawning anything.

### Fallbacks

When an asset fails to load (`AssetState 'failed'`, 0014), its store returns a fallback. Each asset
type supplies its own (`fallback` in `defineAssetType`), stored under the failed asset's guid, so
lookups stay one map read:

| Asset | Fallback |
|---|---|
| Texture | a neutral 50% gray RGBA8 texture (a magenta checker in dev builds), which binds in any slot |
| Mesh | a 1 m beveled box, drawn with the `missing` material (gray; magenta in dev builds) |
| GLB scene | its instance spawns the box above as its one child |
| Material | `standard`, with the failed material's base color if it was readable |
| Font | the engine's built-in font: printable ASCII from the gizmo label atlas |

Entities showing a fallback get a `MissingAsset { ref, code, message }` component, so the host can
query them and show a badge: those whose components reference the failed asset, or an asset that
uses it (a material whose texture failed; asset types list what they use with `references`). The
render plugin keeps the marks current (`assets.markMissing()`). `assets.retry(ref)` reloads, and on
success entities switch back without respawning.

A ref nothing can load (its guid unknown to the catalog, or its runtime asset deleted from its
store) gets the same treatment through `assets.missing(ref, type)`, which the renderer calls instead
of waiting on it forever. A development build (`new App({ dev: true })`, the `DevMode` resource)
makes the fallbacks loud.

### Shader and pipeline failures

Pipelines are created with `createRenderPipelineAsync`. A rejection, or a module that fails to link
or compile with no earlier version that did (`ShaderLibrary.failure`), marks that material type
failed. Its draws, in every pass, fall back to the standard pipeline with the same vertex layout,
through a standard proxy of the material (its standard fields, or its `baseColor`/`color`), and the
error goes to `Gpu.errors` naming the material type and the WGSL line. A later `defineMaterial`
with the same name, or any shader edit, clears the mark. A failed pipeline isn't a skipped draw, so
it doesn't hold an on-demand app awake. Nothing using a failed pipeline disappears, and no frame
renders black.

### Health

```ts
RenderHealth {
  state: 'ok' | 'degraded' | 'lost' | 'failed'
  issues: { code, message, ref?, since, severity: 'degraded' | 'info' }[]
}
```

The state is `degraded` while any fallback, failed pipeline or `degraded` issue is in use, `lost`
between a device loss and its recovery, and `failed` when recovery itself fails (after 3 attempts,
1 s apart; `createGpuContext({ recovery })` changes that; `GpuContext.status` says where it is).
`info` issues are reported without changing the state. Other code raises issues with
`raiseHealthIssue` (0064's unsupported features). `RenderHealthChanged` fires on transitions, as an
event for systems and a trigger for host code (`world.observe`), so a host can show "graphics
reset" or "3D unavailable" instead of a stale canvas. While the device is lost, frames skip the
graph.

### Cycles and reconnects

A scene switch is `owners.release(old)`, then load the new one. A reconnect is a mirror `sync`
(0055): documents whose `rev` didn't change cost nothing, so a reconnect rebuilds only what changed
while the client was away. A leave is `app.dispose()` (0052).

### Agent surface

- `owners.describe` and `owners.release` through the protocol.
- `render.describe` → `health`, and `MissingAsset` is queryable like any component.
- The `shard validate` output lists assets that would fall back (`fallbacks`: sources that fail to
  import).

## Decisions

- **Ownership is a component that only host code can write.** Queries and despawning by owner stay
  ordinary ECS work, but the grant comes from holding an `Owner` object, so data can't claim an
  owner. That's what lets a host give a mod objects without giving it authority.
- **Fall back, mark, and report.** A VTT session shouldn't end because one token image 404s. The
  marker makes the degradation visible instead of silent.
- **Standard-material fallback for shader errors.** It keeps the object's shape and color, which is
  the most useful wrong answer.

## Acceptance criteria

- [x] Releasing an owner with 1,000 entities, 20 textures and 10 meshes despawns them all, and
      returns `gpu.stats` and the asset store to their pre-load counts. Assets also leased by
      another owner stay loaded.
- [x] Releasing a parent owner releases its child owners' entities and leases.
- [x] A scene file, prefab, `entity.patch` or `entity.spawn` containing `OwnedBy` fails with
      `core/owner-not-authorable`, and creates nothing.
- [x] An owner at its `entities` or `triangles` limit fails the next spawn or lease with
      `core/owner-quota`, leaves its counts unchanged, and a parent's limit counts its children.
- [x] A protocol server created with an allowlist rejects every method outside it, with
      `protocol/method-not-allowed`.
- [x] A 404 texture, a truncated GLB and a non-existent mesh each render their fallback, carry
      `MissingAsset`, set `RenderHealth` to `degraded`, and render normally after a successful
      `assets.retry`.
- [x] A material type with a WGSL error draws its meshes with the standard pipeline, reports the
      error with the type name and line, and recovers after `defineMaterial` fixes it.
- [x] A simulated device loss goes `ok → lost → ok`, and the scene renders the same afterwards
      (golden). A device that fails to recover 3 times goes `failed`.
- [x] 50 cycles of mount, load the parity fixture (0057), switch scene, reconnect, and dispose
      leave entity counts, `gpu.stats`, listeners, observers and workers at their baseline.
- [x] `probeWebGpu()` distinguishes `no-webgpu`, `no-adapter`, `missing-feature`, `device-failed`
      and `timeout`, and never throws.

## Open questions

- Should `MissingAsset` fallbacks be hidden from players and shown only to a GM? Proposed: that's
  the host's call. The engine marks them; Aether can hide the badge.
