# 0053 — Deterministic physics and recorded tracks

- **Status:** implemented
- **Packages:** `@aethervtt/shard-physics`, `apps/cli`
- **Depends on:** 0028

## Context

0028 uses `@dimforge/rapier3d-compat`, which is deterministic only on one build and platform. It
runs synchronously in `FixedUpdate`, and it imports `@aethervtt/shard-render` for meshes and the collider
overlay. That's right for a game, but not for server-authored dice.

Aether rolls on the server and animates on every client. Its client simulates the throw with
`@dimforge/rapier3d-deterministic-compat@0.20.0` in a Worker, records every body's pose at every
fixed step (a *track*), and then plays the track back while rotating each die's mesh by a symmetry
so the up face is the server's value. That contract has to survive any move to Shard: same
version of Rapier, off the main thread, with results that don't depend on the machine.

Recording a track is also generally useful: replays, cutscenes baked from physics, and previewing
a throw before committing to it.

## Goals

- `deterministic: true` on `physics3dPlugin` / `physics2dPlugin`, backed by Rapier's
  deterministic builds (same 0.20.0 API).
- `@aethervtt/shard-physics/track`: record a track from a plain scene description. No ECS, no renderer, and
  it runs in a Worker, in Node, or inline.
- A versioned, binary, transferable track format, plus no-allocation sampling.
- A worker client with cancellation, crash restart and disposal.
- `@aethervtt/shard-physics`'s simulation code stops importing `@aethervtt/shard-render`.

## Non-goals

- Rollback netcode and world snapshots. A track is output, not resumable state.
- Running the ECS `FixedUpdate` physics on a worker. It stays synchronous (0028).
- Deterministic float math outside Rapier. Scene descriptions carry already-computed numbers.

## Design

### Deterministic builds

The plugins take options, so they're factories now: `physics3dPlugin()` and
`physics3dPlugin({ deterministic: true })` (every call site changed). `loadRapier(dim,
{ deterministic })` caches one module per `(dim, variant)`, with one literal `import()` per build
so each is its own lazy chunk. Two variants can live on one page: the game uses the regular build,
the dice worker uses the deterministic one. Tracks load through `loadDeterministic3d()`, which
references only that build. `PhysicsWorld.variant` says which one runs, and 0028's suite
(`physics.test.ts`) runs against both.

The render-facing parts of 0028 (the collider overlay, `Mesh` handle resolution) move to
`@aethervtt/shard-physics/render`, which the plugin imports and lists in `provides`. `PhysicsWorld` takes a
`MeshLookup` instead of reading `Meshes` itself. `@aethervtt/shard-physics/track` imports only
`@aethervtt/shard-core` and Rapier.

### Track scenes

```ts
interface TrackScene {
  version: 1
  dim: 3
  step: number                        // seconds, e.g. 1 / 60
  maxSteps: number                    // at most 65535 (contact steps are u16)
  gravity: Vec3
  fixed: TrackCollider[]              // floor, walls
  bodies: TrackBody[]                 // recorded, in this order; at most 32767 (contacts are i16)
  groups?: { [name: string]: { layers: number; mask: number } }
}
interface TrackBody {
  id: string                          // unique; errors name it
  translation: Vec3; rotation: Quat; linear: Vec3; angular: Vec3
  colliders: TrackCollider[]
  ccd?: boolean; canSleep?: boolean; linearDamping?: number; angularDamping?: number
}
interface TrackCollider {
  shape: 'ball' | 'cuboid' | 'convex'  // convex: points, already scaled
  radius?: number; halfExtents?: Vec3; points?: Float32Array
  translation?: Vec3; rotation?: Quat  // offset on a body; a fixed collider's place in the world
  friction: number; restitution: number; density: number; group?: string
}
```

Colliders need a pose (a floor and walls have to be somewhere), so `TrackCollider` has
`translation` and `rotation`. Groups are 16-bit layer and mask bits, as in 0028; a collider with no
group collides with everything. `checkTrackScene` fails with `physics/track-scene` and a `path` to
the first bad field. `trackSceneToJson` / `trackSceneFromJson` turn convex points into arrays and
back, for files and the CLI.

The caller computes initial velocities and orientations itself (dice do this from a seeded `Rng`),
so the recorder never draws random numbers.

### Recording

```ts
const track = await recordTrack(scene, {
  signal,                              // AbortSignal
  settle: (s: SettleView) => 'continue' | 'done' | TrackPhase,   // default: done when all sleep
  contacts: { minForce: 0.5, dedupeSteps: 3, max: 1024 },        // default: none recorded
})
```

The recorder builds a Rapier world, fixed colliders then bodies in order, steps it, and writes
every body's pose each step, including step 0. After each step it calls `settle` with a
`SettleView`: `step`, `bodyCount`, a `sleeping` `Uint8Array`, and a no-allocation
`pose(i, outPos, outRot)`. `settle` can end the track, or return a `TrackPhase` once, applied
before the next step:

