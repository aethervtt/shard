# 0047 — Small bodies: asteroids, belts, rings, and comets

- **Status:** accepted
- **Packages:** `@aethervtt/shard-space`, `@aethervtt/shard-procgen`, `@aethervtt/shard-render`, `@aethervtt/shard-particles`,
  `@aethervtt/shard-physics`
- **Depends on:** 0026, 0028, 0040, 0041, 0042, 0043, 0045, 0046

## Context

A star system is more than its planets. Asteroid belts, planetary rings, lone asteroids you can
land on, and comets with tails are what make a system feel full. They are also where space games
put mining, hiding, and chases.

They share a problem that planets don't have: **counts**. A belt is millions of rocks and a ring
is billions of ice chunks. Each is in orbit, visible as a band from across the system, and
something you can fly into and collide with. That's the same three-tier problem as 0045's
foliage, plus motion. Far away, it's a band of light. At mid range, it's GPU instances nobody
simulates. Up close, it's a few hundred real entities with colliders, all derived from the same
deterministic field so the tiers agree.

Individual bodies span sizes too. A 30 m boulder is a mesh. A 2 km asteroid is a mesh you land
on. A 200 km lumpy Vesta is closer to a small planet, and 0043's terrain handles it with an
ellipsoid shape and heavy relief.

## Goals

- **Asteroids** at every size, all seeded generators:
  - 0.1–50 m: instanced chunks for belts and rings.
  - 50 m – 1 km: a landable mesh with a collider.
  - 1–500 km: 0043 terrain with an ellipsoid shape, lumpy relief, and craters.
  Classes (carbonaceous, stony, metallic, icy) drive shape, color, and material.
- **Asteroid belts** around stars and **rings** around planets, as orbiting particle fields with
  three render tiers (band, GPU instances, entities) derived from one deterministic lattice.
- Flying into a belt or ring: nearby chunks are real kinematic bodies on their orbits, so ships
  collide with them, and scanning or mining one is ordinary game code on an entity.
- Rings seen from afar: a lit, shadowed annulus with a radial density profile, casting shadows on
  the planet and receiving the planet's shadow. This moves here from 0046.
- **Comets**: an icy nucleus on an eccentric orbit, with a coma, a curved dust tail, and a straight
  ion tail that point away from the star and grow as the comet nears it.
- Landing on and walking on small bodies, with weak point gravity, through the same grid
  reparenting as planets (0040, 0046).
- A crater operator in the noise library (0041), so moons and asteroids get impact craters.

## Non-goals

