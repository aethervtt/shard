# 0129 — Refracting material types

- **Status:** draft (built 2026-11-17). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0019, 0021, 0056, 0064, 0097, 0108, 0127

## Context

0097 added the opaque copy: after opaque geometry and the sky, `opaque-color` (half resolution,
with mips) and `opaque-depth`. Only render-graph nodes can read it (the water pass does). A project
material can't, so a game's own water can't tell how much water lies between its surface and what's
behind it. Stranded's ocean (`stranded/Ocean`, its specs 0002 to 0005) is an alpha-masked opaque
material for that reason: nothing under the surface shows, though the game wants a raft's beams
and a castaway's legs seen through clear water that washes into the water's colour with depth.

Blending doesn't get there. A transparent material isn't in the depth and normals SSAO and ink read
(`prepass-depth`/`prepass-normal` in forward views, the G-buffer and `scene-depth` in deferred ones,
`postAliases`). With `blend: 'alpha'` the ocean loses its crest outlines, and every submerged edge
draws an ink line through the water. The water pass has the same ink problem.

## Goals

- A material type can ask to draw after the opaque copy, and its shader can sample `opaque-color` at
  a mip and read `opaque-depth`, with helpers that turn a depth into a world point and a distance
  along the view, and give the thickness between the surface and what's behind.
- It writes `scene-depth`, so fog, aerial perspective and everything later see its surface.
- It's in the depth and normals that ink and SSAO read: ink outlines its silhouette and crests, and
  what's seen through it draws no lines of its own.
- Everything else a material has keeps working in that pass: the `vertex_position`, `vertex_extra`
  and `pbr_input` hooks, Toon lighting, received shadows, the alpha mask (a discarded pixel writes
  nothing), cutaways, MSAA, forward and deferred views, both tiers.
- A view where no such material draws runs nothing new: no copy, no extra pass.

## Non-goals

- Refracting surfaces seen through refracting surfaces: the copy is taken once, before any of them,
  so water behind water shows the opaque scene only.
- Shadows cast by them. They draw with blended ones (culled on the CPU, sorted back to front), which
  cast none. Light reaches what's under the water.
- The water pass (0097) in ink's inputs. It has its own shader and pipelines, not a material type's;
  giving it the same treatment is a second draw of its rings with a prepass entry point, for
  0097's part 2. Stranded's ocean is a material type, which is what this spec covers.
- Screen-space reflections of the surface: 0101 reads the copy the same way, separately.

## Design

### The flag and the batch

`defineMaterial(name, { refraction: true, … })` sets `MaterialType.refraction`. A refracting type
never blends: `blend` set to a blended mode throws `render/refraction-blend`, and a material whose
`alphaMode` asks for blending draws opaque (`mask` still masks). It's never deferrable. Its batches
are `transparent`: they skip shadow views, the G-buffer, the GPU cull and the opaque lists, and are
culled and sorted back to front into the camera's `transparent` list like blended ones. The queue
counts the list's refracting draws into `CameraData.refraction` each frame (a walk over the list's
items, a few per view); the transparent pass skips them (and only begins when the list holds
something else), and the refraction passes draw only them.

### The passes (`refractionPlugin`, in forwardPlugin)

All of them are enabled only where `cam.refraction > 0`. The opaque copy is culled unless something
reads it, so it only runs in those views too.

| Node | Phase | Views | Draws into |
|---|---|---|---|
| `refraction` | copy + 5 | forward | `scene-color` (MSAA as the scene), `scene-depth`, written |
| `refraction-deferred` | copy + 5 | deferred | `scene-color` and `gbuffer1` (MRT), `scene-depth` |
| `refraction/prepass` | copy + 6 | with a prepass (ink or SSAO forward, TAA, motion blur) | `prepass-normal`, `velocity`, `prepass-depth`, loaded |
| `refraction/depth` | copy + 6 | baseline with MSAA | `depth`, the single-sample prepass later passes read |

