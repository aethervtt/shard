# 0116 — Shadow casters that matter, occlusion culling, and shadow-only visibility

- **Status:** accepted (built; implemented once its criteria pass in CI)
- **Lands:** after 0114 (nav), before 0115 (hordes), which changes the instance store after this.
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-structure`, `@aethervtt/shard-partition`
  (fixture)
- **Depends on:** 0018, 0022, 0055, 0064, 0067, 0070, 0106, 0113

## Context

A Project Zomboid-style game streams a town of hundreds of buildings, drawn out to 512 m (0113's
`far` level), with a third-person camera and a true first-person toggle. Three parts of the
renderer don't fit it.

**Shadows cost what isn't visible.** tabletop-max's CPU frame is 210 ms on the laptop, and about
160 ms of it encodes four cascades over thousands of structure chunks (`TODO.md`). Each
(chunk, material) is its own mesh, so its own batch, and each draw in a shadow pass binds a
material and five vertex buffers. Cached shadows (0055) don't save it in a game: any skinned pose
(`InstanceStore.deforming`) redraws every cached view, and in this game zombies are always moving.

**No occlusion culling.** At street level the nearest buildings hide most of the town. Everything
behind them is still drawn, and still casts into the cascades.

**Shadow-only and per-camera hiding exist but don't compose.** `ShadowWhenHidden` (0067) sets the
`ShadowOnly` instance flag, but only per mesh and only on a hidden mesh, so a character subtree
needs a tag on every part. `ViewVisibility` (0070) already hides a subtree from one camera while it
keeps casting into that camera's cascades. That's the first-person head. This spec makes both work
with occlusion and with the shadow cache, and adds an inheritable shadow-only mode.

Measured for this spec on an Apple M5 Max (not a named machine), 2026-11-13, with scratch
prototypes that aren't committed:

| Encoding 8,800 depth draws (Node Dawn) | CPU | per draw |
|---|---|---|
| Own buffers per mesh: bind group and 5 vertex buffers and an index buffer per draw (today) | 29.3 ms | 3.3 µs |
| One shared vertex/index arena, sorted by material, `drawIndexedIndirect` | 2.4 ms | 0.27 µs |
| Same draws replayed from a render bundle | 0.39 ms | 0.04 µs |
| 55 merged depth-only meshes | 0.05 ms | |

| Street-level occlusion (CPU raster of wall spans minus openings, 256×144) | street town | 0113 fixture |
|---|---|---|
| Chunk meshes after frustum → after occlusion | 1,763 → 477 (−73%) | 1,197 → 685 (−43%) |
| Indoor props after frustum → after occlusion | 7,576 → 307 (−96%) | 3,954 → 330 (−92%) |
| Characters whose shadow volume is in view → after occlusion | 100 → 11 (−89%) | 101 → 17 (−83%) |
| Raster and pyramid, unoptimized JS (median) | 3.8 ms | 1.3 ms |

The street town is 2,010 one- and two-storey houses in rows along 12 m streets (1 km²). The 0113
fixture is `StructureTownCell` (four one-storey buildings per 64 m cell). Both use 192 views at
2.6 m eye height. The per-draw cost on the M5 Max matches `TODO.md`'s 160 ms on the laptop (about
35k cascade draws).

## Goals

- **Casters that matter.** Per cascade, draw only the casters whose shadows can land in the view
  slice, and skip casters smaller than a texel there.
- **Cached static shadows under moving characters.** Static casters live in cached layers that
  redraw only in the rectangle where a static caster changed, or when the cascade steps or the
  light turns. Dynamic casters draw each frame into a layer of their own, sampled with it. Far
  cascades update less often.
- **Structure in few draws.** A shadow pass draws one merged depth-only mesh per 32 m region and
  group instead of a mesh per (chunk, material). Chunk meshes share one GPU arena.
- **Occlusion culling** for camera views, and for dynamic casters whose shadows would land behind
  occluders. Same frame, so nothing pops, with the same results on both tiers.
- **Shadow-only and per-camera hiding.** `Visibility.mode: 'shadow-only'` is inherited like
  `hidden`. `ViewVisibility` and render layers compose with occlusion and the shadow cache, so a
  first-person head casts its shadow without its own camera drawing it.

## Non-goals

- HLOD (0073), the far level's look, and character tiers (0115; see "What this expects from 0115").
- GPU Hi-Z occlusion (0101's planned pyramid keeps the nearest depth; culling needs the farthest),
  scrolling cascades, and occlusion from the light's side. See Decisions and Open questions.
- Occlusion inside GPU foliage (0045) and 0115's crowd pass. They can read the pyramid later.

## Design

### Casters per cascade

A cascade has a stable box (0018: sphere-fitted, texel-snapped). Casters are tested in three ways:

1. **Shadow volume (dynamic casters, and every caster of an `'always'` light).** The caster's
   sphere is swept along the light direction to the cascade's far depth, which gives a capsule. It
   is kept if the capsule meets the camera's frustum slice for that cascade (its 6 planes). A
   character behind the camera whose shadow falls into view is kept. One whose shadow falls away
   is not. Spot and point views use a capsule from the caster away from the light to its range,
   with its radius grown by the spread there. These views are shared, so a caster is kept if any
   driving camera's frustum meets it.
2. **Cascade box (static casters in cached layers).** The layer is reused while the camera turns,
   so it holds everything in the box, open toward the light (as today).
3. **Size.** A caster whose sphere spans fewer than `minCasterTexels` (1) texels of the cascade is
   skipped. Far cascades shed cans and distant characters with no distance to tune.

Dynamic casters also pass the receiver test (see Occlusion): if the capsule's screen box is fully
hidden in the camera's pyramid, the shadow lands where nobody can see it.

**On the CPU, for game code.** `casterRelevant(world, camera, center, radius)` runs test 1 for a
sphere. It returns true when the sphere's light-swept capsule meets the camera's frustum slice of
any cascade of the shadowed directional light, or the frustum of a shadowed spot or point light
whose shadows that camera drives (0106: it ranks them). It doesn't test size or occlusion, so
false means no shadow of the sphere can be on screen. 0115 calls it before dropping a character
to "off".
- **This frame's boxes.** It fits the camera's cascades with the renderer's own function
  (`fitCascadeGeometry`) from the same inputs: the camera's `GlobalTransform` and `Camera3d`, its
  view's aspect, and the sun read as `prepare-lights` reads it. Called after transform propagation
  (`PostUpdate`, after `TransformSystems`), it agrees with that frame's shadow views exactly; called
  in `Update`, it sees the camera where propagation last left it. It refits only when one of those
  inputs changed. Local lights use the last assignment.
- **Allocates nothing.** Scratch planes and slices live per camera, created the first time a
  camera is asked about. A camera with no shadowed light, an unknown or inactive camera, or one
  that hasn't rendered yet (its aspect is unknown) returns false.

### Static and dynamic layers

This applies to `shadowUpdate: 'on-change'` lights (0055) of all three types. `'always'` keeps one
layer per view, drawn each frame with the culling above.

- **Classified by evidence.** A slot is *dynamic* if it is skinned or morphed, has
  `render/DynamicCaster`, uses a material type whose vertex stage animates over time
  (`animatesVertices`: wind, vertex animation), or its transform changed within the last
  `LightingSettings.staticAfterFrames` (60) frames. Everything else is *static*. The class is a
  bit in the slot's flags word (bit 29). Shadow views select one class with a view flag, on the
  GPU and CPU culls alike.
- **Layers.** A cached sun's cascade array has 8 layers: 0–3 static, 4–7 dynamic. Local shadow
  arrays, when any assigned light is cached, hold a dynamic layer per spot or face after the static
  ones (`spots.length + i`, `points.length × 6 + k`). Receivers sample both layers and keep the
  darker result; a flag per cascade, and a bit per local light, skips the second lookup when no
  dynamic caster reaches it. A dynamic layer clears and draws only dynamic casters, and only when
  one passes its tests: dynamic casters are few, so the CPU walks them first (`anyDynamicIn`) and a
  view nothing reaches draws no pass. Shadow views also skip batches with no caster of their class
  (`anyCaster`), so a dynamic layer doesn't issue an empty draw per static batch.
- **Static redraws.**
  - *Full*: the layer is new, its matrix changed (the cascade stepped or the light turned), its
    depth range grew, or a change can't be localized (a batch's mesh with more than 64 members
    changed, or the shadow epoch moved for another reason).
  - *Rect*: a static caster appeared, left, moved, changed class, or its mesh changed. Its old
    and new light-space bounds, joined per view, become one scissor rect. The rect is cleared by a
    depth-only quad at depth compare `always`, and then the static casters overlapping it are
    drawn. Pixels outside the rect are untouched.
  - At most one full static redraw per light per frame. Others wait, and their old layer and
    matrix stay valid inside the step's guard band.
  - A local light's static view redraws whole when a static change reaches its frustum (no rect:
    its maps are 1024² and few).
- **Steps.** A cached cascade's center snaps to a grid of `step` (1/8) of its width, and its extent
  grows by one step. Walking doesn't redraw it until the eye crosses a step. That's 1 m for a 0–8 m
  cascade 0, and about 11% of texel density.
- **Depth range.** It reaches from the cascade's far end to the top of the static casters' bounds
  (all casters' on the GPU path), in quarters of the cascade's radius, and stays while the box
  doesn't move. A dynamic caster above it grows it, which is a full redraw.
- **Light direction.** `DirectionalLight.shadowAngleStep` (degrees, default 0) quantizes the
  direction the shadow views use, so a day cycle redraws static layers in steps.
- **Far cascades.** Cascade *i* draws its dynamic layer every `max(1, farEvery >> (count − 1 − i))`
  frames, staggered so two far cascades never draw in the same frame (`shadowFarEvery`, default
  4: 1, 1, 2, 4). A far cascade's dynamic casters lag by up to that many frames.
- **Settings live on DirectionalLight** (`shadowStep`, `shadowFarEvery`, `minCasterTexels`,
  `shadowAngleStep`), not in `CascadeSettings`: a struct field is required in every patch, so
  adding them there broke existing `cascades: { count, maxDistance, splitLambda }` values.

A still camera over a static scene draws no shadow pass. With a walking character it draws only
the dynamic layers of the cascades the character's capsule meets.

### Structure: arena and shadow proxies

- **Arena.** CPU meshes with `Mesh.arena` set (structure's chunk meshes and proxies use
  `'structure'`) allocate from one `MeshArena` in `GpuAssets`: growable vertex buffers (positions,
  normals, uvs, uvs1, tangents) and a uint32 index buffer, with a first-fit, coalescing free list. A
  mesh that outgrows its range moves within the arena. Indices are stored absolute (offset by the
  mesh's first vertex), so draws need only a first index: WebGL2 can't offset `vertex_index` by a
  base vertex. A grow copies into new buffers and retires the old ones until the next frame (draws
  already recorded still use them). It is the CPU-mesh counterpart of `Mesh.gpu.share`. Draws in one
  arena bind its buffers once per pass, and 0022's near-first sort keeps arena runs together.
- **Shadow proxies.** For each 32 m region (`StructureSettings.shadowRegion`, 4×4 chunks) and
  group (level or roof, 0067), structure keeps one positions-only mesh of the chunk meshes whose
  material is the plain standard type, opaque and single-sided (masked ones discard, double-sided
  ones cull differently, custom types may move vertices). It lives on an entity with `Visibility: 'shadow-only'`, a child of the group,
  so a hidden level hides its proxy. Roofs with `shadowWhenHidden` give their proxy
  `ShadowWhenHidden` too. The proxy is the same triangles in the same world space as the chunk
  meshes, so cascade layers are bit-identical. Chunk meshes of opaque materials get
  `NotShadowCaster`. Masked materials, door leaves and panes still cast as themselves.
- **Rebuild.** A chunk rebuild marks its region, and its proxy rebuilds in the same compile by
  concatenating the region's merged chunk positions, so a proxy is never stale. A region whose
  material is still loading looks again next compile, its chunks casting meanwhile.

On the max fixture, a full redraw of four cascades issues 572 draws with proxies and 38,304
without (measured), and the layers are bit-identical either way.

### Occlusion

`occlusionPlugin` (in `forwardPlugin`) adds CPU occlusion for cameras with `OcclusionCulling`.

- **Occluders** are explicit and simple, not the drawn meshes.
  - `Occluder { mesh }` on an entity with a Transform: triangles that lie inside what it draws.
    Over 256 triangles logs `render/occluder-too-complex`.
  - Structure makes them with `StructureSettings.occluders` (default true). Each chunk mesh gets
    its walls' solid pieces (from the same split the walls are built from, frames left out) as
    quads on the centreline, inside the wall whatever its thickness, clipped to the chunk. Opaque
    materials only. Door leaves get their box, wherever they've swung. An opening, or a door that's
    gone (0114), is a hole. Floors and roofs give none: from street level walls do the hiding, and
    a large slab's farthest corner is too far for its depth to hide anything.
  - An occluder follows its entity's `ComputedVisibility`, render layers, and each camera's
    `ViewVisibility`. A shadow-only or hidden entity occludes nothing. A `Cutaway` occluder
    doesn't occlude for a camera with `CutawayView` points.
- **Raster, per camera, per frame** (skipped while the camera, every occluder, and every slot's
  flags are still). The raster code loads with `import()` the first time a world has an occlusion
  camera or an occluder:
  1. Gather occluders from a uniform 16 m grid within `range` (200 m) and the frustum. Skip any
     whose projected size is under 4 pixels.
  2. Rasterize them into a `width`×(width / aspect) f32 buffer (256×144 at 16:9). Coverage is
     inner-conservative (only fully covered pixels) and depth is the triangle's farthest, so the
     result never hides a visible object. Edges two triangles of an occluder share are tested at
     pixel centers, so a quad has no crack down its diagonal. Triangles are clipped at the near
     plane.
  3. Build a farthest-depth mip pyramid.
- **Tests.**
  - An instance is tested by its mesh's box through its transform (eight corners), or a skinned
    pose by its sphere: a flat floor chunk's sphere would reach far above any wall's edge. The test
    starts at the pyramid level where the screen bounds span at most 4×4 texels and descends only
    into texels that don't hide it whole, so bounds just above an occluder's edge still count.
  - The CPU tests each batch's draw before it's encoded: a small batch (up to 8 members, every
    structure chunk) is skipped when all its members are hidden, which extends 0022's small-batch
    skip.
  - On the full tier, the GPU cull also tests every camera-view instance against the pyramid. The
    pyramid uploads as an `r32float` texture with one layer per occlusion camera, only when it
    changed. The test sits behind `@if(OCCLUSION)`, as `HIDDEN` does, so the default cull variant
    links the same code.
  - On the baseline tier, the CPU cull already visits every instance, so it tests each one the
    same way. Both tiers draw the same visible sets (f32 math, same order).
  - Every camera pass tests: opaque, transparent, ground, prepass, G-buffer, and picking.
- **Shadows.** With `OcclusionCulling.shadows` (default true), the swept casters of that camera's
  cascades (dynamic layers, and every caster of an `'always'` sun) also pass the receiver test: the
  caster's box swept along the light until its top reaches the floor (the lowest static caster's
  center, flat ground's height), tested as a box. Static layers never use it, because they are
  reused as the camera turns, and nor do shared local views.
- **Game code** can ask `occluded(world, camera, center, radius)`, for example to animate occluded
  zombies at a lower rate. It reads the last raster and allocates nothing.

### Shadow-only and per-camera hiding

- `Visibility.mode` gains `'shadow-only'`. `ComputedVisibility` gains `shadowOnly`. A subtree
  under a shadow-only entity is shadow-only, and children set to `inherit` follow it. A `hidden`
  child stays hidden. A shadow-only entity under a hidden parent is hidden, so a hidden level
  hides its proxies. `'visible'` keeps its override (0007).
- The instance store sets `ShadowOnly` from `shadowOnly`, or from `ShadowWhenHidden` on a hidden
  mesh as before. To camera views, picking, outlines and occluders, it's hidden. Shadow views draw
  it, as a static or dynamic caster by the usual rules.
- **Per camera:** use `ViewVisibility { hide, shadows: 'keep' }` (0070) for a named subtree, or
  render layers for classes. A hide list with `shadows: 'hide'` still redraws cached cascades whole
  when it changes, as in 0070.
- `compute-visibility` also walks hierarchies whose root has no `Visibility` (structure's groups,
  scene roots), as visible: modes under them used to be ignored. It skips frames where no mode,
  parent link, or table holding them changed.

First person is `world.add(fpCamera, ViewVisibility, { hide: [head], shadows: 'keep' })`, with
`head` the head mesh and what's attached to it. That camera never draws it or occludes with it,
its cascades keep the head's shadow, and every other camera, here or on another client, draws it.

### API sketch

```ts
// render
DirectionalLight { ...,
  shadowStep: f32 = 0.125,     // on-change: snap grid as a fraction of the cascade's width
  shadowFarEvery: u8 = 4,      // the farthest cascade's dynamic layer redraws every N frames
  minCasterTexels: f32 = 1,
  shadowAngleStep: f32 = 0 }   // degrees; 0 follows exactly
