# 0112 — Streamed generated worlds (generated cells, deltas, server-driven loading)

- **Status:** accepted (built; implemented once its criteria pass in CI)
- **Packages:** `@aethervtt/shard-partition` (new, per 0072), `@aethervtt/shard-net`,
  `@aethervtt/shard-save`, `@aethervtt/shard-procgen`, `@aethervtt/shard-scene`,
  `@aethervtt/shard-mesh`, `@aethervtt/shard-physics`, `@aethervtt/shard-runtime`, `apps/cli`,
  `apps/playground`
- **Depends on:** 0030, 0038, 0040, 0042, 0072, 0087, 0089, 0092

## Context

Take a server-authoritative open world made from a seed: a few hundred buildings now, a county
several km across later. It can't be authored as cell files, and the server can't hold it all at
once. The world is the seed plus what players changed: broken or built walls, emptied containers,
dead zombies, dropped items. Only the changes should be saved. Only the changes should cross the
network too, because every machine can regenerate the rest.

0072 streams authored cells around local cameras. 0042 makes generators pure and cached, and saves
a generator instance as seed, params and diffs. 0087 filters replication per peer. This spec joins
the three: a cell is a generator's output for `(seed, x, z, level)` plus a delta. The server loads
cells around every player and simulates them. Each client generates the same cells around its own
player, at a detail level that depends on distance, and receives only deltas and dynamic entities.

## Goals

- A partition grid whose cells come from an `entities` generator (0042), keyed by world seed, cell
  and level, and bit-identical on every machine. Generation runs on the worker pool, and the main
  thread stays within a per-frame budget.
- Per-cell deltas against the generated baseline (removed and patched generated entities, added
  static entities, dormant dynamic entities). They persist through `save`, and survive generator
  version changes in a defined way.
- Server-driven loading of the union of rings around every streaming source, with hysteresis. An
  entity that crosses a border moves to the new cell.
- Clients generate static content themselves. The server sends a cell's delta and replicates only
  dynamic entities, through net interest by cell. A peer never receives entities from cells it
  hasn't loaded.
- Separate rings per source: server (simulate), client (draw, per detail level), and replication
  (with update rates that fall with distance).
- Detail levels per cell (`full`, `far`, …). The generator decides what they contain. Streaming
  picks the level and swaps it in one frame, with hysteresis.
- Hidden information: what a client must not know before it's revealed (a container's loot) comes
  from a server-only seed, never from what a client can generate, and reaches a peer only through
  net's redaction.
- A hook for simulating unloaded cells (hordes), with no behavior of its own.

## Non-goals

- Baked HLOD (0073). Its proxies can become a level later.
- Terrain (0071 streams its own pages), occlusion culling, and line of sight.
- What dormant zombies do. A later hordes spec uses the hook below.
- Zone sharding (several servers for one world).
- The importer, index and tools for file cells. 0072 builds those; this spec builds the runtime
  they plug into.

## Design

### Grids

A 0072 partition grid gets a `generator` instead of cell files, or as well as them. Until 0072's
`*.partition.json` importer lands, a partition is defined in code with the same fields:
`definePartition('town', { grids: [ … ] })`, and `PartitionInstance.partition` names it.

```json
{ "grids": [{
  "name": "town", "cellSize": 64,
  "generator": "zomboid/TownCell",
  "params": { "plan": { "path": "generators/plan.gen.json" } },
  "levels": [{ "name": "full", "range": 96 }, { "name": "far", "range": 512 }],
  "simulate": 160,
  "secrets": { "generator": "zomboid/TownLoot", "components": ["zomboid/Contents"] },
  "replicate": { "range": 160, "bands": [
    { "within": 48, "every": 1 }, { "within": 96, "every": 2 }, { "within": 160, "every": 4 }] }
}] }
```

- **A cell's content** is the generator's fragment for `seed = PartitionInstance.seed` and params
  `{ ...grid.params, x, z, level }`. The generator spreads `cellParams(levels)` (an i32 `x` and
  `z`, and an enum `level`) into its params schema, and seeds its RNG with `ctx.childSeed` from the
  cell's coordinates.
