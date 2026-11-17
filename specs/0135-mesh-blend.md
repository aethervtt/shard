# 0135 — Mesh blending

- **Status:** draft
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-terrain`
- **Depends on:** 0021, 0022, 0023, 0056, 0064, 0071, 0074, 0108

## Context

Where one mesh pushes into another, a rock into terrain, two kitbash walls, a log into a bank, the
join is a hard line: albedo, normal and roughness change from one pixel to the next. Artists hide
it with decals, vertex-painted terrain or hand-modelled transitions, and none of that survives a
rock that's placed by a generator or moved by a designer.

Unreal's MeshBlend plugin (meshblend.lervik.com) removes the line in screen space. Every blended mesh
writes a byte to the G-buffer (a size class and an ID), IDs are assigned so meshes that overlap
differ, and a pass before lighting reads across each ID boundary and mixes the two surfaces over a
few centimetres. Because the mix happens before lighting, shading, shadows and specular stay
continuous across the seam. It costs about 0.2–0.4 ms at 1440p, independent of how many meshes
blend. Jack Tollenaar's write-up (an ID buffer, a mirrored sample across the seam, a depth test)
describes the same idea applied after lighting, which leaves the lighting seam visible.

Shard has the inputs: the deferred G-buffer (0021), TAA to resolve a dithered search (0023), and
a lighting pass that already links plugin modules under defines (interior lighting, Toon, cloud
shadows).

## Goals

- `MeshBlend` on a mesh: where it meets another blended mesh, the two surfaces blend over a world
  width set by a size class, on deferred cameras.
- Terrain (0071) blends with what stands in it, and its own blocks don't blend with each other.
- Cost in proportion to the seams on screen, not the number of blended meshes: under
  `gpu:mesh-blend` (proposed 0.4 ms at 1440p on `desktop`) with seams on 15% of the screen.
- No cost and byte-identical full-tier WGSL when no camera blends.

## Non-goals

- Forward cameras. `MeshBlend` meshes draw unblended there, and `render.describe` says so. A
  forward variant would blend lit colour and leave the lighting seam; a later spec if a forward
  project needs it.
- MSAA: deferred views have none (0021). Blending is built for TAA; FXAA works with
  `frameDither` off.
- Suppressing Ink (0108) at blended seams. Ink draws where normals turn, which includes every
  seam blending hides; a Toon and Ink camera turns blending off (`MeshBlendView.enabled`).
- Seams inside one mesh (MeshBlend's vertex-colour masks), foliage-path instances and crowds.
- The WebGL2 baseline: `baseline: 'unsupported'` (0064).

## Design

### Data

```ts
MeshBlend {                     // on a Mesh3d entity
  size: 'small' | 'medium' | 'large' | 'xlarge' = 'medium'
  group: u32 = 0                // nonzero: entities with the same group share one ID
}