`refraction` is the forward pass's opaque fragment with two differences: group 0 binds the copy
(bindings 20 and 21) in place of SSAO's texture (15), and the fragment writes alpha 1 and depth,
testing `greater`. Everything else in group 0 is as in the forward pass, `shard::shader_data`
(0127, binding 18) included, so a refracting material reads the same per-frame data in every
pass it draws in. The deferred variant's `fs_gbuffer` also packs the surface's normal into
`gbuffer1` the way the G-buffer does (octahedral xy), which is what ink and SSAO read there; lighting
already ran, so nothing else sees it. `refraction/prepass` draws the same batches with the ordinary
prepass pipelines (`shard::prepass`, which runs `pbr_input` for normals and the mask). SSAO runs at
`Prepass + 50`, before the copy, so it measures the scene behind the water (what's under it is lit
with its own occlusion), and ink, at `Post − 10`, sees the surface. On the baseline tier with MSAA
the copy reads the depth prepass; `refraction/depth` draws the surfaces into it after the copy, as
the water pass's `water/depth` does.

### The shader

`shard::refraction`, importable from any material shader. Its bindings exist only under the
`REFRACTION` define, which the refraction pass links; elsewhere (the prepass, picking, the depth
prepass) the same functions return "nothing behind", so a hook that calls them links in every pass.

```wgsl
fn refraction_uv(frag: vec4f) -> vec2f                 // in.clip → screen UV
fn refraction_color(uv: vec2f, mip: f32) -> vec3f      // behind, cd/m² (like emissive); mip 0–4 blurs
fn refraction_depth(uv: vec2f) -> f32                  // reversed Z; 0 where nothing was drawn
fn depth_world(uv: vec2f, depth: f32) -> vec3f         // the world point a depth stands for
fn depth_distance(uv: vec2f, depth: f32) -> f32        // along the view ray, m; REFRACTION_FAR for 0
fn refraction_thickness(uv: vec2f, world_position: vec3f) -> f32  // surface → behind, m
fn refraction_offset(uv: vec2f, offset: vec2f, world_position: vec3f) -> vec2f  // bent UV, or uv
```

The surface is shaded as any lit surface: the material puts what it sees through into `emissive`
and its own colour into `base_color`, so lighting, Toon bands, shadows and its glints apply to the
water and not to what's under it. A water material:

```wgsl
import shard::refraction::{ refraction_uv, refraction_color, refraction_thickness };

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let uv = refraction_uv(in.clip);
  let clear = exp(-refraction_thickness(uv, in.world_position) * Water.absorption);
  p.base_color = Water.tint.rgb * (1.0 - clear);
  p.emissive = refraction_color(uv, 0.0) * clear;
  return p;
}
```

### API sketch

```ts
const Ocean = defineMaterial('stranded/Ocean', {
  fields: { … },
  shader: 'stranded::ocean',
  refraction: true,
})

refractionPlugin // in forwardPlugin; needs opaqueCopyPlugin
RefractionPath, REFRACTION_BINDINGS, REFRACTION_PHASE, REFRACTION_SHADERS
CameraData.refraction // refracting draws in view this frame
```

### Agent surface

The `refraction` option is in the material type's definition; `render.describe` shows the
`refraction*` nodes in a view's order when they run, and `render/feature-missing` names
`refractionPlugin` when a refracting draw finds it absent (its draws are skipped).

## Decisions

- **Group 0's numbers come from one table.** `VIEW_BINDINGS` (`view-bindings.ts`) lists every
  binding of the view group, and building a view layout throws `render/view-binding-collision` on a
  duplicate. The copy first took 19 and 20, and 0131's cloud shadows took 19 too, so with the sky
  installed every refracting draw failed its layout.

- **The surface writes depth and covers its pixel; the material mixes in what's behind.** Ink,
  SSAO and fog all key on depth, and only an opaque surface's depth makes ink outline it and hide
  what's under it. Blending would put the half-resolution copy's blur nowhere and keep the
  submerged lines; mixing in the shader also allows bending (`refraction_offset`) and tinting by
  thickness, which a blend can't.