LightingSettings { ..., staticAfterFrames: u16 = 60 }
export const DynamicCaster: TagDef                             // render/DynamicCaster
MaterialTypeOptions { ..., animatesVertices?: boolean }         // wind, vertex animation
Visibility { mode: 'inherit' | 'visible' | 'hidden' | 'shadow-only' }
ComputedVisibility { visible: bool, shadowOnly: bool }
OcclusionCulling { width: u16 = 256, range: f32 = 200, shadows: bool = true }  // on a Camera3d
Occluder { mesh: handle('Mesh') }
export function occlusionPlugin(): Plugin                      // in forwardPlugin()
export function occluded(world: World, camera: Entity, center: ArrayLike<number>, radius: number): boolean
export function casterRelevant(world: World, camera: Entity, center: ArrayLike<number>, radius: number): boolean
Mesh.arena: string | undefined                                 // e.g. 'structure': shared buffers
export interface OcclusionTest { hides(...); hidesInstance(...); hidesShadow(...) }
export class OcclusionBuffer implements OcclusionTest           // the plugin's

// structure
StructureSettings { ..., shadowRegion: f32 = 32, occluders: bool = true }
StructureShadowProxy { group, x, z }                           // on each proxy
```

### What this expects from 0115 (hordes)

- **Skinned and GPU-animated characters are dynamic casters.** The Mesh3d skinning path gets this
  automatically. A tier that animates in the vertex stage, without the deform system (vertex
  animation textures, a crowd shader), must mark its material type `animatesVertices`, or tag its
  entities `DynamicCaster`. Otherwise its shadows freeze in the static layer.
- **Conservative bounds per instance.** Culling, `minCasterTexels`, the capsule test and occlusion
  all read the slot's sphere. Skinned slots already use the deform sphere. A GPU-animated tier must
  give a sphere that contains every pose.
- **Far tiers and shadows are 0115's call.** `minCasterTexels` already drops characters smaller
  than a texel in a cascade. A tier that should never cast (impostor cards) sets `NotShadowCaster`.
  A tier that should cast a blob uses its own shadow-only proxy mesh.
- **The player's own character stays full tier, with a separable head.** The head, hair, headwear
  and anything attached to the head joint must be meshes apart from the body, so `ViewVisibility`
  can hide them. A merged single-mesh character can't be partly hidden.
- **A crowd drawn outside Mesh3d** (its own pass, like foliage) must draw into the dynamic cascade
  layers through the same hook foliage uses (`drawShadow`), and read the occlusion pyramid for its
  own culling, or it gets neither.
- **Occlusion for animation LOD.** 0115 can call `occluded()` to skip or slow animation for hidden
  characters. The renderer won't do this for it.
- **Never "off" while the shadow shows.** Before dropping a character to "off", 0115 checks
  `casterRelevant(world, camera, center, radius)` with the same sphere the slot uses. True means
  its shadow can be in that camera's view this frame.

0114 (doors): a breached or opened door moves its leaf, which is a dynamic caster until it settles,
and removes its occluder box. Nothing else is asked of it.

### Agent surface

- `render.describe` gains `occlusion`: the occluder count and, per occlusion camera, the buffer's
  size, occluders and triangles rastered, raster ms, and batches and instances culled.
- `render.capture { debug: 'shadow-map:<light>:<layer>' }` reaches a cached sun's dynamic layers at
  4–7, a cached spot's at 1 and a point light's at 6–11.
- Each camera's `Cascades` counts this frame's static redraws (`fullRedraws`, `rectRedraws`, and
  masks of which cascades); `StructureShadowProxy` marks proxies.
- Errors: `render/occluder-too-complex`; `render/feature-missing` for `Occluder` or
  `OcclusionCulling` without `occlusionPlugin`.
- Not built: shadow-view redraw reasons in `render.describe`, an `occlusion` debug capture, and
  proxy counts in `structure.describe`.

## Decisions

- **CPU occlusion, not GPU Hi-Z.** It runs in the same frame (no popping), and it removes CPU
  draw encodes, which GPU culling can't: GPU culling still encodes every indirect draw. One
  implementation serves both tiers and is testable headless. The town's occluders come free from
  structure.
- **Explicit occluders, not the drawn meshes.** Wall spans minus openings are exact and few. Drawn
  meshes have far more triangles, and windows that must stay holes.
- **The GPU tests instances against the CPU's pyramid on the full tier.** Testing 40k instances in
  JS cost 2.3 ms in the prototype. The CPU tests only what decides whether a draw is encoded.
- **Static casters cull against the cascade box, dynamic ones against the view.** A static layer
  is reused while the camera turns. Tight tests pay off only for what is redrawn every frame.
- **Static and dynamic layers in one array, sampled together.** Baseline has no texture binding
  to spare (0105 kept it to 16). A tile-based GPU clears the dynamic layer for free, and the
  static layer is never copied.
- **Dynamic by evidence, not authored.** Authors classify nothing. A door swings in the dynamic
  layer and settles back into the static one, which costs two rect redraws.
- **Rect redraws.** A wall edit or a settled door redraws its own rectangle, not the cascade.
- **Cascades step, not scroll.** At walking pace, a full redraw of cascade 0 every ~1 m costs a
  handful of proxy draws. Scrolling needs a ping-pong layer and strip draws.
- **Merged depth-only proxies per (32 m region, group).** Depth needs no material. 32 m keeps
  culling useful while turning about 16 chunk meshes (×materials) into one draw. Groups keep 0067's
  per-level hiding.
- **A shared arena for structure meshes, not render bundles.** The arena measured 12× cheaper with
  no invalidation logic. Bundles save another 6×, but they must re-record whenever the draw list,
  the order or a pipeline changes.
- **An inherited `'shadow-only'` mode.** A character is a subtree. `ShadowWhenHidden` is per mesh
  and means "cast while hidden".
- **No new per-camera component.** `ViewVisibility` (0070) already hides a subtree from one camera
  and keeps its shadow. Here it learns occlusion and rect redraws.
- **What a camera doesn't draw doesn't occlude for it.** Otherwise a hidden first-person head
  would cull what's in front of the eye.
- **`minCasterTexels` instead of per-cascade distance cutoffs.** It adapts to resolution and
  cascade size with no tuning per game.
- **A new street-town generator, not a parameter on `StructureTownCell`.** Existing `cellHash`
  checks stay as they are.
- **Occlusion is opt-in per camera.** A top-down tabletop camera gains nothing from it and would
  pay about 1 ms.
- **Instances are tested by their mesh's box, not their sphere** (as built). A flat floor chunk's
  sphere reaches far above any wall's edge: at street level, boxes took instances drawn from 0.30×
  to 0.15× and draws from 0.42× to 0.19× on the street town.
- **Occlusion's raster loads with `import()`** (as built). Apps that install `forwardPlugin` and
  never use occlusion (`export-maze-chase`) don't carry it; `renderer-min` carries only its
  components and the cull's hooks.
- **Proxies rebuild in the compile that rebuilt their chunks** (as built), with no per-frame
  budget: a scene load otherwise kept rebuilding proxies, and flipping chunks' casting, for many
  frames after.
- **New sun settings on `DirectionalLight`, not `CascadeSettings`** (as built): a struct field is
  required in every patch, so adding them there broke existing code.

## Acceptance criteria

Fixtures: 0055's max fixture (tabletop-max), and a new `test/StreetTownCell`
(`partition/src/fixtures/street-town.ts`): one- and two-storey houses with pitched roofs, a front
door and three windows each, in two rows per 64 m cell along a 12 m street; `far` cells keep the
shells. As built, its test (`partition/src/street-town.test.ts`) streams it with `full` to 96 m and
`far` to 256 m, adds 12 props inside every house and 300 moving characters (box casters tagged
`DynamicCaster` standing in for skinned ones: half on the five nearest streets, half indoors), and
walks 192 m (512 m under `pnpm bench`) at a 2.6 m eye height, turning, with two cameras that share
every transform, one with `OcclusionCulling`. Measured on an Apple M5 Max (not a named machine),
2026-11-13.

- [ ] **tabletop-max.** In `pnpm bench`, the CPU frame p95 meets `tabletop-max`'s `frame.cpu`, and
      `render/shadows/cascades` alone meets `render/shadow-encode`. As built: `render` 14.4 to
      18.5 ms p95, the cascade encode 0.94 to 1.0 ms (from about 160 ms), on the M5 Max. The
      budgets are 20 / 15 ms and 1.5 / 1.2 ms, unmeasured on both named machines (the spec proposed
      16 / 12 and 1.0 / 0.8); `TODO.md` keeps the entry until the laptop confirms.
- [x] **Few structure draws.** A full redraw of four cascades on the max fixture issues 572 draws
      with proxies against 38,304 without, and the layers are bit-identical (readback,
      `structure/src/shadow-proxies.test.ts`).
- [x] **Occlusion counts.** Over the street walk, with occlusion against without (CPU cull, exact
      counts): draws 0.19× (`render/occlusion-draws`, 0.3), instances 0.15×
      (`render/occlusion-instances`, 0.2), dynamic-caster instances in the cascades 0.57×
      (`render/occlusion-shadow-instances`, 0.65; proposed 0.4: shadows of characters indoors drop
      to 0.52×, of those on other streets to 0.59×, as they show through gaps between houses). GPU
      and CPU visible sets are checked equal on the occlusion test scene
      (`render/src/occlusion.test.ts`), not on the walk.
- [x] **Occlusion cost and correctness.** `render/occlusion` 0.6 ms median, 0.67 ms p95 per camera
      (budget 1.0 / 0.8). The sampled frames render bit-identical with and without occlusion.
- [ ] **town-street** meets its scenario budgets. Not built: the walk measures counts, not a
      capture; `budgets.json` holds the proposal.
- [x] **Still scene.** A still camera over static casters draws no shadow pass for 120 frames and
      uploads no scene bytes. A `DynamicCaster` idling in view redraws no static layer; only the
      dynamic layers of the cascades its shadow reaches draw (`render/src/cached-shadows.test.ts`).
- [x] **A moving character over cached shadows.** Walking 60 frames past buildings, cached (steps
      off, `shadowFarEvery` 1: the far cadence lags by design and has its own test) against
      `'always'`: frames 1, 30 and 60 differ in at most 0.1% of pixels, and no static layer redraws.
- [x] **Rect redraws.** A new building redraws only its rectangle: texels outside are bit-identical
      and the draws issued are exactly the static casters over it. A door that swings and settles
      costs two rect frames, its swing in the dynamic layer.
- [x] **Steps and far cascades.** Over 10 m of walking, cascade 0 redraws exactly on the frames its
      center steps. At `shadowFarEvery` 4, the four cascades draw their dynamic layers 16, 16, 8 and
      4 times in 16 frames, cascades 2 and 3 never together.
- [x] **Casters per cascade.** A character behind the camera whose shadow falls into view is drawn
      into a cascade, one whose shadow falls away isn't; a 0.2 m prop is left out of a cascade where
      it spans under a texel, and kept at `minCasterTexels` 0. GPU and CPU culls alike
      (`render/src/shadow-casters.test.ts`).
- [x] **`casterRelevant`.** For 400 boxes around a camera walking five frames under a sun and a
      shadowed spot, it agrees with the GPU and the CPU culls on every box (2,000 checks each),
      called in `PostUpdate` after transform propagation. 10,000 calls a frame allocate nothing
      (checked under `pnpm bench`).
- [ ] **Shadow-only.** As built: a shadow-only subtree is in shadow views and not camera views,
      `inherit` children follow it, a `visible` child overrides it, a hidden parent hides it, on
      both culls (`render/src/culling.test.ts`), and it occludes nothing. Not built: the golden
      against a visible twin.
- [ ] **Hidden from camera A, shown in B.** 0070's two-camera test covers hiding and kept shadows;
      a `ViewVisibility`-hidden occluder hides nothing for that camera
      (`render/src/occlusion.test.ts`). Not built: the skinned-head golden with occlusion on both
      cameras.
- [ ] **Baseline.** As built: every new render test passes with `SHARD_TIER=baseline` (Dawn's
      compatibility mode, CPU culls, the dual-layer lookup translated), and structure's WebGL2
      upload test passes on the fake GL context. Not run: the browser goldens on `?backend=webgl2`.
- [ ] **renderer-min.** As built: `pnpm size --check` passes with `renderer-min` raised to
      104,594 B entry and 178,494 B all-JS, and `export-maze-chase` to 433,626 / 673,622 B (noted in
      `bench/size/budgets.json`). Core shaders change (the cull's sweep, class and occlusion hooks,
      the dual-layer lookup), so `wgsl-identity.mjs` doesn't apply; occlusion's WGSL is the plugin's
      own module, linked only under `OCCLUSION`.

## Open questions

- **Scrolling cascades.** Proposed: steps first. Scroll cascade 0 only if `town-street`'s worst
  frames show step redraws.
- **Occlusion from the light's side** (roofs hiding interiors and indoor zombies from the sun).
  Proposed: deferred. Proxies already make static redraws cheap. As built, it's the lever left for
  dynamic shadows: indoor characters' shadows drop only to 0.52× with the receiver test.
- **What's left of tabletop-max's CPU frame** is per-batch work over 8,812 single-instance batches
  (`forward-opaque` 7.2 ms encoding, `forward-queue` 6.4 ms). Proposed: merge a chunk's materials,
  or record render bundles for static draws, if the laptop misses 20 ms.
- **Occluder raster on a worker.** Proposed: main thread within `render/occlusion`. A worker costs a
  frame of latency, which brings back the popping this design avoids.
- **Flip `shadowUpdate`'s default to `'on-change'`** once these criteria pass? Output matches
  `'always'` within the penumbra tolerance, and only cost changes. Proposed: yes, in the change
  that marks this spec implemented.
