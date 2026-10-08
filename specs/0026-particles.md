# 0026 — GPU particles

- **Status:** implemented
- **Packages:** `@aethervtt/shard-particles` (new), `@aethervtt/shard-render`
- **Depends on:** 0005, 0014, 0016, 0019, 0020

## Context

Ship thrusters, jetpack exhaust, dust kicked up on landing, sparks from mining, rain, snow on an
ice moon, the warp tunnel: particles carry much of what makes a space game feel alive. VISION
targets 1M GPU particles, with effects as data assets, and CPU particles for small counts or
effects tied to gameplay.

Compute shaders make this natural in WebGPU. Simulation, spawning, and culling stay on the GPU,
and draws are indirect.

## Goals

- `ParticleEffect`: a data asset of one or more emitters, each with spawn rules, initial values,
  update modules, and render settings. It's validated by schema and hot reloadable.
- A GPU simulation in compute: a fixed-capacity particle buffer per emitter, ring allocation, and
  instanced draws over the capacity. No CPU readback in the frame.
- Update modules: gravity, drag, velocity over life, curl noise, attractors and repulsors, color
  and size over life (gradients and curves), rotation, and depth-buffer collision (bounce or die).
- Rendering as billboards (camera-facing, velocity-stretched, or axis-aligned) or mesh particles.
  Blend modes are additive, alpha, or premultiplied, with soft particles (depth fade) and flipbook
  textures.
- Deterministic seeding: the same seed and frame produce the same particles on the same device.
- A CPU backend with the same effect format, for small counts and for gameplay reads (hit tests
  against particles).

## Non-goals

- Particle lighting beyond ambient and emissive (later: particles receiving cluster lights).
- Fluid simulation, ribbons and trails (trails later), GPU sorting of more than 64k particles per
  effect.
- Sub-emitters in v1: emitting from particle death or collision (later; the buffers allow it).

## Design

### Effect assets

```json
{
  "$schema": "../.shard/schemas/particle-effect.schema.json",
  "emitters": [{
    "name": "exhaust",
    "capacity": 20000,
    "spawn": { "rate": 4000, "bursts": [] },
    "shape": { "type": "cone", "angle": 8, "radius": 0.2 },
    "init": { "lifetime": [0.3, 0.6], "speed": [18, 25], "size": [0.2, 0.35], "color": "#9ad4ff" },
    "update": [
      { "module": "drag", "coefficient": 1.5 },
      { "module": "curl-noise", "strength": 2, "frequency": 0.6 },
      { "module": "color-over-life", "gradient": [[0, "#e9f6ff", 1], [0.4, "#4aa3ff", 0.7], [1, "#1a3a7a", 0]] },
      { "module": "size-over-life", "curve": [[0, 0.6], [0.2, 1], [1, 1.8]] }
    ],
    "render": { "mode": "billboard", "blend": "additive", "texture": { "path": "assets/fx/soft.png" }, "emissive": 4000 }
  }]
}
```

- `*.particles.json` is a data asset (0014) with a schema generated from the module registry. Each
  update module declares its parameter schema and a WGSL snippet. Emitters compile their modules
  into one update shader (a WESL module per emitter layout, cached by module list).
- Values can be constants, `[min, max]` ranges (seeded random), curves, or gradients. The
  schema documents each form.

### Components

```ts
ParticleSystem { effect: handle('ParticleEffect'), playing: bool, seed: u32, timeScale: f32, space: 'world' | 'local', backend: 'gpu' | 'cpu' }
ParticleEmitterOverrides { emitter: string, spawnRate: f32, spawnScale: f32 }   // optional, for gameplay (thrust → exhaust rate)
```

- Systems inherit the entity's transform. `space: 'world'` leaves emitted particles behind a moving
  ship, and `'local'` keeps them attached (engine glow).
- Gameplay drives effects through `ParticleEmitterOverrides`, read each frame. `spawnRate`
  replaces the effect's rate (negative keeps it), `spawnScale` multiplies it (thrust → exhaust),
  and `emitter` names the emitter to change (empty: all of them).

### Simulation (GPU)

```
spawn  (compute): the k-th spawned particle takes slot k % capacity, seeded pcg(seed ^ pcg(k))
update (compute): integrate, run modules, age; count the living per workgroup (one atomic each)
sort   (compute): alpha emitters only, bitonic by view depth
draw   (render) : capacity instances; dead slots collapse to nothing in the vertex shader
```

