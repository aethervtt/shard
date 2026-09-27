# 0057 — Tabletop layers: grids, drawings, tokens, outlines, and ground order

- **Status:** accepted
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-grid` (new), `@aethervtt/shard-vector` (new)
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
`fog 50`, `overlay 60`. The phase works the same in orthographic and perspective views, so both
views stack alike.

### Render layers

```ts
RenderLayers { mask: u32 = 1 }          // on a renderable; absent = layer 1
Camera3d.layers: u32 = 0xffffffff       // what this camera draws
```

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
`euclidean | equal | alternating` rules.

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

`tessellate(shape) → MeshData` does fills by ear clipping with holes bridged, strokes as a mitred
polyline (round caps and joins for pen), and ellipses and cones subdivided to a chord error of 0.5
CSS px at the densest zoom. The mesh is rebuilt only when `rev` changes. CSS-pixel strokes widen in
the vertex shader from the view's pixel scale, so they don't need a rebuild on zoom. Pure
functions, used by `@aethervtt/shard-fog`.

### Outlines

`Outline { color: color, width: f32 (CSS px) = 2, occluded: 'hide' | 'show' | 'dim' }` on any
renderable, or on a parent (applied to every descendant). The post pass renders outlined entities'
ids into a small mask, dilates it by jump flood to `width`, and composites the edge. It runs only
while at least one `Outline` exists in the view; with none, it isn't in the graph. Selection and
hover are two `Outline`s with different colors; the host sets and clears them.

### Lights

`PointLight.falloff: 'physical' | 'tabletop'`, and `bright: f32` for tabletop. Tabletop falloff is
full intensity inside `bright`, linear down to zero at `range` (Aether's dim radius). It's a
clustered light like any other (0018), so it lights floors, tokens and props, and casts shadows if
asked.

### Projection helpers

```ts
worldToScreen(world, camera, point: Vec3, out: Vec2): boolean   // CSS px; false when behind
screenToRay(world, camera, x, y, outOrigin, outDir): void
screenToPlane(world, camera, x, y, planeY, out: Vec3): boolean
world.events(CameraMoved)                                        // after extraction, once per changed camera
```

A host repositions its DOM handles on `CameraMoved` and on its own edits, not every frame.

### Baseline tier (0064)

Every shader here reads per-draw and per-scene data through `shard::data` accessors, never raw
`var<storage>`, and every pass is a render pass. The ground phase, render layers, the grid, vector
shapes, outlines and tabletop falloff all run on the baseline tier unchanged. Outlines' jump flood
is a chain of fragment passes on both tiers. Tabletop lights count toward
`LightBudget.baselineMax` on baseline.

### Agent surface

- `render.describe` lists ground bands with their entity counts, and outlines by view.
- `Grid`, `VectorShape`, `GroundLayer`, `RenderLayers` and `Outline` are schema components, so
  scenes, `entity.patch` and the inspector cover them.

## Decisions

- **A ground phase with depth write off, not depth bias.** Bias depends on the angle and the depth
  precision, and it fails exactly at the oblique Tabletop angles. Sorting coplanar content is exact.
- **Two child visuals and a layer mask, not a per-view component switch.** It reuses culling and
  picking as they are, and the logical transform stays in one place.
- **An analytic grid.** One quad, no geometry to rebuild, and constant line width at every zoom and
  density, which is a fidelity gate.
- **Handles stay DOM.** Aether's handles already work and they're accessible; the engine gives them
  positions.

## Acceptance criteria

- [ ] Golden captures of the parity fixture (floor, tiles, grid, drawings, flat tokens, fog, walls,
      props) in both views at 30°, 55° and top-down show band order preserved and no z-fighting.
      Walls hide the bands behind them.
- [ ] With the Map camera active, standees draw 0 instances and flat discs draw; switching to the
      Tabletop camera swaps them, and no mesh or instance is rebuilt.
- [ ] Grid lines measure `lineWidth` ± 0.5 CSS px at zoom 0.25×, 1× and 4×, and at pixel ratios 1
      and 2, for square, pointy hex and flat hex.
- [ ] Changing the grid's `distance`, `unit` or `diagonal` changes no pixel of a golden capture.
- [ ] `cellAt ∘ cellCenter` is the identity over 10k random cells for every grid kind, and
      `distance` matches Aether's fixtures for all three diagonal rules.
- [ ] A polygon with two holes tessellates to the exact area (± 0.1%), and a 1,000-point pen stroke
      tessellates in under 1 ms.
- [ ] With no `Outline`, the graph has no outline pass. With one, the outline measures `width` ± 1
      CSS px.
- [ ] Tabletop falloff is 1 at `bright`, 0.5 halfway to `range`, and 0 at `range`.
- [ ] `worldToScreen` agrees with the GPU's projection to within 0.5 px in both projections.

## Open questions

- Should standees billboard to the camera or keep a fixed yaw, as Aether's do today? Proposed:
  billboard around the vertical axis, as now.
