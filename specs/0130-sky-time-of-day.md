# 0130 — Sky and time of day

- **Status:** draft
- **Packages:** `@aethervtt/shard-sky` (new), `@aethervtt/shard-render`, `@aethervtt/shard-cli`
- **Depends on:** 0018, 0019, 0023, 0044, 0064, 0087, 0096

## Context

Shard can draw a correct sky (0044) but has no clock to drive it. A scene that wants a day turns
its own DirectionalLight, as the playground's `sky` demo does, and night is only a sun below the
horizon: there's no moon, no stars, and the scene goes black. Every game with an outdoor world
writes the same script, and none of them sync it over the network.

Unreal's Ultra Dynamic Sky (UDS) shows what a game expects from one drop-in sky: a time of day
that animates, a sun and moon that light the scene and hand shadows between them, moon phases,
stars, aurora, a choice of cloud renderers ("sky modes"), and events at sunrise and sunset. This
spec is the base of a family that brings that to Shard:

- **0130** (this): time of day, sun, moon, stars, aurora, sky modes, and color modes.
- **0131** clouds, **0132** volumetric fog, **0133** weather, **0134** surface weather.

They supersede 0049, which was written for the space explorer and never built. Its planet-scale
parts (orbit views, cube-sphere weather maps) become a later extension. The cloud shell stays a
sphere around the atmosphere's center, so nothing here blocks that extension.

## Goals

- One `Sky` component sets up an outdoor sky: clock, sun, moon, stars, sky mode, color mode.
- A game clock (`TimeOfDay`) with separate day and night lengths, pausing, scrubbing and timed
  transitions. It's derived from the fixed tick, so it's deterministic and the same on every
  machine of a multiplayer session.
- The sun and moon drive ordinary DirectionalLights. Shadows, Toon, interior lighting (0069) and
  the atmosphere keep working unchanged, and only one of the two casts shadows at a time.
- An optional real sky: sun and moon positions from latitude, longitude, date and time zone, with
  moon phases.
- A night sky: a procedural star field (or a real star catalog) that turns with sidereal time, a
  phase-lit moon disk, a Milky Way band, and 2D aurora.
- Sky modes as a registry. This spec adds `none` and `space`; 0131 adds the cloud modes. Each mode
  names its baseline fallback.
- Two color modes: `atmosphere` (0044) and `gradient`, which is cheap, art-directable, and runs
  on the baseline tier.
- Headless events and queries: sunrise, sunset, hour changes, custom times, `isDaytime`, and
  `sunAt`.
- A realistic playground demo, `weather`, that the rest of the family builds on.

## Non-goals

- Exposure control. 0023's `AutoExposure` keeps it; the Sky only lifts night light (see Night).
- Clouds (0131), fog (0132), and weather and seasons (0133). The date lives here; seasons are
  derived from it in 0133.
- Eclipses, other planets in the sky (0046), lens flares, and light shafts (0132 gives
  volumetric shafts).
- Calendars other than Gregorian, and daylight saving rules. A game that wants them sets
  `timeZone` itself.

## Design

### Components and resources

```ts
Sky {                                   // one per world (sky/two-skies otherwise)
  mode: string = 'none'                 // a registered sky mode: none, space; 0131 adds more
  colorMode: 'atmosphere' | 'gradient' = 'atmosphere'
  gradient: handle('SkyGradient')       // colorMode gradient; default: a built-in day/dusk/night set
  sun: entity, moon: entity             // DirectionalLights; spawned as children when unset
  sunIlluminance: f32 = 100000          // lux at the top of the atmosphere
  moonIlluminance: f32 = 0.3            // lux at full moon; scaled by phase
  nightBrightness: f32 = 1              // artistic lift of moon, stars and night sky (see Night)
  path: 'simple' | 'real' = 'simple'
  yaw: f32 = 0, tilt: f32 = 30          // simple path: azimuth of sunrise, and the arc's tilt from overhead (degrees)
  latitude: f32 = 45, longitude: f32 = 0, timeZone: f32 = 0, north: f32 = 0   // real path; north = world yaw of north
  stars: f32 = 1, twinkle: f32 = 1, starCatalog: handle('StarCatalog')       // empty: procedural
  milkyWay: f32 = 1
  moonTexture: handle('Texture')        // empty: the built-in 512² moon
  aurora: f32 = 0                       // 2D aurora strength (visible at night only)
}
TimeOfDay (resource) { hours: f64, day: i32, date: { year, month, day }, dawn: f32 = 6, dusk: f32 = 18,
                       dayLength: f32 = 1200, nightLength: f32 = 600, /* real seconds */ paused: bool }
```

