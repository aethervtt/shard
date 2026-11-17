# 0134 — Surface weather

- **Status:** draft (visual pass built; tests to come)
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-weather`, `@aethervtt/shard-terrain`,
  `@aethervtt/shard-scatter`, `@aethervtt/shard-nature`, `@aethervtt/shard-water`
- **Depends on:** 0020, 0064, 0068, 0071, 0096, 0097, 0101, 0127, 0133

## Context

0133 knows how wet, snowed-on and dusty the world is (`wetness`, `snowCover`, `dustCover`) and
where the sky reaches (the weather mask). Nothing draws it yet: the ground under a thunderstorm
looks as dry as at noon.

UDS draws it through material functions: Surface Weather Effects for props, Dynamic Landscape
Weather Effects for terrain, Foliage Weather Effects, and glass rain drips. Every material has to
be edited to call them, through Material Attributes and static switches, and a material nobody
edited stays dry. Shard's materials share the standard model and 0020's `pbr_input` hook, so the
same effects can be on by default for every built-in material, and one WGSL call away for a
custom one.

## Goals

- Wet surfaces darken and gloss by porosity, vertical surfaces dry first, and covered surfaces
  stay dry.
- Puddles fill flat low areas as wetness rises, with animated rain ripples. They reflect through
  0101 and the IBL.
- Snow covers upward-facing surfaces by `snowCover`, with an optional small displacement.
- Dust and sand tint and roughen upward surfaces by `dustCover`.
- A foliage profile: wet, glossy leaves and snow on top of the canopy, without puddles.
- On by default for the standard material, surface variation (0068), terrain layers, scatter and
  nature foliage, through one `weather` field per material.
- A WGSL API (`shard::weather`) for custom materials: one `apply` call, plus accessors for every
  channel, the season and the mask.
- Rain ripples on 0097's water surfaces.
- No cost without the weather plugin, and byte-identical WGSL.

## Non-goals

- Per-entity wetness that differs from the place, such as a character still dripping indoors.
  `WeatherExposure` (0133) has the values; feeding them to an instance's shading is deferred.
- Snow and dust trails, deformation, and accumulation as geometry.
- Glass drips, window rain, wipers, and screen droplets.
- Seasonal foliage color. `season()` is exposed so a material can do it; no built-in profile does.

## Design

### Profiles and the material field

```ts
weather: 'auto' | 'none' | 'prop' | 'ground' | 'foliage' = 'auto'   // a field on every built-in material type
porosity: f32 = -1                                                  // 0 sealed … 1 absorbent; -1: from roughness
puddles: f32 = 1                                                    // ground only: 0 none … 1 full
snowDisplacement: f32 = 0                                           // metres along the normal at full cover
```

- `auto` resolves per type:
  - `StandardMaterial` and `SurfaceMaterial` (0068) take `prop`;
  - terrain layers (0071) take `ground`;
  - scatter vegetation and nature trees take `foliage`;
  - water, unlit, sprite, UI and decal types take `none`.
- Terrain layers get their own fields, so a road layer has puddles and a grass layer doesn't. The
  terrain shader applies the profile per layer weight.
- A custom material type (0020) declares nothing: it gets `none` unless it calls `apply` itself.

### The model

`shard::weather::apply(pbr: PbrInput, world: vec3f, profile: u32) -> PbrInput`, after the
material's own surface:

- **Exposure.** `e = exposure(world)` is 0133's mask: 1 under open sky and 0 under cover. Beyond
  the mask's range it fades to 1 (assume outdoors). Every effect below is multiplied by the
  exposure for its channel (rain, snow, dust), so mask brushes can unmask snow and leave the floor
  dry.
- **Wetness** (Lagarde's "Water drop" model, simplified):
  - `porosity` comes from the field, or from roughness when unset (rough materials absorb).
  - Albedo darkens by `mix(1, 0.2 + 0.8 × (1 − porosity)², w)`.
  - Roughness falls toward 0.1 by `w × (1 − porosity × 0.5)`.
  - Metals only lose roughness.

  `w = wetness × e`, reduced on vertical faces in proportion to drying (`1 − |n.y|` scaled by
  0.6), so walls look streaky-dry before the ground does.
- **Puddles** (`ground`, scaled by `puddles`):
  - The mask is a tiling world-space noise (from 0041, generated once) thresholded by `wetness ×
    puddles`.
  - Only flat areas fill (`n.y > 0.95`), and lower ones first: a terrain layer's height and a
    material's AO, when present, bias the threshold, so ruts and cavities fill first.
  - Inside a puddle, albedo goes toward dark water and roughness to 0.02. The normal flattens to
    up, plus `ripple_normal(world.xz)` scaled by `rain`.
- **Ripples.** An animated normal from a 16-frame flipbook of expanding rings at random times. The
  flipbook is generated at startup (256², `rg8`) and tiled at 1 m with two offset layers.
  Intensity is `rain × e`. 0097's water material calls `ripple_normal` with its own scale, so lakes
  and the sea ripple too.
- **Snow** (all three profiles):
  - Coverage is `smoothstep(0.2, 0.6, n_world.y + noise) × snowCover × e`.
  - Foliage uses its geometric normal blended with world up, so canopies whiten from the top.
  - Covered pixels take a snow albedo of 0.85, roughness 0.65, a normal flattened toward up, and a
    faint subsurface tint.
  - `snowDisplacement` moves vertices along the normal by coverage in `vertex_position` (0020),
    which every pass compiles, so shadows and depth agree.
- **Dust** (`prop` and `ground`): albedo lerps toward the preset's dust color and roughness rises
  toward 0.9, by `dustCover × e × max(n.y, 0)`.
- **Order.** Dust, then wetness (wet dust darkens), then puddles, then snow on top. When snow is
  present, wetness and puddles are reduced by `snowCover`.

### The WGSL API

```wgsl
import shard::weather

