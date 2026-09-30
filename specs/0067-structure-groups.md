# 0067 — Structure groups: levels, roofs and cutouts

- **Status:** draft
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
Level { index: i32, elevation: f32, height: f32 }     // requires Transform (identity)
Wall.level, Opening.level (from its wall), Floor.level, Roof.level: entity | null
```

A piece with no level belongs to the ground level. `index` orders levels (a cellar is −1). A
level's `elevation` is where its floor stands; pieces keep their own `elevation`, relative to it,
so moving a level moves everything on it with one edit (every chunk on that level rebuilds).

### Roofs

```ts
Roof {
  points: list(vec2),          // the footprint, as a floor's
  height: f32,                 // eaves above its level's elevation
  pitch: f32,                  // degrees: 0 flat, else one slope rising toward `ridge`
  ridge: vec2,                 // direction the slope rises, (x, z)
  thickness: f32,
  material: handle('Material'),
  shadowWhenHidden: bool,      // keeps casting while hidden (a dark interior)
}
```

Each roof is its own group: its footprint is triangulated like a floor's (`polygon.triangulate`),
given a top, an underside and edges, and clipped into chunks like everything else.

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
- **Hatch:** a leaf entity (a trapdoor) the shape of the hole, hinged on its `hinge` edge. `structure/doors` swings it
  up by `state` over `doorSwingMs`, holding a frame demand while it moves: one instance slot a
  frame, no rebuild. `DoorLeaf.opening` points back at the cutout.
- **Skylight:** a glass pane across the hole, which casts no shadow.

A cutout's outline must lie inside its host and not overlap another cutout on it; otherwise it
reports `structure/cutout-outside` or `structure/cutout-overlap` with its path and is skipped.
`roofAt` counts a point under a skylight or a hole as under the roof.

### Group key and compile

Compile keys every chunk mesh by (group, chunk, material), where a piece's group is its roof's
entity for roof geometry, else its level's entity (or the ground level). A chunk is still an 8 m
square, and an edit still rebuilds exactly the (group, chunk) pairs its old and new geometry
overlap; an edit on one level never rebuilds another level's meshes.

Each chunk mesh is spawned as a child of its group's entity (the ground level has an implicit
one). `Visibility.mode: 'hidden'` on a level or a roof hides every mesh under it through
`ComputedVisibility` (0007): one flag write per mesh, no rebuild, no geometry upload. "Show this
level and below" is a Visibility per level; cutaway and fade are host choices on the same switch.

`Roof.shadowWhenHidden` keeps a hidden roof's meshes in shadow views only: a new instance flag,
`ShadowOnly`, that culling honours for camera views (skip) and shadow views (draw).

### Barriers and bands

- `planarBarriers(walls, openings, { level })` returns one level's segments; each segment carries
  its `level`.
- Ground bands sort by (level index, band, order): a lower level's tokens never draw after an upper
  level's fog. `GroundLayer` gains `level: entity | null`. Depth still hides a lower level under an
  upper floor.

### Roof query

`roofAt(world, x, z, level?) → Entity | undefined` finds the roof whose footprint contains (x, z),
through each roof's chunk set (no scan of every roof). A host hides the roofs its viewer's tokens
are under, and shows the rest.

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

- `structure.describe` lists levels and roofs: their chunks, meshes and whether they're hidden.
- `Level`, `Roof`, `Cutout` and the new `level` fields are schema components and fields.
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

## Acceptance criteria

- [ ] Hiding or showing a level or a roof rebuilds 0 chunks, uploads no geometry, and writes one
      instance slot per mesh in the group.
- [ ] An edit on one level rebuilds only that level's (group, chunk) pairs.
- [ ] With the upper level hidden, a top-down golden of a two-level tower shows the lower level
      exactly as a one-level scene of it does.
- [ ] A roof hidden with `shadowWhenHidden` draws nothing in camera views and still darkens the
      interior (golden); without it, the interior is lit.
- [ ] `roofAt` agrees with a point-in-polygon test over 10k random points, including concave
      footprints and points on shared edges.
- [ ] Ground bands on two levels stack level first: a lower level's tokens never draw over an
      upper level's fog.
- [ ] `planarBarriers` with `level` returns only that level's segments, each tagged with it.
- [ ] A floor with two cutouts keeps its exact area minus theirs (± 0.1%), clipped into chunks, and
      a stairwell hole shows the level below through it (golden, 30°).
- [ ] A hatch toggle rebuilds 0 chunks, and each frame of its swing writes only the leaf's slot.
- [ ] Moving a cutout rebuilds exactly its host's chunks that its old and new outlines overlap.
- [ ] A cutout outside its host, or overlapping another, reports its error with its path and
      leaves the host drawn whole.

## Open questions

- Should a roof fade instead of popping when hidden? Proposed: host choice later (an opacity on
  the group); popping first.
- Pitched roofs beyond one slope (hips, gables): generated from a footprint, or authored as several
  single-slope roofs? Proposed: several roofs first.
