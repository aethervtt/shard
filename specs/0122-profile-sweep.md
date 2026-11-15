# 0122 — A profile swept along a spline

- **Status:** draft (built 2026-11-15). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-mesh`
- **Depends on:** 0045, 0071

## Context

0045's `MeshBuilder` has `tube` (circles along a curve) and `lathe` (a profile turned about an
axis), and nothing that pulls an arbitrary cross-section along a path. Roads need it: Risen's
roads (its spec 0009) are a mesh per cell from the road's spline, an asphalt or gravel surface with
painted lines, kerbs and sidewalks as raised strips, fences and guard rails beside them, and bridge
decks. Every one of those is a 2D profile swept along a curve with texture coordinates running
along it. 0071's terrain flattens the ground under the same spline, so the sweep has to follow the
same curve the terrain does.

## Goals

- `MeshBuilder.sweep(profile, curve, options)`: a cross-section (2D points) extruded along a
  Catmull-Rom curve through 3D control points, appended like any other shape.
- The curve is 0071's: uniform Catmull-Rom sampled by `sampleCatmullRom` (the terrain's roads and
  0097's rivers use the same), so a road surface sits on the ground its spline flattened.
- Level cross-sections: the profile's up stays as close to world up as the curve allows (a road
  doesn't roll on a bend), with optional banking per control point.
- UVs: v along the curve in metres (scaled), so a dashed line or a fence's posts repeat at a fixed
  length; u across the profile, 0 to 1 by default or per profile point.
- Hard and smooth edges in the profile by angle (a kerb's corners are hard, a crown is smooth).
- Open and closed profiles, open and closed curves (a ring road), caps for closed profiles.
- Deterministic like the rest of `MeshBuilder` (only + − × ÷ and sqrt), for generators (0113).

## Non-goals

- Splitting a sweep at a junction, or junction meshes. Intersections are a game's own mesh.
- Conforming to terrain under the curve. The curve is the road's; 0071 grades the ground to it.
- Instancing objects along a curve (posts, lamps): scatter or the game places them, using
  `sweepFrames` below for positions and orientations.

## Design

```ts
const road = MeshBuilder.create()
  .sweep(
    // [x, y] pairs: x to the right of travel, y up, metres. Left edge to right edge faces up.
    [-4, 0, -3.9, 0.02, 0, 0.08, 3.9, 0.02, 4, 0],
    points, // [x, y, z, …] control points (the road's spline)
    { step: 1, vScale: 1 / 8 },
  )
  .finish()
```

```ts
interface SweepOptions {
  /** The profile's last point joins its first. Default false. */
  closed?: boolean
  /** The curve loops through its first point again. Default false. */
  loop?: boolean
  /** Most metres between rings along the curve (sampleCatmullRom's step). Default 1. */
  step?: number
  /** The direction a profile's y keeps to. Default [0, 1, 0]. */
  up?: [number, number, number]
  /** Roll about the curve per control point, radians (banking). Default none. */
  roll?: number | ArrayLike<number>
  /** u per profile point; default the profile's length from its first point, 0 to 1. */
  u?: ArrayLike<number>
  /** v per metre along the curve, and v at its start. Defaults 1 and 0. */
  vScale?: number
  v0?: number
  /** Profile corners sharper than this (degrees) get split normals. Default 30. */
  smoothAngle?: number
  /** Closed profiles: cap the two ends. Default false. */
  caps?: boolean
}
```

- **Rings.** The curve is sampled with `sampleCatmullRom(points, loop, step)`. Each ring's frame:
  tangent `t` by central differences, `right = normalize(t × up)`, `normal = right × t`; the
  profile point (x, y) is at `centre + right·x + normal·y`. A tangent parallel to `up` keeps the
  previous ring's right (a vertical piece doesn't flip). With `roll`, the frame turns about `t` by
  the roll interpolated along the curve as the points are.
- **Faces.** Each profile segment faces its left as you walk it in the (x right, y up) plane: a
  surface listed from its left edge to its right faces up, and a closed profile listed clockwise
  faces out. Normals are the profile's in the ring's frame, so they're exact on straight and
  curved pieces alike; a corner sharper than `smoothAngle` duplicates its column with each side's
  normal.
- **UVs.** u per profile point (or by length, 0–1), v the arc length along the samples × `vScale`
  + `v0`. Two sweeps along the same curve with the same `v0` line up (a road and its kerb).
- **Caps** triangulate the profile with core's `triangulate` (holes not supported), facing along
  −t at the start and +t at the end.
- `sweepFrames(curve, options)` returns the rings' centres, tangents, rights and normals and arc
  lengths, so a game can put posts or lamps along the same curve at the same spacing.

### Agent surface

None beyond the API: generators (0042) reach it through `ctx.mesh.create()`.

## Decisions

- **The terrain's sampler, not a new spline.** A road mesh and the ground it was graded into come
  from one curve; any other spline drifts from the terrain by up to the difference of the curves.
- **Up-locked frames, not parallel transport.** `tube` transports its frame so a pipe doesn't
  twist; a road must keep its cross-section level, which parallel transport doesn't guarantee on a
  curve that climbs and turns.
- **Arc-length v in metres.** Line dashes and fence spans are lengths, not fractions of a curve.

## Acceptance criteria

- [x] A flat 8 m profile swept along a straight 100 m curve is a 8 × 100 m quad strip facing up, v
      from 0 to 100 × `vScale`.
- [x] Swept along a curve that climbs and turns (a 90° bend over 50 m, rising 5 m), every ring's
      right is horizontal and perpendicular to the curve within 1e-9, and every vertex lies within
      1 mm of `centre + right·x + normal·y`.
- [x] The surface's centre line follows `sampleCatmullRom` of the same points exactly, and on a
      0071 terrain with a `flatten` spline of the same points, the profile's (y = 0) vertices lie on
      the ground within 2 cm.
- [x] A kerb profile with 90° corners has split normals there and smooth ones across its crown.
- [x] A closed profile with caps is watertight (every edge shared by two triangles) on a looped curve
      and on an open one.
- [x] The same calls give the same bytes twice. The code uses only + − × ÷, sqrt and `sinCos`
      (0113's rule), so engines agree.

## As built

- `MeshBuilder.sweep(profile, curve, options)` and `sweepFrames(curve, options)`
  (mesh/src/builder.ts), exported with `SweepOptions` and `SweepFrames`. Roll rides as the y of a
  copy of the control points with the same x and z, so it's sampled on the same pieces.
- Columns: one per profile point, two where the corner is sharper than `smoothAngle` (by the cosine
  of the segments' normals, through `sinCos`). A closed profile's seam is its first point twice (u
  0 and 1), with one normal when smooth.
- **Tests**: mesh/src/sweep.test.ts (strip, climbing bend frames and vertices, kerb normals, capped
  rails watertight open and looped and identical twice, banking),
  terrain/src/heightfield/sweep-road.test.ts (a road swept along a terrain's flatten spline lies on
  the leaf ground within 2 cm).

## Open questions

- None.
