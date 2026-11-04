# 0100 — Water interaction: buoyancy, wakes, foam and spray

- **Status:** draft
- **Packages:** `@aethervtt/shard-water`, `@aethervtt/shard-physics`, `@aethervtt/shard-particles`
- **Depends on:** 0026, 0053, 0086, 0087, 0097, 0098

## Context

With 0097 and 0098, water looks right but nothing touches it. Boats should float and pitch with the
swell, drift with a river, and leave a V-shaped wake. A swimmer should leave ripples, a crate
dropped in should splash, and waves should throw spray off rocks.

References:

- **Buoyancy**: Unreal's pontoons are spheres with buoyancy, damping and drag, plus river flow
  pushing objects downstream. Atlas samples columns of water under a ship and, because its server
  runs at a low rate, fits a plane to the samples and pulls the ship toward it with a spring. Just
  Cause 3 (Kerner) clips hull triangles at the waterline for the best quality.
- **Wakes**: a Kelvin wake is a 19.47° V for most speeds, narrowing for fast boats. It emerges
  from deep-water dispersion. iWave (Tessendorf) produces it from a 2D height field and a
  convolution kernel; Three.js Water Pro uses iWave on both its backends; Atlas used eWave (the
  same dynamics, integrated exactly in frequency space).
- **Spray**: Atlas emits particles across the frustum and keeps only those that land on whitecaps.
  Water Pro uses probes on objects that spawn spray above a relative speed; spray is WebGPU-only
  there.

## Goals

- `Buoyancy` on physics bodies: sample points, buoyant force, drag, angular drag, river flow, and
  a plane-fit mode for large ships. Deterministic, so it works in 0053 tracks and on a server.
- `WakeSource` on moving objects: they stamp the path they travelled since the last frame into a
  wave field around the camera, which spreads with dispersion into Kelvin wakes.
- Interaction foam: where wakes break and where objects cut the surface at speed, in the same foam
  as wind whitecaps (0098).
- Spray: plumes when objects hit the water fast and when waves hit `SprayProbe`s; from whitecaps in
  storms. WebGPU only.
- `WaterEntered` / `WaterExited` events, with speed, for audio and gameplay.
- Each part opt-in: `waterInteractionPlugin({ buoyancy, wakes, spray })`.

## Non-goals

