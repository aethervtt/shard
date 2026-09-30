# 0057 — Tabletop layers: grids, drawings, tokens, outlines, and ground order

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-grid` (new), `@aethervtt/shard-vector` (new),
  `@aethervtt/shard-core` (`polygon`, shared with 0055)
- **Depends on:** 0007, 0018, 0022, 0024, 0027, 0055

## Context

A virtual tabletop is mostly flat things on a floor, with a few tall things among them: floors,
tiles, a grid, drawings, fog, flat tokens, and walls, doors and 3D props. Aether shows the same
scene two ways: a top-down orthographic *Map* and an oblique perspective *Tabletop*. Switching views
is a camera change (`Camera3d.active`, 0007). Everything else is shared: the objects, assets and
picking.

Three things Shard doesn't have yet make that work:

- **Coplanar content in a defined order.** Several layers sit on the same floor; they must stack
  in a fixed order without z-fighting at any angle, while walls and props still hide them.
- **Per-view presentation.** A token is a flat disc on the Map and a standing figure on the
  Tabletop. That's one logical object with two visuals, and each camera draws one of them.
- **Tabletop primitives:** square and hex grids, vector drawings, and selection and hover
  outlines.

The Aether adapter that maps Aether's documents onto these (tokens, drawings, grid, lights,
structure, props) lives in Aether and uses the mirror from 0055. Saved worlds open unchanged
because the adapter reads today's documents; nothing is converted on disk.

## Goals

- Ground bands: coplanar layers drawn in band order, depth-tested against 3D geometry.
- `RenderLayers`: an entity-side and a camera-side bitmask, for per-view visuals.
- `@aethervtt/shard-grid`: square and hex (pointy and flat) grids, drawn analytically with lines of constant
  CSS-pixel width, plus cell math.
- `@aethervtt/shard-vector`: pen, line, rectangle, ellipse, cone and polygon-with-holes shapes, with stroke
  and fill, tessellated once per revision. Fog (0058) uses the same tessellator.
- `Outline`: selection and hover outlines as a post pass that costs nothing when no outline exists.
- A tabletop light falloff (full bright radius, linear to the dim radius) on point lights.
- Projection helpers so host DOM overlays (authoring handles, labels) can follow the scene.

## Non-goals

- Fog (0058), tiles (0059) and camera controls (0060).
- Engine-drawn authoring handles. Aether's handles and labels are DOM and SVG, and they stay that
  way; the engine provides the projection they need.
- The Aether adapter itself.

## Design

### Ground bands

```ts
GroundLayer { band: i16, order: i32 }   // requires Transform
```

Entities with `GroundLayer` draw in a `Ground` phase after opaque geometry. Depth test is on, so
walls, doors and props in front hide them. Depth write is off, so bands never fight each other.
They're sorted by `(band, order)`. Floors are opaque, write depth, and sit under every band.
Default bands, which a host may renumber: `tiles 10`, `grid 20`, `drawings 30`, `tokens-flat 40`,
`fog 50`, `overlay 60` (`GROUND_BANDS`). The phase works the same in orthographic and perspective
views, so both views stack alike.

Any `Mesh3d` can be ground: its (mesh, material) batch is kept apart from the same pair off the
ground, the GPU culler leaves it to the CPU, and each view builds its ground list on the CPU in
`(band, order)` order, one draw per run of a batch. `RenderPhase.Ground` (420) comes after the sky,
which draws wherever no depth was written. Ground draws cast no shadows, and picking draws them
last with `greater-equal`, so the topmost band wins a click.

A band lies exactly on its floor, and two meshes at one height don't interpolate the same depth to
the last bit, so ground pipelines carry a small depth bias (a few float ULPs plus a slope term)
toward the camera. It only ever decides band against floor; bands against each other never
compare depth at all.

### Render layers

```ts
RenderLayers { mask: u16 = 1 }          // on a renderable; absent = layer 1
Camera3d.layers: u16 = 0xffff           // what this camera draws
```

Sixteen layers: the mask rides in bits 8–23 of the instance record's flags word, where the GPU
culler reads it (its compute stage is already at the default limit of 8 storage buffers). The
convention: layer 1 holds what every view shares, and each view's own visuals take a bit of their
own, so a Map camera draws `1 | MAP` and a Tabletop camera `1 | TABLETOP`. Cascades cull with
their camera's layers; spot and point shadows, shared by every camera, with the main camera's.

A renderable draws in a view only if `mask & camera.layers` is nonzero. Culling tests it first, so
a hidden visual costs no draw. A token entity carries the logical `Transform`, and two children
carry the visuals: a flat disc on a `map` layer and a standee (billboarded sprite or GLB) on a
`tabletop` layer. The Map camera draws `map`, and the Tabletop camera draws `tabletop`. Picking
reads the view's own id buffer, so a click resolves to whichever visual the active view shows. The
host maps it back to the token through its parent (and to the host id through the mirror, 0055).

### Grid

`Grid { kind: 'square' | 'hex', orientation: 'pointy' | 'flat', size: f32, offset: vec2,
color: color, opacity: f32, lineWidth: f32 (CSS px) = 1, extent: vec2 }` draws one quad in the grid
band. The fragment shader computes the distance to the nearest cell edge analytically (square: per
axis; hex: over the three axial directions) and antialiases it with screen derivatives, so lines
stay `lineWidth` CSS pixels wide at any zoom and any display density. In perspective, lines whose
spacing drops below 3 pixels fade out, which avoids moiré at grazing angles.

`size` and `offset` are in world units. A host converts them with the same fixed visual scale it
uses for everything else (0055). Game distance (`distance` per cell, `unit`, `diagonal`) is used
only by `distance()` below and never places or sizes anything, so relabelling a scene's units
leaves the picture unchanged. Grid `size` is visual: it resizes the grid and anything the host
sizes in cells (token footprints, per-cell props), as 0055 describes.

`@aethervtt/shard-grid/math`, a set of pure functions: `cellAt(grid, x, z)`, `cellCenter`, `cellPolygon`,
axial and cube hex coordinates, `neighbors`, and `distance(grid, a, b, diagonal)` with Aether's
`euclidean | equal | alternating` rules. `pathDistance(grid, points, diagonal)` measures legs and
carries the alternating phase across waypoints (Aether's `pathCells`).

Hex `size` follows Aether: the distance between adjacent cell centres. The quad is a child of its
Grid entity (it follows the Grid's Transform, scaled to `extent`), and the lines themselves are
anchored in world space at `offset`. Line color is display-referred: the scene's exposure doesn't
dim it.

### Vector shapes

```ts
VectorShape {
  geometry: { kind: 'pen', points } | { kind: 'line', from, to } | { kind: 'rect', width, height }
          | { kind: 'ellipse', rx, ry } | { kind: 'cone', length, angle }
          | { kind: 'polygon', outer, holes }
  stroke: color, strokeWidth: f32, strokeUnits: 'world' | 'css-px'
  fill: color, fillOpacity: f32, rev: u32
}
```

`tessellate(geometry, style, { pixelsPerUnit }) → MeshData` does fills by ear clipping with holes bridged
(`polygon.triangulate` in core), strokes as a mitred polyline (miters clamped at 4 half-widths;
round caps and joins for pen), and ellipses and cones subdivided to a chord error of 0.5 CSS px at
the densest zoom (`pixelsPerUnit` CSS px per world unit, default 256). Geometry is local (x, z):
`rect` runs from the origin, `ellipse` is centred, `cone` has its apex at the origin and opens
along +x. Only closed shapes fill. The mesh is rebuilt only when `rev` (or the stroke's width,
units, or whether it fills) changes; colors live in a per-shape `VectorMaterial` and change
without a rebuild. CSS-pixel strokes keep their centreline and carry the widening in their
tangents (offset direction, and half the width in w); the material's `vertex_position` widens them
from the view's pixel scale, so they don't need a rebuild on zoom. A shape gets `Mesh3d`,
`MeshMaterial` and a drawings-band `GroundLayer` unless it has its own. Pure functions, used by
`@aethervtt/shard-fog`.

`ViewUniform.pixelScale` carries what this needs: render pixels per CSS pixel, world units per
render pixel at one unit of depth (or everywhere, orthographic), and whether the view is
orthographic.

### Outlines

`Outline { color: color, width: f32 (CSS px) = 2, occluded: 'hide' | 'show' | 'dim' }` on any
renderable, or on a parent (applied to every descendant). The post pass renders outlined entities'
style and depth into a small mask (through the mesh vertex stage, so skinned meshes outline where
they are), seeds jump flood from it (parts something hides seed only for `show` and `dim`),
floods to `width`, and composites the ring on the view target after the display stage. It runs
only while at least one `Outline` exists in the view; with none, it isn't in the graph. Selection
and hover are two `Outline`s with different colors; the host sets and clears them. A view draws up
to 16 styles at once: the style rides in the top four bits of each visible-list entry. The
component is core; the pass is `outlinePlugin` (in `forwardPlugin`), and an Outline without it
logs `render/feature-missing`.

### Lights

`PointLight.falloff: 'physical' | 'tabletop'`, and `bright: f32` for tabletop. Tabletop falloff is
full intensity inside `bright`, linear down to zero at `range` (Aether's dim radius). It's a
clustered light like any other (0018), so it lights floors, tokens and props, and casts shadows if
asked. Both falloffs are one WGSL function, `light_falloff` in `shard::pbr::lights`, which the
lighting and the shadow catcher share; `tabletopFalloff` is its CPU mirror.

### Projection helpers

```ts
worldToScreen(world, camera, point: Vec3, out: Vec2): boolean   // CSS px; false when behind
screenToRay(world, camera, x, y, outOrigin, outDir): void
screenToPlane(world, camera, x, y, planeY, out: Vec3): boolean
world.reader(CameraMoved)                                        // after extraction, once per changed camera
```

A camera moves when its unjittered view-projection, display size or pixel ratio changes, and on its
first frame. The helpers use that same unjittered projection, so they agree with what the GPU drew.

A host repositions its DOM handles on `CameraMoved` and on its own edits, not every frame.

### Baseline tier (0064)

Every pass here is a render pass, and outlines' jump flood is a chain of fragment passes. The
`shard::data` accessors 0064 defines don't exist yet: the grid, vector and outline shaders read
per-draw data through the material system's accessors (`instance_at`, `vertex_world`,
`vertex_tangent`, `mesh_vertex_at`), which are what 0064 retargets, and never declare storage of
their own. Tabletop lights will count toward `LightBudget.baselineMax` once 0064 adds it.

### Agent surface

- `render.describe` lists ground bands with their entity counts and each view's ground draws
  (`ground`), and outlines by view (`outlines`: styles and how many renderables they cover).
- `Grid`, `VectorShape`, `GroundLayer`, `RenderLayers` and `Outline` are schema components, so
  scenes, `entity.patch` and the inspector cover them.

## Decisions

- **A ground phase with depth write off, not depth bias.** Bias depends on the angle and the depth
  precision, and it fails exactly at the oblique Tabletop angles. Sorting coplanar content is exact.
  (A few ULPs of bias against the floor under the bands are still needed: see Ground bands.)
- **Sixteen render layers in the flags word.** A layer buffer would be a ninth storage buffer in
  the cull pass; sixteen layers cover every view a VTT has.
- **Two child visuals and a layer mask, not a per-view component switch.** It reuses culling and
  picking as they are, and the logical transform stays in one place.
- **An analytic grid.** One quad, no geometry to rebuild, and constant line width at every zoom and
  density, which is a fidelity gate.
- **Handles stay DOM.** Aether's handles already work and they're accessible; the engine gives them
  positions.

## Acceptance criteria

- [x] Golden captures of the parity fixture (floor, tiles, grid, drawings, flat tokens, fog, walls,
      props) in both views at 30°, 55° and top-down show band order preserved and no z-fighting.
      Walls hide the bands behind them.
- [x] With the Map camera active, standees draw 0 instances and flat discs draw; switching to the
      Tabletop camera swaps them, and no mesh or instance is rebuilt.
- [x] Grid lines measure `lineWidth` ± 0.5 CSS px at zoom 0.25×, 1× and 4×, and at pixel ratios 1
      and 2, for square, pointy hex and flat hex.
- [x] Changing the grid's `distance`, `unit` or `diagonal` changes no pixel of a golden capture.
- [x] `cellAt ∘ cellCenter` is the identity over 10k random cells for every grid kind, and
      `distance` matches Aether's fixtures for all three diagonal rules.
- [x] A polygon with two holes tessellates to the exact area (± 0.1%), and a 1,000-point pen stroke
      tessellates in under 1 ms.
- [x] With no `Outline`, the graph has no outline pass. With one, the outline measures `width` ± 1
      CSS px.
- [x] Tabletop falloff is 1 at `bright`, 0.5 halfway to `range`, and 0 at `range`.
- [x] `worldToScreen` agrees with the GPU's projection to within 0.5 px in both projections.

## Open questions

- Should standees billboard to the camera or keep a fixed yaw, as Aether's do today? Proposed:
  billboard around the vertical axis, as now. Still open: a standee is the host's visual (a sprite
  or a GLB on the tabletop layer), and the engine doesn't turn it yet.