- **What's behind goes in through `emissive`.** No new hook, every lighting path (forward, deferred
  forward, Toon) adds it unlit, and the copy is converted back to scene luminance (÷ exposure) so it
  reads like any emissive.
- **A pass of its own after the copy, not a graph node per material.** The draws stay in the
  instance store and its culling; the pipelines are the material pipelines with a define and a
  group-0 variant, cached like the others (refraction slots 24–30).
- **Group 0, not a group of their own.** Groups 0–3 are taken (view, material, instances,
  cutaway); the copy rides in a variant of the view layout, as interior lighting's bindings do.
- **The copy replaces SSAO's texture in that layout.** SSAO's value at a refracting pixel is the
  occlusion of what's behind it anyway, and the baseline tier has no room to spare. Its counts,
  per fragment stage of the refraction pass against the forward pass's:
  - *Uniform buffers:* the same as the forward pass. The copy is two textures, not a buffer, so
    0127's worst case (interior lighting, a standard extension, a cutaway: 12 of 12 on a
    compatibility device) is still 12 here.
  - *Sampled textures:* group 0 holds 8 in the forward pass (the cluster bits, three shadow maps,
    two environment cubes, the BRDF table, SSAO) and 9 here (SSAO out, the copy's two in); the
    standard slots are 5 and the instances 2. A refracting standard extension is 16 of 16. With
    interior lighting on (+1) or a texture field of its own (+1) it's 17: such a type needs
    `standardTextures: false` on baseline. Stranded's ocean has it and no texture fields: 11, or
    12 with interior lighting. The full tier counts 8 in group 0 here (its lights and cluster bits are
    storage) and has room.
- **Normals for ink by a second draw in forward views, MRT in deferred ones.** Forward scene color
  can be multisampled and the prepass isn't, so they can't share a pass; deferred views are
  single-sampled, so one pass writes both.
- **Refracting batches ride the transparent list.** It's already culled on the CPU every frame,
  sorted, and kept out of shadows and the G-buffer; a count per frame tells the two passes apart.
- **No shadows from refracting surfaces.** As blended ones; an ocean shouldn't darken everything
  under it, and the CPU cull of the transparent list keeps casters to the GPU-culled lists.

## Acceptance criteria

- [x] A box half under a wavy sheet of a refracting type that tints by thickness (its tint read
      from `shard::shader_data`, which changes the result when rewritten), in forward views
      with and without MSAA and in a deferred view: pixels over the submerged half show the box
      mixed with the water's tint, more so deeper; above the water and in a masked rectangle the
      box is as without the water; ink outlines the sheet's edge against the floor below and the
      box above the water, and neither open water nor the box's submerged edges (which are inked
      without the water) (`refraction.test.ts`).
- [x] The same on the baseline tier (Dawn's compatibility mode), MSAA 1 and 4; on WebGL2 every
      refraction shader translates through naga, and with MSAA the surface draws into the depth
      prepass after the copy, with no GL errors.
- [x] A view with no refracting draw runs none of `opaque-copy`, `refraction`,
      `refraction-deferred`, `refraction/prepass`.
- [x] A blend mode with `refraction: true` throws `render/refraction-blend`; blended `alphaMode`s
      draw opaque, `mask` masks; refracting types aren't deferrable.
- [x] The WGSL of every existing variant is byte-identical (`node scripts/wgsl-identity.mjs`).
- [x] `pnpm size --check`: export-maze-chase, which installs forwardPlugin, grows 2.2 KiB to
      452,554 B entry (its budget is now that measurement); renderer-min grows 0.6 KiB, inside its
      2%.
- [ ] `pnpm bench` passes with its budgets unchanged (opaque-only views do one walk over the
      transparent list per camera more).

## Open questions

- Whether the water pass should join (see Non-goals) once a game wants ink on Shard's own water.