`SkyGradient` (`*.sky-gradient.json`) holds zenith, horizon and ground colors, plus sun and moon
light colors, keyed by sun elevation. It's 0019's studio gradient made data.

### The clock

- Time comes from the sky's tick (`skyTick`), not from accumulated deltas: the fixed tick, or on a
  multiplayer client the server's (`NetClock.serverTick`), as 0098's waves read it. The `Clock`
  resource holds an anchor (hours since day 0 at a tick) and the rates. `hours` is a
  piecewise-linear function of `tick - anchorTick`: game hours between `dawn` and `dusk` take
  `dayLength` real seconds, and the rest take `nightLength`. Every machine computes the same hours
  for the same tick, with no drift and no traffic, and a server needn't run a sky at all.
- The clock starts at `TimeOfDay`'s hours: at the first tick it runs, or on a client at the
  server's tick 0, where every player's clock started however late they joined. A
  `setTimeOfDay` or rate change re-anchors at the tick it's made on, so every client must make it
  at the same server tick (from a replicated event, say). A server-side change that clients follow
  by themselves needs the anchor replicated; that isn't built.
- `setTimeOfDay(world, '18:30' | hours, { fromTick?, day? })` re-anchors.
  `transitionTimeOfDay(world, to, seconds)` sets a temporary rate that reaches `to` at a known
  tick, which makes a fast-forward to morning when sleeping deterministic. `paused` freezes the
  clock.
- The date advances at midnight. `TimeOfDay.day` counts days since the start.
- Events, which fire on the tick that crosses them, headless: `Sunrise`, `Sunset` (the sun's
  center crossing 0° elevation, with optional offsets), `Midnight`, `HourChanged`, and
  `TimeMarker { name }` for `addTimeMarker(world, name, hours)`.

### Sun and moon

- **Simple path.** The sun rises at `dawn` on azimuth `yaw`, peaks at `90 − tilt` degrees, and sets
  at `dusk`. The moon runs the same arc twelve hours behind, with its phase advancing over a
  29.53-day cycle.
- **Real path.** The sun comes from NOAA's solar position equations (about 0.01° against the
  almanac), and the moon from Meeus' low-precision lunar theory (chapter 47, truncated to the main
  terms: about 0.3°). Both give phase and illuminated fraction. They're about 150 lines of f64
  math and have no dependencies.
- `sunAt(world, hours?, day?)` and `moonAt(...)` return direction, elevation, azimuth, and (for the
  moon) phase and illuminated fraction. They work headless.
- Lights. The Sky writes each light's direction, color and illuminance in `sky/update`
  (`PostUpdate`, before render extraction):
  - The sun's illuminance is `sunIlluminance` at the top of the atmosphere. 0044 already applies
    transmittance, which makes dusk orange.
  - The moon's illuminance is `moonIlluminance × illuminated fraction × nightBrightness`.
  - The moon is the atmosphere's second sun. 0044 already scatters the two brightest
    DirectionalLights, so a moonlit sky comes for free.
  - Since the lights keep their top-of-atmosphere illuminance, `SkyFrame.sunGround` and
    `moonGround` report what reaches open ground (lux and a luminance-1 color, so
    `illuminance × color` is lux per channel). They're computed on the CPU through the default
    sky's atmosphere, from 10 m up, with the disk setting over its own width. Game code that scales
    its own light by the sun's (a glint, unlit particles) reads them; cloud shadows aren't counted.
- Shadows hand over at twilight. The sun casts while its elevation is above −2°. The moon casts
  once the sun is below −6° and the moon is above 2°. Each light's `illuminance` crossfades
  across the gap, and its `shadows` flag flips only while its contribution is under 5%, so the
  switch can't be seen. Only one cascade set is paid for at a time.
- `DirectionalLight.disk: bool = true` (new) lets the Sky turn off 0044's plain disk for the moon.
  The moon's disk is drawn by the sky background below.

### The sky background

0044's sky pass composites the atmosphere over a background, attenuated by transmittance. That
background becomes a **hook**, `shard::sky::background(dir) -> vec3f`, which the sky plugin fills
when a `Sky` is present. Without a `Sky`, it's the environment map, as before. So stars, the moon
and aurora sit behind the atmosphere and fade out at dawn by physics, not by a timer:

