# 0133 — Weather

- **Status:** draft (visual pass built; tests to come)
- **Packages:** `@aethervtt/shard-weather` (new), `@aethervtt/shard-particles`,
  `@aethervtt/shard-sky`, `@aethervtt/shard-wind`
- **Depends on:** 0026, 0069, 0077, 0087, 0096, 0116, 0118, 0128, 0130, 0131, 0132

## Context

0130–0132 give a sky, clouds and fog, each with fields a game can set by hand. Weather is what
sets them together: rain needs clouds, wind, wet ground, darker light and the sound of rain, all
rising over the same two minutes. UDS's weather half (UDW) does it with one weather state (cloud
coverage, fog, wind, rain, snow, dust, thunder) taken from a preset, a random climate or a
script, overridden in regions and storms, and read by everything else.

That works, and this spec keeps the model, with three changes for Shard:

- The state is **deterministic from the tick**, so `shard run` hashes, multiplayer and saves get
  it for free.
- Channels are **a registry**, so a game can add its own.
- Every way of overriding the weather locally is **one modifier stack**.

0049's timeline idea (weather as a function of time) survives. Its planet-wide regions don't:
weather here is around a listener, with zones and storms placed in the world.

## Goals

- **A weather state of named channels.** `cloudCoverage`, `cloudType`, `fog`, `wind`, `rain`,
  `snow`, `dust` and `thunder`, plus temperature, plus channels a project defines.
- **Material state that accumulates and dries:** `wetness`, `snowCover`, `dustCover`. 0134 reads
  it.
- **Presets as assets**, with twelve built in.
- **Three base sources:**
  - a fixed preset;
  - a schedule;
  - a random climate, with seasons, that can be evaluated at any time, the future included.
- **Timed transitions**, started by a command that lands on the same tick everywhere.
- **Local overrides in one stack:** weather zones, radial storms, script modifiers, and the
  above-the-clouds rule.
