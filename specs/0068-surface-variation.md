# 0068 — Surface variation and contact shade

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render` (`/surface`), `@aethervtt/shard-structure`
- **Depends on:** 0041, 0055, 0056, 0066, 0067

## Context

0066 made structure textured, but a textured wall still reads as one tile repeated, and the lines
where walls meet each other and the floor are hard and clean. Aether hides both with two cheap
tricks, and they are what we need to support:

- **Surface variation.** A shader modulates a material in world space with shaped noise: patches,
  streaks, mottling, per-brick tones, weathering. The colour shifts between a cool and a warm
  pigment, the brightness moves up and down, and the roughness shifts. It breaks up the repeat
  without new textures. Aether ships eight tuned recipes (`surface-style.ts`), selected by name,
  and will have more materials, including ones users author.
- **Contact shade.** Dark, noisy, blended strips along the foot of walls on floors, and up the
  wall where two walls join (`room-shading.ts`). It is fake ambient occlusion: no depth pass, no
  screen-space sampling.

The goal is the capability, not a copy. The variation is a parameterized model that any material
can use, and Aether's recipes become presets of it. The contact shade is built by structure
compile, so it follows curves, rebuilds incrementally and hides with its level. Both have quality
switches, because a host must be able to turn them down on a weak machine.

No renderer core work is needed:
- Material types that extend the standard material can override `pbr_input`.
- Materials can blend (`alphaMode: 'alpha'`).
- The structure plugin already owns built-in materials (0066's `structure:frame`).

The engine's SSAO exists, but it's a full-resolution screen pass whose quality depends on depth.
The strips are cheaper and art-directed.

## Goals

- **A generic surface variation model.**
  - Parameters describe how patches are shaped, how large, how strong, what they tint toward and
    how they weather.
  - Presets are plain data, and hosts add their own.
  - `SurfaceMaterial` is the standard material plus variation, and every preset shares one
    pipeline.
  - A WGSL function, `surface::variation`, lets a custom material type use the same model.
  - It lives in `@aethervtt/shard-render/surface`, not in structure. Props, terrain and tokens'
    bases can use it too.
- **Contact shade compiled by structure.**
  - One blended mesh per (group, chunk): it rebuilds with its chunk and hides with its level or
    roof.
  - Floor strips on the sides of walls that face a floor, broken at doorways.
  - Corner strips at wall joints.
  - Curved walls get curved strips.
  - Noise wobbles the edge, so it's never a straight line.
- **Quality switches.** Each switch drops its cost to zero, at runtime:
  - a global variation switch, which falls back to the plain standard shading;
  - a contact shade switch, which removes the meshes and so adds no draws.

## Non-goals

- Visual or code parity with Aether. Its values seed the presets; the look can differ.
- Shade where there is no `Floor`. No floor, no shade: walls standing on the map image get none.
- Real ambient occlusion. The shade darkens direct light too. Interior light is 0069.
- Stair shading. It belongs to generated stair props, and a prop can use variation or its own
  material.

## Design

### Variation model

A variation is evaluated at a surface point `p` (2D, metres) and yields a tint (rgb multiplier)
and a roughness offset:

```ts
Variation {
  strength: f32,                // 0 off, 1 full; scales everything below
  seed: u32,
  pattern: 'mottle' | 'streaks' | 'grain' | 'cells' | 'stagger' | 'brushed',
  scale: vec2,                  // patch size along the surface's u and v (m); unequal stretches
  warp: f32,                    // domain warp by a second noise (stone-like breakup)
  detail: f32,                  // blend toward a 3.1× finer octave
  bands: f32,                   // 0 soft noise … 1 posterized "paint bands"
  toneRange: f32,               // ± brightness at the patch extremes
  coolTint: vec3, warmTint: vec3,   // the pigments a patch moves between (multipliers)
  roughnessRange: f32,          // ± roughness from the detail octave
  weathering: f32,              // darken and roughen where the weather mask is on
  weatherThreshold: vec2,       // smoothstep edges of the weather mask
}
```

**Patterns** decide what the base value is:
- `mottle`: value noise (after warp);
- `streaks`: value noise squashed across one axis, as for plaster runs;
- `grain`: stretched along u, as for wood;
- `cells`: a hash per cell of `scale`, as for tiles;
- `stagger`: cells with alternate rows offset by half, as for bricks, with a group tone per 2×2;
- `brushed`: `mottle` plus a slanted brush mark per cell, as for stone.

`streaks` and `grain` stretch the noise themselves (×1.25 by ×0.42, and ×0.36 by ×4.2), so `scale`
stays the patch size for every pattern. `warp` moves the point before any pattern, so it also
breaks up cell edges.

The base value then goes through `bands` and is mixed with `detail`. The weather mask is a
smoothstep of the detail octave between `weatherThreshold`. The final tint is the pigment mix, times
`1 + tone − weather`, clamped to 0.62–1.3; `strength` scales the pigment's departure from white, the
tone, the weather and the roughness, as Aether's intensity does. The hash is integer (PCG-style),
so the CPU mirror computes the same lattice values exactly.

**Presets.** `SURFACE_PRESETS` holds `solid`, `plaster`, `stone`, `brick`, `timber`, `ground`,
`metal` and `tile`. Their values come from Aether's recipes, converted to metres and to these
parameters. They're a `Record<string, Variation>` a host spreads and overrides; nothing in the
shader knows their names. Patch sizes are Aether's, converted at 1.5 m per 70 px, and every preset
has `strength: 0.5` (Aether's global intensity). `surfaceVariation(v, p)` is the TypeScript mirror of
the WGSL, used by tests and by tools that preview a preset.

**Surface point.**
- `projection: 'uv'` uses the mesh's UV. Structure's UVs are metres (0066): along and down the
  face on walls, and x, z on floors. So a pattern runs continuously around an arc.
- `'world'` uses the world plane the interpolated normal is closest to (`xz`, `(z, −y)` or
  `(x, −y)`). It's for meshes without metre UVs. The normal rather than `dpdx` × `dpdy`, so the
  function works in any control flow.
- Structure's own pieces use `'uv'`. Either way the point is anchored to the world, not to a
  chunk, so there's no seam where a wall crosses a chunk boundary.

### SurfaceMaterial and the WGSL library

```ts
// @aethervtt/shard-render/surface
export const SurfaceMaterial = defineMaterial('render/SurfaceMaterial', {
  extends: 'standard',
  fields: { variation: VariationField, projection: t.enum(['uv', 'world']) },
  shader: 'surface::material',
})
export const surfacePlugin: Plugin            // registers the WGSL and SurfaceSettings
```

**The variation field.** `VariationField` is `t.struct(VARIATION_FIELDS, { wgsl:
'surface::variation::VariationUniform' })`. A struct field with a `wgsl` option (a new
`FieldOptions` entry in core) packs into a material's uniform as that struct: `wgslLayout` nests it
(16-aligned, as uniforms need) and lists it in `imports`, and the generated material module imports
it. `surface::variation` declares the struct from the same fields, so the two can't drift. Presets
are the field's `examples` (another new `FieldOptions` entry, emitted as JSON Schema `examples`).

**The material.** `surface::material` overrides `pbr_input`:
1. Call `standard_input`.
2. Multiply `base_color.rgb` by the tint.
3. Add the roughness offset.

**Using the model in another type.** `surface::variation` exports:
- `surface_point(in, projection: u32) -> vec2f` (0 `uv`, 1 `world`);
- `surface_variation(p, v: VariationUniform) -> SurfaceVariation { tint: vec3f, roughness: f32 }`.

A user-authored type (a mossy wall, a lava floor) imports these and adds a `variation` field of
the same schema, so the model isn't tied to one material type.

**One pipeline.** Pattern, seed and every range are uniforms, and the pattern branch is uniform
control flow. So any number of variation materials share one pipeline.

### Contact shade

Compile emits contact geometry for every wall into one mesh per (group, chunk), with the built-in
material `structure:contact`. It is an `extends: 'none'` type, alpha-blended, and it:
- casts no shadow;
- is left out of picking;
- writes no depth.

- **Floor strips.**
  - The wall's sampled centreline (0066) is walked in pieces of at most `noiseStep` (1.8 m).
  - A side of a piece is interior when a point `thickness / 2 + ε` off the piece's midpoint lies
    in a floor on the wall's level. So a wall that runs halfway across a floor shades only that
    half.
  - Each interior piece gets a quad from the wall face out to `floorReach`, lifted 2 mm above that
    floor's top.
  - Pieces under a door opening are skipped, so a threshold has no shade across it.
  - Windows keep their strip, because the wall below the sill still meets the floor.
- **Corner strips.**
  - At each wall end joined to another wall, each interior side gets a vertical quad 2 mm off the
    face.
  - It runs from the joint out to `cornerReach`, over the height the two walls share, inset
    0.2 m at the top and bottom.
- **Clipping and groups.** Strips are clipped into chunks like every piece, and they belong to
  their wall's group.
- **Fragment.**
  - Each strip carries `fade` (0 at the wall, 1 at the reach).
  - One octave of world-space value noise `n` wobbles it: `fade' = fade × (1 + wobble × (2n − 1))`.
    The edge meanders instead of running straight.
  - It also varies alpha ±6%.
  - Alpha is a smoothstep falloff plus a contact core over the first 10%. It never brightens as it
    darkens toward the wall, and it's capped at `maxAlpha`.
  - An edge fade over the last 20% of the raw `fade` takes it to 0 at the reach, so a wobble that
    pushes the edge outward never leaves a hard line where the quad ends.
  - `color` is display-referred: the shader divides it by the view's exposure, so the shade is as
    dark by day as by night. `contactAlpha` is the CPU mirror.