- **Shared world data** reaches the generator through handles in `params`, loaded with
  `ctx.load`. For example, a town plan generated once from the seed lets roads and lots agree
  across cells. Nothing here assumes a particular generator.
- **A cell file** `<grid>/<x>_<z>.scene.json`, when one exists, replaces the generator for that
  cell at every level, for a hand-made landmark. Its delta is 0072's diff against the file. The
  file source lands with 0072.
- **Fragments are in partition space.** The cell root sits at the partition origin, and paths
  start at the cell root (`b3/walls/n`).

### Secrets

A client runs the cell generator itself, so anything that generator computes, a client can read.
What players mustn't know before they find it comes from somewhere a client can't reach:

- **A server-only seed.** `PartitionInstance.secretSeed` is set on the server and saved with it.
  It's never sent: clients have 0.
- **A secrets generator.** `secrets.generator` is a `data` generator (0042) with the same
  `cellParams` and the secret seed. It returns 0030 overrides for the cell's first level
  (`{ "b3/crate-2": { "zomboid/Contents": { … } } }`). The server applies them to the cell's
  baseline before the delta, so the delta is taken against public baseline plus secrets.
- **Secret components.** `secrets.components` lists the components a client never gets through a
  fragment or a delta. The cell generator mustn't write them (`partition/secret-in-fragment`), and
  delta entries sent to peers leave them out (an entry left empty isn't sent). The server's own
  delta, and so its saves, keep them.
- **Revealing.** On the server, every cell entity with a secret component is **bound**: it gets
  `net/Replicated { bound: true }` with the prefab `cell:<grid>/<x>,<z>/<path>`. A client's `bind`
  hook (net) resolves that to the entity it generated instead of spawning one, and receives only
  components whose `replicate(…)` entry has `visibleTo`. The game's `visibleTo` decides when (the
  container is open, or in reach). When the entity leaves a peer's interest, the client removes
  those components and keeps the entity. A cell's bound entities become relevant to a peer only
  after the client reports the cell committed, so a bind never arrives before the entity exists.

### Levels

- `levels` run from near to far. A `range` is measured from a source to the nearest point of the
  cell's square.
- A client loads each cell at the finest level whose range contains it, and leaves it unloaded
  past the last range.
- **Path contract.** An entity that exists at more than one level has the same path at each, so a
  delta applies to every level. The generator decides what each level holds. The test generator's
  `far` level keeps building shells (the same wall paths, no colliders) and drops interiors and
  props.
- **Swapping.** Streaming sets the instance's `level` param only once the new level's prefab and
  its load dependencies are resident. The respawn (0042, ids kept by path) then happens in one
  frame, with no hole and no double draw. Until then the old level keeps drawing.
- **Hysteresis.** A cell gets coarser, or unloads, once it has been beyond 1.2 × the range for
  `unloadDelay` seconds. It gets finer as soon as it is within the range.

### Rings and roles

```ts
PartitionInstance { partition: string, seed: u32, secretSeed: u32, enabled: bool = true }
StreamingSource { enabled: bool = true, rangeScale: f32 = 1, priority: u8 = 0, peer: u32 }
CellBound { x: i32, z: i32, grid: u8, key: u32 }   // 0072's tag gains its cell and its `+key`
StreamedCell { x: i32, z: i32, grid: u8, level: u8 }                              // on cell roots
Dynamic {}                                          // a CellBound entity that sleeps when unloaded
```

| App | Loads | Level | Dynamic entities |
|---|---|---|---|
| Server | union of `simulate` rings around every source | first only | live, or dormant |
| Client | `levels` rings around its own sources | by distance | replicated from the server only |
| Single player (no net) | both | the finer of the two | live within `simulate` |

- **On the server,** sources are entities with `StreamingSource`: player entities, and any other
  source the game adds (a scripted event, a vehicle).
- **On a client,** sources are the entities it owns that have `StreamingSource` (its player):
  `partitionNet()` replicates `StreamingSource`, and the server copies `net/Replicated.owner` into
  its `peer`. They're the same entities the server range-checks requests
  against, so a client's rings and the server's check agree. Cameras are sources only with
  `StreamingBudget.camerasAreSources` (default false on a client), and the server still refuses
  cells beyond its check, so a free or spectator camera can't widen what a client receives.
