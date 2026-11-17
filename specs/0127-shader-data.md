# 0127 — Shader data: room for per-frame arrays

- **Status:** draft (built 2026-11-16). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-render`
- **Depends on:** 0020, 0064, 0096

## Context

A project shader that needs arrays of data every frame has had two places to put them, and both
are too small. `shard::globals` (`ShaderGlobals`) holds 128 vec4 slots shared by every plugin, and
wind (0096) takes 99 of them (`WIND_SLOTS = 3 + 16 × 6`) whenever scatter, nature or water is on.
Material type fields (0020) can't be arrays: `wgslLayout` packs scalars, vectors, matrices and
structs only, and a material's uniform uploads when its asset changes, not each frame.

Stranded's sea (its specs 0002–0004) reserves 82 globals slots: 8 Gerstner waves (2 each), 8 water
masks (3 each), 8 hull contacts (2 each), 2 wakes of 12 points, the clock and the sun. It fits only
because no wind plugin is on. Islands with foliage need nature or scatter, and then `reserve` throws
`render/globals-full`.

## Goals

- A project material reads a few hundred vec4s the game rewrites every frame, in every pass it
  draws in (forward, the prepasses, the G-buffer, shadows), on both tiers.
- Wind and every other `ShaderGlobals` user keep working unchanged, and full-tier WGSL that doesn't
  read the new block stays byte-identical.
- Moving Stranded's sea onto it is a rename.

## Non-goals

- Array fields on material types. Per-material data still goes in fields; arrays there can come
  later if a material needs per-asset arrays.
- Per-entity data: that's `render/InstanceData` (two floats) or a `@data` array a plugin owns.
- Compute access. Particles and other compute passes bind their own data.

## Design

`shard::shader_data` is one uniform block a game owns: 1024 vec4 slots (16 KiB), reserved by name
and rewritten by the game's systems, uploaded by the forward renderer each frame.

```wgsl
// shard::shader_data
@group(0) @binding(18) var<uniform> shader_data: array<vec4f, 1024>;
```

- **CPU side.** `render/ShaderData` is a `ShaderDataBlock`: `values` (a `Float32Array` of 4096),
  `reserve(name, count)` returning the first slot (the same name and count get the same slots again;
  past 1024 it throws `render/shader-data-full` saying how many are left), and `length`, the floats
  in use. It mirrors `ShaderGlobalsData` without the header: slot `s` is `values[s * 4]`.
- **Upload.** `render/forward-queue`, next to the globals upload, writes `values[0, length)` into a
  16 KiB uniform buffer when anything is reserved: one `writeBuffer`, no allocation. A game writes
  `values` in `Update` or `PostUpdate`; what it wrote by the time the frame renders is what draws.
- **Binding.** Binding 18 of group 0, visible to the vertex and fragment stages, in both group-0
  layouts materials draw with: the camera view's (`forward/view`, and its interior variant), which
  the forward, ground, transparent, G-buffer, prepass, depth-prepass, outline and pick pipelines
  share, and the shadow view's (`shadows/views`), which every shadow caster uses. It's always in
  the layout and always bound, so no pipeline variant depends on it.
- **Shaders.** `import shard::shader_data::shader_data;`, then `shader_data[slot + i]`. A shader
  learns its slot as Stranded's sea and wind do: the module that reads it is generated with the
  slot as a constant, after `reserve`.
- **Baseline.** Nothing to rewrite: a plain uniform array is valid WGSL on a compatibility device,
  and naga turns it into a GLSL uniform block holding `vec4 …[1024]`, which WebGL2 indexes in place.

### API sketch

```ts
import { ShaderData } from '@aethervtt/shard-render'