- **Joints.** A wall end is joined when another wall on its level passes within its half thickness
  (plus 2 cm) of the end. Walls within 11° of each other continue rather than meet: no corner strip.
  A corner strip starts at the end itself, its fade 0 where the joined wall's face is, so the part
  inside that wall is hidden by it at any angle.
- Each contact mesh carries `StructureChunk` and the `ContactMesh` tag, and `NotShadowCaster`.
- **Dirty marking.** A wall edit already marks the wall's chunks. A floor edit also marks the
  chunks of walls within `floorReach` of its old and new outline, because their interior sides
  may flip.

### Quality switches

```ts
SurfaceSettings { variation: bool }                   // render/surface; hostWritable
StructureSettings.contact: {
  enabled: bool,
  floorReach: f32, cornerReach: f32,  // m: 0.7 and 0.43 by default
  opacity: f32, maxAlpha: f32,        // 0.2, 0.42
  color: vec3,                        // linear
  wobble: f32,                        // 0.2
}
```

- **`variation: false`** links SurfaceMaterial without the variation code: the plugin registers
  `surface::material` as an override that returns `standard_input`. It shades exactly as the
  standard material, at the same cost. Switching re-registers that one module, so the type relinks
  once; it isn't per-frame work.
- **`contact.enabled: false`** despawns every contact mesh, so there are no draws and no compile
  work. Turning it back on rebuilds only the contact meshes. Changing a reach also rebuilds only
  the contact meshes, not the walls. The look (`opacity`, `maxAlpha`, `color`, `wobble`) is the
  built-in material's fields: changing it sets the material and rebuilds nothing.