- **Selection** follows 0072: rings are checked when a source has moved an eighth of a cell, or
  every 30 frames, walking only the cells in range, and requests go nearest first, weighted by
  `priority`.
- **Transforms.** Sources and cells are placed by world transform, so `partitionPlugin` adds
  `core/transform` when the host has no other reason to (a headless project with no plugins).

### Loading and the budget

1. **Generate.** The cell's identity is `generate()`d on the worker pool (0042). Jobs in flight
   are capped by `StreamingBudget.jobsInFlight` (default 8). Results stay cached (0042's LRU and
   disk cache), so a cell visited again is a cache hit.
2. **Resolve.** The fragment's handles load (0014), as in 0072's step 2. A client also waits for
   the cell's delta (see *Network*).
3. **Commit** in `First`. Each cell root (with its `GeneratorInstance` and the delta's overrides)
   spawns, then one `updateInstances` pass spawns every committed cell's children, then the
   delta's added and dormant entities. A frame commits cells until `entitiesPerFrame` (default
   2000) is spent, and always commits at least one.
4. **Unload.** The cell's delta is captured (below), then the root's subtree is despawned.

`StreamingBudget.commit` decides when a ready cell commits:
- **`'ready'`** commits as soon as the cell is ready (`shard server`, interactive clients).
- **`'deterministic'`** commits exactly `commitDelay` frames (default 30) after the cell became
  wanted, waiting for it if it isn't ready, so a world hash depends only on input and seed.
- **`'auto'`** (the default) is deterministic when the host steps deterministically, which runtime's
  `StepMode` says (`shard run`, `shard run --net` and netHarness set it), and ready otherwise.
  Such hosts await `settleBeforeStep(world)` before each step; the partition plugin registers
  `partitionSettled` there. Scene defers asset-triggered respawns to the frame in that mode, since
  when an asset lands would otherwise decide the order of entity ids.

### Deltas

```ts
interface CellDeltaJson {
  generator: string; version: u32           // what the baseline was made with
  entries: Record<string, JsonValue>        // 0030 override keys by path, and `+n` added entities
  revs: Record<string, u32>                 // per key, for incremental sync
  dormant: SavedCellEntity[]                // server only: dynamic entities captured at unload
  next: u32                                 // the last `+n` handed out
}
interface SavedCellEntity {
  parent?: string; components: Record<string, JsonObject>; extra?: JsonObject
}
```

- **Static or dynamic.** An entity is dynamic when it has `partition/Dynamic`, or on the server
  `net/Replicated`: zombies, and items the game replicates. Anything else a game changes or adds
  in a cell is static.
- **Generated entities are never replicated** (`partition/generated-replicated`), except bound
  for their secret components (see *Secrets*). Their other changes, such as a door's state, travel
  in the delta.
- **The delta is kept current** while the cell is loaded, not only at unload, because peers need
  it live. Once per network tick (each frame without net), a cell recomputes the keys of generated
  entities whose saved components changed (change ticks) or that were despawned (`onRemove`), with
  a per-entity form of `currentOverrides` (0030), and of its `CellBound` static entities. Each
  changed key takes the cell's next rev. An untouched cell has an empty delta and costs nothing.
- **Added entities** are runtime entities with `CellBound` and no `Replicated`. Each gets a name
  that is unique in its cell (`+n`). They appear at the first level only, unless they have
  `partition/FarVisible` (a built wall).
- **Dormant entities.** At unload, each dynamic `CellBound` entity is written into `dormant`:
  its saved components, its parent's path when it hangs under a generated entity, and what a hook
  keeps (`net/Replicated`'s prefab and owner, which saves skip). Entity fields are written as
  `null`, and `save/NoSave` entities are dropped. When the cell next loads inside a `simulate`
  ring, they spawn and replicate again.
- **Levels.** A delta applies at every level. Ops on paths a level doesn't have are skipped there,
  silently. So a knocked-down wall disappears from the `far` shell as well, as long as the far
  level keeps that wall's path.
- **Generator versions.** A delta records the generator's `version` (0042's manual bump), not its
  code hash, so an edit that keeps the output the same leaves deltas valid. When `version` changes,
  the generator's migration (`defineDeltaMigration(name, (overrides, from, to) => …)`) runs if
  there is one, and the delta then applies by path. An op whose path is gone is kept and reported
  as `partition/stale-delta`, like `prefab/stale-override`, so a rename never silently drops a
  player's changes. Clients and the server must run the same generator `version` and `codeHash`,
  checked at join.

