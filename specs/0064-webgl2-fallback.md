# 0064 — WebGL2 fallback and the baseline tier

- **Status:** implemented
- **Packages:** `@aethervtt/shard-gpu`, `@aethervtt/shard-gpu-webgl2` (new), `@aethervtt/shard-shader`, `@aethervtt/shard-render`,
  `@aethervtt/shard-sprite`, `@aethervtt/shard-text`, `@aethervtt/shard-ui`, `@aethervtt/shard-particles`, `@aethervtt/shard-dice`,
  `@aethervtt/shard-project`, `@aethervtt/shard-verify`, `apps/cli`, `apps/playground`
- **Depends on:** 0005, 0006, 0020, 0022, 0052, 0056, 0061, 0062

## Context

Shard is WebGPU-first, and on WebGPU it should stay exactly as it is. But a browser app such as
Aether loses every user whose browser or device can't give it a WebGPU adapter, and asking the host
to keep a second renderer for them defeats the point of an engine. Who those users are changes as
browsers ship WebGPU (Chrome, for one, has begun rolling it out on Linux). So this spec doesn't
work from a list: it works from what `probeGraphics` finds on the device.

Shard binds to WebGPU in ways WebGL2 can't express:

- **Storage buffers in the core draw path.** The forward shader reads instances, the visible list,
  lights, clusters, shadow data and skinning data from `var<storage>`.
- **Compute:** 27 entry points, for clustering, culling, IBL prefiltering, atmosphere LUTs, the
  exposure histogram, particles, terrain and noise.
- **Texture views:** 96 `createView` calls, including format reinterpretation (linear and sRGB
  views of one texture), single-mip views, single-layer views, and `2d-array` views of plain 2D
  textures. WebGL2 has no general equivalent of a view.

This is a second GPU backend behind a shared engine API, and it's substantial. naga translates
shaders, but device behavior (views, binding, render passes, readback) is the shim's to supply. It
is **not a prerequisite for moving Aether to Shard**. It's staged so each step proves something on
its own, and a WebGPU replacement can ship before any of it (see Staging).

## Goals

- `backend: 'auto'` (the default): WebGPU when the device offers it, WebGL2 otherwise, and an
  honest `none` with a reason. Probing classifies what the device can actually do.
- **The baseline tier:** a deliberately chosen subset that WebGL2 can run: no storage buffers in
  vertex or fragment shaders, no compute, and a fixed set of texture view kinds. The subset is
  Shard's choice, not a description of any one API.
- `@aethervtt/shard-gpu-webgl2`: the WebGPU subset Shard uses, implemented over WebGL2, including a concrete
  mapping for every texture view kind the engine creates.
- WGSL stays the only shader language. naga (WASM) translates it to GLSL ES 3.0 through a cache
  keyed by everything its output depends on, with a latency budget for misses.
- Zero cost to WebGPU users: the same shaders, features, limits and downloads as before.

## Non-goals

- WebGL1, or any browser without WebGL2.
- Pixel identity between backends. Each gets its own captures.
- WebGPU-only features on baseline: planet terrain generation, GPU scatter, volumetric clouds and
  GPU noise. They report `render/feature-unsupported` on baseline; they aren't emulated.
- An intermediate tier for WebGPU compatibility-mode devices (which do have compute). See Open
  questions.
- A general-purpose WebGPU polyfill. The shim covers what Shard uses.

## Design

### Probing and tiers

`probeWebGpu()` (0061) grew into `probeGraphics()`, which classifies the device it actually gets,
not the one it asked for. Requesting `featureLevel: 'compatibility'` may return a core adapter, and
a core adapter may still have low limits.