```ts
interface TrackPhase { groups?: { [name: string]: TrackGroup }; disableGroups?: string[]; wake?: true }
```

A disabled group collides with nothing; `groups` gives groups new layers and masks. Dice use a
phase for their "cocked die" cleanup: walls disabled, the dice group's mask without the dice layer
(no die-to-die contacts), all bodies woken. Only disabling groups couldn't express "dice stop
touching each other but still touch the floor", hence `groups`. The world is freed in `finally`.

Contacts come from Rapier's contact force events on body colliders, over `minForce`. A pair seen
touching within `dedupeSteps` of the last time is the same contact; `a < b`, and `b` is -1 for a
fixed collider.

Steps run in chunks of at most 64 steps or 4 ms, whichever comes first. Between chunks the
recorder yields a macrotask (`setImmediate` in Node, a `MessageChannel` elsewhere: `setTimeout`
clamps to 4 ms) and checks the signal, so cancellation takes at most one chunk. An aborted
recording rejects with `physics/track-cancelled`. A pose that isn't finite fails with
`physics/track-diverged` naming the body and the step.

### Track format

```ts
interface Track {
  version: 1
  engine: string                       // 'rapier3d-deterministic@0.20.0', from Rapier's version()
  sceneHash: number                    // of the canonical TrackScene
  step: number; steps: number; bodyCount: number
  settled: boolean; maxStepsHit: boolean
  positions: Float32Array              // (steps + 1) × bodies × 3, step-major
  rotations: Float32Array              // (steps + 1) × bodies × 4
  contacts: { steps: Uint16Array; a: Int16Array; b: Int16Array; force: Float32Array }  // b = -1: fixed
  simulationMs: number                 // excluded from equality and hashing
}
encodeTrack(track): ArrayBuffer; decodeTrack(buf, { engine? }): Track  // one buffer, header + arrays
trackHash(track): number                                   // over the arrays and header
sampleTrack(track, time, body, outPos, outRot): void       // lerp + slerp, no allocation
```

The buffer is a 52-byte little-endian header, the engine name padded to 4 bytes, then positions,
rotations and contact forces, then the 16-bit contact arrays, so every array is aligned and
`decodeTrack` returns views on the buffer rather than copies. A buffer that isn't a track, or is
cut off, fails with `physics/track-invalid`.

`sceneHash` and `trackHash` are 32-bit FNV-1a over 32-bit words (numbers by their bits, -0 as 0),
finished with `mix32`. Core's `hash32` is a lattice hash for noise, not a buffer hash. The scene
hash is canonical: defaults filled in, groups sorted by name.

`decodeTrack` fails with `physics/track-version` on a different `version`, or on an `engine`
other than `TRACK_ENGINE` (pass `engine: null` to accept any), instead of playing a track that
might be wrong. The client decodes this way, so a stale worker bundle is caught.

`sampleTrack` clamps `time` to the track, slerps (normalized lerp when two rotations are nearly
equal), and fails with `physics/track-body` for a body the track doesn't have.

### Workers

The platform worker pool (`@aethervtt/shard-platform` `Workers`) doesn't fit, for two reasons. Its job
modules are plain JavaScript loaded by URL with no bundler, so they can't import Rapier's JS glue.
It also has no way to cancel a job. Tracks therefore get a dedicated worker, built by the host's
bundler:

- `@aethervtt/shard-physics/worker` exports `trackWorker()`, which is
  `new Worker(new URL('./track-worker.ts', import.meta.url), { type: 'module' })`. Vite and
  webpack both recognize that literal pattern and bundle the entry with Rapier inside it. Vite 8
  emits it as one file with Rapier's dynamic import inlined, with no worker config. A host with
  another bundler passes its own `spawn`.
- `spawn: 'inline'` runs the same server on the calling thread, replies delivered as microtasks,
  so encoding, decoding and errors take the same path as in a worker. The cancellation checks
  still work, because they happen at the chunk yields.
- `spawn` returns a `TrackWorkerLike` (`postMessage`, `addEventListener`, `terminate`), which a DOM
  `Worker` is. Node's `worker_threads` needs a small adapter; the tests use one, with tsx.

```ts
const client = createTrackClient({ spawn: trackWorker })   // or 'inline'
await client.ready()                                 // loads the WASM; call early to warm it
const track = await client.record(scene, { signal, settle: { rule: 'sleep' }, contacts })
client.dispose()
```

The messages are `init`, `record { id, scene, settle, contacts }`, `cancel { id }` and `dispose`;
the replies are `ready { engine }`, `track { id, buffer }` (transferred) and
`error { id, code, message, hint, path }` (`id` null when `init` failed). The worker records one
track at a time and queues the rest; cancelling a queued one removes it.

