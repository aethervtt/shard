# 0046 — Star systems and galaxy generation

- **Status:** accepted
- **Packages:** `@aethervtt/shard-space` (new), `@aethervtt/shard-render`, `@aethervtt/shard-procgen`, `@aethervtt/shard-terrain`
- **Depends on:** 0018, 0019, 0022, 0040, 0041, 0042, 0043, 0044

## Context

The last layer of the proof project is the universe around the planets: a galaxy of hundreds of
billions of stars from one seed, each star with a system of planets and moons you can fly to, and a
night sky on every planet that shows the real neighboring stars. The playground's galaxy demo
already draws 100k–1M ECS stars at 60 fps, but it has its own fake camera and writes straight to
the view target.

Nothing at this scale can be stored or spawned eagerly. The galaxy is a function from a sector
coordinate to the stars in it. A star is a function from its id to its system, and a planet is a
function from its seed to its terrain, atmosphere, and scatter. Generators (0042) cache each level,
large-world grids (0040) place it, and only the current system and the planets near you are
entities at full detail.

## Goals

- `Galaxy` generation: a density function (bulge, disk, spiral arms, halo) evaluated per sector,
  producing stars with stable ids, positions, spectral classes, and luminosities, lazily and
  deterministically.
- Star catalog queries: nearest stars to a point, stars in a sector, star by id, and a
  line-of-sight search for "which star is under the cursor" in a map view.
- A `shard/StarSystem` generator (`entities` output, 0042): one or two stars, planets, moons, and
  belts, with orbits and per-body seeds and parameters chosen by rules (zones, temperature).
- A `shard/Planet` generator: picks a planet class (rocky, desert, ocean, ice, lava, gas giant,
  ice giant) and a size, from small moons through Earth and super-Earths (up to 2.5 R⊕) to gas giants
  (up to ~12 R⊕, 80 000 km). It produces 0043/0044/0045 components with class-appropriate noise,
  biomes, atmosphere, and scatter.
