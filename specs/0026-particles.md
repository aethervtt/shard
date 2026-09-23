# 0026 — GPU particles

- **Status:** accepted
- **Packages:** `@shard/particles` (new), `@shard/render`
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
- A GPU simulation in compute: per-emitter structure-of-arrays storage buffers, a dead list with
  atomic counters, and indirect draws. No CPU readback in the frame.
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
ParticleSystem { effect: handle('ParticleEffect'), playing: bool, seed: u32, timeScale: f32, space: 'world' | 'local' }
ParticleEmitterOverrides { spawnRate: f32, ... }   // optional, for gameplay (thrust → exhaust rate)
```

- Systems inherit the entity's transform. `space: 'world'` leaves emitted particles behind a moving
  ship, and `'local'` keeps them attached (engine glow).
- Gameplay drives effects through `ParticleEmitterOverrides` (for example, thrust input scales
  `spawnRate`), which the compute pass reads each frame.

### Simulation (GPU)

```
spawn  (compute): pop indices from the dead list (atomic), initialize from shape and init values
update (compute): integrate, run modules, age; on death push the index to the dead list
compact(compute): write alive indices and indirect draw arguments
draw   (render) : instanced billboards or meshes from the alive list (indirect)
```

- Buffers: positions and ages (vec4), velocities and seeds (vec4), plus module state as needed
  (color, size, rotation, all SoA). The capacity per emitter is fixed at load.
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
- **SoA storage buffers with a dead list.** Spawning and death are O(1) atomics, and no CPU
  readback is needed.
- **Seeded randomness from particle index, emitter seed, and frame.** Reproducible captures and
  tests, which matter for an agent loop that verifies effects by screenshot.
- **The same format drives the CPU backend.** Small gameplay effects don't need a second authoring
  model.

## Acceptance criteria

- [ ] 1M particles (4 emitters × 250k, billboards, additive) simulate and render at 60 fps at 1080p
      on the dev machine, with simulation under 2 ms of GPU time.
- [ ] Same seed, same frame, same device: the particle buffers match exactly (headless, stepped).
- [ ] An effect file with a bad module parameter fails validation with a pointer. Editing a valid
      file hot reloads the running effect without restarting it.
- [ ] Depth collision makes particles bounce off a floor (golden sequence). Soft particles fade
      at intersections (golden image).
- [ ] `ParticleEmitterOverrides.spawnRate` changes the emission rate on the next frame
      (alive-count test).
- [ ] The CPU backend produces the same alive count and bounds as the GPU backend for a simple
      effect over 120 frames, within tolerance.

## Open questions

- None blocking. Deferred: sub-emitters, trails, and lit particles.