- Buffers: 16 floats per particle (position and age, velocity and lifetime, color, size, rotation,
  and seed), with the capacity per emitter fixed at load. The alive count is read back
  asynchronously for `render.describe`.
- Simulation and drawing run after the opaque resolve, into the HDR target with the depth buffer
  read-only (collision and soft particles read it), for the primary camera.
- Culling: the emitter bounds (from capacity, speed, and lifetime, or authored) are tested against
  view frustums, and off-screen emitters can simulate at a reduced rate (`offscreen: 'simulate' |
  'pause' | 'reduced'`).
- Alpha-blended effects under 64k particles sort by depth with a bitonic sort in compute. Larger
  alpha effects render unsorted, with a warning.

### Agent surface

- The effect schema is published, so an agent writes effects as JSON and validates them. Errors
  point into the file.
- `asset.preview` of an effect renders it after 1 second of simulation (a seeded, fixed timestep),
  so an agent can see the effect before placing it.
- `render.describe` reports per effect: alive particles (read back asynchronously, one frame
  late), capacity, simulation GPU time, and sorting.

## Decisions

- **Modules compile into one shader per emitter.** There's no branching over module lists in the
  hot loop, and effects stay data.
- **Ring allocation instead of a dead list.** Spawn order decides the slot, so a particle's slot
  and seed depend only on its spawn index, which makes replay exact. An emitter spawning faster
  than capacity over lifetime recycles its oldest particles, which is the visible behavior a dead
  list gives when it runs dry. No atomics are needed on spawn, and no readback in the frame.
- **Seeded randomness from particle index, emitter seed, and frame.** Reproducible captures and
  tests, which matter for an agent loop that verifies effects by screenshot.
- **The same format drives the CPU backend.** Small gameplay effects don't need a second authoring
  model.

## Acceptance criteria

- [x] 1M particles (4 emitters × 250k, billboards, additive) simulate and render at 60 fps at 1080p
      on the laptop, with simulation under 2 ms of GPU time.
- [x] Same seed, same frame, same device: the particle buffers match exactly (headless, stepped).
- [x] An effect file with a bad module parameter fails validation with a pointer. Editing a valid
      file hot reloads the running effect without restarting it.
- [x] Depth collision makes particles bounce off a floor (golden sequence). Soft particles fade
      at intersections (golden image).
- [x] `ParticleEmitterOverrides.spawnRate` changes the emission rate on the next frame
      (alive-count test).
- [x] The CPU backend produces the same alive count and bounds as the GPU backend for a simple
      effect over 120 frames, within tolerance.

## Implementation notes

- `packages/particles`: `values.ts` (value forms, PCG random that matches in TS and WGSL),
  `modules.ts` (the module registry: parameter schema, WGSL, and a CPU version each), `effect.ts`
  (parse, validate, asset type, `*.particles.json` importer, generated schema), `shaders.ts`,
  `sim.ts` (store, CPU backend, graph nodes, sort, describe), `preview.ts`, `plugin.ts`. The
  manifest plugin is `particles` (it pulls in `render/forward`); the docs skill is
  `make-particles.md`.
- The dead list became ring allocation (see Decisions). The draw is instanced over the capacity
  rather than indirect over an alive list. At 250k per emitter the dead slots cost a vertex
  shader invocation each, which the 1M demo absorbs.
- The spawn count for a frame is a backlog: it only advances on a frame that dispatched. A frame
  where the pipelines are still compiling spawns nothing and simulates nothing, and the next
  dispatched frame catches up the spawns. The determinism test compiles with `playing: false`
  before stepping.
- Sorting and simulation run for the primary camera only. Other views draw the same particles
  unsorted.
- The CPU backend runs every module except collision (it has no depth buffer), and it draws
  through the same render path by uploading its particles.
- Offscreen `reduced` simulates every 4th frame with 4× the step.
- Measured on the laptop (Apple M4, `#particles` in the playground, 1920×1080, 4 × 250k additive
  billboards): 60 fps, 999,948 alive, simulation 1.39 ms of GPU time.

## Open questions

- None blocking. Deferred: sub-emitters, trails, and lit particles.