### Moving across cells, and the hordes hook

- **Re-homing.** A `CellBound` entity more than 1 m outside its cell moves to the cell that
  contains it. (This amends 0072, where it stayed in its spawn cell.)
- **Into an unloaded cell.** If that cell isn't loaded, the entity becomes dormant in the cell's
  delta, and `partition/EntityDormant` fires.
- **The hook for hordes** is the `CellLoaded` and `CellUnloading` events,
  `dormantEntities(world, partition, grid, x, z)`, and
  `moveDormant(world, partition, grid, from, to, index)`. With them, a later hordes system can move
  zombies between unloaded cells without loading those cells.

### Network

This is `@aethervtt/shard-partition/net`. Nothing registers on import.

- **Join.** The server sends `partition/World { partition, seed, generators: [{ name, version,
  codeHash }] }`. A client whose generators differ disconnects with `partition/generator-mismatch`;
  otherwise it spawns its `PartitionInstance` from it.
- **Cell requests.** A client reports its cells with the `partition/Cells` command: `add` and
  `update` (`[grid, x, z, level, hash, agent][]`), `loaded` (committed) and `remove`
  (`[grid, x, z][]`). The server refuses a cell beyond 1.25 × the last level's range of that peer's
  sources (`partition/cell-out-of-range`), so deltas can't be scraped from far away, and answers
  each accepted add with the cell's full delta, less secret components.
- **Divergence check.** `hash` is the `cellHash` of the level the client generated. The server
  compares it with its own when it has that level (always for the first level, which it simulates;
  other levels with `verifyLevels: 'all'`, as tests set). A mismatch logs `partition/cell-diverged`
  with the cell, level, generator and the peer's user agent. It doesn't disconnect: the server
  can't tell which side is wrong, and a game may choose to.
- **Delta updates.** After that, the `partition/CellDelta { grid, x, z, rev, full, entries, drop }`
  net event carries only the keys changed since the peer's rev; `drop` lists keys that left the
  delta, each with the baseline values to put back. Events are reliable and fragment, and their
  fields are `t.json` (0089).
- **What a client applies.** A client never receives `dormant`. It patches, removes or spawns the
  affected entities in place (`applyCellDelta`), without respawning the cell; the stored delta
  becomes the instance's overrides when the cell next commits or changes level.
- **`streamInterest()`** is a 0087 `InterestPolicy`. A replicated entity is relevant to a peer
  when the cell containing its position (in the first grid) is one the peer reported, and it is
  within `replicate.range` of the peer's nearest focus (1.1 × for entities the peer already knows).
  Its band gives its update interval. Games combine the policy with others:
  `anyOf(ownerInterest(), streamInterest())`.
- **`replicate.range` defaults to `simulate`.** A peer can then see a zombie across a field, at
  `far` level, without loading the cells in between at `full`. The server simulates everything a
  peer can see.

### Determinism

A cell must be the same bits in Node, Chrome, Firefox and Safari, and engines differ in the last
place of `Math.sin`, `Math.exp` and the like. A matching `codeHash` can't catch that, because the
code is the same and only the engine differs.

- **Allowed math** in a cell or secrets generator:
  - `+ - * /`, `Math.sqrt`, `Math.fround` and `Math.imul`, which IEEE 754 or the language define
    exactly;
  - `Math.floor`, `ceil`, `round`, `trunc`, `abs`, `sign`, `min` and `max`;
  - `ctx.rng`, `ctx.noise` and shard-noise's planar sampling (its WASM kernel is exact);
  - `@aethervtt/shard-mesh`'s deterministic module: `dsin`, `dcos` and `sinCos` (existing), and
    `datan2`, `dexp`, `dlog` and `dpow`, built from the allowed operations.
