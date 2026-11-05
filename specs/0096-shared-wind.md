# 0096 — Shared wind

- **Status:** implemented
- **Packages:** `@aethervtt/shard-wind` (new), `@aethervtt/shard-scatter`, `@aethervtt/shard-nature`,
  `@aethervtt/shard-render` (shader globals, removed material fields), `@aethervtt/shard-project`,
  `@aethervtt/shard-core` and `@aethervtt/shard-runtime` (small hooks); `@aethervtt/shard-net`
  unchanged (wind uses its `NetRole`, `NetClock` and `Replicated`)
- **Depends on:** 0045, 0086, 0095

## Context

Wind lives in `scatter` today. `scatter/Wind { direction, strength, gustScale }`
(`scatter/src/foliage.ts:24`) sways grass and scattered props, and since 0095 scattered trees too:
`applyWind` writes it into any material with wind fields. Water (0097–0100) needs the same wind:
the ocean's spectrum is a function of wind speed and direction, ripples and foam grow with it, and
spray blows downwind. A storm should bend the trees and whiten the sea together.

Water can't depend on `scatter` to read a resource, and `strength` (0 calm, 1 breeze, 2+ gale) has
no unit, while a wave spectrum needs metres per second at 10 m above the surface. 0049 already
plans one `Wind` field per planet with `windAt(world, position, out)`, driving clouds, rain,
foliage and particles. This spec lands the uniform part of that now, in a package everything can
import, so 0049 later replaces the source and not the consumers.

## Goals

- A `Wind` resource in a small package, with a speed in m/s and a direction, read by scatter,
  nature, water, and later particles and weather.
- `windAt(world, position, out)` on the CPU and `shard::wind::wind_at(p)` in WGSL, both
  deterministic, both returning the same uniform wind until 0049 adds variation.
- Local overrides: `WindZone` volumes for sheltered valleys or a storm cell.
- Changes that line up across multiplayer clients, at a tick.

## Non-goals

- Spatial variation from weather fronts and noise (0049 builds it on this API).
- Turbulence for particles (0026's curl noise stays its own module).
- Wind affecting physics bodies (sails, kites). A later spec can read `windAt`.

## Design

### Resource

```ts
Wind {                                    // wind/Wind, package @aethervtt/shard-wind
  direction: vec3 = [1, 0, 0.35]          // world-space, toward where it blows; normalized on use
  speed: f32 = 6 (m/s)                    // at 10 m: 0 calm, 6 a breeze, 15 a strong wind, 25+ a storm
  gustiness: f32 = 0.3                    // 0..1: how much gusts add or take away, as a fraction of speed
  gustScale: f32 = 0.05 (1/m)             // gust waves per metre
}
```

- `strength` is derived: `windStrength(wind) = speed / 6` (`BREEZE`), so 0045's tuned sway (1 is
  a breeze) keeps its look. `scatter/Wind` stays as a deprecated alias for one release: scatter
  inserts it as a view (`windView`) whose accessors read and write `wind/Wind` (`strength` ↔
  `speed / 6`), so old scenes and old code both still work. Resources gained a `deprecated`
  option (core), and `shard validate` warns on scenes that set a deprecated resource.
- Gusts are a pure function of `(position, time)`: value noise drifting downwind, the formula
  `SWAY_WGSL` used, moved here. The noise is in the uniform wind's frame (its direction and a
  horizontal side axis), at `gustScale` cells per metre, moving 0.6 cells a second. A gust is in
  m/s: `speed × gustiness × (2g − 1)` for noise `g` in [0, 1], so `speed + gust` is the
  instantaneous speed and calm has no gusts.
- **The wind clock.** Gusts move with `windTime(world)`: fixed ticks (plus the fraction toward the
  next) times the step, so every machine agrees at a tick. On a multiplayer client it's the
  server's tick (`NetClock.serverTick`). Shaders read the same clock (`wind_time()`), not
  `globals.time`.

### Queries

```ts
windAt(world, position: Vec3, out: WindSample, time = windTime(world)): WindSample
// WindSample { direction (unit), speed (steady, m/s, after zones), gust (m/s) }
```