override fn pbr_input(in: VertexOutput) -> PbrInput {
  let p = standard_pbr_input(in)                   // the material's own surface
  return weather::apply(p, in.world_position, weather::PROFILE_GROUND)
}
```

Accessors, all cheap reads:

- `weather::wetness()`, `snow_cover()`, `dust_cover()`;
- `rain()`, `snow()`, `dust()`, `thunder()`, `fog()`;
- `channel(id)`, for project channels, by a constant `weather::channel_id("risen/toxicity")` the
  compiler resolves;
- `season() -> vec4f`, the spring, summer, autumn and winter weights;
- `exposure(world)`, `puddle(world, n, height) -> f32` and `ripple_normal(xz) -> vec3f`;
- `wind` from `shard::wind`.

Custom materials can build their own response from these: moss that greens in rain, frosted
glass, or ash that settles.

### Data

- **Who owns what.** Render can't import weather. Render owns the material fields (one schema
  drives everything) and a generic **surface modifier** slot: `addSurfaceModifier(world, { module,
  call })` names a WGSL function that built-in materials call on their `PbrInput`, with the
  material's resolved profile. The weather plugin registers `shard::weather` and `apply` there.
  The `shard::weather` module is weather's. Another plugin could register its own modifier the
  same way (0068's variation is a candidate).
- **Uniforms.** The channel values, material state, dust color, ripple time and the mask's
  transform are 8 vec4 slots of `ShaderGlobals`, reserved by the weather plugin. With wind's 99,
  that's 107 of 128. Project channels beyond 8 go to `ShaderData` (0127), which has room for any
  number.
- **The mask.** 0133's mask texture is bound in the view bind group the way 0069's sky visibility
  is, when the weather plugin is present.
- **Variants.** `apply` is compiled only into a pipeline whose material resolves to a profile
  other than `none` while the weather plugin is installed. Without the plugin, the standard,
  surface and terrain WGSL are byte-identical (`scripts/wgsl-identity.mjs`), and so is any material
  set to `none`.
- **Both tiers.** Everything is fragment math, two texture reads (noise and the ripple flipbook)
  and the mask, so the baseline tier runs the same code. Its baseline strategy is the full one
  (0064 `addRenderFeatures`).
- **Deferred.** The G-buffer stores the modified `PbrInput`, so deferred and forward match without
  a separate path.

### Weather off, weather unchanging

- With weather installed but every channel and the material state at 0, `apply` returns its input
  bit-for-bit (no darkening at zero), so a dry day costs only the variant's few instructions.
- 0038's `quality: 'low'` drops puddles and ripples (wetness and snow stay). Each built-in profile
  has a uniform branch on its channel being 0, so a dry scene skips the noise reads.

### Agent surface

- `render.describe` → `weather`: which material types resolved to which profile, the slots
  reserved, and whether the mask is bound.
- `weather.surface { position }` returns the exposure and the effect weights (wet, puddle, snow,
  dust) at a point, from the CPU shelter and the material state, for checking "is the yard wet but
  the porch dry" without a screenshot.
- The docs skill `write-a-material.md` gains a "Weather" section with the `apply` example and the
  accessors. `.agents/skills/weather.md` (0133) gains the material field and profiles.
- Errors: `weather/unknown-profile` (a `weather` value that isn't a profile),
  `weather/unknown-channel` (a WGSL `channel_id` naming an unregistered channel, at compile time
  with `path`), and `render/globals-full` (inherited from 0127's rules when slots run out; the hint
  names the plugins holding slots).

## Decisions

- **On by default, through one field.** UDS's per-material wiring is its biggest integration cost,
  and a forgotten material breaks the look. Here, every built-in material gets weather by adding
  the plugin, and opting out is one field.
- **A `pbr_input` post-step, not a lighting change.** Weather changes what a surface *is* (albedo,
  roughness, normal), which is exactly what `PbrInput` carries. Shadows, Toon, deferred, SSR and
  IBL see wet or snowy surfaces with no new code.
- **Profiles instead of switches.** Four named responses cover props, ground and foliage. Custom
  needs go through the accessors, which are more expressive than a growing list of booleans.
- **Exposure from 0133's mask.** One answer for "under cover" keeps rain, splashes and wet ground
  in agreement. A floor under a roof is dry because no rain falls there, not because of a second
  rule.
- **Puddles from noise biased by height, not simulated water.** It's the look of UDS's puddles
  for a texture read, and terrain layers already know which surfaces are roads.
- **Uniforms in ShaderGlobals, overflow in ShaderData.** Eight slots fit beside wind. Project
  channels can grow without colliding with Stranded-style users of the globals.

## Acceptance criteria

- [ ] Goldens in the `weather` demo's yard on both tiers: dry, wet, wet with puddles in rain,
      snowed, and dust storm.
- [ ] In rain, the paved yard's mean luminance falls by at least 25% and its specular rises. The
      floor under the house's roof, inside the door, is within 1% of dry (region luminance).
- [ ] Puddles appear only on the road and paved terrain layers (`puddles: 1`), not on grass, and
      only on faces with `n.y > 0.95`. Their area grows monotonically with wetness.
- [ ] Ripples animate while it rains and are static once `rain` is 0: pixel difference over 30
      frames is 0 in puddles at `rain` 0.
- [ ] Snow covers roofs and the ground and leaves walls bare (normal-binned coverage). With
      `snowDisplacement` 0.05, shadow edges move with the displaced surface (depth prepass and
      shadow pass agree).
- [ ] A custom material type calling `weather::apply(…, PROFILE_PROP)` renders within 0.5% mean
      difference of the standard material with `weather: 'prop'` and the same inputs.
- [ ] A project channel read through `weather::channel(weather::channel_id("demo/ash"))` tints a
      custom material in the demo (golden). An unknown channel name fails compilation with
      `weather/unknown-channel`.
- [ ] Without the weather plugin, and with it but a material set to `none`,
      `scripts/wgsl-identity.mjs` passes and existing goldens match.
- [ ] With every channel at 0, the frame matches the no-weather frame bit-for-bit.
- [ ] A fullscreen wet ground at 1440p adds at most `gpu:surface-weather` over dry (proposed:
      0.15 ms, a few ALU and two texture reads per pixel), measured as a delta of the forward pass.
- [ ] 0097's lake ripples under rain and is still without it (golden pair).

## As built (visual pass)

- **Every standard surface gets weather; there's no per-material field yet.** The forward fragment
  passes its surface through `surface_weather` when the weather plugin sets `SkyOcclusion.surface`
  (one variant with cloud shadows, so no new pipeline keys). Puddles form on flat, non-metal
  surfaces. The `weather` profile field, terrain layers, foliage and the deferred G-buffer pass are
  still to come.
- **Data lives in shard::shader_data** (68 slots: state, and 16 mask brushes), not globals, which
  wind and the sky nearly fill.
- **Covered surfaces come from WeatherMaskBrush boxes only**, as in 0133's visual pass.

## Open questions

- None blocking. Deferred: per-entity wetness from `WeatherExposure`, snow and dust trails, glass
  drips and window rain, and seasonal foliage tint as a built-in profile.
