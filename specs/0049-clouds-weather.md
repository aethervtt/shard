# 0049 — Clouds and weather

- **Status:** accepted
- **Packages:** `@aethervtt/shard-weather` (new), `@aethervtt/shard-render`, `@aethervtt/shard-texture`, `@aethervtt/shard-particles`,
  `@aethervtt/shard-terrain`
- **Depends on:** 0016, 0018, 0023, 0026, 0040, 0041, 0043, 0044, 0046

## Context

0044 gives each planet a clear-sky atmosphere. The proof project also needs cloud cover you fly up
through, storms that roll in, rain and snow, sandstorms on desert worlds, lightning, and wet ground
after a shower. From orbit, a planet needs visible weather systems swirling over its continents.
VISION's row is "Biomes, weather, day/night".

Real-time volumetric clouds are a solved problem at this quality level: Schneider's Nubis
(Horizon Zero Dawn) and Hillaire's work in Frostbite. Tiled 3D noise textures shape the clouds and
a 2D weather map says where they are. They're raymarched at low resolution with temporal
reprojection, and lit with the atmosphere's transmittance. On a sphere, the cloud layer is a
spherical shell and the weather map covers the planet.

Weather doesn't need simulating. Like orbits (0046), it can be a deterministic function of
`(planet seed, region, time)`. Every visit agrees, saves store nothing, and time can be scrubbed.

## Goals

- A volumetric cloud layer per planet: a shell between two altitudes. Its shape comes from 3D
  noise, its coverage and type from a planet-wide weather map, and it's lit by the suns through
  0044's transmittance with multiple-scattering approximation.
- Viewable from the ground, from inside the clouds, from above them, and from orbit, as the same
  clouds.
- Cloud shadows on terrain, and clouds that darken and fill the IBL.
- Weather states as data (clear, cloudy, overcast, rain, storm, snow, blizzard, sandstorm, toxic
  fog, and project-defined ones), chosen per region from biome and a deterministic timeline.
- Precipitation around the camera as GPU particles, occluded by overhead geometry so it doesn't
  rain indoors.
- Surface wetness and snow cover as global material inputs, driven by recent weather.
- Lightning: flash, bolt, light, and a thunder event with the right delay for 0050's audio.
- Wind that drives clouds, precipitation, 0045 foliage sway, and 0026 particles, from one field.
- `weatherAt` for gameplay (temperature, hazard, visibility, precipitation), headless-safe.

## Non-goals

- Fluid-simulated weather (fronts, pressure systems). The timeline gives weather, not physics.
- Snow and water accumulation as geometry (puddles, snow depth). Wetness and snow are shading
  masks.