- Swimming characters (a character controller mode reading `waterAt`; its own spec).
- Two-way coupling (the water level rising when something sinks into a tank).
- Synchronizing the wake field across clients (it's visual; boats are networked as state).
- Sails, wind forces on hulls (0096's `windAt` makes them possible later).

## Design

### Buoyancy

```ts
Buoyancy {
  points: list({ offset: vec3, radius: f32 })     // local; 4–16 for a boat, 1 for a crate
  density: f32 = 500 (kg/m³)                       // the body's, for the default force scale
  drag: { linear: f32, quadratic: f32, angular: f32 }
  flow: f32 = 1                                     // how strongly river flow carries it
  mode: 'points' | 'plane' = 'points'
}
```

- Each `FixedUpdate`, per point: `waterAt` (0097, with 0098's CPU waves), the submerged volume of a
  sphere of `radius` at that depth, buoyant force `ρ_water × g × V` at the point, and drag against
  `(velocity at point − water flow)` scaled by the submerged fraction. Forces at points sum into a
  force and a torque about the centre of mass.
- **Prerequisite (physics)**: `applyForceAtPoint(world, entity, force, point)`, accumulating into
  `ExternalForce`'s force and torque for the step (today `ExternalForce` has no point form).
- `plane` mode (Atlas): samples fit a plane; the body is pulled toward its height and tilt with a
  critically damped spring, which stays stable at a 10 Hz server tick.
- Deterministic: `waterAt` is (0097, 0098), and Rapier runs its deterministic build where tracks
  need it (0053). `WaterEntered`/`WaterExited` fire when a body's first point goes under and its
  last comes out, with the vertical speed.
- Multiplayer: buoyant bodies are server-authoritative and replicate as state (0087), predicted
  on clients by the same deterministic code.

### Wakes

- A camera-centred wave field, 256² over 128 m (512² on high), `r16float` height and velocity,
  stepped at a fixed 60 Hz with iWave: a precomputed vertical-derivative kernel (13×13) convolved
  each step, damping at the edges, and recentring by whole texels as the camera moves.
- `WakeSource { radius, strength, depth }` stamps a capsule of displacement along the segment
  from its last position to its current one each step, proportional to speed and to how deep it
  sits (from `waterAt`). Boats get a source at the bow and a negative one at the stern.
- Compute tier: the convolution is a compute pass with the kernel in shared memory. Baseline tier:
  the same kernel as a `fragmentKernel` ping-pong. Both are the same WGSL.
- The field adds to the surface's displacement and normals in the water pass (0097), so wakes
  shade with the same refraction, foam and reflections as waves.
- It's visual: `waterAt` ignores it, so buoyancy can't feed back into itself, and clients don't
  need to agree on it.

### Foam

- Wake foam is injected into 0098's foam texture where the wake field's surface folds (its
  Jacobian, as for wind waves), and where an object crosses the surface faster than 1 m/s. Without
  0098, the plugin keeps its own foam texture over the wake field.

### Spray

- **Prerequisite (particles)**: `emitParticles(world, effect, points)` on the GPU backend: a
  buffer of positions, velocities and counts consumed by the effect's emitter this frame. Today's
  emitters are entity-based with no emit-at-point call.
- Sources, each writing into that buffer from a compute pass:
  - impacts: a `WakeSource` or buoyant point entering the water faster than a threshold, as a
    plume shaped by its speed;
  - `SprayProbe { radius, threshold }` on rocks, piers or hulls: wave and object velocity relative
    to the probe above `threshold`;
  - whitecaps: candidate positions across the frustum, kept where foam exceeds a threshold
    (Atlas), scaled by wind speed (0096).
- Spray particles are lit, drift downwind (0096) and fall back. `water.spray` is `null` on the
  baseline tier, and `render.describe` says so (0064 `baseline: 'unsupported'`).

### API sketch

```ts
app.addPlugin(waterInteractionPlugin({ buoyancy: true, wakes: true, spray: true }))
world.spawn(
  [Buoyancy, { points: hullPoints, drag: { linear: 0.2, quadratic: 0.6, angular: 0.5 } }],
  [WakeSource, { radius: 1.2, strength: 1 }],
  [RigidBody, { kind: 'dynamic' }], [Collider, hullShape], [Transform, {}],
)
world.observe(WaterEntered, ({ entity, speed }) => playSound(world, splash, { volume: speed / 10 }))
```

### Agent surface

- `water.describe` adds: buoyant bodies (submerged points, forces), wake sources, the wake field's
  step time, spray emitted per frame.
- `render.capture { debug: 'buoyancy' }` draws points coloured by depth and force arrows;
  `'wake-field'` shows the field's height.
- **Errors:** `water/buoyancy-needs-body` (Buoyancy without a dynamic `RigidBody`),
  `water/spray-unsupported` (warning on the baseline tier), `water/too-many-wake-sources`
  (warning: over 64 near the camera, the nearest are kept).

## Decisions

- **Buoyancy from CPU queries, never GPU readback.** It runs at the fixed tick, headless, on a
  server, and the same everywhere.
- **iWave for wakes on both tiers.** The same algorithm and look everywhere, Kelvin shape from the
  physics, and a known cost. eWave's exact integration needs extra FFTs per step and can come
  later through 0098's FFT.
- **Wakes are visual.** Feeding them into `waterAt` would make buoyancy depend on per-client state.

## Acceptance criteria

- [ ] A 1 m³ crate of density 500 floats half submerged within 2 cm after settling, and a 10 m
      boat with 8 points rides a 2 m swell without jitter at 60 Hz and at 10 Hz in `plane` mode.
- [ ] A boat in a river with flow 2 m/s drifts downstream at 1.6–2 m/s with `flow: 1`.
- [ ] Two runs of a buoyancy track (0053) give the same hash; so do two `shard run --net` clients
      predicting the same boat.
- [ ] A boat at 8 m/s leaves a V wake with arms at 19.5° ± 2° (measured from the wake field), with
      foam along its crests (golden).
- [ ] A crate dropped from 3 m raises spray and fires `WaterEntered` with its speed; on WebGL2 it
      raises no spray and the tier reports why.
- [ ] Buoyancy for 50 boats × 8 points takes under `water/buoyancy` (proposed: 0.5 ms per fixed
      step on `laptop`); the wake field under `gpu:water-wakes` (proposed: 0.4 ms at 256²).

## Open questions

- Kerner's per-triangle hull model as a `mode: 'hull'` for showcase boats? Proposed: after
  `points` ships, if boats look too stiff.
- Should spray on WebGL2 fall back to CPU billboards from probes only? Proposed: no in v1.