- **Stars.** Procedural by default: the direction is mapped to a cube-face grid of cells, and each
  cell hashes to at most one star with a magnitude (a power law for counts) and a color
  temperature (2 500–12 000 K). Stars are point-filtered with a footprint of one pixel, so they
  don't shimmer. A `StarCatalog` asset (the Yale Bright Star Catalogue, about 9 100 stars, 72 KB
  binary; shipped as an optional asset) replaces the hash with real stars. The sphere turns about
  the celestial pole, which sits at `latitude` above north, at sidereal rate. Twinkle is
  scintillation noise that grows toward the horizon.
- **Milky Way.** A procedural band (0041 noise along a great circle tilted 62.9° to the celestial
  equator) at the luminance of a dark site.
- **Moon.** A textured disk, 0.52° across by default. Its normal map is derived from the albedo,
  and it's lit by the true sun direction, so the terminator, crescent and earthshine all fall out
  of the same shading.
- **Aurora (2D).** Curtains from scrolling 0041 ridged noise along a few arcs toward the pole,
  green below and violet above. They're scaled by `aurora × (1 − daylight)`.

All of it is in cd/m² (a clear moonless sky is about 0.001 cd/m², Venus is about 0.1 cd/m² over
its point). It's lifted by `nightBrightness`, so a game chooses between "realistic" and "game
night" with one value.

### Night