- A patch may carry part of `contact` (`{ contact: { wobble: 0.3 } }`): compile merges it over the
  values before, so the rest keep theirs.

A host maps its own quality presets ("low", "high") onto these.

### API sketch

```ts
import { SURFACE_PRESETS, SurfaceMaterial, surfacePlugin } from '@aethervtt/shard-render/surface'
app.addPlugins(surfacePlugin)
materials.add(new MaterialAsset({
  baseColor: [0.8, 0.75, 0.7, 1],
  variation: { ...SURFACE_PRESETS.plaster, seed: 1234, toneRange: 0.2 },
  projection: 'uv',
}, SurfaceMaterial))
world.patchResource(StructureSettings, { contact: { floorReach: 0.9, wobble: 0.3 } })
world.patchResource(SurfaceSettings, { variation: false })       // a low-quality preset
```

The playground's scene-material mapping (a mirror of a host adapter) maps a document's style onto
a preset plus its seed. The engine API only knows variations.

### Agent surface

- `structure.describe` adds contact meshes per group (`contactMeshes`) and chunk
  (`contactTriangles`), their totals, and whether contact shade is on. The last compile reports the
  chunks whose contact mesh alone rebuilt (`contactRebuilt`, `contactChunks`).
- `render/SurfaceMaterial`, `render/SurfaceSettings` and the `Variation` schema appear in the
  material and resource schemas. Presets are readable from the schema's examples.