`settle` can't cross a thread boundary as a function, so worker recordings name a settle rule and
pass its parameters as data. A rule is `(params) => Settle`, called once per recording. A worker
entry is `serveTracks({ rules, scope? })`, which always has `sleep` (done when every body sleeps);
a package with its own rule ships its own entry, as dice do (0054) with
`serveTracks({ rules: { 'dice-settle': diceSettle } })`. An unknown rule rejects with
`physics/unknown-settle-rule`.

Aborting a recording's signal rejects it at once on the calling side and posts `cancel`; the
worker stops at its next chunk yield, so the next recording doesn't wait behind it. A worker
`error` or `messageerror` event, or a failed `init`, rejects everything pending with
`physics/worker-crashed`, and the next call spawns another (`client.spawns` counts them).
`dispose()` terminates the worker and rejects what's pending with `physics/track-cancelled`; later
calls fail with `physics/track-client-disposed`.

### API sketch

```ts
physics3dPlugin({ deterministic: true })
import { recordTrack, sampleTrack, encodeTrack, trackHash } from '@aethervtt/shard-physics/track'
import { createTrackClient, serveTracks, trackWorker } from '@aethervtt/shard-physics/worker'
import { collidersOverlay, rendererMeshes } from '@aethervtt/shard-physics/render'
```

### Agent surface

- `physics.describe` reports the variant (`regular` / `deterministic`).
- `shard track <scene.json> --out track.bin --json` records a track headless and prints its hash,
  scene hash, steps, settle state and contact count, so an agent can check determinism from the
  CLI. The file is a `TrackScene`, or a recording `{ scene, contacts }`;
  `shard track packages/physics/src/track/golden.json` prints the golden hash.

### Demo

The playground's embedding page (0052) rolls its dice through tracks: **roll dice** records in the
worker and plays the track back on the transparent canvas, holding a `dice-track` frame demand
until it ends. **live roll** is the old ECS roll on the regular build, on the main thread, so both
builds run on one page. **cancel a roll** aborts a long recording and prints how soon it rejected
and how soon the next roll recorded. The HUD records the golden track at startup and compares its
hash with Node's. The dice app owns the client, so its 20 mount/unmount cycles also start and
terminate 20 workers.

## Decisions

- **A plain scene description, not the ECS world.** The recorder must run in a Worker without the
  engine, and a description is what makes the input hashable and the output reproducible.
- **Chunked stepping with a yield for cancellation.** A worker can't receive a message mid-loop,
  and `SharedArrayBuffer` needs COOP/COEP headers that a host app may not send. `terminate()` stays
  as the last resort for a hung worker, with a WASM reload cost. Chunks end at 4 ms as well as at
  64 steps, so a big scene cancels as fast as a small one.
- **A dedicated worker, not the platform pool.** The pool's no-bundler modules can't carry Rapier,
  and one long, cancellable job per request doesn't need a pool's queue.
- **Keep f32 full-rate tracks.** 32 bodies × 481 steps × 28 bytes is 431 KB, transferred rather
  than copied. Quantization can come later if a consumer stores tracks.
- **Plugin factories.** Options need a call; a constant with a callable twin would be two ways to
  say one thing. Every other configurable plugin is already a factory.
- **Worker entries don't count as modules to scan.** 0056's provides test imports every source
  module; `*-worker.ts` entries start serving when imported, so it skips them. They register
  nothing.

## Acceptance criteria

- [x] 0028's physics tests pass on both the regular and the deterministic variant.
- [x] The same `TrackScene` gives the same `trackHash` across 10 runs, in the inline recorder and
      in a worker, and it matches a golden hash committed in the test (`0x5d32645f`; the scene and
      options are in `src/track/golden.json`).
- [x] The golden hash matches in Node and in Chromium. Checked 2026-09-28 on Windows: the
      embedding demo's worker prints `5d32645f` in both the dev server and a production build.
- [x] 32 convex bodies over 480 steps record in under 100 ms in `pnpm bench`.
- [x] Cancelling mid-recording rejects within 10 ms with `physics/track-cancelled`, and the
      worker's next recording succeeds (without waiting behind the cancelled one).
- [x] A crashed worker rejects its pending recordings with `physics/worker-crashed`, and the next
      call respawns it.
- [x] `@aethervtt/shard-physics/track` bundles with no `@aethervtt/shard-render` or `@aethervtt/shard-gpu` code (the `physics-track`
      size fixture; `budgets.json` forbids both packages in it).
- [x] `sampleTrack` allocates nothing over 10k calls (heap check in the bench).

## Open questions

- Should 2D get tracks too? Deferred: `TrackScene.dim` is only 3, and nothing needs 2D tracks yet.
  The deterministic 2D build exists for `physics2dPlugin({ deterministic: true })`.