Physical night is about 0.3 lux of moonlight against 100 000 lux of sun. Auto exposure can't
span that range, and its `maxEv` clamp makes night black. `nightBrightness` (default 1, physical;
around 20 is a typical "game night") multiplies the moon light, the background, and the night sky's
in-scatter (the atmosphere's moon contribution). It doesn't touch the sun, so daytime and dusk
are unchanged. `sky.describe` reports the EV100 a camera would need, so an agent can set
`AutoExposure` clamps that fit.

### Sky modes and color modes

```ts
registerSkyMode(world, {
  name: 'volumetric',
  feature: 'sky/clouds-volumetric',     // the render feature that draws it (addRenderFeatures)
  baseline: '2d',                       // the mode used on the baseline tier
  atmosphere: true,                     // false: space-like, no sky color at all
})
```

- `none`: sky color, sun, moon and stars, and no clouds. `space`: no atmosphere and no sky color,
  only the background (stars, moon, sun disk at full top-of-atmosphere illuminance). The Sky
  removes its ProceduralSky and ignores the scene's Atmosphere for that camera.
- A mode that isn't registered logs `sky/unknown-mode` and draws as `none`. A mode whose feature
  can't run on the device switches to its `baseline` mode and logs `sky/mode-fallback` once.
- **`atmosphere`** uses the camera's primary Atmosphere (0044) if the scene has one. Otherwise the
  Sky adds a ProceduralSky to its own entity. Weather (0133) changes that ProceduralSky's turbidity
  for haze.
- **`gradient`** draws the `SkyGradient` and lights with its colors. It has no LUTs, so it's the
  default on the baseline tier when no Atmosphere is present, and the choice for stylized games.
  The background hook applies to both modes.
- IBL follows as it does today. The environment bakes from the sky when the sun turns more than
  0.25° (0019's threshold). At a 20-minute day that's one bake every 1.4 s of play, and 0044 caps a
  moving camera at one bake every 8 frames. Stars aren't baked: at night the bake keeps a floor of
  `nightBrightness × 0.002` cd/m² so night IBL isn't zero.

### Plugin and packages

`skyPlugin` is in `@aethervtt/shard-sky`, which depends on render, wind and net. It registers
`none` and `space`, the background hook, `sky/update`, the clock systems, and the methods below.
Nothing registers on import. Without the plugin, `renderer-min` and every existing golden are
unchanged. 0131's cloud renderers live in the same package as separate render features, each
loaded with `import()` when a camera first needs it.

### The playground demo

`weather` is a new realistic demo (no Toon, no Ink): a terrain hill with scattered grass and a few
trees, a small structure house with a roof, an open door and windows, a paved yard, and a pond,
lit with `AutoExposure` and AgX. This spec adds the panel's time slider, speed, path, sky mode,
color mode and night brightness. 0131–0134 add their own controls. It joins the browser tests'
curated set (`demos.test.ts`) and runs on both backends.

### Agent surface

- `sky.describe`: time, day, date, the clock's rates and pause state, sun and moon (direction,
  elevation, azimuth, illuminance at the camera), the moon's phase, which light casts shadows, the
  mode and color mode (and any fallback), the next sunrise and sunset in game hours and real
  seconds, and the suggested EV100.
- `sky.setTime { time: '18:30' | hours, day?, over? }` and `sky.pause { paused }`. Everything else
  is `entity.patch` on `Sky`.
- MCP: `describe_sky` and `set_time_of_day`. The CLI's `shard screenshot` and `shard run` take
  `--time 18:30` (and `--day N`).
- The docs skill `.agents/skills/set-up-a-sky.md` covers the components, the modes, night
  brightness against exposure, and syncing the clock.
- Errors: `sky/bad-time` (an unparseable time string; `hint` lists the forms), `sky/two-skies`,
  `sky/unknown-mode`, `sky/mode-fallback` (info), and `sky/not-a-light` (`sun` or `moon` set to an
  entity without a DirectionalLight).

## Decisions

- **Supersede 0049 with five specs.** UDS's scope is too big for one ~300-line spec, and 0049's
  planet framing depends on 0046, which isn't built. Each spec here builds and tests on its own,
  in order.
- **The Sky drives lights; it doesn't replace them.** Shadows, Toon, 0069 and 0044 already read
  DirectionalLights, so they keep working with no new code.
- **Time from ticks, not deltas.** Deterministic hashes in `shard run`, identical clocks on every
  client, and scrubbing all come from one function of the tick.
- **Clients read the server's tick instead of a replicated clock.** The clock is a function of the
  tick, so the server's tick is all a client needs, and a server that doesn't draw needn't install
  the sky. `TimeOfDayState` was planned for that and isn't needed for it.
- **Separate day and night lengths.** Games want short nights, as UDS does. A single `dayLength`
  can't express that.
- **The moon is the atmosphere's second sun.** 0044 already scatters two lights, so a moonlit sky
  costs nothing new.
- **One shadow-casting celestial light.** Two cascade sets would double shadow cost for the few
  minutes of twilight when both are faint.
- **A background hook under the atmosphere instead of a star skybox.** Stars and the moon fade
  with transmittance at dawn, and so do aurora and the Milky Way, with no special cases.
- **NOAA and Meeus-lite for the real path.** That's 0.01° and 0.3° in about 150 lines with no
  dependencies, which is far better than a game needs and cheap to test against published tables.
- **`nightBrightness` instead of an exposure override.** Exposure stays with 0023. A lift on
  night light keeps day and dusk physical and makes night a single value to tune.

## Acceptance criteria

- [ ] With `dawn` 6, `dusk` 18, `dayLength` 1200 and `nightLength` 600, starting at 06:00, the clock
      reads 18:00 after exactly 1 200 s of fixed ticks and 06:00 the next day after 1 800 s.
      `Sunset` and `Sunrise` fire once each, on the crossing tick (`clock.test.ts`).
- [ ] `shard run --net clients=2 --frames 3600` with a `setTimeOfDay` and a `transitionTimeOfDay`
      during the run: every client's `TimeOfDay.hours` equals the server's at the same tick, and
      the world hashes match.
- [ ] The real path is within 0.05° of NOAA's calculator for the sun and within 0.5° of JPL
      Horizons for the moon, with illuminated fraction within 2%, on the ten cases in
      `ephemeris.test.ts` (three latitudes, both hemispheres, solstices and equinoxes).
- [ ] Across a full simulated day, the sun and moon never cast shadows on the same frame, and
      the sum of their illuminance at the camera has no step larger than 5% between frames.
- [ ] Goldens in the `weather` demo, on both tiers and both color modes: noon, golden hour, dusk,
      full-moon midnight, new-moon midnight (stars and Milky Way visible), and `space`.
- [ ] At noon, stars add nothing measurable to the sky (max channel difference ≤ 1/255 against
      `stars: 0`). At new-moon midnight, a procedural sky shows at least 1 500 stars above the
      horizon at 1440p.
- [ ] A crescent moon's lit limb faces the sun's direction within 2° (rendered disk centroid
      against `sunAt`).
- [ ] The background and celestial lights add at most `gpu:sky-background` over 0044's sky pass
      at 1440p (proposed: 0.1 ms, like the sky-view LUT). `sky/update` stays under
      `sky/update` (proposed: 0.03 ms) and allocates nothing in `pnpm bench`.
- [ ] A scene without the plugin is unchanged: existing goldens match, `pnpm size --check` passes
      for `renderer-min`, and `scripts/wgsl-identity.mjs` passes.
- [ ] `sky.setTime { time: '18:30' }` followed by `sky.describe` reports 18:30 and a sun elevation
      equal to `sunAt`'s.

## Open questions

- None blocking. Deferred: eclipses, planets and moons from 0046 in the background, lens flares,
  and daylight saving rules.