MeshBlendView {                 // optional, on a Camera3d; defaults without it
  enabled: bool = true
  quality: 'low' | 'medium' | 'high' | 'cinematic' = 'medium'
  widths: vec4 = [0.06, 0.10, 0.20, 0.30]  // m, per size class
  minPixels: vec4 = [1.5, 3, 3, 5]         // far away a seam keeps at least this many pixels
  slope: f32 = 2                           // how fast the width narrows as the seam sharpens
  noise: vec3 = [0.3, 0.5, 10]             // amount, fade toward the seam, tile (m)
  frameDither: bool = true                 // rotate the search each frame (for TAA)
}
```

The G-buffer byte is `class << 6 | id`: two bits of size class, six of ID (1–63). 0 is "not
blended": every mesh without `MeshBlend`, forward-only materials and the foliage path.

### IDs

`render/mesh-blend-ids` (a `PostUpdate` system) keeps one ID per blend node, where a node is an
entity or a nonzero `group`. Two nodes conflict when they share a size class and their world bounds,
grown by that class's width, overlap. Nodes of different classes never conflict, since their bytes
differ anyway.

- A uniform grid over node bounds finds conflicts. A new or changed node takes the smallest ID
  that none of its conflicts hold, so assignment is greedy colouring, in entity order, which makes
  it deterministic.
- IDs are sticky: a moved node keeps its ID while it still has no conflict, so a moving mesh
  doesn't flicker as it passes others.
- With all 63 taken among its conflicts, a node takes the ID whose holders overlap it least, and
  `render/mesh-blend-ids-exhausted` warns once naming the entity. That seam doesn't blend.
- Per frame it touches only changed nodes, allocates nothing, and keeps the IDs in a `Uint8Array`
  by instance slot that uploads when it changes. IDs are render state and stay out of the world
  hash.

Terrain (0071) gives its block entities `MeshBlend { group: <terrain entity> }` when the terrain's
`meshBlend` field isn't `none`, so a whole terrain is one node: its blocks don't blend with each
other, and rocks pick IDs around it.

### G-buffer

While any deferred view blends, the G-buffer pipelines link `MESH_BLEND` (a pipeline-key bit, as
cloud shadows have) and write a fourth target, `gbuffer3` (`r8uint`, 1 byte per pixel). The vertex
stage reads the slot's byte from `mesh_blend_ids`, a `@data` array bound in the view group the way
the sky occlusion map is, and passes it as a flat varying. The foliage path writes 0.

The other G-buffer readers (SSAO, SSR, Ink, refraction) are unchanged and see the unblended
surfaces.

### Classify

`mesh-blend-classify`, one compute pass at 8×8 tiles:

1. A tile is an edge tile when one of its pixels has a nonzero byte and a 4-neighbour with a
   different nonzero byte.
2. The tile mask is dilated by `ceil(maxPixels / 8)` tiles, so every pixel within reach of a seam
   is in an active tile. `maxPixels` comes from `quality`: 16, 24, 32 or 48.

The result is one bit per tile (1440p is 320 × 180 tiles).

### Blend, in lighting

Deferred lighting links `MESH_BLEND` and calls `mesh_blend(px, s)` from `shard::mesh_blend`
(registered by the plugin) on the unpacked sample before `apply_lighting`. Outside active tiles,
or for byte 0, it returns `s` after reading one tile bit. In an active tile:

1. **Radius.** `r = width × projScale / viewDepth` pixels for this pixel's class, at least
   `minPixels` and at most `maxPixels`.
2. **Search.** 8 directions (4 at `low`), rotated per pixel by interleaved gradient noise, plus the
   frame index when `frameDither`. Each takes `steps` samples of `gbuffer3` out to `r` (3, 4, 6 or
   10 by quality). This finds the nearest pixel `q` whose byte is nonzero and different.
3. **Accept.** With `r'` the radius for the smaller of the two classes, the hit counts when
   `|q − px| < r'` and the two reconstructed world positions lie within `2 × width'` of each
   other. This rejects silhouettes: a rock in front of distant terrain shares a screen edge with it
   but no intersection.
4. **Mirror.** Read the other surface at `m = 2q − px` (the pixel reflected across the seam),
   falling back to `q` when `m` holds another byte.
5. **Weight.** `w = 0.5 × (1 − d / r')`, narrowed by the seam's angle (`pow(0.5 + 0.5 n·n', slope)`
   scales `r'`) and broken up by world-space value noise (`noise`). Both sides compute this, so each
   takes half of the other at the seam and the pair is continuous.
6. **Mix.** Base colour, occlusion, roughness and metallic lerp by `w`; normals `normalize(mix)`.
   Emissive and the shadow-receiver flag stay this pixel's own.

Blending inside lighting reads the G-buffer once more only in active tiles, needs no copy of
it, and no second pass. The tile bit keeps the branch coherent: 8×8 tiles are whole waves.

Known limits: where three meshes meet, a pixel blends with the nearest one only. Thin meshes
under `2r` pixels may blend through to their far side; the world-distance test catches most of
it.

### Graph and plugin

`meshBlendPlugin` registers `shard::mesh_blend`, the classify node (`RenderPhase.Lighting − 5`,
reads `gbuffer3` and `scene-depth`), the IDs system, and the lighting define. It's added to
`forwardPlugin()`. Without it, `MeshBlend` logs `render/feature-missing` and nothing changes.
`pnpm size --check` keeps it out of `renderer-min`. A view blends when it's deferred, the plugin
is on, its `MeshBlendView` (if any) is enabled, and a visible mesh has `MeshBlend`.

