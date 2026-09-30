# 0067 — Structure groups: levels, roofs and cutouts

- **Status:** implemented
- **Packages:** `@aethervtt/shard-structure`, `@aethervtt/shard-render`
- **Depends on:** 0055, 0057, 0066

## Context

0055 compiles every wall, opening and floor into chunk meshes keyed by (chunk, material). That's
right for one level with no roofs, but two things a VTT needs break it:

- **Roofs** that show from outside and disappear when the viewer's tokens are inside. Hiding one
  roof must not rebuild the chunks it shares with its neighbours, or with the walls under it.
- **Multiple levels** (a tower's floors, a cellar under a tavern), where a view shows "this level
  and below" and hides the rest.

Both need the same thing: structure that can be hidden as a unit without a rebuild. This spec adds
a group key to structure compile, and the levels and roofs built on it. Levels also need holes: a
stair between two levels only works through a hole in the upper floor, and roofs have skylights,
smoke holes and hatches. Those are cutouts, the horizontal counterpart of 0055's openings. It also fixes the order of
ground bands across levels. Merging a chunk's materials into one mesh (0055's open question on
batch counts) will merge within a group, never across groups.

## Goals

- `Level` entities: walls, openings, floors and roofs belong to one (none means the ground level).
- `Roof` components: a polygon at a height, compiled into its own group.
- Compile keyed by (group, chunk, material). A group's chunk meshes are children of its entity, so
  hiding a level or a roof is one `Visibility` write: zero rebuilds, one instance flag per mesh.
- Barriers per level, and ground bands that stack by level first.
- A point-in-roof query, so the host can decide when a roof hides.
- `Cutout` entities in floors and roofs, modelled on `Opening`: a plain hole, a hatch whose leaf
  swings without a rebuild, or a skylight with glass.

## Non-goals

