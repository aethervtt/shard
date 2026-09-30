# 0066 — Curved walls and structure materials

- **Status:** draft
- **Packages:** `@aethervtt/shard-structure`, `@aethervtt/shard-grid`, `@aethervtt/shard-texture`
- **Depends on:** 0055, 0057

## Context

0055 draws straight walls, because Aether's structural contract only has straight walls. Round
towers, curved corridors and rounded rooms are common on VTT maps, and today a host can only
approximate them with chains of short walls: faceted, seamed at every joint, with openings that
can't cross a joint, and a curve that takes dozens of documents to edit.

This spec adds two curve shapes to `Wall`: a circular arc (exact circles, one number) and a cubic
Bézier (any smooth bend). Aether adopts the arc first and the Bézier when its authoring tools can.
A curve changes what the server blocks as much as what the engine draws, so the subdivision into
segments lives in one pure function, which both the engine and the host's server call.

Authoring (drawing walls and rooms, dragging handles) stays in the host. This spec also moves
Aether's snapping rules into `grid/math` so a host and an agent snap walls identically.

Curves are also where textures go wrong (stretched along a bend, seamed at joints), and Aether
dresses walls and floors in its own textured materials. Structure meshes carry no tangents today,
so normal maps don't apply to them, and Aether keeps roughness and metalness in separate images
where the standard material takes one packed image. This spec makes structure materials work end to
end and proves it with a procedural brick material on straight and curved walls.

## Goals

- `Wall.shape`: `'straight' | 'arc' | 'bezier'`, with the arc's bow and the Bézier's control points.
- One sampler for every shape: the centreline as points with arc lengths, to a chord tolerance.
- Curved walls, their openings and frames in chunk compile, clipped to chunks exactly like 0055.
- `planarBarriers` subdivides curves with the same sampler, and straight walls are unchanged.
- Snapping helpers in `grid/math`: grid vertices, edge midpoints, wall anchors and token centres.
- Structure UVs in metres with tangents, so textured and normal-mapped materials tile the same on
  straight and curved walls and on floors, continuous across joints and chunk cuts.
- A documented mapping from Aether's scene materials onto `StandardMaterial`, in the reference
  adapter, and `packMetallicRoughness` for hosts that keep the two maps apart.
- A procedural brick material (albedo, normal, roughness) for tests and the demo.

## Non-goals

- Curved floors. Floor outlines stay polygons; a host samples a curve into points if it needs one.
- Wall authoring tools and handles (host), and editing a wall's curve by dragging (host).
- Splines through more than two control points. A long free curve is several walls.

## Design

### Shapes

```ts
Wall {
  a: vec2, b: vec2, height, thickness, elevation, material,   // as in 0055
  shape: 'straight' | 'arc' | 'bezier',
  /** Arc: how far the wall's midpoint bows off the line from a to b, metres; positive bows to
      the left of a → b. |bow| > |b − a| / 2 is a major arc. */
  bow: f32,
  /** Bézier: the two control points of a cubic from a to b, world (x, z). */
  c0: vec2, c1: vec2,
}
```

`quadraticToCubic(a, q, b) → { c0, c1 }` converts a single control point exactly
(`c0 = a + 2/3 (q − a)`, `c1 = b + 2/3 (q − b)`), so a host that authors quadratics loses nothing.

### Sampling

`sampleWall(wall, tolerance, out) → count` writes the centreline as points with their arc lengths.
Straight walls give two points. Arcs are sampled at even angles so no chord strays more than
`tolerance` from the circle; Béziers are subdivided adaptively by the same rule, and their arc
lengths are summed from the samples. `StructureSettings.curveTolerance` (default 0.01 m) is the
tolerance compile uses; `planarBarriers` takes the same value.

### Compile

Pieces (spans, lintels, sills, frames) keep their `[s0, s1]` interval, now in arc length. A piece's
footprint is the strip of the centreline samples in its interval, offset by half its thickness on
each side, with mitred joints between consecutive samples. Each sample-to-sample quad is convex, so
0055's labelled clipping applies unchanged: joints between quads are labelled like chunk cuts and
get no caps, so a curved wall is one continuous surface. Caps stay at the wall's ends and around
openings. Chunk overlap uses the same clipped quads, so an edit still rebuilds exactly the chunks
its old and new geometry overlap.