```ts
interface GraphicsSupport {
  backend: 'webgpu' | 'webgl2' | 'none'
  tier: 'full' | 'baseline' | 'none'
  capabilities: {
    core: boolean                               // WebGPU 'core-features-and-limits'
    compute: boolean
    storageBuffersPerStage: { vertex: number; fragment: number; compute: number }
    arbitraryTextureViews: boolean              // any format/dimension view of any texture
    maxTextureDimension2D: number; maxColorAttachments: number; maxUniformBufferBindingSize: number
    hdrSampleCount: 1 | 4                       // samples an rgba16float target takes
  }
  reasons: { backend: string; code: string; message: string }[]   // why a better option was skipped
}
renderPlugin({ canvas, backend: 'auto' })   // 'webgpu' | 'webgl2' insist on one; tier: 'baseline' forces it on WebGPU
createGpuContext({ backend, tier, webgl2: { shaders, persist, profile, checkErrors } })
```

`'auto'` asks WebGPU exactly as Shard always has (a core adapter, then a compatibility-mode one), and
only when that fails imports the shim: `import('@aethervtt/shard-gpu-webgl2')`, so a WebGPU session
never fetches it. A device made with a canvas lives on that canvas's WebGL2 context. When every
backend fails, the error and `probeGraphics` list each one's reason (`no-webgpu`, `no-adapter`,
`no-webgl2`, `no-float-render-targets`, …).

The tier comes from the capabilities, not from the backend: `full` needs a core WebGPU device that
meets the full tier's limits (storage in the vertex and fragment stages, arbitrary views, compute).
Anything else that can run the baseline subset runs `baseline`. That covers WebGL2, and a WebGPU
compatibility-mode device too, until an intermediate tier exists. `RenderHealth` (0061) and
`render.describe` report the backend, the tier, the capabilities and the reasons. On WebGL2,
`webglcontextlost` maps to device loss and follows the existing recovery: the new device waits for
the browser to restore the canvas's context.

### `@aethervtt/shard-gpu-webgl2`

It implements the WebGPU interfaces Shard calls over one `WebGL2RenderingContext`, following wgpu's
GL backend where they meet:

| WebGPU | WebGL2 |
|---|---|
| Buffers (vertex, index, uniform) | GL buffers. Index buffers keep a CPU copy: a `uint16` list holding 65535 draws from a `uint32` copy, since WebGL2 always restarts strips there. Uniform buffers round up to 16 bytes |
| Bind groups and layouts | Uniform block binding points and texture units, from naga's binding map. A block read by both stages shares one point; a (texture, sampler) pair shares one unit. A block is bound with at least its std140 size, which rounds a WGSL struct up to 16 bytes |
| Render pipelines | Linked programs plus cached blend, depth, stencil and cull state. The vertex stage flips y, so framebuffer memory, `@builtin(position)`, viewports and uploads match WebGPU, and front faces flip with it. Per-target blending uses `OES_draw_buffers_indexed` where targets differ |
| Draws | Direct draws only. `firstInstance` and `baseVertex` move the attribute pointers; the shader gets its instance index from naga's `naga_vs_first_instance`. A nonzero `baseVertex` with a shader that reads `vertex_index` is refused (only terrain does that, and it's unsupported) |
| Render passes | Framebuffers, cached by attachment. `loadOp: 'clear'` opens the write masks and drops the scissor first; `storeOp: 'discard'` invalidates; MSAA attachments are renderbuffers, resolved with `blitFramebuffer` |
| Command encoders | Recorded into a pooled typed-array stream, then replayed at `queue.submit`. Recording and replay allocate nothing once warm |
| Copies and readback | `copyBufferSubData` and `blitFramebuffer`; `copyTextureToBuffer` through `readPixels` into a pixel buffer and `fenceSync`, repacked into WebGPU's bytes when the readable format differs (half floats, 11/11/10, single-channel and integer formats); depth by drawing it into an `R32F` target |
| Canvases | The device's own canvas: a flipping blit into its default framebuffer, alpha forced to 1 when opaque. Other canvases (0052's shared device): the device's canvas is blitted, then drawn onto theirs with `drawImage` |
| Errors, device loss | Error scopes and `uncapturederror` as in WebGPU; GL errors checked after every submit in dev builds; context loss is device loss |
| Texture views | See below |

