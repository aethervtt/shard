# 0053 — Deterministic physics and recorded tracks

- **Status:** accepted
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

`loadRapier(dim, { deterministic })` caches one module per `(dim, variant)`. Two variants can live
on one page: the game uses the regular build, the dice worker uses the deterministic one. The
plugin option picks the variant. Behavior and API are otherwise the same, and a test runs 0028's
suite against both variants.

The render-facing parts of 0028 (the collider overlay, `Mesh` handle resolution) move to
`@aethervtt/shard-physics/render`, which the plugin imports. `@aethervtt/shard-physics/track` imports only
`@aethervtt/shard-core` and Rapier.

### Track scenes

```ts
interface TrackScene {
  version: 1
  dim: 3
  step: number                        // seconds, e.g. 1 / 60
  maxSteps: number
  gravity: Vec3
  fixed: TrackCollider[]              // floor, walls
  bodies: TrackBody[]                 // recorded, in this order
  groups?: { [name: string]: { layers: number; mask: number } }
}
interface TrackBody {
  id: string
  translation: Vec3; rotation: Quat; linear: Vec3; angular: Vec3
  colliders: TrackCollider[]
  ccd?: boolean; canSleep?: boolean; linearDamping?: number; angularDamping?: number
}
interface TrackCollider {
  shape: 'ball' | 'cuboid' | 'convex'  // convex: points, already scaled
  radius?: number; halfExtents?: Vec3; points?: Float32Array
  friction: number; restitution: number; density: number; group?: string
}
```

The caller computes initial velocities and orientations itself (dice do this from a seeded `Rng`),
so the recorder never draws random numbers.

### Recording

```ts
const track = await recordTrack(scene, {
  signal,                              // AbortSignal
  settle: (s: SettleView) => 'continue' | 'done' | TrackPhase,
  contacts: { minForce: 0.5, dedupeSteps: 3, max: 1024 },
})
```

The recorder builds a Rapier world in body order, steps it, and writes every body's pose each step,
including step 0. Every step it calls `settle` with a `SettleView`: the step index, each body's
sleeping flag, and a no-allocation `pose(i, outPos, outRot)`. `settle` can end the track, or
return a `TrackPhase`: `{ disableGroups?: string[], wake?: true }`. Dice use a phase for their
"cocked die" cleanup: walls off, die-to-die contacts off, all bodies woken. The world is freed in
`finally`.

Stepping runs in chunks of 64 steps. Between chunks the recorder yields a macrotask and checks the
signal, so cancellation takes at most one chunk (well under 10 ms). An aborted recording rejects
with `physics/track-cancelled`. A pose that isn't finite fails with `physics/track-diverged`
naming the body and the step.

### Track format

```ts
interface Track {
  version: 1
  engine: string                       // 'rapier3d-deterministic@0.20.0'
  sceneHash: number                    // hash32 of the canonical TrackScene
  step: number; steps: number; bodyCount: number
  settled: boolean; maxStepsHit: boolean
  positions: Float32Array              // (steps + 1) × bodies × 3, step-major
  rotations: Float32Array              // (steps + 1) × bodies × 4
  contacts: { steps: Uint16Array; a: Int16Array; b: Int16Array; force: Float32Array }  // b = -1: fixed
  simulationMs: number                 // excluded from equality and hashing
}
encodeTrack(track): ArrayBuffer; decodeTrack(buf): Track   // one buffer, header + arrays
trackHash(track): number                                   // over the arrays and header
sampleTrack(track, time, body, outPos, outRot): void       // lerp + slerp, no allocation
```

A consumer that sees a different `engine` or `version` than it expects fails with
`physics/track-version` instead of playing a track that might be wrong.

### Workers

The platform worker pool (`@aethervtt/shard-platform` `Workers`) doesn't fit, for two reasons. Its job
modules are plain JavaScript loaded by URL with no bundler, so they can't import Rapier's JS glue.
It also has no way to cancel a job. Tracks therefore get a dedicated worker, built by the host's
bundler:

- `@aethervtt/shard-physics/worker` exports `trackWorker()`, which is
  `new Worker(new URL('./track-worker.ts', import.meta.url), { type: 'module' })`. Vite and
  webpack both recognize that literal pattern and bundle the entry with Rapier inside it. A host
  with another bundler passes its own `spawn`.
- In Node and in tests, `spawn: 'inline'` runs the same code on the calling thread. The
  cancellation checks still work, because they happen at the chunk yields.

```ts
const client = createTrackClient({ spawn: trackWorker })   // or 'inline'
await client.ready()                                 // loads the WASM; call early to warm it
const track = await client.record(scene, { signal })
client.dispose()
```

The messages are `init`, `record { id, scene }`, `cancel { id }` and `dispose`; the replies are
`ready`, `track { id, buffer }` (transferred) and `error { id, code, message }`. `settle` can't
cross a thread boundary as a function, so worker recordings name a settle rule and pass its
parameters as data. A worker entry is `serveTracks({ rules })`: the default entry registers
`sleep` (done when every body sleeps), and a package with its own rule ships its own entry, as
dice do (0054) with `serveTracks({ rules: { 'dice-settle': diceSettle } })`. A worker crash
rejects everything pending with `physics/worker-crashed` and respawns on the next call.

### API sketch

```ts
physics3dPlugin({ deterministic: true })
import { recordTrack, sampleTrack, encodeTrack, trackHash } from '@aethervtt/shard-physics/track'
import { createTrackClient, serveTracks, trackWorker } from '@aethervtt/shard-physics/worker'
```

### Agent surface

- `physics.describe` reports the variant (`regular` / `deterministic`).
- `shard track <scene.json> --out track.bin --json` records a track headless and prints its hash,
  steps and settle state, so an agent can check determinism from the CLI.

## Decisions

- **A plain scene description, not the ECS world.** The recorder must run in a Worker without the
  engine, and a description is what makes the input hashable and the output reproducible.
- **Chunked stepping with a yield for cancellation.** A worker can't receive a message mid-loop,
  and `SharedArrayBuffer` needs COOP/COEP headers that a host app may not send. `terminate()` stays
  as the last resort for a hung worker, with a WASM reload cost.
- **A dedicated worker, not the platform pool.** The pool's no-bundler modules can't carry Rapier,
  and one long, cancellable job per request doesn't need a pool's queue.
- **Keep f32 full-rate tracks.** 32 bodies × 481 steps × 28 bytes is 431 KB, transferred rather
  than copied. Quantization can come later if a consumer stores tracks.

## Acceptance criteria

- [ ] 0028's physics tests pass on both the regular and the deterministic variant.
- [ ] The same `TrackScene` gives the same `trackHash` across 10 runs, in the inline recorder and
      in a worker, and it matches a golden hash committed in the test.
- [ ] The golden hash matches in Node and in Chromium (the `#dice` demo prints it; the check is
      recorded here when this spec is implemented).
- [ ] 32 convex bodies over 480 steps record in under 100 ms in `pnpm bench`.
- [ ] Cancelling mid-recording rejects within 10 ms with `physics/track-cancelled`, and the
      worker's next recording succeeds.
- [ ] A crashed worker rejects its pending recordings with `physics/worker-crashed`, and the next
      call respawns it.
- [ ] `@aethervtt/shard-physics/track` bundles with no `@aethervtt/shard-render` or `@aethervtt/shard-gpu` code (checked by 0056's
      size script).
- [ ] `sampleTrack` allocates nothing over 10k calls (heap check in the bench).

## Open questions

- Should 2D get tracks too? Proposed: the format supports `dim: 2`, but only 3D is built now.