- **UVs:** `u` runs along the arc length (offset so a straight wall's UVs are what they were), `v`
  up the wall: textures follow the curve without stretching.
- **Openings:** `offset` and `width` are measured along the centreline. Frames follow the curve.
  A door leaf is straight, spanning the chord between the opening's two ends on the centreline;
  a window pane likewise.
- **Tight curves:** a radius of curvature smaller than half the thickness folds the inner face. An
  arc that tight is invalid (`structure/wall-too-tight`, with the wall's path); a Bézier that
  folds anywhere draws as sampled and logs `structure/wall-folds` once per revision.

### Planar split

`planarBarriers(walls, openings, { tolerance })` splits each wall around its openings along the arc
length, then samples each span. A straight wall produces exactly the segments and ids it produces
today. A curved span produces one segment per sample interval: the first keeps the span's id, the
rest append `~1`, `~2`, …; an opening's segments all carry its `openingId`. The sampled points are
the ones compile draws, so the server blocks what players see.

### Materials

Structure UVs are in metres, so a material's texture slot `scale` is tiles per metre:

- **Wall faces:** `u` along the centreline's arc length (a straight wall's `u` is what it was,
  the projection on its direction), `v` the height `y`. Courses of bricks stay level and follow
  a curve without stretching; `u` is continuous across sample joints and chunk cuts.
- **Caps (ends, reveals):** `u` across the wall, `v` the height.
- **Tops, undersides and floors:** `u, v = x, z`.
- **Tangents:** every vertex carries its `u` direction and handedness, so normal maps apply.

Aether's scene material maps onto `StandardMaterial` like this (the reference adapter does it):
`tint` → `baseColor`; `baseColorTexture` → `baseColorTexture`; `repeat` (pixels per tile) →
slot `scale` = 1 / (`repeat` × pxToWorld); `rotation` (degrees) → slot `rotation` (radians);
`wrap: 'mirrored-repeat'` → `'mirror'`; `roughness`, `metalness` → `roughness`, `metallic`;
`normal` (OpenGL convention) → `normalTexture` with `normalScale` = `strength`;
`ambientOcclusion` → `occlusionTexture` with `occlusionStrength`; and `roughnessTexture` with
`metalnessTexture` → one `metallicRoughnessTexture`, packed by `packMetallicRoughness(roughness?,
metalness?)` (`@aethervtt/shard-texture`: G roughness, B metalness, as glTF).

`brickMaterial(world, options)` (`@aethervtt/shard-structure/fixtures`) builds a brick material
procedurally from a seed: running-bond courses, per-brick color variation, recessed mortar in the
normal map, and rougher mortar.

### Snapping helpers

`grid/math` gains Aether's snapping (packages/core/src/grid.ts): `gridVertex(grid, x, z)`,
`edgeMidpoints(grid, x, z)`, `wallAnchor(grid, x, z)` (the nearest corner or edge midpoint) and
`tokenCenter(grid, x, z, footprint)` (odd footprints in cells, even ones on intersections).

### API sketch

```ts
import { quadraticToCubic, sampleWall } from '@aethervtt/shard-structure'
import { planarBarriers } from '@aethervtt/shard-structure/planar'
import { wallAnchor } from '@aethervtt/shard-grid/math'
world.spawn([Wall, { a: [0, 0], b: [6, 0], shape: 'arc', bow: 3 }])   // a half-circle
world.spawn([Wall, { a: [0, 0], b: [6, 0], shape: 'bezier', ...quadraticToCubic([0, 0], [3, 4], [6, 0]) }])
planarBarriers(walls, openings, { tolerance: 0.01 })
```

### Agent surface

- `Wall`'s new fields are schema fields: scenes, `entity.patch` and the inspector cover them.
- `structure.describe` reports each curved wall's sample count, and folded walls.
- Errors: `structure/wall-too-tight`, `structure/wall-folds`.

## Decisions

- **Arcs and Béziers, not one of them.** Arcs are exact circles with closed-form lengths (towers,
  rounded rooms); Béziers cover free bends. Both feed one sampled centreline, so the second shape
  costs a sampler, not a second pipeline.
- **Cubic only.** Quadratics convert exactly; one Bézier degree keeps the schema and the server
  simple.
- **The engine owns the subdivision.** Vision is only correct if the server blocks the segments
  that are drawn; one pure function with one tolerance makes that true by construction.
- **Straight door leaves.** A leaf that bends with its wall can't swing; the chord is what a real
  door on a curved wall does.

## Acceptance criteria

- [ ] Straight walls compile to the same meshes, and `planarBarriers` returns the same segments
      and ids, as before this spec (every 0055 test and golden unchanged).
- [ ] An arc's samples lie on its circle, no chord strays more than the tolerance from it, and its
      arc length is exact (± 0.1%); a Bézier's samples stay within the tolerance of the curve.
- [ ] A curved wall's footprint, clipped into chunks, keeps its exact area (± 0.1%), each part
      inside its chunk, and an edit rebuilds exactly the chunks its old and new geometry overlap
      (checked against a reference overlap test), under 4 ms in `pnpm bench` for a 6 m arc.
- [ ] A door on an arc sits at its arc-length offset: its opening's barrier segments start and end
      at the centreline points `offset` and `offset + width` along the arc.
- [ ] `planarBarriers` on curved walls uses the same points compile draws, and every point of a
      curved wall's centreline is within the tolerance of a barrier segment.
- [ ] A round tower (four quarter arcs, a door and a window) matches its golden captures top-down
      and at 30°, with no seam at sample joints or chunk cuts.
- [ ] An arc with a radius under half its thickness reports `structure/wall-too-tight` with its
      path; a folding Bézier draws and logs `structure/wall-folds` once.
- [ ] `quadraticToCubic` reproduces the quadratic exactly (to float precision) at 100 parameters.
- [ ] The snapping helpers match Aether's grid fixtures (wall anchors, grid vertices, edge
      midpoints, token centres for footprints 1 to 3).
- [ ] Brick walls, straight and curved, match golden captures top-down and at 30°: courses level,
      bricks the same size on both, no seam at sample joints, chunk cuts or wall corners.
- [ ] A normal-mapped brick wall lit from the side differs from the same wall without its normal
      map (the tangents reach the shader), on straight and curved walls.
- [ ] An Aether scene material (tint, base color texture, repeat, rotation, mirrored wrap,
      roughness and metalness textures, normal map, AO) maps to the `StandardMaterial` above, and
      one texture tile covers `repeat` pixels of the scene.
- [ ] `packMetallicRoughness` puts roughness in G and metalness in B, and a missing map packs as 1.

## Open questions

- Should `curveTolerance` scale with the view (finer when zoomed in)? Proposed: no; 1 cm is below a
  pixel at any VTT zoom, and a fixed tolerance keeps the server's segments stable.