- **Enforced.** A partition refuses a cell or secrets generator without `deterministicMath: true`
  (`partition/nondeterministic-generator`). With it (0042's guard, extended), `Math.sin`, `cos`,
  `tan`, their inverses and hyperbolics, `atan2`, `exp`, `expm1`, `log*`, `pow`, `cbrt` and
  `hypot` throw `procgen/nondeterministic`, naming the function and suggesting a replacement.
  `**` can't be trapped; `shard check` flags it in modules that define these generators, except
  exponents 0, 1 and 2 and `2 ** n` with an integer literal. `ctx.rng.gaussian()` uses
  `Math.log` and `Math.cos`, so it throws there too.
- **Checked live.** The divergence check above catches anything the guard misses, per cell and per
  engine.

### API sketch

```ts
import { cellHash, cellParams, definePartition, PartitionInstance, partitionPlugin,
  StreamingSource } from '@aethervtt/shard-partition'
import { partitionNet, partitionNetPlugin, streamInterest } from '@aethervtt/shard-partition/net'

export const TownCell = defineGenerator('zomboid/TownCell', {
  params: { ...cellParams(['full', 'far']), plan: t.handle('Data') },
  output: 'entities', version: 3, deterministicMath: true,
  run(ctx, p) { /* p.x, p.z, p.level → FragmentEntity[] in partition space */ },
})
const town = definePartition('town', { grids: [{ name: 'town', generator: TownCell, … }] })

// build(app): app.addPlugin(partitionPlugin()); app.addPlugin(partitionNetPlugin())
const interest = anyOf(ownerInterest(), streamInterest())
project.net(partitionNet({ interest, replicate, players }))
world.spawn([PartitionInstance, { partition: town, seed: 1234, secretSeed }])   // server
world.spawn([StreamingSource, {}], [Replicated, { owner: peer }], …)          // each player

await cellHash(world, 'town', 3, -2, 'far')   // sha256 of the canonical fragment, for checks
```

`partitionNet(options)` returns the options with its command, events, `replicate(StreamingSource)`
and the `bind` hook added. `partitionNetPlugin` does nothing in a build without the net plugin, so
one project serves single player and multiplayer.

### Changes outside the partition package

These are limited to what streaming can't do without.

- **net:** `RelevanceSet.add(entity, every = 1)`, where the smallest interval wins when several
  policies add an entity. The server sends an entity's unreliable state only every `every` network
  ticks (reliable changes are never delayed), and a reliable `rate` section tells the client the
  interval when it changes. Client interpolation delays each entity by
  `max(delay, every × ticksPerNet + jitter)`, so sparse samples interpolate instead of holding and
  then jumping.
- **save:** `defineSaveSection(name, { capture, restore, owns })`, called by `captureGame` and
  `loadGame` (restored before instances settle). Entities a section `owns` (cell roots, generated
  children, `CellBound` entities), and their descendants, stay out of `spawned` and scene diffs.
  0072's `partition` section needs it too. Fixed on the way: a `save/NoSave` entity's descendants
  were still written.
- **net:** bound entities. `Replicated.bound` marks an entity the client already has; the
  client's `bind(world, ref)` hook resolves it (a `bind` wire section, protocol version 2). The
  server sends it only components whose `replicate` entry has `visibleTo`. When it leaves
  interest, or the server despawns it, the client removes those components and keeps the entity.
  `netHarness` sets `StepMode` and settles before each step, `connect` included.
- **mesh:** `datan2`, `dexp`, `dlog` and `dpow` next to `dsin` and `dcos`.
- **procgen:** `outputHash(world, ref)`, the hash of a generated record's canonical bytes, which
  `cellHash` uses. A generator option, `deterministicMath`, extends the guard to transcendental
  `Math` functions.
- **scene:** `entityOverrides(world, instance, path)`, the per-entity piece of `currentOverrides`,
  for incremental deltas. `updateInstances(world, only?)` looks at just the instances whose
  component changed (what the frame's system does now), so its cost follows changes, not the
  number of instances: with hundreds of cell instances, a full walk on every commit was most of a
  client's frame. Asset loads still update every instance.
- **runtime:** `StepMode { deterministic, settles }` and `settleBeforeStep(world)` (above).
- **physics:** `removeBody` scanned every collider, so unloading a cell with n bodies cost
  O(n × colliders). A collider list per body (`bodyColliders`) fixes it.
- **structure and nav, from the parallel collider and navmesh branch (not built here):**
  - structure runs on a `display: false` app, producing colliders and nav sources without meshes;
  - a per-structure switch turns off collider and nav output, which `far` levels set;
  - a count-based per-frame compile budget for structure, if measuring shows a full cell's compile
    exceeds its slice (count-based keeps headless hashes deterministic);
  - nav's incremental gather and budgeted tile rebuilds, triggered by a "sources changed in these
    bounds" signal (or per-tile dirtiness) when a cell despawns;
  - a nav query for whether the tiles over given bounds are built, so a game can hold agents in a
    fresh cell;
  - an initial `maxTiles` setting, so streaming never hits `reserve`'s full rebuild, which also
    destroys the crowd.

  Structure's absolute `Wall` coordinates need no change, because fragments are in partition
  space. Cells bring colliders and nav sources as ordinary entities, and unloading despawns them.

### Agent surface

- `partition.describe`: role, budget, and per partition cells loaded by level, cells generating,
  delta count and bytes, dormant entities and last frame's ms; on a server, per peer its reported
  and committed cells.
- `partition.cell { grid, x, z }`: the cell's state, level, `cellHash` per level, delta, and
  entity counts.
- `partition.gen { partition, grid, x, z, level, seed, compare }` and
  `shard partition gen [grid] --cell 3,-2 [--level far] --seed N [--compare] [--json]`: one cell
  generated in a fresh world, its hash, entity count and time; `--compare` also generates it
  inline, off the pool, and fails if the hashes differ.
- MCP tools: `describe_partition`, `partition_cell`.
- **Errors:** `partition/generator-mismatch`, `partition/cell-out-of-range`,
  `partition/cell-diverged` (a warning), `partition/secret-in-fragment`,
  `partition/stale-delta` (a warning), `partition/generated-replicated`,
  `partition/nondeterministic-generator`, `partition/late-commit` (a deterministic commit came due
  before its cell was ready: the host didn't settle), `partition/bad-levels` (ranges that don't
  increase, or `simulate` below the first level's range), `partition/unknown-partition`,
  `partition/unknown-grid`, and `partition/cell-too-big` (0072, with file cells).

## Decisions

- **A new spec, not an amendment to 0072.** It adds generators, levels, live deltas and per-peer
  rings across six packages, and 0072 would pass 300 lines. 0072 keeps file cells and tools.
- **A cell is a `GeneratorInstance` on its root.** Worker generation, caching, path-keyed respawns
  that keep ids, and overrides already exist (0042, 0030).
- **Deltas are 0030 overrides plus 0038 entities.** That keeps one diff format, and stale paths
  and saves already work on it.
- **Fragments are in partition space.** Structure's walls are absolute, entities that change cell
  need no rebasing, and f32 holds about 1 mm at 8 km.
- **Static changes go in the delta, and dynamic entities go through replication.** Doors and
  containers change rarely and must reach every peer that has the cell, at any distance. Zombies
  move every tick and matter only within range.
- **Clients report their cells.** The server can't know a client's loaded set and levels, which
  lag behind its rings. A report is exact, and the range check bounds it.
- **A client commits a cell only with its delta.** A destroyed wall never flashes back for a
  frame. The round trip hides behind generation time.
- **Delta sync uses a rev per key.** A looted town's delta can be several KB, and resending all of
  it on every door opening would cost more than the zombies.
- **A delta records `version`, not `codeHash`.** A refactor must not invalidate saves. When the
  output really changes, the author bumps the version, and the migrate hook handles it.
- **Commits are deterministic in tests and ready in production.** Hashes stay reproducible, and a
  live server never stalls on disk or worker timing.
- **Update intervals live in net, not in the policy's priority.** Priority only orders sends when
  bandwidth runs out. A far zombie should cost fewer sends even when bandwidth is plentiful.
- **The server loads only the first level.** It simulates and doesn't draw, so far levels are a
  client concern.
- **Secrets come from a server-only seed, not from stripping.** A client runs the generator, so
  leaving fields out of what it receives hides nothing; it must lack the input.
- **Reveal through bound replication.** 0087's `visibleTo` already decides per peer and per
  component, and binding to the generated entity sends no generated content.
- **Guard transcendental `Math`, don't reimplement the engine's.** Throwing at the first call finds
  the problem on the author's machine; the live hash check finds what slips through, before a
  player reports a wall that isn't there.
- **The player is a client's source.** It's what the server checks requests against, so the two
  can't disagree, whatever the camera does.
- **Deterministic stepping is the host's statement (`StepMode`), not the partition's guess.** The
  same project runs `ready` under `shard server` and deterministic under `shard run`, with no
  setting to forget.
- **Bound entities wait for the client's commit report.** Otherwise a bind can arrive in the same
  message as the cell's delta, before the client has the entity, and is lost.

## Acceptance criteria

Headless with no GPU unless a criterion says otherwise. The fixture,
`partition/src/fixtures/town.ts` (exported as `@aethervtt/shard-partition/testing`), defines
`test/TownCell`: 64 m cells, buildings of box-collider walls with `NavSource`, props, doors and
crates, and a `far` level of shells only; `test/TownLoot` is its secrets generator. Net tests use
`netHarness` with a server and one or two clients. Files are under `packages/partition/src/`
unless named.

- [x] `cellHash` of 20 cells at both levels is identical on a server app and on a client app. It
      is also identical inline, on the worker pool, in a second Node process, and in Chrome,
      Firefox and WebKit (`hash.test.ts`; `apps/playground/src/partition-hash.test.ts`, which
      `browser.yml` runs with all three engines installed).
- [x] A cell generator that calls `Math.sin` fails with `procgen/nondeterministic` naming it. A
      client whose cell hash differs (forced in a test) makes the server log
      `partition/cell-diverged` with the cell and level, and the session continues (`hash.test.ts`,
      `net.test.ts`).
- [x] A client's generated fragments and the deltas it receives contain no `Contents` component,
      even after a container is emptied. A peer receives a container's `Contents` only once the
      game's `visibleTo` reveals it, and loses it when the reveal ends; the container entity stays
      (`net.test.ts`).
- [x] A client's free camera, with a source of its own 1 km from its player, makes it load no cell
      beyond its player's rings, and no request is refused (`net.test.ts`).
- [x] A player walks 1 km across the fixture at 30 m/s, so cells load, unload and change level
      (on both sides, with physics colliders, generation on the worker pool). During the walk no
      frame's main-thread time exceeds `partition/walk-frame` on the server or a client (GC pauses
      subtracted, as in 0042), streaming's own time stays under `partition/stream` at p95, and no
      frame's commits take over `partition/cell-commit` (`perf.test.ts`).
- [x] Walking back and forth across a cell border (±10 m) for 60 s unloads no cell and changes no
      level (`stream.test.ts`).
- [x] Two players 1 km apart: the server has both sets of cells loaded. Neither client receives an
      entity whose cell it hasn't reported, the other player included, checked every tick for 90
      ticks; no generated entity reaches a client except bound for its secrets (`net.test.ts`).
- [x] A zombie 130 m from a client (inside `replicate.range`, outside the `full` ring) reaches
      that client with an interval of 4 network ticks, one at 20 m with 1, and the far one's
      interpolated position moves on all but at most 2 of 40 frames while it moves (`net.test.ts`;
      the 30 ± 1 sends in 120 ticks are `net/src/streaming.test.ts`).
- [x] After a cell unloads and reloads, a removed crate stays removed, a moved prop stays moved, an
      opened door stays open, and an added item and a zombie (dormant while unloaded) are back
      (`stream.test.ts`). All of this also holds after `captureGame` on a server and `loadGame` into
      a new server app, for a cell unloaded and a cell loaded at save time (`persistence.test.ts`).
      A wall removed on the server disappears on a client that has that cell at `far` level
      (`net.test.ts`).
- [x] A zombie that walks from cell 0 into cell 1 belongs to cell 1, and stays when cell 0
      unloads. One that walks into a cell nobody simulates (drawn at `far`) becomes dormant there,
      and is back when that cell loads at `full` (`persistence.test.ts`).
- [x] An untouched cell's delta message is under 32 bytes (`perf.test.ts`).
- [x] A delta made with generator version 1 applies to version 2 after a save and a load: surviving
      paths apply, a missing path warns `partition/stale-delta` and stays in the delta, and the
      migration runs once (`persistence.test.ts`). A client whose generator `codeHash` differs is
      refused with `partition/generator-mismatch` (`net.test.ts`).
- [x] Recomputing deltas for 100 changed entities takes under `partition/delta-update`, and a
      client applies a 100-entry delta in under `partition/delta-apply` (`perf.test.ts`).
- [x] `shard run --net clients=2 --frames 600` on the fixture project
      (`packages/partition/fixtures/streamed-town`), run twice, prints identical hashes for the
      server and both clients, and each client sees only its own player (`cli.test.ts`; ten runs
      in a row matched while building it). `shard partition gen` hashes a cell the same inline and
      on the pool.

## As built

Measured on an Apple M5 Max (2026-11-12), which is neither named machine; the budgets keep room
for the laptop, and `budgets.json` notes say so.

| Measure | Server | Client | Budget |
|---|---|---|---|
| Worst frame in the 1 km walk | 1.9 ms | 1.8 ms | `partition/walk-frame` 8 |
| Streaming per frame, p95 | 0.26 ms (both) | | `partition/stream` 2 |
| A frame's commits, worst | 1.06 ms (243 entities) | | `partition/cell-commit` 3 |
| 100 changed entities' delta keys | 0.39 ms | | `partition/delta-update` 1 |
| A 100-entry delta applied | | 0.17 ms | `partition/delta-apply` 0.5 |

- `partition/cell-commit` was proposed per entity. The cost is mostly per cell, so it's a frame
  target. The walk swaps 148 levels and unloads 302 cells.
- Before `updateInstances` took `only`, the client's worst frame was 14.9 ms and streaming p95
  3.2 ms: every commit walked every cell instance. Batching commits into one pass, then making the
  pass incremental, brought them to the numbers above.
- `shard run --net` first gave a client a different hash one run in four: a Prefab landing between
  steps respawned instances there, so entity ids came out in another order. Scene now defers that
  respawn to the frame under `StepMode.deterministic`.
- Nav and structure aren't in the fixture's apps (the parallel branch reworks both); the fixture's
  walls carry `nav/NavSource` for when they are.

## Open questions

- **Cell size.** Proposed: 64 m. It's 5 nav tiles of 12.8 m and about a town block, a full cell
  stays under 2000 entities, and a 4 km county is about 3,900 cells, of which only the touched ones
  cost storage. To confirm against the house generator's density.
- **A floating origin.** Proposed: none for a county. f32 keeps about 1 mm at 8 km, enough for
  physics and for rendering through 0040's camera-relative path. A larger world would make the
  partition root a 0040 `Grid` with `FloatingOrigin`, which shifts every cell together, so cells
  need no offsets of their own.
- **What a client shows while a cell generates.** Proposed: the previous level keeps drawing until
  the new one is ready. Cells are requested at `far` from 1.25 × the far range, so a cell entering
  the `full` ring almost always swaps up from `far` rather than appearing from nothing. A cell
  drawn for the first time (at spawn, or after a teleport) shows nothing until it commits; games
  hide that with fog or a loading screen, and `partitionSettled` says when it's done.
- **Zombies beyond the replication range.** `replicate.range` defaults to `simulate` (160 m), but
  `far` draws to 512 m, so a horde 300 m away across a field is invisible. Accepted here. A cheap
  far representation (counts and positions per cell, drawn as instanced crowds, as in Unreal's
  Mass) is the hordes spec's job, built on the dormant hook. Streaming doesn't cover it.
- **The view distance a client can afford.** Proposed: start `far` at 512 m, which is about 200
  far cells. Measure draws and memory on the laptop with the house generator's shells before
  raising it. HLOD (0073) is the third level after that.