const sea = world.resource(ShaderData)
const slot = sea.reserve('stranded/sea', SEA_SLOTS) // once the renderer is up
registerShaders(library, { 'stranded::sea': seaModule(slot) })
// each frame
sea.values[slot * 4] = seaClock(world)
```

```wgsl
import shard::shader_data::shader_data;
const SEA_BLOCK: u32 = 0u; // generated
fn sea_time() -> f32 { return shader_data[SEA_BLOCK].x; }
```

Moving Stranded's sea: `ShaderGlobals` → `ShaderData`, `4 + slot * 4` → `slot * 4`,
`import shard::globals::globals` → `import shard::shader_data::shader_data`, and
`globals.data[` → `shader_data[`.

### Agent surface

The `write-a-material` skill (`shard docs`) says when to use the block and how to read it.
`render/shader-data-full` is in the error catalog with its hint. `render/ShaderData` is a resource
like `render/ShaderGlobals`.

## Decisions

- **A game-owned block, not array fields on material types.** The data is the game's, not a
  material's: Stranded's waves are read by the ocean and by whatever else the sea moves, and its
  water masks hide water under several hulls. Fields would copy the arrays into every material that
  needs them, and a material's uniform uploads on an asset change, through validation, not as a
  per-frame write.
- **A separate block, not a bigger `shard::globals`.** `Globals` is a struct, and ANGLE on Direct3D
  11 copies a struct-typed uniform block out whole in every shader that reads it (0064): a 16 KiB
  globals would be copied by every shader that reads `globals.time` (wind, dice, terrain), and
  lengthen FXC's compiles. Growing it would also change every full-tier variant that imports
  `shard::globals`. `shader_data` is a bare array, which naga declares as the block's only member
  and ANGLE indexes in place, and only shaders that import it change.
- **A uniform block, not storage or a `@data` array.** WebGL2 has no storage buffers, and a `@data`
  array becomes a data texture on baseline: a texture unit per stage, out of the 16 WebGL2's floor
  has and the 16 sampled textures a stage gets, which materials already compete for
  (`standardTextures: false`). A uniform array needs neither, and indexing one is fast where the
  slot is the same for a whole draw, as here.
- **1024 slots, on both tiers.** 16 KiB is the most a uniform binding holds at WebGL2's floor
  (`MAX_UNIFORM_BLOCK_SIZE`, which `profile: 'minimum'` holds to) and at a WebGPU compatibility
  device's default `maxUniformBufferBindingSize`. Core WebGPU allows 64 KiB, but one size keeps one
  shader for both tiers. It's ten times Stranded's sea, with the other three quarters of the block
  for spray, wakes and anything else.
- **Reserved by name, like `ShaderGlobals`.** Moving a block from globals is then a rename, and
  plugins and game code can share it without coordinating offsets. Only the reserved slots upload.
- **Group 0, binding 18, in the layout whether or not anything reads it.** Every material pass
  already binds group 0, so this adds no group and no pipeline variants; 16 and 17 are interior
  lighting's (0069). The cost is one uniform binding per stage in every material pipeline. On a
  baseline compatibility device that's the tightest limit: a lit fragment stage's group 0 has 8
  uniform buffers with interior lighting on (view, lights, directional lights, shadow data, SH,
  globals, interior, shader data), a standard extension's group 1 has 3, and a cutaway (0070) adds
  1: 12, exactly what WebGPU allows. The next uniform a material pass binds on baseline has to
  replace one (the four light blocks could share a buffer). WebGL2 counts only the blocks a program
  uses.
- **The 0127 test lives in `@aethervtt/shard-wind`.** The criterion needs the wind plugin on, and
  wind depends on render, not the other way round.

## Acceptance criteria

- [x] A material type that reads 256 vec4s a system writes each frame, rendered with the wind
  plugin on (wind's 99 globals slots reserved, `wind_at` read in the same shader), shows each
  frame's values: the mean of the 256 slots within 5 cd/m² (of 100–800), and a vertex offset read
  from the block moving the mesh in the forward pass, its depth in the prepass (SSAO on) and its
  shadow, from one frame to the next. Full tier and baseline tier (a WebGPU compatibility device).
  `wind/src/shader-data.test.ts`.
- [x] WebGL2 at its floor (`profile: 'minimum'`, the shim over a fake context, real naga): every
  program that reads the block declares `vec4 …[1024]`, and each frame's forward, prepass and four
  shadow draws bind a buffer holding that frame's 256 values. Same file.
- [x] Wind's own tests pass unchanged, and the full-tier WGSL of every variant render, wind,
  terrain, water, nature, scatter and dice link is byte-identical (`node scripts/wgsl-identity.mjs`).
- [x] Uploading all 1024 slots each frame adds under `render/shader-data-upload` (0.05 ms) to
  `render/forward-queue`. `render/src/shader-data.test.ts`.
- [x] `reserve` hands out named slots once and throws `render/shader-data-full` past 1024, saying
  how many are left. Same file.

## As built

- `render/shader-data-upload`, on an Apple M-series laptop (not a named machine) with other test
  runs on it, 2026-11-16: 0.098 ms of `render/forward-queue` with 1024 slots uploading against
  0.105 ms without, best of 200 frames each: the upload is inside the noise. The 0.05 ms budget is
  proposed, not measured on the named machines.
- The baseline depth prepass (`depth-prepass`, MSAA views only) shares the camera view's layout
  but isn't in the tests: neither Dawn's compatibility device here nor the fake context
  multisamples a float target, so both render at 1×. The post prepass, which binds the same
  layout, is.

## Open questions

- None.