- Gas giant clouds (0046's banded shader) and their storms.
- Tornadoes and other localized vortex volumes (later, as a cloud type with its own density field).

## Design

### Components

```ts
CloudLayer {                           // on a planet with an Atmosphere
  bottom: f32 = 1500, top: f32 = 8000  // metres above radius
  coverage: f32 = 0.5                  // baseline, modulated by weather
  density: f32 = 0.04                  // extinction per metre at full density
  shapeScale: f32 = 0.00005, detailScale: f32 = 0.0008   // metres⁻¹
  types: handle('Texture')             // height gradient per cloud type (stratus → cumulonimbus)
  albedo: color = [1, 1, 1]
}
Weather { states: handle('WeatherSet'), regionSize: f32 = 200000, period: f32 = 1800 }
WeatherState {                         // data type
  coverage: f32, cloudType: f32, precipitation: 'none' | 'rain' | 'snow' | 'sand' | 'ash' | string,
  intensity: f32, wind: f32, gusts: f32, fog: f32 /* extra Mie */, temperature: f32 /* offset K */,
  lightning: f32 /* strikes per km² per minute */, hazard: string, visibility: f32
}
WeatherSet { states: list(struct { state: handle('WeatherState'), weight: f32, biomes: list(string),
             minDuration: f32 }) }
```

### Textures

- 0016 gains **3D textures**: `Texture.create({ …, depth })` and the `texture_3d` binding.
- The cloud noise textures are generated at startup by 0041 graphs through a 0042 generator and
  cached. The shape texture is 128³ `rgba8` (Perlin-Worley plus three Worley octaves), and the
  detail texture is 32³ (Worley octaves). Both tile. They're the same for every planet; planets
  differ in weather maps and scale.

### The weather map

- Per planet, a **weather map** cube texture (6 × 256², `rgba8`) holds coverage, cloud type,
  precipitation, and wetness. It's rebuilt incrementally (one face per frame) when the timeline
  advances.
- The timeline: the planet surface is divided into regions of `regionSize` on the cube-sphere. Each
  region picks a state per `period`-long window from `hashSeed(planetSeed, region, window)`,
  weighted by `WeatherSet` weights for the region's dominant biome. Durations respect
  `minDuration` by extending windows.
- Between windows and regions, states blend: coverage and type interpolate over a transition
  fraction of the period, and region edges are warped by 0041 noise advected by the wind. So
  storms have soft, moving fronts instead of square borders, and a storm visibly approaches from one
  direction.
- Everything is a function of `SpaceTime.seconds` (0046). There is no state to save or sync, and
  scrubbing time scrubs weather.

### Cloud rendering

- `render/clouds` runs per camera after the opaque pass. It raymarches the shell at quarter
  resolution with a blue-noise jittered start and temporal reprojection (with 0040's history shift),
  up to 64 steps adaptively, with early-out on opacity and a coarse step in empty space.
- Density = shape noise (scaled, advected by wind) × height gradient for the local cloud type ×
  coverage from the weather map, minus detail erosion. All positions are relative to the planet
  center in km, with the 0041-style offset for the noise lookups, so clouds are stable at any radius.
- Lighting per sample: 6 light-march steps toward each of the two brightest suns, Beer-Powder, a
  dual-lobe Henyey-Greenstein phase, a multiple-scattering approximation (Wrenninge octaves), and
  ambient from the sky-view LUT. The suns' colors already include 0044 transmittance, so sunset
  clouds glow orange.
- Output: in-scatter and transmittance, composited before aerial perspective. The clouds are also
  written into 0044's froxel volume as extra extinction, so distant haze and clouds agree.
- **From orbit**: the same raymarch, entering the shell from outside, at a lower step count by
  distance. Beyond 2 000 km, the clouds become a 2D layer: the weather map's coverage shaded with a
  precomputed lighting term on the planet impostor (0046), so the planet has swirling white systems
  from far away.
- **Inside a cloud**: the raymarch starts at the camera, and visibility falls with density. Flying
  through a storm is flying through fog, dark at the core.
- **Cloud shadows**: a top-down cloud shadow map (512², following the camera) from the sun's view
  of the layer's optical depth, sampled in the lighting pass and in 0018's directional light. It
  also dims the sun term of `sunTransmittanceAt` for gameplay (solar panels, temperature).
- **IBL**: 0044's environment bake includes the clouds at low step count when the weather changes
  by more than a threshold, so overcast days are flat and grey.

### Precipitation

- A `Precipitation` system spawns a GPU particle volume (0026) around the camera: rain streaks
  (motion-stretched, with splashes on impact), snowflakes (tumbling), sand (streaking, with a
  screen-space grit overlay), and ash. The choice comes from the weather map at the camera, and the
  rate from `intensity`. Project precipitation types name their own particle effect.
- **Occlusion**: a 256² top-down height map around the camera (a depth render from above,
  refreshed when the camera moves 20 m) kills particles under cover, so it doesn't rain inside a
  cave or a ship's hangar.
- **Wetness and snow**: a global `SurfaceConditions { wetness, snow }` uniform, eased toward the
  current state (wetting fast in rain, drying over minutes; snow accumulating over minutes). The
  standard material's `pbr_input` darkens and smooths wet surfaces and whitens upward-facing
  surfaces with snow. Per-pixel, it's masked by the occlusion map, so covered ground stays dry.
- **Fog**: the state's `fog` adds Mie to 0044's atmosphere near the ground (a low-altitude density
  layer). Sandstorms are thick, low, and tinted, with reduced visibility.

### Lightning

- Strikes are placed deterministically from `(region, window, strike index)` inside storm cells
  (high coverage and cumulonimbus type). Each strike gets a branching bolt (a generated polyline
  mesh, emissive, 0.2 s), an in-cloud flash (a light added to the cloud lighting at that point),
  and a brief point light for ground strikes.
- `LightningStrike { position, time, distance }` is an event. 0050 plays thunder after
  `distance / speedOfSound`.

### Wind

- A `Wind` field per planet: a global direction and strength from the weather state, with gusts
  from 0041 noise over time and space, rotating with the region's front. `windAt(world, position,
  out)` samples it.
- Consumers: cloud advection, precipitation drift, 0045's foliage `Wind` (which becomes a view of
  this field), and 0026 particles with a `wind: f32` influence.

### Gameplay queries

- `weatherAt(world, planet, position)` returns the blended state (`coverage`, `precipitation`,
  `intensity`, `wind`, `temperature`, `hazard`, `visibility`, and whether it's `sheltered` when an
  occlusion map covers the point). It's from the CPU timeline, deterministic, and headless-safe.
- `WeatherChanged { planet, region, from, to }` events fire when the camera's region changes state.

### Agent surface

- `weather.describe { planet }` returns the current state at the camera, the next scheduled
  changes nearby with times, wind, and timings.
- `weather.at { planet, position | latlon, time? }` answers "will it be storming here in 10 minutes"
  from the timeline.
- `weather.map { planet, time?, channel }` returns an equirectangular PNG of coverage,
  precipitation, or state ids, for checking that a desert planet has sandstorms and not snow.
- `weather.force { planet, state, radius, duration }` overrides the timeline locally, for tests and
  scripted events. It's recorded in saves because it's the one stateful thing.
- `procgen.preview` of a planet (0044's three shots) gains `surface-storm` and `orbit-weather`.
- MCP tools: `describe_weather`, `weather_at`, `weather_map`, `force_weather`.
- **Errors:** `weather/no-atmosphere` (a CloudLayer without an Atmosphere), `weather/bad-layer`
  (bottom ≥ top), `weather/unknown-precipitation`.

## Decisions

- **Weather is a function of time, not a simulation.** It's deterministic, costs nothing to save,
  can be scrubbed, and agrees between visits, like orbits and populations.
- **Nubis-style clouds on a spherical shell.** It's the proven real-time approach and scales from the
  ground to orbit with one density function.
- **Clouds feed the atmosphere's froxels.** One set of haze and extinction data keeps clouds and
  aerial perspective from disagreeing at the horizon.
- **Wetness and snow as shading.** It gets most of the look for none of the geometry work, and the
  occlusion map keeps it honest under cover.
- **One wind field.** Clouds, rain, grass, and particles all lean the same way.

## Acceptance criteria

- [ ] The example planet shows cumulus from the ground, a flight up through the layer with no
      discontinuity (frame-to-frame luminance change under 5%), a cloud deck from above, and
      weather systems from orbit (goldens at each).
- [ ] Clouds cost ≤ 2.5 ms GPU at 1440p from the ground and ≤ 1.5 ms from orbit on the desktop
      (budget `gpu:clouds`, proposed), with no visible temporal smearing on a 90°/s camera pan
      (history rejection test).
- [ ] `weather.at` for a location and time returns the same state on Node and Chrome, and the
      rendered precipitation at that time and place matches it.
- [ ] A storm front approaches over 5 minutes of game time from one side (coverage at a test
      point rises monotonically across the transition), and time scrubbing back restores the
      earlier sky.
- [ ] Rain stops under a roof or in a cave within one occlusion refresh, and the ground under
      cover stays dry while open ground darkens.
- [ ] A lightning strike 3.4 km away raises `LightningStrike` with the distance, and 0050's
      thunder starts 10 s later (headless audio log).
- [ ] Cloud shadows move across terrain with the wind, and `sunTransmittanceAt` under a thick
      cloud is below 20% of clear sky.
- [ ] A desert planet's `WeatherSet` never produces snow, and `weather.map` shows sandstorms only
      over desert biomes.

## Open questions

- Should cloud layers support two decks (low cumulus and high cirrus as a 2D layer)? Proposed: yes,
  with cirrus as a cheap 2D layer at the top of the shell, if the goldens look flat without it.
- None blocking. Deferred: tornadoes, aurorae (a nice fit for 0044 plus a magnetic field
  param), rainbows, and puddles.