A call outside the subset (a compute pass, a storage binding, an indirect draw, a reinterpreting
view) throws `gpu-webgl2/unsupported`, naming the call and the pipeline, pass or texture.
`EXT_color_buffer_float` is required for HDR targets; without it the probe says `none` with that
reason. With `EXT_clip_control`, clip-space depth stays [0, 1] as WebGPU has it and only y is
flipped. Without it, naga maps z to GL's [-1, 1]: the same depth values, with less precision far
away, and no finite far plane, since the engine's projections stay as they are. The clip mode is
part of every translation's key. A `profile: 'minimum'` option holds a device to WebGL2's floor
(no clip control, 16 texture units, 2048 texels, 4 draw buffers) for tests.

**ANGLE on Direct3D 11** (Chrome and Edge on Windows) compiles GLSL to HLSL with FXC, which shaped
two rules. ANGLE copies an array of structs out of a uniform block whole, into a static array, and
FXC took minutes to compile a forward shader that indexed a 128-light copy. So on baseline a
`@data(uniform)` array of structs (or matrices) becomes `array<vec4<u32>, N>`, read field by field
by a generated loader, the same bytes either way. And heavy shaders still take FXC seconds the first
time (the noise planet's material, about 4 s a variant); Chrome caches the result on disk.

### Texture views

A GL texture has one target (2D, 2D array, cube, 3D) and one internal format for its lifetime. So
the baseline tier fixes each texture's **binding dimension at creation**, as WebGPU compatibility
mode requires with `textureBindingViewDimension`. Every view kind the engine uses maps as follows:

| Use in Shard | Where | Baseline mapping | Engine change |
|---|---|---|---|
| Linear and sRGB views of one texture (material slots: base color is sRGB, data maps are linear) | `gpu-assets.ts` | One format per texture, chosen by the engine's asset layer on both baseline backends (see Format twins). The shim never reinterprets a format | `gpu-assets` stops creating reinterpreting views on baseline |
| Single-mip views sampled while another mip is rendered (bloom chain, IBL prefilter, the environment's mips) | `post-nodes.ts`, the IBL passes | Rendering to mip *k* is `framebufferTexture2D` at level *k*. Sampling a view sets `TEXTURE_BASE_LEVEL` and `TEXTURE_MAX_LEVEL` to its mips at bind time, so sampling level *k − 1* while writing *k* isn't a feedback loop | none |
| Single-layer `2d` views of array textures, as render attachments (shadow cascades, spot and point shadow layers, atmosphere slices) | `forward.ts`, `shadows.ts`, `atmosphere-nodes.ts` | `framebufferTextureLayer` | none |
| Slices of 3D textures as attachments (the atmosphere's froxels) | `baseline/atmosphere.ts` | `framebufferTextureLayer` at the pass's `depthSlice` | the froxels render a slice a pass |
| Single-layer views *sampled* as `2d` | none | Not supported: a view binds only as its texture's one binding dimension. Shaders sample the array with a layer index | none: the shim and compatibility mode refuse the binding, naming it |
| `2d-array` views of plain 2D textures (texture-array material bindings) | `gpu-assets.ts`, `atmosphere-nodes.ts` | Textures that may be bound as arrays are created as 1-layer `TEXTURE_2D_ARRAY` on baseline, and their `2d` binding is a **dimension twin** only if something binds them as `2d` | `gpu-assets` passes the binding dimension at creation |
| `cube` views of 6-layer textures (environment, IBL) | `environment.ts` | Created as `TEXTURE_CUBE_MAP`; face attachments with `framebufferTexture2D` and the face target. The source cube is read as a cube, never as a `2d-array` | the environment passes `cube` as the binding dimension at creation |
| Multisampled depth read by later passes (fog, SSAO, outlines, deferred) | `forward.ts` | GLSL ES 3.00 can't sample a multisampled texture. On baseline, readers take `depth` from a single-sample depth prepass, added only when something reads it and MSAA is on | the forward plugin's depth prepass node |
| The read-only depth attachment sampled in its own pass (particles' soft fade) | `particles` | A feedback loop to WebGL: the shim samples a copy of it, made once per pass | none |

Twins are allowed only for sampled assets. A texture the engine renders into must have one binding
dimension and format, since a twin would go stale. A view in another format, or `viewFormats` on
a texture, throws `gpu-webgl2/unsupported`, naming the texture.

### Format twins (both baseline backends)

Reinterpreting one texture as both `rgba8unorm` and `rgba8unorm-srgb` needs WebGPU's
`core-features-and-limits`. A compatibility-mode device can't do it any more than WebGL2 can. So
format choice belongs to the engine's asset layer (`gpu-assets`), and it applies at the baseline
tier on every backend:

- **One format, from the import usage.** The texture importer already records each texture's usage:
  `color` (sRGB albedo), `data` (linear masks such as ORM) or `normal`. On baseline, a `color`
  texture is created in the sRGB format and everything else in the linear one, with no
  `viewFormats` and no reinterpreting view. The full tier keeps today's one texture with two views.
- **A twin only on a mismatch,** when a texture is bound to a slot of the other color space (a
  `data` map used as base color, say). The asset layer creates a second texture in the other
  format and counts it in `gpu.stats`. In dev builds it logs `render/texture-color-space-mismatch`
  with the texture and the slot, since fixing the texture's usage in its `.meta` removes the twin.
- **The twin's bytes.** Imported textures drop their CPU bytes after upload, and the twin doesn't
  keep them. It reloads the texture's artifact from the asset cache, the path device-loss recovery
  already uses, and uploads it in the twin's format. Textures with `keepCpu` twin from their bytes
  at once.
- **Requested early, shown only when right.** The twin is requested during material preparation,
  when a material's slots are resolved against their textures, not at the first draw that needs
  it. Until it's ready, that slot doesn't use the primary texture in the wrong color space. It uses
  the slot's loading fallback instead: the default texture a slot shows while its texture is still
  loading (`defaultTextures`), so the object appears in its final colors late rather than in wrong
  colors early. This is the same rule as a shader cache miss. A host can choose
  `deferUntilReady: true` on the material to skip its draws until the twin is ready. The wait is
  measured (`render.describe` → `twins`, with each one's wait), but it's I/O, so no frame count is
  promised.
- **Generated textures** (`gpuOnly`, storage-written) already have no sRGB view. On baseline they're
  created in the one format their writer and readers use.

### Shaders

WGSL modules (0006) compile as today. On WebGL2, each pipeline stage goes through naga's GLSL ES
3.0 backend (`crates/shard-naga`, built to `packages/gpu-webgl2/wasm/shard_naga.wasm`), which also
returns the binding map the shim uses.

**Cache key.** A translation is keyed by a hash of everything its output depends on:

- the naga version and the shim version;
- the stage and the entry point;
- the preprocessed WGSL, after imports, defines, material hooks and the baseline rewrite;
- the clip mode (`EXT_clip_control` or not), the one extension naga's output depends on.

The bind group and vertex layouts aren't in it: naga's GLSL doesn't depend on them, and a layout
that changes what a shader reads changes its WGSL, so its key.

**Baking.** `shard shaders bake` builds the WebGL2 cache (`.shard/shaders/webgl2.json`), which the
app ships as a lazy asset: `createGpuContext({ webgl2: { shaders } })` takes its URL or the set
itself, and `shard dev` passes the project's. WebGPU needs no baking and never fetches it. The bake
runs the project headless at the baseline tier, as most WebGL2 devices run it (4× HDR, so the depth
prepass too), records every pipeline stage the run makes, and translates each for devices with and
without clip control. It takes two sources:

- the project's scenes, run headless;
- a variant manifest, `shaders.variants.json`, for variants no scene shows: `{ "variants": [
  { "<source>": … } ] }`, each entry run by the source a plugin registered with
  `addShaderVariantSource`. `material` shows a material asset with parameter overrides; `dice` shows
  skins × die kinds, opaque and blended (the looks that make different pipelines).

Aether lists its skins and material variants in the manifest, so the cache covers skins no fixture
scene happens to show. A host can also record a set from a live session: on WebGL2,
`gpu.exportShaderCache()` returns every translation the session used, in the same format.

**Misses.** A variant not in the cache loads naga's WASM lazily, translates, and stores the result
in IndexedDB. Pipeline creation is already asynchronous, so a missed variant's draws are skipped
until it's ready. Its object appears late rather than wrong. Misses are visible:
`render.describe → shaderCache` lists them with their times (and naga's load time), and an `info`
issue, `render/shader-cache-miss`, counts them in `RenderHealth` without changing its state.
Budgets:

- loading naga the first time: under 300 ms on the mid-range reference device;
- translating one variant after that: under 20 ms p95.

### The baseline tier

Shaders read per-draw and per-scene arrays through `@data` declarations (0064's rewrite):

```wgsl
@data @group(0) @binding(3) var<storage, read> instances: array<Instance>;   // a data texture on baseline
@data(uniform, 128) @group(0) @binding(1) var<storage, read> lights: array<Light>;   // a uniform array
```

On the full tier these are today's storage reads, and the linked WGSL is byte for byte today's: the
marks are stripped before linking. On baseline a rewrite after linking turns each into a
`texture_2d<u32>` (`rgba32uint`, 1024 texels wide) read through a generated loader that pulls each
field out at its storage-layout offset, or into a uniform block, so the engine uploads the same
bytes either way through `DataStore` and the existing dirty-slot uploads (0022). Material hooks
(0020) use the same declarations. Algorithms that genuinely differ use `@if(BASELINE)`.

| Feature | Full tier | Baseline tier |
|---|---|---|
| Instances, visible list | Storage + GPU culling, indirect draws | Data texture + CPU culling (exists), direct draws |
| Light clusters | Compute | Built on the CPU into a 128-bit mask per cluster over a per-view uniform array of lights; `LightingSettings.baselineMaxLights` (default and most 128) keeps the nearest, and `render/light-budget` reports the rest |
| Shadows | Render passes | The same |
| Skinning, morph targets | Storage | Data textures |
| Sprites, tilemaps, text, UI, gizmos | Storage in sprite, text and UI shaders | Data textures |
| 2D lighting (0039) | Compute binning, storage | Binned on the CPU (`binLightsCpu`, shadow rows cached by light), data textures |
| Particles | GPU backend, GPU sort | CPU backend (exists), CPU depth sort, data textures. Modules only the GPU runs (depth collision) report `render/feature-unsupported` |
| IBL prefilter, BRDF LUT | Compute | Fragment passes into the same textures, one face of one mip each: the image kernels in fragment form, mips and SH9 reading the cube as a cube |
| Atmosphere LUTs, sky-view, froxels, bake | Compute | Fragment passes: the image kernels in fragment form; froxels a slice a pass, each marching its column to that slice |
| Auto exposure | Histogram compute | A 64×36 meter image read back and binned into the same histogram on the CPU, so both tiers meter alike |
| MSAA | 4× | 4× where the device multisamples `rgba16float` (`hdrSampleCount`), else 1×; `render.describe` says which and why |
| Depth read by later passes | The MSAA depth, resolved | A single-sample depth prepass, only when something reads it |
| Bloom, DoF, TAA, FXAA, SSAO, fog, grading | Fragment passes | The same |
| Outlines, fog masks, grid, lens fields (0057, 0058, 0063) | Fragment passes | The same |
| Terrain generation, GPU scatter, clouds, GPU noise | Compute | Unsupported: `render/feature-unsupported`, naming the feature and the tier |

An **image kernel** is a compute entry point that stores to one storage texture at its invocation
id. It runs as a fragment pass on baseline with the same WGSL body: `fragmentKernel`
(`@aethervtt/shard-shader/fragment-kernel`, loaded only on baseline) binds a `vec4u` target uniform
(size and layer) where the storage texture was, reads `textureDimensions` from it, and turns each
store into the fragment's return and an early return into `discard`. Kernels that aren't image
kernels (reductions, several outputs) get a fragment form written for baseline.

Limits are per tier: a baseline limit never applies on the full tier. Every render feature declares
a baseline strategy or `baseline: 'unsupported'`, and a registry test enforces it. A feature that
can't run reports `render/feature-unsupported` when a scene uses it, not when its plugin is
installed. `shard validate --tier baseline` (and every `shard validate` of a project whose manifest
sets `"graphics": { "baseline": "required" }`) draws each of the project's scenes headless on a
compatibility-mode device, so every variant they use links with `BASELINE` and passes the rewrite
and the device's rules, and translates every entry point with naga. It fails on raw `var<storage>`
in vertex or fragment code, on anything naga can't translate, and on features the tier can't run,
naming the module and line, or the scene. Sampled single-layer views fail where they're bound
(compatibility mode rejects them in the run), naming the bind group. Plain `shard validate` stays
GPU-free and fast.

### Staging

Each stage is useful by itself, and none blocks a WebGPU replacement of Aether's renderer:

1. **Baseline on WebGPU.** The data declarations, the CPU strategies, format twins and the view
   rules, run on a WebGPU device **that enforces compatibility validation**: a Dawn adapter
   requested with `featureLevel: 'compatibility'` and without `core-features-and-limits`. Forcing
   `tier: 'baseline'` on a core device isn't enough, because a core device accepts views that a
   compatibility device rejects. A canary test proves the device enforces them. This proves the
   restricted render path with tools that already work (Dawn goldens, the benchmarks), and it's
   where most of the engine work is.
2. **The shim.** `@aethervtt/shard-gpu-webgl2`, tested headless against a stateful fake
   `WebGL2RenderingContext` (bytes through every copy and readback, every draw's bound state), and
   in Playwright's Chromium: every playground demo on WebGL2, and `auto` with `navigator.gpu`
   removed.
3. **Aether's full fixture on WebGL2.** The parity fixture (0057), fog (0058), tilemaps (0059), the
   dice (0054) with every manifest variant baked, and 0062's plans run with `backend: 'webgl2'`.

The playground's **Backend** dropdown (auto, webgpu, webgl2; `?backend=`) switches every page,
and its HUD shows the backend, the tier, auto's reasons and the health; features a page can't run
there say so over the canvas. `?tier=baseline` previews the baseline tier on WebGPU, and
`?gl=minimum` holds WebGL2 to its floor.

### Documents this changes on acceptance

- `VISION.md`'s stack table ("GPU API: WebGPU only. No WebGL2 fallback.") becomes "WebGPU first;
  WebGL2 fallback at the baseline tier (0064)".
- 0061's non-goal "WebGL fallback" is removed, and its `probeWebGpu` references point to
  `probeGraphics`.

### Agent surface

- `render.describe` → `backend`, `tier`, `capabilities`, the tier's limits, `shaderCache` (hits,
  misses with their times, naga's load time), `twins`, and the reasons better options were skipped.
- `shard validate` reports baseline shader and feature errors with the module and line.
- `shard shaders bake --json` lists the scenes run, the manifest's variants, the stages baked and
  their translations, and any that couldn't be shown or translated.

## Decisions

- **A shim under one API, not a second renderer.** Every engine package and every host stays on
  one code path. What the shim can't do, the baseline tier designs around.
- **Baseline is a chosen subset, classified from capabilities.** WebGL2 and WebGPU compatibility
  mode have different limits, so neither defines the other. Shard picks one subset it can promise
  everywhere, and the probe decides from the device, not from the request.
- **Backend selection in `@aethervtt/shard-gpu`, the shim loaded lazily.** The shim depends only on
  core, so there's no package cycle, and a WebGPU session's request path and downloads are today's.
- **Binding dimension fixed at creation; twins only for sampled assets.** That's the one rule that
  maps every view the engine uses onto GL. It's also the rule WebGPU compatibility mode imposes.
- **Format choice in the asset layer, not the shim.** Both baseline backends lack format
  reinterpretation, so a shim-only fix would leave compatibility-mode WebGPU broken. The import
  usage picks the format, so twins stay rare, and reloading the artifact keeps them from holding
  CPU memory.
- **Storage reads retargeted after linking.** `@data` marks are stripped before linking, so the full
  tier links today's source; the baseline rewrite matches declarations by group and binding, which
  survive WESL's renaming.
- **GL conventions follow wgpu's GL backend:** a y flip in the vertex stage, inverted front faces,
  `naga_vs_first_instance`, uint16 restart promotion, clears that open the masks, a sampled copy of
  a read-only depth attachment.
- **MSAA stays 4× on baseline** where the device can, so both tiers look alike; readers of depth
  get a single-sample prepass, since GLSL ES 3.00 can't sample a multisampled texture.
- **The cache key covers everything the output depends on; the manifest covers what scenes don't
  show.** Otherwise a stale or missing variant shows up only in a user's browser.
- **Health issues by severity.** Fallbacks, failed pipelines and unsupported features degrade
  `RenderHealth`; shader cache misses are `info` and don't.
- **Staged, and off the critical path.** The fallback shouldn't delay a replacement that works on
  WebGPU.

## Acceptance criteria

- [x] `probeGraphics` classifies a Dawn core adapter as `full`, the same adapter forced to baseline
      as `baseline`, Chromium with WebGPU disabled as `webgl2`/`baseline`, and a simulated missing
      `EXT_color_buffer_float` as `none` with that reason. It never throws, and a compatibility
      request that returns a core adapter classifies as `full`. (`gpu/src/probe.test.ts`,
      `gpu/src/backend.test.ts`; `auto` without `navigator.gpu` in `playground/src/demos.test.ts`.)
- [x] With WebGPU available, a session loads no `@aethervtt/shard-gpu-webgl2`, naga, shader cache or
      baseline module (network log, `playground/src/webgl2.test.ts`; `pnpm size --check` for built
      bundles). The full-tier WGSL of every variant the suite links is byte-identical before and
      after (`scripts/wgsl-identity.mjs`), full-tier goldens are unchanged, and `pnpm bench`
      passes the same budgets as before 0064, its printed timings within run-to-run noise.
- [x] Stage 1 runs on a Dawn compatibility adapter whose probe reports `core: false`. A canary
      test there creates an sRGB view of a linear texture and gets a validation error, proving the
      device enforces compatibility rules.
- [x] Stage 1: the parity fixture, fog and tilemaps render at `tier: 'baseline'` on that adapter,
      with approved goldens, no validation errors, and no compute pass or vertex or fragment
      storage binding in their graphs.
- [x] On baseline, on both backends: a `color` texture is created sRGB and a `data` texture linear,
      with no reinterpreting view. Binding a `data` texture to a base-color slot **after its CPU
      bytes were released** requests a twin from the reloaded artifact during material preparation.
      Until it's ready, the slot shows the loading fallback (or, with `deferUntilReady`, the draw is
      skipped), never the primary texture in the wrong color space. Once it's ready, the object
      renders correctly. The wait is recorded in `render.describe`, the dev build logs
      `render/texture-color-space-mismatch`, and the CPU bytes aren't kept afterwards
      (`texture.levels` stays undefined). (`render/src/baseline-twins.test.ts`.)
- [x] Stage 2, one test per view row: a mismatched texture renders through a counted twin; bloom
      samples mip *k − 1* while writing *k*; shadow cascades render into array layers; cube faces,
      array layers and 3D slices are attachments; IBL renders into and samples a cube map. A view of
      a texture in another format fails with `gpu-webgl2/unsupported`. (`gpu-webgl2/src/shim.test.ts`;
      the post, scene, lights and IBL demos on WebGL2 with no GL errors.)
- [x] Stage 3: the parity fixture, fog, tilemaps and a 32-die roll render on WebGL2 in Playwright's
      Chromium, their captures repeat to the byte, and the fixture's plans pass there
      (`playground/src/verify.test.ts`).
- [x] Plans take a `backend` (`?backend=` on the page; a browser without it skips the plan), so a
      host approves its WebGL2 captures in a set of their own (`shard compare --approved <dir>`).
      Aether approves its replacement plan's, as it does for WebGPU (0062); the playground keeps
      no approved set for either backend.
- [x] Changing the naga version, a define, the entry point or the clip mode changes the cache key;
      changing none of them keeps it (`gpu-webgl2/src/cache.test.ts`).
- [x] After baking a project and its variant manifest, a WebGL2 session loads naga 0 times
      (`cli/src/shaders.test.ts`); the `dice` source shows every skin as each kind, opaque and
      blended (`dice/src/table.test.ts`). A variant left out loads naga once, within the stated
      budgets (`playground/src/webgl2.test.ts`), shows as a counted miss, and loads naga 0 times in
      the next session (IndexedDB, `gpu-webgl2/src/cache.test.ts`).
- [x] A token move on WebGL2 uploads one instance record to the instance data texture (0055
      accounting, `structure/src/structure.test.ts`). `pick` returns the same entity, at the same
      distance, as on WebGPU for 100 random pixels of the tabletop, at a pinned render scale
      (`playground/src/webgl2.test.ts`).
- [x] `shard validate` fails a material hook with a raw `var<storage>` read in a fragment shader,
      naming the module and line (the rewrite's error, `shader/src/baseline/rewrite.test.ts`, which
      validate reports from the link). A sampled single-layer view fails where it's bound, since
      that's where the view is chosen: compatibility mode rejects it in validate's run, and the
      shim throws `gpu-webgl2/unsupported` naming the texture (`gpu-webgl2/src/shim.test.ts`). A
      `Planet` scene fails on baseline with `render/feature-unsupported` (`cli/src/cli.test.ts`).
- [x] A WebGL2 context loss recovers like a device loss: `RenderHealth` goes `ok → lost → ok`
      (`playground/src/webgl2.test.ts`).
- [x] Every registered render feature declares a baseline strategy or `baseline: 'unsupported'`
      (registry test).
- [x] Every playground demo runs on both backends with no GPU or page errors; on WebGL2 its health
      is `ok` or names exactly what the tier can't run (`playground/src/demos.test.ts`). Each push
      runs a curated set, a demo per path the baseline tier takes; the nightly sweep runs every
      demo (`.github/workflows/browser.yml`, `SHARD_DEMOS=all`).

## Open questions

- Should WebGPU compatibility-mode devices get an intermediate tier that keeps compute (GPU
  clustering, GPU particles) but follows compat's view and storage limits? Proposed: not now.
  Classify them as baseline, and add the tier if the probe shows enough such devices in real
  sessions.
- Should the baked cache be per project or per engine release? Proposed: per project, since
  material hooks, defines and manifests are project-specific.
- ANGLE copies every struct-typed uniform block out whole on Direct3D (the view and shadow blocks
  too), which lengthens FXC's compiles. Reading those through word loaders as well would shorten
  them, at the cost of a wider rewrite.