### Agent surface

- `MeshBlend`, `MeshBlendView` and terrain's `meshBlend` are schema components and fields (scene
  files, inspector, generated docs).
- `render.capture { buffer: 'blend' }`: blend IDs coloured by size class (small green, medium cyan,
  large blue, xlarge red), seams in white, and active tiles tinted.
- `render.describe` per view: `meshBlend { active: bool, reason?, tiles: { active, total },
  gpuMs }`. `reason` is set when blended meshes are visible but the view doesn't blend: `forward`,
  `disabled` or `baseline`. World-wide: nodes per class, and exhausted nodes.
- Spans: `gpu:mesh-blend/classify`, and `gpu:deferred-lighting` with its blended share.

## Decisions

- **Blend before lighting, in the G-buffer.** After lighting, the seam's shading still shows.
- **A separate `r8uint` target rather than a borrowed channel.** `gbuffer0.a` is specular
  occlusion and `gbuffer1.w` already carries the receiver flag. One byte per pixel (3.7 MB at
  1440p) costs less than losing either.
- **IDs on the CPU, by colouring overlap.** Precomputing them in the editor, as MeshBlend does,
  breaks for generated and moving meshes. Hashing positions on the GPU (Tollenaar) collides with
  no recourse. Greedy colouring is local, incremental and deterministic.
- **Blend inside the lighting pass, not in a pass of its own.** A separate pass would have to copy
  the G-buffer it rewrites (`rgba8unorm-srgb` isn't a storage format), and that copy costs more at
  1440p than the blend itself.
- **Mirror across the seam.** It is symmetric, so both sides meet at 50%, and it takes one sample,
  where gathering an area would take many.
- **Terrain as one node through `group`.** Otherwise every block border would be a seam, costing
  time and blending identical surfaces.
- **Deferred only, TAA expected.** This matches how the technique ships elsewhere. Forward and MSAA
  would each need their own design.

## Acceptance criteria

- [ ] A box half sunk in a plane, both blended, shows no step along the seam: albedo across it
      changes by under 10% per pixel over the blend width, where without `MeshBlend` it steps by
      the full difference (golden pair, deferred camera, TAA converged).
- [ ] The same box in front of the plane at 5 m, touching it nowhere, is unchanged by blending.
- [ ] Width follows the class: a `small` seam's blended band is narrower than a `large` one's, and
      `small` against `large` blends at the `small` width.
- [ ] 63 overlapping same-class boxes get 63 distinct IDs; a 64th warns
      `render/mesh-blend-ids-exhausted` once. The same scene loaded twice assigns the same IDs.
- [ ] A box moving through a row of blended boxes keeps its ID while it has no conflict, and the
      IDs system allocates nothing per frame (`allocationChecks`).
- [ ] A heightfield terrain with `meshBlend: 'large'` blends with rocks in it and draws no blend
      along its own block borders (no active tiles over bare terrain).
- [ ] With no `MeshBlend` entity, or no deferred camera, every existing golden is unchanged and
      `scripts/wgsl-identity.mjs` reports no changed variant.
- [ ] A forward camera reports `meshBlend.reason: 'forward'`; a disabled `MeshBlendView` reports
      `disabled`; the baseline tier draws unblended and reports `baseline`.
- [ ] 1440p, medium quality, seams on 15% of the screen: classify plus the lighting delta stay
      under `gpu:mesh-blend` (proposed 0.4 ms on `desktop`, 1 ms on `laptop`); 10k static blended
      meshes take their first IDs under `render/mesh-blend-ids` (proposed 5 ms on `laptop`).
- [ ] A static camera's blended seams vary by under 1% per pixel over 60 frames after TAA
      converges.

## Open questions

- None blocking. Deferred: a forward variant that blends lit colour; blend masks inside one mesh;
  foliage-path instances; letting Ink skip seams that blend.
