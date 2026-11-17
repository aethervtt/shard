# 0128 — One-off particle bursts

- **Status:** draft (built 2026-11-16). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-particles`, `@aethervtt/shard-project` (docs skill)
- **Depends on:** 0026, 0064

## Context

An effect spawns by rate (`ParticleEmitterOverrides.spawnRate`) or by bursts authored in its file,
always at its `ParticleSystem`'s transform. Gameplay often needs "throw 30 droplets here, this
way, now": a body diving into the sea, a crate dropped in, an axe hitting wood, a footstep in sand.

Stranded's spray (`apps/game/scripts/splash/spray.ts`, its spec 0004) keeps eight world-space
emitters per floating hull, moves them to the waterline each frame and sets their rate. That fits
continuous spray. A one-off splash would mean keeping spare emitters, moving one to the spot,
setting a rate for one frame and putting it back, with a pipeline and a buffer per spare.

## Goals

- `emitParticles(world, effect, { position, direction, count, seed? })` spawns `count` particles of
  each of the effect's emitters at `position` this frame, in world space, with the emitter's shape
  turned to point along `direction`.
- No entity per call. Every burst of an effect shares one simulation per backend, and a frame's
  bursts spawn in one dispatch per emitter.
- The same effect files, modules and render settings, on the GPU and CPU backends and on the
  baseline tier.
- Dozens of bursts in a frame cost about what their particles cost: nothing fixed per burst.

## Non-goals

- Bursts on a `ParticleSystem` entity, in its local space. A system that should spray where it is
  keeps its rate or authored bursts.
- Inheriting a velocity (a splash moving with the body that made it). Later: a `velocity` field
  added to every particle of the burst.
- Sub-emitters (bursts from particle deaths or collisions), still deferred by 0026.

## Design

### API sketch

```ts
interface ParticleBurst {
  position: ArrayLike<number>          // world
  direction?: ArrayLike<number>        // the shape's +y (a cone's axis); default up; any length
  count: number                        // from each emitter
  seed?: number                        // same seed, same particles; default: per burst, in call order
  emitter?: string                     // one emitter by name (empty: all)
  backend?: 'gpu' | 'cpu'              // as ParticleSystem.backend
}
emitParticles(world, effect: AssetRef<'ParticleEffect'>, burst: ParticleBurst): number  // queued
```

It returns the particles queued: 0 while the effect isn't loaded, and fewer than `count` once the
frame's bursts fill an emitter's capacity. `position` and `direction` take reused `Float32Array`s,
so a caller in a per-frame system allocates nothing but the options object it chooses to make.

### Burst pools

`ParticleStore.bursts` (and `cpuBursts`) hold one `SystemState` per effect guid: the effect's
**pool**. It's an ordinary running system with no entity, an identity transform, `space: world`
and no culling radius, so it reuses the buffers, sort, draw, describe and floating-origin code of
0026. The first `emitParticles` of an effect makes its pool; the pool lives while the effect is in
`ParticleEffects` and keeps its particles across a hot reload, as systems do.

Each pool emitter has a **burst queue**: 12 floats a burst (origin and seed, the shape's x axis and
the burst's first index in the frame, its y axis and count), grown by doubling. The rotation is the
shortest arc from +y to `direction` (Rodrigues; straight down is half a turn about x), so `up`
spawns exactly as a `ParticleSystem` with no rotation does.

Per frame (`particles/prepare`): the spawn count is the queued total; the queue goes to a storage
buffer in one `writeBuffer`. The `particles/simulate` node runs the emitter's burst variant of its
compute module (the same WGSL as 0026 with a different `spawn` entry and a fifth binding): one
thread per new particle over every burst, each finding its burst by binary search on the first
indices, then spawning the shape in that burst's frame. Slots are the ring of 0026 (`k % capacity`),
and a particle's random stream is `pcg(burst seed ^ pcg(i))`, i its index in the burst, so the CPU
backend reproduces the GPU's particles. A frame the pipelines are still compiling keeps its bursts
for the next frame; bursts emitted after prepare wait for the next frame too.

A pool emitter whose last particles have outlived `lifetime[1]` neither simulates, sorts nor
draws, and stops holding the frame demand (0052). Its own `rate` and authored bursts never run.

### Agent surface

- `render.describe` → `particles.bursts`: per pool, the effect, backend, bursts emitted so far and
  each emitter's alive count, capacity and spawned total.
- The docs skill `make-particles.md` names `emitParticles`.

## Decisions

- **A function by effect, not a command on a system.** Gameplay knows the effect and the spot, not
  a system entity; a splash from a dive needs nothing placed beforehand. A burst on a system would
  inherit its transform and space, which is what its rate already gives.
- **One pool per effect and backend, made on first use.** Bursts of one effect share a simulation
  (one pipeline, one particle buffer, one dispatch), so the cost is per effect and per particle.
  The capacity in the file bounds a frame's bursts and the ring recycles the oldest, as 0026's does.
- **The queue is data, the frame is per burst, not per particle.** 48 bytes a burst; the shader
  finds a thread's burst in log₂(bursts) steps. Uploading a rotation per particle would cost the
  CPU what the GPU should do.
- **A burst variant of the compute module, not a branch in the shared one.** Systems keep their
  WGSL byte-identical (checked with `scripts/wgsl-identity.mjs`), and pools pay no uniform branch.
  `Sim` gives its last float to the burst count in the variant, so both read the same 336 bytes.
- **Pools live with their effect.** Freeing an idle pool would make a splash every few seconds
  allocate buffers and bind groups again. An idle pool costs its buffers and nothing per frame.

## Acceptance criteria

- [x] Bursts at three places in one frame (including straight down) each spawn their count at their
      point, every particle heading along the burst's direction within the 15° cone, on the GPU
      backend, the CPU backend, and the baseline tier; the spawn-time values match across all three.
      No entity is made, and the effect's rate and authored burst don't run (`bursts.test.ts`).
- [x] Later bursts land in the same simulation; a burst emitted after prepare spawns the next
      frame; the pool releases the frame demand once its particles die.
- [x] 50 bursts of 30 particles in one frame: the `emitParticles` calls plus `particles/prepare`
      take under `particles/bursts` (median frame, `pnpm bench`).

## Implementation notes

- `sim.ts`: `emitParticles`, the queue, pools (`prepareBursts`), and the nodes and describe over
  systems and pools; `shaders.ts`: `simulationShader(def, bursts)`.
- Measured on an Apple M5 Max (not a named machine, under heavy load), median frame, GPU backend:
  50 × 30 particles 0.12 ms, 1 × 1,500 particles 0.11 ms, so about 0.25 µs per extra burst. CPU
  backend: 1.15 ms and 1.12 ms, nearly all of it simulating the 2,048-particle capacity. The
  budget proposes 0.25 ms for both named machines; neither has run it yet.

## Open questions

- None blocking. Deferred: a burst velocity, and bursts in a system's local space.
