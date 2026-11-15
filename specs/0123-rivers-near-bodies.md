# 0123 — Rivers, and water bodies chosen by distance

- **Status:** draft (built 2026-11-15). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-water`
- **Depends on:** 0097 (part 1), 0071, 0106
- **Takes from 0097 part 2:** rivers, flow and the river-to-lake blend. The rest of part 2
  (volumes and sides, masks, shore distance and foam, `WaterFloor`) stays in 0097.

## Context

0097 part 1 built oceans and lakes. A region (Risen's ADR 0009) has rivers running between its
lakes and towns, and dozens of lakes and ponds over 20 × 16 km. Two things stop it: there is no
river body, and only 64 bodies draw, chosen by priority, so past 64 the lowest-priority ones stop
drawing wherever the camera is. Risen works around the second by spawning lakes per cell, which
also hides them from `waterAt` on a server that doesn't load those cells.

## Goals

- `WaterBody { kind: 'river' }` with an open `WaterSpline`: per point a surface height (its y),
  width, depth and flow. Its water draws in the shared surface, with ripples carried along the
  flow, and `waterAt` reports its surface, ground and flow velocity.
- Where a river's end is inside a lake or the ocean, it meets that body's level with no step: its
  height and flow blend into it over `max(width, 10 m)`.
- Any number of bodies: `waterAt` sees all of them (a server has no camera), and the 64 that draw
  are those nearest the view camera (0106), in priority order among themselves.
- Both tiers, as part 1.

## Non-goals

- 0097 part 2's other items (above).
- Simulated rivers, rapids or waterfalls. A river follows its spline; a drop is two rivers.
- Carving the bed. 0071's `carve` splines (or a terrain generator, 0119) make it.

## Design

### Rivers

```ts
world.spawn(
  [WaterBody, { kind: 'river', optics: waterOptics('river') }],
  [WaterSpline, { closed: false, points: [
    { position: [0, 12, 0], width: 14, depth: 2, flow: 1.2 },
    { position: [300, 10.5, 120], width: 18, depth: 2.5, flow: 1.0 },
    …
  ] }],
  Transform,
)
```

- The centre line is 0071's uniform Catmull-Rom (`sampleCatmullRom`, as lakes and terrain splines
  are), and width, depth, flow and the surface height are interpolated along it the same way
  (each sampled as the y of a copy of the points with the same x and z, so they get the same
  pieces). Positions are in the entity's frame; the entity's y adds to the heights.
- **Shape.** Per sample: world x, z, surface height, half width, depth, flow speed, and the unit
  tangent. Its bounds, a ribbon of two triangles per piece for the info raster, and a grid of
  pieces (8 m cells) for point queries.
- **The water there.** A point is in the river when its nearest piece is within that piece's half
  width at the nearest point (interpolated). The surface is the interpolated height; the flow is
  the tangent times the interpolated speed (m/s, horizontal).
- **Ground.** The terrain's (0071), as for lakes; without one, the surface less the depth.
- **Mouths.** At each end, when the end's sample is inside a lake or bounded ocean that draws
  before it (or an unbounded ocean exists), the samples within `max(width, 10 m)` of the end ease
  (smoothstep) their height to that body's level and their flow to zero. Recomputed when either
  body changes.
- **Priority.** A river overlaps the lake it runs into; it draws over it (rivers default to the
  priority of what they're given, so give the river the higher one where it matters), and the mouth
  blend makes the two meet at one level.

### The info texture

- Body vertices carry (x, z, surface height, draw slot, flow x, flow z). Lakes and oceans have
  their level and no flow; a river's height and flow interpolate across its ribbon.
- The body raster writes all four info channels (it reads the ground the level's first draw
  copied, so compatibility mode keeps one write mask per target): surface height, ground, flow x,
  flow z.

### Shading

- The surface reads flow from the finest info level at the fragment. Where there is flow, the
  ripples are the two-phase flow-map blend (Vlachos, Portal 2): two copies of the wind ripples
  offset by `flow × phase × 4 s`, half a period apart, weighted by a triangle wave so neither's
  reset shows. Flow also adds ripple strength (a river ripples with no wind).

### Bodies by distance

- Every body is kept and sorted by priority. When more than 64 are valid, the 64 whose outline
  bounds are nearest the view camera's (x, z) draw (an unbounded ocean is at distance 0), still in
  priority order. The choice is made again when the camera has moved 32 m or a body changed; the
  info texture redraws only when the chosen set changes.
- `waterAt` finds the body at a point through a grid of every valid body's bounds (64 m cells,
  unbounded oceans in every cell), highest priority first, so it costs the same with 10 or 1 000
  bodies, and is the same with and without a camera.
- `water.describe` reports `bodies` (all valid), `drawn`, and the body index's chosen set; part
  1's `skipped` now means "valid but not chosen".

### Agent surface

- `water.describe` lists rivers with their length, width range and flow range.
- `water.sample` reports `flow`.
- **Errors:** `water/bad-spline` gains: a river needs at least 2 points and `closed: false`;
  a point's width must be positive.

## Decisions

- **Rivers in the shared surface**, not a separate mesh: lake mouths and confluences need no seam
  work beyond the height blend, as Unreal's water zone does it.
- **Flow on the CPU from the spline**, not read back from the info texture, as part 1 decided.
- **Distance to the bounds**, not to the outline: a cheap, stable choice that never drops the body
  the camera is in (distance 0).

## Acceptance criteria

- [x] `waterAt` on a river: inside its banks, surface height and flow (direction and speed) within
      1 cm and 1 cm/s of the spline's interpolated values at 1 000 points; outside, dry.
- [x] A river ending in a lake meets its level: along the centre line no step over 1 cm where the
      water passes from the river to the lake, the surface otherwise smooth (the 16 m blend falls
      at most about 5 cm per 0.5 m), and `waterAt`'s flow fades to 0 at the end.
- [x] `waterAt` matches the info texture's surface height and flow within 1 cm and 1 cm/s at 1 000
      texel centres over a river and a lake (readback), on WebGPU and the baseline tier. Texels a
      bank crosses are left out: the raster's straight pieces and the CPU's distance to the centre
      line differ by a fraction of a texel there.
- [x] With 300 lakes spread over 20 km, the 64 drawn are the nearest the camera; moving the camera
      10 km changes the set, and `waterAt` finds every lake from a world without a camera.
      `waterAt` with 300 bodies stays inside `water/at`.
- [x] A river renders with flow-advected ripples (golden on both tiers; with no wind, a frame 1 s
      later differs over the river more than three times as much as over the still lake).

## As built

- **Rivers** (water/src/rivers.ts): `buildRiver`, `riverAt`, `blendMouth`/`resetMouths`,
  `riverTriangles`. A river ends square at its first and last samples, by their tangents, in both
  `riverAt` and the ribbon (a round end would claim a few texels the raster doesn't draw).
  `WaterBodyRecord.river`; a river's `level` is its lowest surface (what dry surface collapses to).
- **Bodies** (bodies.ts): `all` (every valid body by priority), a 64 m grid of their bounds (bodies
  over 4 096 cells and unbounded oceans in `wide`), `chooseBodies` by distance to bounds from the
  view camera's position (`viewCamera` in `water/bodies`), again past 32 m of camera movement; the
  info texture's version bumps only when the chosen set changes. Without a camera, the highest
  priorities draw.
- **`waterAt`** walks the point's cell list and `wide` together from the highest priority down.
- **Info raster**: six floats a vertex; both targets written whole, the ground read back from the
  ground texture as `ground_copy` does. Part 1's goldens and readback are unchanged.
- **Shading**: `flow_at` (bilinear over the finest level's wet texels); two copies of
  `ripple_slope` offset by `flow × phase × 4 s`, half a period apart, triangle-weighted; flow raises
  the ripple strength to at least `0.12 × clamp(speed / 2)`.
- **Measured** (M5 Max, not a named machine): readback worst 3.0 mm and 3.3 mm/s over 61 river
  texels, the same on both tiers.
- **Tests**: water/src/rivers.test.ts, water/src/rivers-gpu.test.ts.

## Open questions

- None.