- Uniform wind, then `WindZone`s in order. No allocation: it writes into `out` (about 120 ns a
  call with 8 zones). Zones are as of the last PostUpdate, since they follow transforms.
- WGSL: `shard::wind` exports `wind_at(p: vec3f, time: f32) -> vec4f` (xyz the velocity,
  direction × speed after zones; w the gust) and `wind_time()`. `shard::wind::sway` exports
  `wind_sway(position, sway) -> vec3f`, 0045's sway moved here: the push at the instance's origin,
  tangent to its up axis, weighted by the part code squared. Its constants keep 0045's look at the
  default gustiness: `sway / 6 × part² × (speed × (0.675 + 0.3 × flutter) + gust × 0.65 / 0.6)`.
  `scatter/Vegetation` and `nature/Tree` call it and no longer have `windDirection`,
  `windStrength` or `gustScale`; `applyWind` and scatter's `windMaterials` are gone.
- **Where shaders find it.** `shard::globals` (bound wherever materials run: camera views,
  shadows, foliage) grew a `data: array<vec4f, 128>` that plugins reserve slots in
  through render's `ShaderGlobals` resource; the forward renderer uploads it with time and frame.
  Wind reserves 99 slots: three for the wind and clock, six per zone (world→zone rows, half size
  and falloff, override velocity and scale, flags), and `shard::wind` is generated with its slot.
  This needed no new binding in any group-0 layout.
- **Old material files.** Material types gained `removed: { field: replacement }`. A file that
  still sets a removed field loads with it ignored, and its import (MaterialImporter version 3)
  warns, which `shard validate` lists.

### Zones

```ts
WindZone { shape: 'box' | 'sphere', size: vec3 = [10, 10, 10] (m), falloff: f32 = 2 (m),
           speedScale: f32 = 1, override: bool, direction: vec3, speed: f32 (m/s), priority: i32 }
```

- `size` is the box's full size along its local axes, or the sphere's diameter (`size[0]`). The
  transform places and rotates a zone; its scale is ignored, so `falloff` stays in metres.
- Weight 1 inside the shape, falling linearly to 0 at `falloff` metres outside it (0: a hard
  edge). Inside, the wind is blended toward `wind × speedScale`, or with `override` toward
  `normalize(direction) × speed × speedScale`. Zones apply lowest priority first (ties by entity),
  so the highest wins where they overlap. Gusts scale with the resulting speed.
- `override` is flattened into three fields (`override`, `direction`, `speed`): component fields
  are columns, and a struct field would be JSON on every read.
- `windAt` uses every zone. Up to 16 are uploaded, the 16 nearest the view camera (0106) when there are
  more (logged once per count as `wind/too-many-zones`).

### Multiplayer

- 0087 doesn't replicate resources, so the server's wind lives on a singleton entity with
  `WindState { direction, speed, gustiness, gustScale, fromTick }` (flattened like zones). A game
  replicates it with `replicate(WindState, { channel: 'reliable' })`; the wind plugin then keeps
  the singleton on the server (with `net/Replicated`). Every machine copies it into `Wind` once
  the server tick reaches `fromTick` (`wind/sync`, PreUpdate), so they all switch on the same
  tick and water's spectrum (0098) rebuilds from the same inputs everywhere.
- Two ways to change it on the server. `scheduleWind(world, wind, fromTick)` writes WindState
  ahead of time: a tick a few round trips out switches every client exactly then. Writing `Wind`
  directly also works: the server publishes it from the tick it saw the change, and clients follow
  when it arrives (late by their latency).
- The server reads its own wind back from WindState the frame after publishing, so it runs on the
  same f32 values its clients receive and `windAt` agrees bit for bit across machines.
- Consumers that would pop (the ocean) crossfade over a fixed number of ticks from `fromTick`.
  `WindZone`s are entities and replicate like any other.

### Installation

- `windPlugin` from `@aethervtt/shard-wind`. `scatterPlugin` and `naturePlugin` add it when it
  isn't there (`App.hasPlugin`, new in runtime), so existing apps keep swaying with no change.
- Projects: a `wind` manifest plugin. `scatter` and `nature` imply it, and it isn't display-only,
  so a dedicated server built with `display: false` (which drops `scatter`) still has the wind
  clients sync to.

### API sketch

