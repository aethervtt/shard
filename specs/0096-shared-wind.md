# 0096 — Shared wind

- **Status:** draft
- **Packages:** `@aethervtt/shard-wind` (new), `@aethervtt/shard-scatter`, `@aethervtt/shard-nature`,
  `@aethervtt/shard-net`
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
Wind {                                    // resource, package @aethervtt/shard-wind
  direction: vec3 = [1, 0, 0.35]          // world-space, toward where it blows; normalized on use
  speed: f32 = 6 (m/s)                    // at 10 m: 0 calm, 6 a breeze, 15 a strong wind, 25+ a storm
  gustiness: f32 = 0.3                    // 0..1: how much gusts add, as a fraction of speed
  gustScale: f32 = 0.05 (1/m)             // gust waves per metre
}
```

- `strength` becomes derived: `strength = speed / 6`, so 0045's tuned sway (1 is a breeze) keeps
  its look. `scatter/Wind` stays as a deprecated alias for one release: reading or writing it reads
  or writes `Wind`, and `shard validate` warns on scenes that set it.
- Gusts are a pure function of `(position, time)`: value noise moving downwind, the same formula
  `SWAY_WGSL` uses today, moved here.

### Queries

```ts
windAt(world, position: Vec3, out: WindSample): WindSample   // { direction, speed, gust }
```

- Uniform wind, then `WindZone`s in order. No allocation: it writes into `out`.
- WGSL: `shard::wind` exports `wind_at(p: vec3f, time: f32) -> vec4f` (direction × speed, gust),
  from a small uniform block the plugin writes when `Wind` or a zone changes. Materials import it
  instead of carrying `windDirection`/`windStrength` fields. `scatter/Vegetation` and `nature/Tree`
  move to it, and `applyWind` goes away.

### Zones

```ts
WindZone { shape: 'box' | 'sphere', size: vec3, falloff: f32 (m),
           speedScale: f32 = 1, override?: { direction: vec3, speed: f32 }, priority: i32 }
```

- Up to 16 zones are uploaded (nearest the camera when there are more, `wind/too-many-zones`
  warning). Zones blend by `falloff`, highest priority last.

### Multiplayer

- 0087 doesn't replicate resources ("game state that isn't an entity goes on a singleton
  entity"). So the server's wind lives on a singleton entity with a `WindState { wind, fromTick }`
  component, replicated as usual, and clients copy it into their `Wind` resource at `fromTick`.
  Every client switches on the same tick, and water's spectrum (0098) rebuilds from the same
  inputs everywhere. Consumers that would pop (the ocean) crossfade over a fixed number of ticks
  from that tick. `WindZone`s are entities and replicate like any other.

### API sketch

```ts
import { Wind, WindZone, windAt, windPlugin } from '@aethervtt/shard-wind'

app.addPlugin(windPlugin)
world.resource(Wind).speed = 18           // a gale: trees bend, the sea whitens
const w = windAt(world, [x, 2, z], sample)
```

### Agent surface

- `wind.describe` (protocol, MCP `describe_wind`): the resource, zones, and `windAt` at a point.
- `render.capture { debug: 'wind' }` draws arrows on a grid around the camera, coloured by speed.
- **Errors:** `wind/too-many-zones` (warning), `wind/bad-direction` (a zero direction with a
  speed above 0).

## Decisions

- **Its own package.** scatter, nature, water, particles and weather all read it; none should
  depend on another to do so.
- **Speed in m/s.** Wave spectra, spray and audio need a physical quantity; sway keeps its tuning
  through the derived `strength`.
- **Materials read wind from one WGSL module.** Copying wind into every material asset each frame
  (0045's `applyWind`) only reached materials scatter knew about.

## Acceptance criteria

- [ ] scatter's grass and a 0095 tree placed by hand both sway with `Wind`, with no wind fields on
      their materials.
- [ ] Old scenes that set `scatter/Wind` load with the same look, and `shard validate` warns.
- [ ] `windAt` matches `wind_at` on the GPU within 1e-4 m/s at 1 000 points (readback test).
- [ ] A `WindZone` with `speedScale: 0` stills the grass inside it, with a `falloff`-wide blend.
- [ ] Two `shard run --net clients=2` clients that change wind at tick 600 report the same
      `windAt` from tick 600 on.
- [ ] `windAt` allocates nothing (allocation check under `pnpm bench`).

## Open questions

- Should `speed` be authored as a Beaufort number in the inspector? Proposed: m/s, with the
  Beaufort name shown beside it.