- Gas and ice giants: banded, animated cloud spheres with storms, deep atmospheres you can dive
  into (0044's deck), and optional rings (0047).
- On-rails orbits (Kepler elements, evaluated analytically from game time), placed with f64 math
  into grid cells.
- Stars light their system: a star entity drives a directional light whose direction and
  illuminance follow the camera's position.
- Rendering at every scale: stars as HDR point sprites in the galaxy view and system view,
  planets as lit impostor spheres until terrain takes over, and a star-field environment baked from
  the catalog around the current position.
- System transitions: arriving at a new system spawns it and unloads the old one, with no hitch
  beyond a budgeted background generation.

## Non-goals

- N-body or orbital-mechanics gameplay (orbits are on rails; ships fly Newtonian or arcade as game
  code decides).
- Realistic galactic astrophysics (star formation history, metallicity, dust lanes beyond a
  density/extinction texture).
- A galaxy map UI. The engine provides queries and a star-field renderer; the map is game code
  (0036).
- Gas giant interiors below the cloud deck.
- Asteroids, belts, rings, and comets (0047).
- Nebula volumes (later; 0041 noise into a raymarched volume).

## Design

### Galaxy and sectors

```ts
Galaxy {
  seed: u32
  radius: f64 = 4.7e20           // metres (~50 000 ly)
  armCount: u8 = 4
  armTightness: f32 = 0.35
  bulgeRadius: f32 = 0.15        // fraction of radius
  thickness: f32 = 0.02          // disk scale height / radius
  starsPerCubicLy: f32 = 0.004   // at the solar-neighborhood density; scales the whole catalog
  sectorSize: f64 = 9.46e16      // 10 ly
}
```

- The galaxy entity is the root `Grid` (0040, cell 10¹² m). A star's position is in galaxy
  coordinates.
- `density(p)` is analytic: exponential disk × log-spiral arm modulation (with 0041 noise for
  clumping) + a spherical bulge + a faint halo. It returns the expected stars per cubic light-year.
- A sector `(sx, sy, sz)` (i32) holds `Poisson(density × volume)` stars, with the count drawn from
  `hashSeed(galaxySeed, sector)`. Star `i` of a sector has id `(sector, i)`, packed as a string
  `"s:sx,sy,sz:i"` for files and a u32 triple + u16 for queries. Its position, class, and seed come
  from `hashSeed(sectorSeed, i)`.
- Spectral class follows a Kroupa-like IMF mapped onto O–M plus white dwarfs, with temperature,
  radius, and luminosity from class tables. Color is blackbody at the star's temperature.
- Generating a sector is pure and cheap (a few stars near the Sun's radius, up to a few thousand in
  the bulge), so sectors are generated on demand
  on the worker pool and kept in an LRU (default 4 096 sectors). A query around the player
  touches ~1 000 sectors.

### Queries

```ts
const catalog = world.resource(StarCatalog)
await catalog.nearest(position64, count, out)        // ids + distances, sorted
await catalog.sector(coord)                          // StarInfo[] (plain values)
catalog.star(id)                                     // StarInfo, sync when its sector is cached
await catalog.pick(ray64, maxDistance, pixelRadius)  // for map clicks
```

`StarInfo` is `{ id, position: [f64, f64, f64], class, temperature, luminosity, radius, seed }`.
Positions are f64 arrays in galaxy metres. Absolute positions are fine here because they're
data, not rendered directly.

### Star systems

`shard/StarSystem` (0042, `entities` output) takes `{ star: StarInfo, rules: handle('SystemRules') }`
and the star's seed:

- The fragment root is a `Grid` (cell 2 000 m) placed in the galaxy grid at the star's position.
- Star entity or entities: `Star { temperature, luminosity, radius }`, `Mesh3d` sphere with an
  emissive blackbody material, and a `GravitySource`.
- Planets: count and spacing from a Titius–Bode-like rule with jitter. The habitable zone comes
  from luminosity, and the class is chosen by `SystemRules` weights per zone (hot: lava, desert;
  temperate: rocky, ocean; cold: ice; outer: gas giants). Each planet and moon is a nested
  `GeneratorInstance` of `shard/Planet` with its own seed, class, and radius. Nested instances
  generate lazily (0042 open question), so a system spawns instantly and a planet's terrain setup
  generates when first needed.
- Small bodies (0047): belts, rings, comets, and large asteroids, placed by `SystemRules`.
- `SystemRules` is a data type projects override, for more planets, gas giant frequency, size
  distributions per class, and two scale factors: `bodyScale` (default 1, real sizes) and
  `orbitScale` (default 0.05, which compresses orbital distances 20×). Compression can't pack bodies
  into each other. After scaling, each orbit is at least `3 × (star radius + body radius)` from the
  star and 10 Hill radii from its neighbors, and the generator pushes orbits outward to satisfy that.
  With real-sized planets, heavier compression would put Earth inside the Sun. How long travel
  takes is up to the game's ship drives.

### Gas and ice giants

```ts
GasGiant {
  radius: f32                         // cloud top, metres (up to 8×10⁷)
  style: handle('GasGiantStyle')      // data type: band palette, turbulence, storm frequency
  seed: u32
  bandCount: u8 = 14, turbulence: f32 = 0.5, rotationPeriod: f64
}
```

- A gas giant is a planet entity with `GasGiant` and `Atmosphere` (the `gas-giant` preset), and
  no `Planet` terrain.
- **Shape.** The body is a ray-traced sphere, as are the impostors below. A proxy box draws, and
  the fragment shader intersects the exact sphere in camera-relative km and writes correct depth.
  The silhouette stays perfect from a million kilometres away to skimming the cloud tops, with no
  tessellation.
- **Clouds.** The shader maps latitude through the style's band palette. It advects the bands with
  domain-warped 4D noise (0041's 4D source, with `w` driven by `SpaceTime`), so the clouds flow
  slowly. Band speed alternates by latitude, for differential rotation. Storms are seeded cellular
  vortices, a few large, long-lived ones and many small ones, placed by `seed`. Ice giants are the
  same model with low `turbulence`, few bands, and blue-green palettes.
- **Rings** are 0047's `PlanetRing`. The gas giant shader includes its analytic ring-shadow test.
- **Close up.** Descending into the clouds hands off to 0044's deck. `gasGiantDepthAt(world, e,
  position)` reports depth below the cloud top for gameplay (pressure, damage, crush).
- Moons of gas giants are ordinary rocky planets with `Orbit.parent` set to the giant.

### Orbits

```ts
Orbit {
  parent: entity                      // the body orbited
  semiMajorAxis: f64, eccentricity: f32, inclination: f32,
  longitudeOfAscendingNode: f32, argumentOfPeriapsis: f32, meanAnomalyAtEpoch: f32,
  period: f64                         // seconds of game time; derived from mass when 0
}
Spin { axis: vec3, period: f64, phaseAtEpoch: f32 }
SpaceTime { seconds: f64, scale: f32 = 1 }        // resource; saved
```

- `space/orbits` runs in Update. Per body it solves Kepler's equation (Newton's method, 5
  iterations, f64) at `SpaceTime.seconds`, computes the position relative to the parent in f64,
  and writes `GridCell` + `Transform` through `placeInGrid` (0040). The whole solar system is a
  few dozen bodies, so f64 JS math is fine here.
- `Spin` rotates a planet's grid, so surface entities co-rotate (0040). Day length is `Spin.period`.
- Positions depend only on `SpaceTime.seconds`, so they're deterministic, identical after a save
  and load, and time can be scrubbed.

### Starlight

- `Star` entities drive `StarLight` directional lights (one per star, created by the system
  generator). Each frame, `space/starlight` sets the light's direction to `normalize(camera − star)`
  and its illuminance to `luminosity / (4π d²)` in lux, from `worldPosition64`. The sun gets
  dimmer as you fly out and moves across the sky with `Spin`. Atmosphere transmittance (0044) then
  applies.
- `DirectionalLight.angularDiameter` (0044) is set from the star's radius and distance, so the
  sun disk size is right from every planet.
- Shadows: only the brightest star casts cascaded shadows by default.

### Rendering at scale

- **Star field (`StarField` render node).** Draws catalog stars as HDR point sprites with
  magnitude-correct brightness (luminance from `luminosity / d²`) and blackbody color. It covers
  stars within `StarField.radius` (default 1 000 ly) of the camera, uploaded from the sector LRU
  into a GPU buffer that's rebuilt incrementally as the camera moves between sectors. Positions are
  camera-relative in f32 (galaxy metres minus camera, divided by a scale), so nothing jitters. It
  replaces the playground demo's custom node, and the demo moves onto it.
- **Galaxy background.** Beyond the star field radius, the galaxy's integrated light is a
  procedural equirectangular HDR (density along view rays, with 0041 noise for dust extinction).
  It's baked per sector the camera is in and composited behind the star field.
- **Environment.** From inside a system, the star field plus galaxy background bake into the
  environment map's background source (0019). The sky from a planet's surface is the real
  neighborhood, and it shows through as 0044's atmosphere thins at night or with altitude.
- **Planets from afar.** A planet whose terrain isn't selected (0043 chooses no chunk at depth ≥ 0,
  or the planet covers fewer than 32 px) renders as an **impostor**: a ray-traced sphere with a baked
  equirectangular albedo and normal map from the planet's CPU map (`terrain.map`, 512×256),
  lit by its star, with 0044's limb. At 32 px, the impostor crossfades into the quadtree's root
  chunks over 16 frames.
- **Distant bodies smaller than a pixel** render as star-field-style points with phase-dependent
  brightness, so planets are visible as bright "stars" from their neighbors.

### Transitions

- `enterSystem(world, starId)` generates (or gets from cache) the `StarSystem` fragment, spawns it
  as a `GeneratorInstance` under the galaxy grid, and reparents the ship into the new system's grid
  (0040). The old system is despawned once the ship is outside its `exitRadius`. Assets become
  unreachable and unload (0014).
- A ship approaching a planet (inside `3 × radius`) is reparented into the planet's grid with
  `reparentToGrid`, so it co-rotates. Leaving reverses it. `space/frames` does this automatically for
  entities with `SpaceBody` (ships, the player), with hysteresis.

### Agent surface

- `space.describe` returns the current system (star, planets with class, radius, orbit, and day
  length), the camera's grid chain, `SpaceTime`, and loaded sector count.
- `space.nearestStars { position?, count }` and `space.star { id }` return catalog data, and
  `space.enterSystem { id }` jumps there (for tests and agents exploring).
- `procgen.preview` of `shard/StarSystem` renders an orrery view (orbits and bodies, labeled), and
  of `shard/Planet` renders 0044's three standard shots. `shard gen shard/Planet --seeds 1-9
  --param class=ice` makes a contact sheet of ice planets.
- `debug.overlays` gains `orbits` and `sectors`.
- `.agents/space.md` documents the generation chain (galaxy → sector → star → system → planet →
  terrain/atmosphere/scatter), which seed feeds which, and how to override `SystemRules` and
  planet class tables.
- MCP tools: `describe_space`, `nearest_stars`, `enter_system`.
- **Errors:** `space/unknown-star`, `space/orbit-parent-missing`, `space/bad-orbit`
  (eccentricity ≥ 1 or a non-positive semi-major axis).

## Decisions

- **The galaxy is a function, not data.** Hundreds of billions of stars can't be stored. Sectors
  from `hash(seed, coord)` give lazy, parallel, deterministic generation with stable ids.
- **Every level is a 0042 generator.** Caching, hot reload, previews, and contact sheets come free
  at every scale, and an agent tunes planets with the same loop it tunes rocks with.
- **On-rails orbits.** Deterministic, scrubbable, save-free positions from one f64 clock, and no
  integration drift over hours of play.
- **Real sizes, compressed orbits by default.** Earth-sized and larger planets are the point.
  Real orbital distances make flight tedious, so orbits are compressed within the no-overlap
  constraint. Both scales are data (`SystemRules`), so a realistic project sets both to 1.
- **Ray-traced spheres for giants and impostors.** A 70 000 km sphere needs no tessellation budget,
  has an exact silhouette and depth at any distance, and one shader serves both.
- **Impostors from the CPU terrain map.** A planet seen from its moon is a textured sphere that
  matches what you land on, without keeping its quadtree resident.

## Acceptance criteria

- [ ] The same galaxy seed gives the same star ids, positions, and classes on Node, Chrome, and
      Tauri, and a sector generates in ≤ 1 ms on one worker.
- [ ] `nearest(position, 100)` around the default start returns in ≤ 20 ms cold and ≤ 1 ms warm.
- [ ] The star field renders ≥ 1M stars within 1 000 ly at under 2 ms GPU, with the galaxy's arms
      and bulge visible from outside (golden) and a sky of neighboring stars from inside.
- [ ] A generated system has planets whose classes follow `SystemRules` zones over 1 000 seeds
      (histogram test), and every body's orbit is valid.
- [ ] Orbits: a planet's position at `t` matches an independent f64 Kepler reference within 1 m
      after 10⁶ s of game time, and a save/load at any `t` reproduces positions exactly.
- [ ] Sun illuminance at a planet at 1 AU (unscaled rules) from a G2 star is 128 000 lux ±5%, and it
      falls with 1/d² as the camera flies outward.
- [ ] Flying from orbit to landing on a generated planet has no visible pop at the impostor-to-
      terrain crossfade (frame-to-frame screen diff under threshold) and no frame over 25 ms.
- [ ] Over 1 000 generated systems, rocky planet radii span 0.3–2.5 R⊕ and giants 3.5–12 R⊕, and
      no two bodies' orbits violate the spacing constraint.
- [ ] A Jupiter-sized gas giant renders from 10⁶ km to 100 km above the cloud tops with an exact
      silhouette (no faceting at any distance, golden), and its bands visibly flow over a 60 s
      capture.
- [ ] Descending into a gas giant's clouds fades smoothly to the opaque deck (frame-to-frame
      luminance change under 3%), and `gasGiantDepthAt` matches the camera's depth.
- [ ] `space.enterSystem` to a neighboring star spawns the new system and unloads the old one. Asset
      memory returns to within 10% of the pre-jump baseline after collection.
- [ ] The playground galaxy demo runs on `StarField` and the engine camera at its current star
      counts and frame rate.

## Open questions

- Binary and multiple-star systems beyond two stars: proposed max two in v1, with circumbinary
  planets.
- Should planet impostors bake on the GPU from the render path instead of the CPU map for more
  detail? Proposed: CPU, for headless determinism, and revisit if impostors look soft.
- None blocking. Deferred: nebula volumes, black holes and lensing, volumetric gas giant cloud
  layers (the banded shader is a surface).