- Collisions between belt or ring particles (they're on rails; only ships and entities collide).
- Rubble-pile physics, fracturing, or mining that changes shape (a mined asteroid is removed or
  replaced by game code; a per-body delta layer is later, with terrain deformation).
- Kuiper belts and Oort clouds as separate systems (they're sparse belts with other parameters).
- Artificial bodies such as stations and wrecks (prefabs placed by game code or generators).

## Design

### Asteroid generators

| Generator | Output | Use |
|---|---|---|
| `shard/AsteroidChunk` | mesh + LODs | belt and ring particles, 6–16 variants per field |
| `shard/Asteroid` | entities: mesh, LODs, collider, `Grid`, gravity | 50 m – 1 km bodies |
| `shard/LargeAsteroid` | entities: `Planet` (0043) + `Grid` + gravity | 1–500 km bodies |

- Params include `radius`, `class` (`carbonaceous | stony | metallic | icy`), `elongation`,
  `lumpiness`, `craterDensity`, and `seed`. The class picks a palette and PBR values: dark and
  rough, grey and speckled, bright and metallic, or white with subsurface-ish ice.
- `shard/Asteroid` builds an icosphere, scales it to a random ellipsoid, and displaces it with
  low-frequency noise for the potato shape, then with the crater operator and fine noise. It emits
  LODs through meshoptimizer (0045) and a collider from the second LOD (`trimesh`; `convex` for
  bodies under 100 m).
- `shard/LargeAsteroid` is a `Planet` with `shape` set (0043 gains `shape: vec3 = [1, 1, 1]`,
  ellipsoid axis ratios applied to the base radius per direction). Its height graph uses high
  relief relative to radius plus craters. It has no ocean, climate, or atmosphere, and it has one
  regolith biome per class.
- Every landable body carries `Grid`, `GravitySource` (point, strength from its volume × class
  density), and `Spin` (0046). A ship or player with `SpaceBody` that comes within `3 × radius` is
  reparented into its grid, so the asteroid's tumble and orbit don't drag the physics. At 1 km,
  gravity is about 1/20 000 g, so the character controller's `up: 'gravity'` still works and jumps
  are long.

### Craters (0041)

A new noise node:

```json
{ "craters": { "density": 0.3, "sizes": [0.01, 0.2], "falloff": 2.2, "rim": 0.3, "seed": 5 } }
```

Craters are seeded cellular features, one crater per cell per size octave, with a power-law size
distribution. The profile is a bowl with a raised rim and ejecta falloff. The node returns a
height offset, so it composes with everything else. Like every node, it has CPU and WGSL
implementations, and it supports origin-offset sampling.

### Orbiting fields (belts and rings)

```ts
AsteroidBelt {                         // on the star (or any body) it orbits
  inner: f64, outer: f64               // metres (after SystemRules.orbitScale)
  thickness: f32                       // vertical spread, metres (1σ)
  density: handle('Texture')           // 1D radial profile, generated with gaps (Kirkwood-style)
  count: f64                           // expected particles, e.g. 2e6
  sizes: vec2 = [1, 800]               // metres, power-law
  chunk: generator item                // 0045 item shape: shard/AsteroidChunk + variants
  bodies: f32 = 0.001                  // fraction promoted to shard/Asteroid entities when near
}
PlanetRing {                           // on a planet
  inner: f32, outer: f32, thickness: f32 = 20
  profile: handle('Texture'), opacity: f32, tint: color
  sizes: vec2 = [0.05, 12]
  chunk: generator item                // icy chunks
}
```

- **The lattice.** A field is a set of cells in orbital coordinates `(r, θ₀, z)`, where `θ₀` is
  the angle at the epoch. Each cell's content comes from `hashSeed(fieldSeed, cell)`: particle
  count from the density profile × cell volume, then per particle a radius, `θ₀`, `z`, size,
  variant, and tumble axis. That's the same order-independent, seam-free approach as 0045's
  placement.
- **Motion.** A particle's angle at time `t` is `θ₀ + n(r) × t`, with Keplerian mean motion
  `n = sqrt(GM / r³)`. To find the particles near the camera at time `t`, invert per radial band:
  `θ₀ = θ_cam − n(r) × t`. Bands are narrow enough (0.1% of `r`) that `n` is constant across one.
  The field is deterministic from `SpaceTime` alone, so it saves nothing and can be scrubbed.
  Differential rotation (inner particles overtake outer ones) comes for free.
- **Far tier: the band.** Belts render as a ray-marched volume over the field's torus, 16 steps
  at half resolution, sampling the density profile and thickness. It's lit by the star and
  forward-scattering for dust. Rings render as the annulus: a mesh in the planet's equatorial
  plane, lit on both sides with forward scattering when back-lit, and opacity from the profile.
  Shadows are analytic both ways. The ring shadows the planet with a ray-plane test in the planet's
  shader, and the planet shadows the ring with a ray-sphere test in the ring's. The same test lets
  a ring shadow the moons that pass through its plane.
- **Mid tier: GPU instances.** Within `instanceRange` (default 20 km for belts, 2 km for rings),
  a compute pass fills 0045's GPU instance layer from the cells around the camera. It evaluates the
  lattice in the shader, which gives the same hash and the same positions. Particles move on the GPU
  each frame through their `n(r) × t`, and tumble in the vertex hook. No CPU work per particle.
  The band fades out as instance density fades in, so there's no visible edge.
- **Near tier: entities.** Within `entityRange` (default 800 m), the CPU evaluates the same cells
  (canonical, 0041 rules) and spawns entities for particles larger than `entityMinSize` (default
  2 m). Each is a `Mesh3d` of its variant, a kinematic body with a convex collider, an `Orbit`
  (0046) matching its lattice motion, and `smallbody/Particle { field, cell, index }`. Its GPU
  instance is hidden, via a per-cell mask the entity tier uploads, so it isn't drawn twice. Spawning
  is budgeted like 0045 props, and the `bodies` fraction spawns as full `shard/Asteroid`s you can
  land on.
- **Removal.** A destroyed or mined particle is saved as `(field, cell, index)`, like 0045's removed
  props, and masked from all three tiers.
- **Precision.** Fields are evaluated relative to the camera's orbital position in f64 on the
  CPU and passed to the GPU as offsets, 0041-style, so a ring particle 10⁸ m from its planet's
  center doesn't jitter.

### Comets

```ts
Comet { nucleus: handle('Generator') /* shard/Asteroid, icy */, activity: f32 = 1,
        dustTail: handle('ParticleEffect'), ionTail: handle('ParticleEffect') }
```

- A comet is an `Orbit` with high eccentricity (0.6–0.99) and a small icy asteroid as its nucleus.
- Activity scales with `activity × (r₀ / r)²` from the star, and is zero beyond ~5 AU (scaled by
  `orbitScale`).
- The coma is a camera-facing, depth-faded glow sprite whose radius and brightness follow activity.
- The **ion tail** is a 0026 GPU particle effect emitted anti-sunward, straight, bluish, and long.
- The **dust tail** is a second effect emitted along the anti-sun direction, with the comet's
  orbital velocity inherited. The particles lag, so the tail curves naturally. It's yellowish and
  broad. Both are world-space particle systems, so they shift with the origin (0040).
- From across the system, a comet is a point (0046's sub-pixel bodies) plus a tail impostor: a
  billboarded strip along the anti-sun direction, faded by activity.

### Systems (0046)

`shard/StarSystem` places small bodies by `SystemRules`: belts at the snow line and between giants,
rings on giants (likely) and on some rocky planets (rare), a few named large asteroids and comets
per system, and captured asteroid moons around small planets. Each field and body gets its seed
from `childSeed` of the system.

### Agent surface

- `space.describe` lists each system's belts, rings, comets, and large asteroids with their params.
- `smallbody.sample { field, position, radius }` lists particles near a point (cell, index, size,
  variant, position at the current time), headless, from the CPU path.
- `smallbody.describe` returns per-field tier counts (band on or off, instances drawn, entities
  spawned) and removed-particle counts.
- `procgen.preview` of `shard/Asteroid` and `shard/AsteroidChunk` gives nine-seed contact sheets per
  class. A `PlanetRing` or `AsteroidBelt` preview renders the far view plus a view from inside the
  field.
- `debug.overlays` gains `field-cells` and `comet-vectors` (sun and velocity directions).
- MCP tools: `sample_small_bodies`, `describe_small_bodies`.
- **Errors:** `smallbody/field-too-dense` (particles per cell over the cap), `smallbody/bad-range`
  (inner ≥ outer), `smallbody/unknown-field`.

## Decisions

- **One lattice, three tiers.** The band, the instances, and the entities can't disagree because
  they're views of the same hash. Flying in from far away looks continuous.
- **Orbits by inverting mean motion, not simulation.** Millions of particles move exactly, for
  free, with no state to save.
- **Entities only near the ship.** Collisions and gameplay need entities, and at most a few hundred
  exist at a time.
- **Large asteroids reuse planet terrain.** An ellipsoid shape and craters are a few lines in 0043
  and 0041, cheaper than a second LOD terrain system for lumpy bodies.
- **Comet tails are particles.** 0026 already simulates and draws them. Tails are emission rules
  pointed at the star.

## Acceptance criteria

- [ ] Each asteroid generator's nine-seed contact sheet per class matches its golden, and a 500 m
      asteroid and a 200 km large asteroid are landable: a character walks 50 m on each headless
      without falling off.
- [ ] Flying from 10⁷ m into a belt shows a continuous transition from band to instances to
      entities (screen luminance change under 5% frame to frame at each handoff), and a ship
      that rams a spawned chunk collides.
- [ ] Belt particle positions at time `t` from the CPU lattice and the GPU instances agree within
      1 cm, and a spawned entity's `Orbit` matches its lattice path within 1 cm over 600 s.
- [ ] A 2M-particle belt draws its mid tier at under 2 ms GPU on the desktop (budget `gpu:belt`,
      proposed), with no per-particle CPU work.
- [ ] A ringed gas giant (0046) shows the ring shadow on the planet and the planet's shadow on the
      ring, and flying through the ring plane shows icy chunks tumbling (golden and a capture).
- [ ] A destroyed belt chunk stays gone after leaving the belt, returning, and a save/load.
- [ ] A comet's tails point away from the star within 2°, the dust tail curves behind the orbit,
      and activity at perihelion is at least 10× activity at 3× the perihelion distance.
- [ ] A crater noise node renders the same on CPU and GPU within 0041's tolerance, and its crater
      size histogram follows the configured power law.

## Open questions

- Should belts also have sparse, huge "named" rocks that are visible from across the system,
  like dwarf planets such as Ceres? Proposed: yes, as `shard/LargeAsteroid` bodies in the belt with
  their own orbits, which the system generator already places.
- None blocking. Deferred: particle-particle collisions, gravitational shepherding (ring gaps
  from moons, beyond what the profile texture draws), and deformation from mining.