- **Weather drives:**
  - clouds (0131's cloud map) and fog (0132);
  - wind (0096);
  - precipitation particles, kept out from under cover;
  - lightning with thunder;
  - audio parameters;
  - road wetness (0118).
- **A weather mask:** where the sky reaches, around the camera, for particles and for 0134.
- **Gameplay queries**, headless: `weatherAt`, `exposureAt`, `temperatureAt`, a forecast, and
  per-entity exposure.

## Non-goals

- Simulated weather (fronts, pressure, humidity transport).
- Planet-wide weather maps and weather seen from orbit (0049's, a later extension).
- Shipping sounds. Weather exposes parameters and events, and the project's audio events (0077)
  play them.
- Snow and puddles as geometry, and surface shading (0134).
- Puddle fluid volumes, window rain and wipers, screen-space droplets and frost, and rainbows
  (deferred).

## Design

### Channels and presets

```ts
defineWeatherChannel('risen/toxicity', {
  default: 0, min: 0, max: 1,
  blend: 'linear',                     // or 'max': zones and storms can only raise it
  material?: { rise: 0.02, fall: 0.002 }   // per second: also keep an accumulated version
})
Weather {                              // on the Sky entity, or alone without 0130
  source: 'preset' | 'schedule' | 'random' = 'preset'
  preset: handle('WeatherPreset')      // source preset
  schedule: list(struct { at: f64 /* game hours since day 0 */, preset, over: f32 })
  climate: handle('Climate')           // source random
  seed: u32
  windDirection: vec3 = [1, 0, 0.35], windVariance: f32 = 20     // degrees of slow noise
  materialState: 'simulate' | 'direct' = 'simulate'
  drivesWind: bool = true
  listener: entity                     // whose position the local state is taken at; default the camera
}
WeatherPreset (*.weather.json) { name, displayName, channels: { rain: 0.8, … }, temperature: f32 /* bias °C */,
  windSpeed: f32 /* m/s at wind 1 */, effects?: { rain?, snow?, dust?, debris? /* ParticleEffect refs */ },
  lightning?: { interval: [f32, f32], obscured: f32 }, fogColor?: color }
Climate (*.climate.json) { seasons: { spring|summer|autumn|winter: { temperature: [min, max],
  weights: { [preset]: f32 }, interval: [f32, f32] /* game hours */, transition: [f32, f32] } } }
```

- The state is a `Float32Array` with one slot per registered channel. Blending, zones and
  uploads loop over slots, never over names, so per-frame work allocates nothing.
- Built-in presets: `clear`, `partly-cloudy`, `cloudy`, `overcast`, `foggy`, `light-rain`, `rain`,
  `thunderstorm`, `light-snow`, `snow`, `blizzard`, `dust-storm`. Built-in climates:
  `temperate`, `desert`, `arctic`, `tropical`.
- **Seasons** come from 0130's date and the latitude's hemisphere, as four weights that sum to 1
  (spring, summer, autumn, winter), smoothly blended across a 15-day transition. `Weather.season`
  can fix them. `seasonAt(world)` returns them.

### The base state

All three sources are pure functions of the game time (0130's day and hours) and the replicated
singleton below:

- **`preset`**: the preset's channels.
- **`schedule`**: a list of entries sorted by `at`. The state at time t is the previous entry's
  preset, transitioning to the next over its `over`.
- **`random`**: game time is cut into windows whose lengths come from
  `hash(seed, window index)` within the season's `interval`. Each window picks a preset by the
  season's weights from the same hash, and transitions into it over a hashed `transition`.
  Because windows only depend on the seed and the index, `forecast(world, hours)` reads the
  future without simulating it.

**Commands.** `changeWeather(world, preset | channels, { over, fromTick? })` overrides the base
from a tick on. It follows 0096's pattern: a replicated singleton, `WeatherState { source,
preset, seed, from: snapshot, to, startTick, overTicks, materialSnapshot }`, written by the server
and applied by every machine at `startTick`. `resumeWeather(world, { over })` returns to the
component's source. Clients evaluate the same functions, so the only replicated traffic is a
command or a source change.

### Modifiers

The local state at a point is the base state with an ordered stack of modifiers applied:

```ts
WeatherZone {                          // with a Transform
  shape: 'box' | 'sphere' | 'polygon', points: list(vec2)   // polygon: xz, extruded without a top
  edge: f32 = 50                       // metres of blend inside the boundary
  priority: i32 = 0
  preset: handle('WeatherPreset'), channels: map(string, f32)   // either or both
  mode: 'override' | 'add' | 'multiply' = 'override'
  temperature?: [f32, f32], climate?: handle('Climate')        // a zone can have its own climate and seed
}
Storm { radius: f32 = 3000, core: f32 = 0.5 /* fraction at full strength */, preset,
        velocity: vec3, lifetime: f32, fade: f32 = 60 }       // a moving radial storm
addWeatherModifier(world, { channels, weight, ease }) → handle // scripted, global; remove with the handle
```

- Weight inside a zone ramps from 0 at its boundary to 1 at `edge` inside. Modifiers apply in
  priority order, then script modifiers in insertion order.
- **Above the clouds:** while the listener is above `Clouds.bottom + thickness`, precipitation
  and fog are multiplied by 0. It's a built-in modifier with no settings.
- **Storms** can spawn from the climate (`Climate.storms: { chance, radius, speed }` per season),
  deterministically from the window hash, or be placed by a game. They move with their velocity.
- Every zone and storm also registers its shape as a **0131 cloud map source**, with the
  coverage and type of its preset. So a storm is visible as a dark cell on the horizon before it
  arrives, as in UDS.
- Zones and storms are ordinary entities. Replicate them and clients see the same weather.

### Local state and drives

`weather/update` (`FixedUpdate`) evaluates the base and the stack at the listener's position,
integrates the material state, and writes the drives below. The local state is what the player
feels. The cloud map is what the sky shows everywhere.

- **Clouds and sky.** Writes `Clouds.coverage` and `type`, and the ProceduralSky's turbidity
  (haze rises with fog and dust).
- **Fog.** Writes `Fog.density`, `heightFalloff`, `color` and `fogNoise` (0132) from `fog` and
  `dust`. The values are the preset's, eased.
- **Wind.** With `drivesWind`, writes `wind/Wind`: speed from the `wind` channel times the
  preset's `windSpeed`, direction from `windDirection` plus slow deterministic noise within
  `windVariance`, and gustiness rising with wind. Every machine computes the same wind, so weather
  writes `Wind` directly instead of through `WindState`. A game that also calls `scheduleWind` gets
  `weather/owns-wind` (a warning).
- **Material state.** `wetness` rises with `rain` and falls with drying (faster with wind and
  warmth). `snowCover` accumulates while `snow > 0` and the temperature is below 1 °C, and melts
  above it. `dustCover` follows `dust`. Rates are per preset, with defaults. `materialState:
  'direct'` makes them equal the channels (for cinematics and tests). The server writes
  `materialSnapshot` every 10 s, clients ease to it, and saves keep it.
- **Temperature.** The season's range mapped by a diurnal curve (lagged sun elevation, peaking
  around 15:00), plus the preset's bias, plus slow hashed noise. `temperatureAt(world, pos)`
  applies zones and blends toward `interiorTemperature` (default 18 °C) by shelter.
- **Physics.** Writes `physics/RoadConditions.wetness = wetness` when physics is present, so 0118's
  cars lose grip in the rain.
- **Audio.** Sets global 0077 parameters every tick, eased: `weather.rain`, `weather.snow`,
  `weather.wind`, `weather.thunder`, `weather.dust`, `weather.outdoors` (the listener's shelter,
  0–1), `time.hour`, and `time.daylight`. Project events read them.
- **Events.** `WeatherThreshold { channel, rising }` fires when a channel crosses its threshold (a
  per-channel setting; default 0.1). This covers started and stopped raining, getting foggy, and
  the rest with one event. `WeatherChanged { from, to, displayName }` fires when the base preset
  changes. `LightningStrike` is described below.

### The weather mask and shelter

What the sky reaches is computed two ways, for two jobs:

- **The GPU weather mask**, for visuals. It's a camera-centered top-down depth map (512², 128 m
  by default) of the highest occluder at each xz:
  - It re-renders when the camera moves a quarter of its range, or when a mesh in it changes. The
    render uses the shadow caster lists of 0116, so a still scene costs nothing.
  - Points below the stored height are covered. Precipitation and 0134 sample it through
    `shard::weather::exposure(world)`.
  - `WeatherMaskBrush` entities (a box, or a texture projected down) add or remove coverage per
    channel (rain, snow, dust), for places geometry gets wrong. A covered bridge with gaps is one
    example; a shelter whose roof is hidden is another.
- **CPU shelter**, for gameplay. `exposureAt(world, pos)` combines shelter sources registered with
  `addShelterSource(world, fn)`, taking the minimum:
  - When structure is present, the weather plugin registers 0069's `skyAt`.
  - When physics is present, it registers an upward ray cast (50 m).
  - It also registers the mask brushes.

  It's deterministic and headless. The GPU mask is only ever visual, so gameplay never waits on a
  readback.

### Precipitation

- Rain, snow, dust and wind debris are 0026 effects, with defaults shipped and replaceable per
  preset. They spawn in a box around the camera (`spawnRadius` 30 m, height 20 m), offset upwind
  and ahead of the camera's motion, at a rate scaled by the channel and `engine/Settings.quality`.
  Particles take the wind through 0026's `wind` influence.
- Two generic particle modules are added to 0026. Neither knows about weather:
  - `heightFieldKill` kills a particle below a registered height texture. Weather registers the
    mask, so rain stops at a roof with no CPU cost.
  - `spawnOnHeightField` spawns on that surface. Rain splashes and snow puffs land on whatever is
    highest, roofs included.
- Debris (leaves, paper) appears above `wind` 0.6.

### Lightning

- **Strikes.** With `thunder > 0`, strikes come from `hash(seed, window, i)` at intervals from the
  preset, placed in the cloud map's high-coverage, high-type area within 10 km of the listener.
  Every machine places the same strikes on the same ticks.
- **What a strike draws.** A ground strike gets:
  - a branching bolt (a generated polyline ribbon, emissive, 0.2 s with one or two re-strokes);
  - a 0131 `cloudFlash` at its root;
  - a short shadowless point light at the ground.

  `obscured` sets the fraction of flashes that stay inside the cloud, with no bolt.
- **Targets.** `LightningTarget { weight }` entities are struck preferentially, up to
  `fractionTargeted` of the strikes, chosen by the hash.
- **Events.** `LightningStrike { position, distance, target?, ground }` fires on the strike tick.
  The project's `weather/thunder` audio event (0077) is posted after `distance / 343` s, with a
  `distance` parameter.

### Exposure on entities

`WeatherExposure {}` on an entity makes `weather/exposure` keep `wet`, `snowed`, `cold` (°C) and
`wind` on it. Each is eased toward `exposureAt` times the channels at its position, at rise and
fall rates on the component. It's for gameplay (a character soaked through, a fire going out in
the rain), and 0134 can read it per entity. It updates in round-robin, 64 entities a tick.

### Agent surface

- `weather.describe`:
  - the source, preset and display name, and the command in force;
  - the channels at the listener, the material state and the temperature;
  - active modifiers with their weights;
  - the next changes, with game and real times.
- `weather.set { preset | channels, over }` and `weather.resume { over }`.
- `weather.at { position, time? }` and `weather.forecast { hours, step }`.
- `weather.mask {}` returns the GPU mask as a PNG.
- MCP: `describe_weather`, `set_weather`, `weather_at`, `forecast_weather`.
- `shard screenshot --weather storm` (with `--time` from 0130) sets the preset with
  `materialState: 'direct'` and warms precipitation for 2 s, so one command gives a settled frame.
- The docs skill `.agents/skills/weather.md` covers presets, climates, zones, storms, channels,
  audio parameters and events.
- Errors:
  - `weather/unknown-preset` and `weather/unknown-channel` (both with `path`);
  - `weather/bad-climate` (a season whose weights are all 0);
  - `weather/two-weathers`;
  - `weather/owns-wind` (a warning);
  - `weather/no-sky` (info: no 0130 Sky, so no clouds or clock; game time comes from
    `TimeOfDay` alone).

## Decisions

- **Deterministic from time and replicated commands.** It's 0049's best idea and UDW's
  replication model in one. Clients compute their own weather, saves store a command and a
  material snapshot, and a forecast is a function call.
- **Channels are a registry, not fixed fields.** UDW's state is closed. A game's toxic fog or ash
  fall blends, zones, replicates and reaches shaders like rain does.
- **One modifier stack.** UDW has override volumes, radial storms, sky modifiers and
  above-the-clouds multipliers as four systems. Here they're one ordered blend, and the cloud map
  shows the spatial ones from afar.
- **Weather writes `Wind`, not `WindState`.** Every machine already computes the same weather, so
  routing wind through the network would add a tick of latency and nothing else.
- **Two shelter answers.** The GPU mask is cheap and exact for visuals. Gameplay needs a CPU
  answer that's deterministic and headless, and 0069 and physics already have one.
- **Generic particle modules.** `heightFieldKill` and `spawnOnHeightField` are useful beyond
  weather (smoke under a ceiling, leaves on roofs), and particles stays independent.
- **No audio assets.** Sound is a project's style. Parameters and events let 0077 do what UDW's
  sound classes do, without shipping sounds.

## Acceptance criteria

- [ ] `random` with the `temperate` climate over 2 game days: `weatherAt` at five points matches
      on Node and Chrome, and on a server and two clients (`shard run --net clients=2`), at every
      tick, and the world hashes agree.
- [ ] `weather.forecast` at 10:00 for 14:00 names the preset that's in force when the clock reaches
      14:00.
- [ ] `changeWeather('thunderstorm', { over: 120 })`: `rain` rises monotonically and reaches the
      preset's value at exactly 120 s, and every client starts the change on the same tick.
- [ ] Walking into a `WeatherZone` with a 50 m edge blends its channels linearly over those 50 m.
      Of two overlapping zones, the higher priority wins.
- [ ] A `Storm` 15 km from the listener shows on 0131's cloud map at its preset's coverage while
      the listener's rain is 0, and as it passes overhead rain rises and falls again.
- [ ] Under a structure roof, no rain particle is alive below the roof within one mask refresh,
      and `exposureAt` there is 0 while it's 1 in the open yard.
- [ ] A strike 3.4 km away raises `LightningStrike` with that distance, and `weather/thunder`
      starts 9.9 s later (headless audio log).
- [ ] In rain, `wetness` rises at the preset's rate and `RoadConditions.wetness` follows. After the
      rain, it dries at the drying rate, faster in wind.
- [ ] `snowCover` doesn't grow at 5 °C during snow and melts above 1 °C.
- [ ] The `desert` climate produces no snow preset over 1 000 simulated days. `arctic` produces no
      rain in winter.
- [ ] A project channel defined in the `weather` demo blends through a zone and is readable in
      WGSL (0134's accessor) and from `weatherAt`.
- [ ] `weather/update` stays under `weather/update` (proposed: 0.05 ms with 16 zones, 2 storms and
      64 exposed entities) and allocates nothing in `pnpm bench`. Heavy rain at 1440p stays within
      `gpu:precipitation` (proposed: 0.3 ms, like 0026's particles demo at its count). The mask
      stays within `gpu:weather-mask` (proposed: 0.1 ms on a refresh frame, 0 otherwise).

## As built (visual pass)

What the first pass built differs from the design above in these ways; tests and the rest follow
once the look is approved.

- **Precipitation is drawn, not simulated.** Rain and snow are instanced streaks and flakes whose
  positions are a function of time, wrapped in a box around the camera (`shard::weather::precip`).
  They're lit by `apply_lighting`, so lamps, the flashlight and shadows light them. 0026 effects
  for splashes and debris are still to come.
- **The weather mask is WeatherMaskBrush boxes only.** The GPU top-down depth mask, 0069's sky
  visibility and the CPU shelter sources are still to come.
- **Seasons** come from the sky's date and the hemisphere of its latitude (or are fixed with
  `Weather.season`): four weights blended over 15 days, which pick each climate's seasonal table and
  shift the temperature (summer +7 °C, winter −9 °C; up to +4 °C with the sun high).
  `weather_season()` gives them to shaders. Climates are `{ weights, seasons? }`.
- **Random climates change on game-hour windows** (`changeEvery`, default 3 h), so
  `forecastWeather(world, { hours, step })` reads the future exactly; schedules
  (`Weather.schedule`, entries of game hours, preset and seconds) are evaluated the same way.
- **Audio:** `weatherAudioPlugin` (added by projects with `audio/events`) writes `weather.rain`,
  `.snow`, `.wind`, `.thunder`, `.dust`, `.outdoors`, `.lightning`, `time.hour` and `time.daylight`
  into every global parameter bank that declares them. `exposureAt` is the CPU shelter test (mask
  brushes); `WeatherState.outdoors` is it at the listener.
- **Zones, seasons, schedules, forecasts and audio are in; storms, RoadConditions and the agent
  surface are not.**
- **`strikeLightning(world, position)`** places a strike for scripted moments. Bolts glow for half a
  second after their strokes; a DirectionalLight flashes the land and SkyFlash lights the clouds.

## Open questions

- None blocking. Deferred: window rain and wipers, screen droplets and frost, puddle fluid volumes,
  rainbows, heat haze, and planet-wide weather.