```ts
import { scheduleWind, Wind, WindZone, windAt, windPlugin, windSample } from '@aethervtt/shard-wind'

app.addPlugin(windPlugin)                 // or let scatter / nature add it
world.resource(Wind).speed = 18           // a gale: trees bend, the sea whitens
const w = windAt(world, [x, 2, z], windSample())
scheduleWind(world, { speed: 0 }, tick + 120)   // multiplayer: calm everywhere at that tick
```

### Agent surface

- `wind.describe` (protocol, MCP `describe_wind`): the resource with its Beaufort name and sway
  strength, the wind clock and server tick, every zone in the order it applies and how many are
  uploaded, and `windAt` at a `position`.
- The `wind` overlay (`render.capture { overlays: ['wind'] }`, `debug.overlays`) draws arrows on a
  9×9 grid every 4 m around the camera, a metre below it, coloured by speed. (Drafted as
  `render.capture { debug: 'wind' }`; plugin drawings are overlays.)
- **Errors:** `wind/too-many-zones` (warning), `wind/bad-direction` (a zero direction with a
  speed above 0: logged once, and the wind is calm until it's fixed).

## Decisions

- **Its own package.** scatter, nature, water, particles and weather all read it; none should
  depend on another to do so. nature no longer depends on scatter.
- **Speed in m/s.** Wave spectra, spray and audio need a physical quantity; sway keeps its tuning
  through the derived `strength`.
- **Materials read wind from one WGSL module.** Copying wind into every material asset each frame
  (0045's `applyWind`) only reached materials scatter knew about.
- **Installed by both.** A `wind` manifest plugin, and scatter and nature adding it when missing:
  servers need the wind without the display-only scatter plugin, and apps that only add scatter or
  nature shouldn't have to know.
- **Old material files load.** Removed fields are dropped with an import warning, not rejected:
  every 0045 vegetation material set them.
- **CPU and GPU agree within tolerance, not bit for bit.** The hash is integer math and identical,
  but the GPU evaluates the rest in f32 (and may fuse multiply-adds) where `windAt` uses f64; the
  readback test measures a worst difference of 9.4e-6 m/s over 1 000 points with zones, and 32 of
  them bit-identical as f32. The 1e-4 m/s contract holds; nothing needs more. Across CPUs (server
  and clients) `windAt` is bit-identical.
- **One shared data block in `shard::globals`** rather than a new binding: every material
  pipeline already binds it, in every pass, on both tiers.

## Acceptance criteria

- [x] scatter's grass and a 0095 tree placed by hand both sway with `Wind`, with no wind fields on
      their materials. (`scatter/src/wind.test.ts`: blades lean 0.63–0.78 m in a breeze and
      1.9–2.0 m in a gale per metre of sway; `nature/src/render.test.ts`: a hand-placed tree is
      pixel-identical across calm frames and moves at 18 m/s.)
- [x] Old scenes that set `scatter/Wind` load with the same look, and `shard validate` warns.
      (`strength: 2` reads as 12 m/s; the CLI test also checks a material file with the old wind
      fields imports with a warning.)
- [x] `windAt` matches `wind_at` on the GPU within 1e-4 m/s at 1 000 points (readback test:
      `wind/src/gpu.test.ts`, three zones, worst 9.4e-6 m/s).
- [x] A `WindZone` with `speedScale: 0` stills the grass inside it, with a `falloff`-wide blend.
      (A blade inside doesn't move; one 5 m into an 8 m falloff leans about half as far as one
      outside; `windAt` gives 0, 3 and 6 m/s across a 4 m falloff.)
- [x] Two `shard run --net clients=2` clients that change wind at tick 600 report the same
      `windAt` from tick 600 on. (`wind/src/net.test.ts` runs the same harness, `netHarness`,
      with 50 ms latency, jitter and 5% loss: server and both clients agree bit for bit at every
      tick from 560 to 780, all switching at 600.)
- [x] `windAt` allocates nothing (allocation check under `pnpm bench`; so do `wind/sync` and
      `wind/field` with 24 zones).

## Open questions

- Should `speed` be authored as a Beaufort number in the inspector? Proposed: m/s, with the
  Beaufort name shown beside it. `wind.describe` shows the name; there's no inspector yet.