- Errors: an out-of-range variation field fails material validation (`schema/out-of-range`, at
  `/variation/<field>`). `render/feature-missing` fires once when a SurfaceMaterial is drawn without
  `surfacePlugin`: a material type can name the plugin that registers its shader
  (`MaterialTypeOptions.plugin`), and a draw whose shader module isn't registered logs it and falls
  back to the standard material (0061) instead of failing to link.

## Decisions

- **A parameter model, presets as data.** Hosts and users author new surfaces without engine
  changes; a closed enum of today's recipes would not survive the first custom material.
- **In render, behind a subpath.** Variation isn't a structure concept. Keeping it out of the core
  renderer keeps `renderer-min` unchanged (0056).
- **Face coordinates for structure.** Metre UVs (0066) make patterns continuous on curves.
- **Contact shade as geometry, not SSAO.** It's cheaper and stable. It shows only where structure
  says surfaces meet, and it hides with its group.
- **One contact mesh per (group, chunk).** It rebuilds and hides like the chunk's other meshes. The
  cost is one transparent draw per chunk that has walls near floors.

## Acceptance criteria

- [x] The WGSL variation matches `surfaceVariation` within 1/255 at 1,000 points for each preset
      and each pattern (GPU readback).
- [x] Twenty variation materials across every preset create one render pipeline.
- [x] A custom material type that imports `surface::variation` renders the same tint as
      SurfaceMaterial with the same variation (GPU readback).
- [x] A wall crossing a chunk boundary renders the same as the same wall inside one chunk (golden,
      max difference 2/255), and an arc wall's pattern shows no seam (golden, 30°).
- [x] With `variation: false`, a SurfaceMaterial renders byte-identical to a StandardMaterial with
      the same fields.
- [x] Floor strips exist only on sides that face a floor on the wall's level. A doorway has no
      strip across its threshold, a window keeps its strip, and a wall with no floor has none.
- [x] Corner strips exist only at joined ends, spanning the walls' shared height minus the insets.
- [x] The contact alpha is monotonic in `fade` for any noise value.
- [x] Hiding a level or a roof hides its contact meshes, rebuilding 0 chunks. Contact meshes add 0
      draws to shadow views.
- [x] `contact.enabled: false` leaves 0 contact meshes and 0 extra draws. Re-enabling it rebuilds
      only contact meshes.
- [x] A floor edit rebuilds only the contact meshes within `floorReach` of its old and new outline.
- [x] The max fixture's full compile stays within its 0055 budget.
- [x] `renderer-min` holds no surface or contact code and its baked shaders are unchanged
      (`pnpm size --check`, bake test). It grows 0.3 KB (brotli) for nested struct fields in
      `wgslLayout` and `MaterialTypeOptions.plugin`, within its budget.
- [x] A room golden at 30°: brick walls with the `brick` preset, a plaster room with contact shade.

## Open questions

- Should contact shade darken only ambient light (true AO) once 0069 exists? Proposed: keep it a
  blend. 0069's sky visibility already darkens corners indoors, and the blend is what works with
  the sun and without 0069.