- Deciding who sees what: which tokens count as "inside" (the viewer's own, any visible one) is the
  host's rule. The engine answers geometric questions and hides what it's told to.
- Stairs, ramps and moving between levels (host and physics). Aether's stairs are generated shapes
  (props); the hole a stairwell needs is a cutout here.
- Cutouts that cross their host's edge. A cutout sits inside its floor or roof; one that runs off
  the edge is really a different outline, and would need polygon booleans.
- Pitched roof generation from a footprint beyond a single flat or single-pitch roof.

## Design

### Levels

```ts
Level { index: i8 (−16..15), elevation: f32, height: f32 }   // requires Transform (identity)
Wall.level, Opening.level (from its wall), Floor.level, Roof.level: entity | null
Floor.thickness: f32                                          // 0: the top only, as in 0055
```

A piece with no level, or naming an entity without a `Level`, belongs to the ground level. `index`
orders levels (a cellar is −1), in the range a ground layer's `level` holds. A level's `elevation`
is where its floor stands; pieces keep their own `elevation`, relative to it, so moving a level
moves everything on it with one edit (every chunk on that level rebuilds). Removing a level puts
its pieces back on the ground level.

A floor with `thickness` > 0 also gets its underside, its outline's edges and its cutouts' rims (the
floor's thickness around a stairwell); at 0 it is the single top face 0055 draws.

### Roofs

```ts
Roof {
  points: list(vec2),          // the footprint, as a floor's
  height: f32,                 // eaves above its level's elevation
  pitch: f32,                  // degrees: 0 flat, else one slope rising toward `ridge`
  ridge: vec2,                 // direction the slope rises, (x, z)
  thickness: f32,              // measured straight down
  material: handle('Material'),
  shadowWhenHidden: bool,      // keeps casting while hidden (a dark interior); true by default
}
```

Each roof is its own group: its footprint is triangulated like a floor's (`polygon.triangulate`),
given a top, an underside and edges, and clipped into chunks like everything else. Floors and roofs
share one slab geometry: an outline with holes, a surface that is flat or rises along one slope
(`pitch` up to 80°), and a thickness below it. On a slope, v runs up it in metres along the surface
and u across it; flat, u, v = x, z as on floors.

### Cutouts

```ts
Cutout {
  host: entity,                          // a Floor or a Roof
  points: list(vec2),                    // the hole, a simple polygon inside the host
  kind: 'hole' | 'hatch' | 'skylight',
  frameWidth: f32, frameDepth: f32, frameMaterial: handle('Material'),
  hinge: u16,                            // hatches: the outline edge the leaf hangs from (edge i: point i to i + 1)
  state: 'closed' | 'open' | 'locked',   // hatches
}
```

Compile triangulates a floor or roof with its cutouts as holes (`polygon.triangulate` bridges
them), so the surface keeps its exact area minus theirs, and gives each cutout's rim its faces
(the floor's thickness around a stairwell) and a frame. A cutout marks its host's chunks when its
outline, kind or frame changes; its `state` marks nothing, as with a door.

- **Hole:** just the gap: stairwells, pits, chasms, smoke holes.
- **Hatch:** a leaf entity (a trapdoor) the shape of the hole, flush with the surface, with a mesh
  of its own built around its hinge. `structure/doors` swings it 90° up about its `hinge` edge by
  `state` over `doorSwingMs`, holding a frame demand while it moves: one instance slot a frame, no
  rebuild. `DoorLeaf.opening` points back at the cutout.
- **Skylight:** a glass pane across the hole, which casts no shadow.

A frame is a band `frameWidth` wide around the hole on the host's surface, standing `frameDepth`
above it, mitred at its corners, in the frame material (the built-in wood when empty).

A cutout's outline must lie inside its host, touching no edge, and not overlap another cutout on
it; otherwise it reports `structure/cutout-outside` or `structure/cutout-overlap` with its path and
is skipped. Cutouts the host already has are checked first, then new ones by entity, so a new
cutout that overlaps an old one is the one skipped. `roofAt` counts a point under a skylight or a
hole as under the roof.

Moving a cutout, or changing its frame, rebuilds only the host's chunks its old and new hole, rim
and frame cover: the rest of the host draws the same area however it is now triangulated. Any other
edit to the host rebuilds all its chunks.

### Group key and compile

Compile keys every chunk mesh by (group, chunk, material), where a piece's group is its roof's
entity for roof geometry, else its level's entity (or the ground level). A chunk is still an 8 m
square, and an edit still rebuilds exactly the (group, chunk) pairs its old and new geometry
overlap; an edit on one level never rebuilds another level's meshes.

Each chunk mesh is spawned as a child of its group's entity. The ground level's is an entity the
plugin spawns (`Structure.ground`, derived, never saved). Door leaves, window panes, hatches and
skylight panes are children of their host's group too, so they hide with it. `Visibility.mode: 'hidden'` on a level or a roof hides every mesh under it through
`ComputedVisibility` (0007): one flag write per mesh, no rebuild, no geometry upload. "Show this
level and below" is a Visibility per level; cutaway and fade are host choices on the same switch.

`Roof.shadowWhenHidden` keeps a hidden roof's meshes in shadow views only. Render gains a tag,
`ShadowWhenHidden`: a hidden mesh with it keeps its Visible flag off and gets a new instance flag,
`ShadowOnly`, which only shadow views accept (GPU and CPU culling, caster bounds, moved casters).
Camera views, outlines, overlays and picking need no change: to them it is hidden. Structure adds
the tag to a roof's chunk meshes while `shadowWhenHidden` is on.

### Barriers and bands

- `planarBarriers(walls, openings, { level })` returns one level's segments (`null` is the ground
  level), each carrying its `level`. Walls name their level by id (`PlanarWall.level`); without the
  option every wall is returned, and a segment carries a level only if its wall names one.
- Ground bands sort by (level, band, order): a lower level's tokens never draw after an upper
  level's fog. `GroundLayer` gains `level: i8` (−16..15), the level's index rather than its entity:
  render can't read structure's `Level`, so the host copies the index. The key packs 5 + 16 + 32
  bits, exact in a double. Depth still hides a lower level under an upper floor.

### Roof query

`roofAt(world, x, z, level?) → Entity | undefined` finds the roof whose footprint contains (x, z),
an edge included, through an index of the chunks each roof's bounds cover (no scan of every roof).
With `level` (null: the ground level), only that level's roofs; ties go to the lowest entity. A
host hides the roofs its viewer's tokens are under, and shows the rest.

### API sketch

```ts
import { Cutout, Level, Roof, roofAt } from '@aethervtt/shard-structure'
const cellar = world.spawn([Level, { index: -1, elevation: -3, height: 3 }], Transform)
world.spawn([Wall, { a: [0, 0], b: [8, 0], level: cellar }])
const tavern = world.spawn([Roof, { points, height: 3, pitch: 30, ridge: [0, 1] }])
world.spawn([Cutout, { host: upperFloor, points: stairwell, kind: 'hole' }])
world.spawn([Cutout, { host: tavern, points: skylight, kind: 'skylight' }])
world.set(tavern, Visibility, { mode: roofAt(world, x, z) === tavern ? 'hidden' : 'inherit' })
```

### Agent surface

- `structure.describe` lists every group (ground, level, roof): its chunks, meshes and whether it's
  hidden, plus roof, cutout and level counts. The last compile reports each rebuilt chunk's group.
- `Level`, `Roof`, `Cutout`, `Floor.thickness`, the new `level` fields, `GroundLayer.level` and
  `ShadowWhenHidden` are schema components and fields.
- Errors: `structure/cutout-outside`, `structure/cutout-overlap`.

## Decisions

- **Groups as parents, hiding through Visibility.** It reuses visibility propagation and instance
  flags as they are; hiding costs a flag write, like hiding any entity.
- **Roofs are their own groups.** A roof hides alone; its neighbours and the walls under it don't
  rebuild.
- **Piece elevations relative to their level.** Moving a level is one edit, not one per piece.
- **Cutouts as their own documents, like openings.** A stairwell moves without rewriting its floor,
  and hatches and skylights reuse the door leaf and window pane.
- **Material merging (0055's open question) merges within a group.** Merging across groups would
  make levels and roofs impossible to hide without a rebuild.
- **ShadowOnly beside the Visible flag, not in it.** A hidden caster gets a flag only shadow paths
  read, so no camera-side path (outlines, overlays, picking, plugins) can draw it by mistake.
- **A level index on ground layers, not the entity.** Render doesn't depend on structure.
- **Old cutouts win an overlap.** Adding a cutout never knocks out a hole that was already there.

## Acceptance criteria

- [x] Hiding or showing a level or a roof rebuilds 0 chunks, uploads no geometry, and writes one
      instance slot per mesh in the group.
- [x] An edit on one level rebuilds only that level's (group, chunk) pairs.
- [x] With the upper level hidden, a top-down golden of a two-level tower shows the lower level
      exactly as a one-level scene of it does.
- [x] A roof hidden with `shadowWhenHidden` draws nothing in camera views and still darkens the
      interior (golden); without it, the interior is lit.
- [x] `roofAt` agrees with a point-in-polygon test over 10k random points, including concave
      footprints and points on shared edges.
- [x] Ground bands on two levels stack level first: a lower level's tokens never draw over an
      upper level's fog.
- [x] `planarBarriers` with `level` returns only that level's segments, each tagged with it.
- [x] A floor with two cutouts keeps its exact area minus theirs (± 0.1%), clipped into chunks, and
      a stairwell hole shows the level below through it (golden, 30°).
- [x] A hatch toggle rebuilds 0 chunks, and each frame of its swing writes only the leaf's slot.
- [x] Moving a cutout rebuilds exactly its host's chunks that its old and new outlines overlap.
- [x] A cutout outside its host, or overlapping another, reports its error with its path and
      leaves the host drawn whole.

## Open questions

- Should a roof fade instead of popping when hidden? Proposed: host choice later (an opacity on
  the group); popping first.
- Pitched roofs beyond one slope (hips, gables): generated from a footprint, or authored as several
  single-slope roofs? Proposed: several roofs first.
