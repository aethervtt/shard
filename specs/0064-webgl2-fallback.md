# 0064 — WebGL2 fallback and the baseline tier

- **Status:** accepted
- **Packages:** `@shard/gpu`, `@shard/gpu-webgl2` (new), `@shard/shader`, `@shard/render`,
  `@shard/sprite`, `@shard/text`, `@shard/ui`, `@shard/particles`, `apps/cli`
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
- **Compute:** 29 entry points, for clustering, culling, IBL prefiltering, atmosphere LUTs, the
  exposure histogram, particles, terrain and noise.
- **Texture views:** 26 `createView` calls, including format reinterpretation (linear and sRGB
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
- `@shard/gpu-webgl2`: the WebGPU subset Shard uses, implemented over WebGL2, including a concrete
  mapping for every texture view kind the engine creates.
- WGSL stays the only shader language. naga (WASM) translates it to GLSL ES 3.0 through a cache
  keyed by everything its output depends on, with a latency budget for misses.
- Zero cost to WebGPU users: the same shaders, features, limits and downloads as before.

## Non-goals

- WebGL1, or any browser without WebGL2.
- Pixel identity between backends. Each gets its own approved captures.
- WebGPU-only features on baseline: planet terrain generation, GPU scatter, volumetric clouds and
  GPU noise. They fail validation on baseline; they aren't emulated.
- An intermediate tier for WebGPU compatibility-mode devices (which do have compute). See Open
  questions.
- A general-purpose WebGPU polyfill. The shim covers what Shard uses.

## Design

### Probing and tiers

`probeWebGpu()` (0061, implemented) grows into `probeGraphics()`, which classifies the adapter it
actually gets, not the one it asked for. Requesting `featureLevel: 'compatibility'` may return a
core adapter, and a core adapter may still have low limits.

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
  }
  reasons: { backend: string; code: string; message: string }[]   // why a better option was skipped
}
renderPlugin({ canvas, backend: 'auto' })   // 'webgpu' | 'webgl2' force one, for tests
```

The tier comes from the capabilities, not from the backend: `full` needs a core WebGPU device that
meets the full tier's limits (storage in the vertex and fragment stages, arbitrary views, compute).
Anything else that can run the baseline subset runs `baseline`. That covers WebGL2, and a WebGPU
compatibility-mode device too, until an intermediate tier exists. `RenderHealth` (0061) and
`render.describe` report the backend, the tier, the capabilities and the reasons. On WebGL2,
`webglcontextlost` maps to device loss and follows the existing recovery.

### `@shard/gpu-webgl2`

It implements the WebGPU interfaces Shard calls over one `WebGL2RenderingContext`:

| WebGPU | WebGL2 |
|---|---|
| Buffers (vertex, index, uniform) | GL buffers. Uniform buffers bind as uniform blocks; `writeBuffer` is `bufferSubData` |
| Bind groups and layouts | Uniform block binding points and texture units, from naga's binding map |
| Render pipelines | Linked programs plus cached blend, depth, stencil and cull state |
| Render passes | Framebuffers. `loadOp` and `storeOp` become clears and invalidates; MSAA resolves with `blitFramebuffer` |
| Command encoders | Recorded, then replayed at `queue.submit` |
| Copies and readback | `copyBufferSubData`, `blitFramebuffer`; `copyTextureToBuffer` through a pixel buffer and `fenceSync` (picking, screenshots) |
| Errors, device loss | GL errors checked once per submit in dev builds; context loss is device loss |
| Texture views | See below |

A call outside the subset (a compute pass, a storage binding, an indirect draw, an unmapped view)
throws `gpu-webgl2/unsupported`, naming the call and the pipeline or pass that made it.
`EXT_color_buffer_float` is required for HDR targets; without it the probe says `none` with that
reason. `EXT_clip_control` enables reversed-Z where present; without it, depth uses a finite far
plane, and far precision drops.

### Texture views

A GL texture has one target (2D, 2D array, cube, 3D) and one internal format for its lifetime. So
the baseline tier fixes each texture's **binding dimension at creation**, as WebGPU compatibility
mode requires with `textureBindingViewDimension`. Every view kind the engine uses maps as follows:

| Use in Shard today | Where | Baseline mapping | Engine change |
|---|---|---|---|
| Linear and sRGB views of one texture (material slots: base color is sRGB, data maps are linear) | `gpu-assets.ts:305`, `:361` | One format per texture, chosen by the engine's asset layer on both baseline backends (see Format twins). The shim never reinterprets a format | `gpu-assets` stops creating reinterpreting views on baseline |
| Single-mip views sampled while another mip is rendered (bloom chain, IBL prefilter, exposure mip chain) | `post-nodes.ts:757` and the IBL and exposure passes | Rendering to mip *k* is `framebufferTexture2D` at level *k*. Sampling a one-level view sets `TEXTURE_BASE_LEVEL` and `TEXTURE_MAX_LEVEL` on the texture at bind time, so sampling level *k − 1* while writing *k* isn't a feedback loop | none |
| Single-layer `2d` views of array textures, as render attachments (shadow cascades, spot and point shadow layers, atmosphere slices) | `forward.ts:917`, `:946`, `atmosphere-nodes.ts:508` | `framebufferTextureLayer` | none |
| Single-layer views *sampled* as `2d` | none today | Not supported. Shaders sample the array with a layer index | a baseline shader lint rule |
| `2d-array` views of plain 2D textures (texture-array material bindings) | `gpu-assets.ts:320`, `atmosphere-nodes.ts:81` | Textures that may be bound as arrays are created as 1-layer `TEXTURE_2D_ARRAY` on baseline, and their `2d` binding is a **dimension twin** only if something binds them as `2d` | `gpu-assets` passes the binding dimension at creation |
| `cube` views of 6-layer textures (environment, IBL) | `environment.ts:180`, `:181`, `:244` | Created as `TEXTURE_CUBE_MAP`; face attachments with `framebufferTexture2D` and the face target | the environment passes `cube` as the binding dimension at creation |

Twins are allowed only for sampled assets. A texture the engine renders into must have one binding
dimension and format, since a twin would go stale. Creating a twin of a render target throws
`gpu-webgl2/unsupported`, naming the texture.

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
- **The twin's bytes.** Imported textures drop their CPU bytes after upload (`gpu-assets.ts:337`),
  and the twin doesn't keep them. It reloads the texture's artifact from the asset cache, the path
  device-loss recovery already uses, and uploads it in the twin's format. Textures with `keepCpu`
  twin from their bytes at once.
- **Requested early, shown only when right.** The twin is requested during material preparation,
  when a material's slots are resolved against their textures, not at the first draw that needs
  it. Until it's ready, that slot doesn't use the primary texture in the wrong color space. It uses
  the slot's loading fallback instead: the default texture a slot shows while its texture is still
  loading (`defaultTextures`), so the object appears in its final colors late rather than in wrong colors early. This
  is the same rule as a shader cache miss. A host can choose `deferUntilReady: true` on the
  material to skip its draws until the twin is ready. The wait is measured (`render.describe` →
  pending twins, with each one's wait), but it's I/O, so no frame count is promised.
- **Generated textures** (`gpuOnly`, storage-written) already have no sRGB view. On baseline they're
  created in the one format their writer and readers use.

### Shaders

WGSL modules (0006) compile as today. On WebGL2, each pipeline stage goes through naga's GLSL ES
3.0 backend, which also returns the binding map the shim uses.

**Cache key.** A translation is keyed by a hash of everything its output depends on:

- the naga version and the shim version;
- the stage and the entry point;
- the preprocessed WGSL, after imports, defines and material hooks;
- the bind group layouts and vertex layout;
- the target (GLSL ES 3.00) and the enabled extensions.

**Baking.** `shard shaders bake` builds the WebGL2 cache (`.shard/shaders/webgl2.bin`), which the
app ships as a lazy asset. WebGPU needs no baking. The bake takes two sources:

- the project's scenes, run headless, recording every pipeline variant they create;
- a variant manifest, `shaders.variants.json`, for variants no scene shows: for example, every
  registered dice family × die kind × quality tier, or every material × define set a host can
  select at runtime.

Aether lists its skins and material variants in the manifest, so the cache covers skins no fixture
scene happens to show.

**Misses.** A variant not in the cache loads naga's WASM lazily, translates, and stores the result
in IndexedDB. Pipeline creation is already asynchronous, so a missed variant's draws are skipped
until it's ready. Its object appears late rather than wrong. Misses are visible:
`render.describe` counts them with their times, and each adds a `shader-cache-miss` issue to
`RenderHealth` in dev builds. Budgets:

- loading naga the first time: under 300 ms on the mid-range reference device;
- translating one variant after that: under 20 ms p95.

### The baseline tier

Shaders read per-draw and per-scene arrays through `shard::data` accessors:

```wgsl
let inst = shard::data::instance(instance_index);   // storage read on full; data texture on baseline
let light = shard::data::light(i);
let pose = shard::data::pose(joint);
```

On the full tier these are the same storage reads as today and inline to the same code. On baseline
the same records are written to `rgba32float` or `rgba32uint` data textures (fetched with
`textureLoad`), or to uniform blocks when small and fixed-size, using the existing dirty-slot
uploads (0022). Material hooks (0020) use the accessors too.

| Feature | Full tier | Baseline tier |
|---|---|---|
| Instances, visible list | Storage + GPU culling, indirect draws | Data texture + CPU culling (exists), direct draws |
| Light clusters | Compute | Built on the CPU, uploaded as a texture; `LightBudget.baselineMax` (default 128) |
| Shadows | Render passes | The same |
| Skinning, morph targets | Storage | Data textures |
| Sprites, tilemaps, text, UI | Storage in 6 sprite and 1 UI shader | Data textures |
| Particles | GPU backend | CPU backend (exists) |
| IBL prefilter, BRDF LUT | Compute | Fragment passes into the same textures |
| Atmosphere LUTs | Compute | Fragment passes |
| Auto exposure | Histogram compute | Mip-chain average |
| Bloom, DoF, TAA, FXAA, SSAO, fog, grading | Fragment passes | The same |
| Outlines, fog masks, grid, lens fields (0057, 0058, 0063) | Fragment passes | The same |
| Terrain generation, GPU scatter, clouds, GPU noise | Compute | Unsupported: `render/feature-unsupported`, naming the feature and the tier |

Limits are per tier: a baseline limit never applies on the full tier. From this spec on, every
render feature declares a baseline strategy or `baseline: 'unsupported'`, and a registry test
enforces it. `shard validate` translates every registered module, material and manifest variant
for baseline and fails on raw `var<storage>` in vertex or fragment code, on sampled single-layer
views, and on anything naga can't translate. Each failure names the module and line.

### Staging

Each stage is useful by itself, and none blocks a WebGPU replacement of Aether's renderer:

1. **Baseline on WebGPU.** The accessors, the CPU strategies, format twins and the view rules, run
   on a WebGPU device **that enforces compatibility validation**: a Dawn adapter requested with
   `featureLevel: 'compatibility'` and without `core-features-and-limits`. Forcing
   `tier: 'baseline'` on a core device isn't enough, because a core device accepts views that a
   compatibility device rejects. A canary test proves the device enforces them. This proves the
   restricted render path with tools that already work (Dawn goldens, the benchmarks), and it's
   where most of the engine work is.
2. **The shim, one small scene.** `@shard/gpu-webgl2` renders one lit, textured, shadowed scene
   with bloom and picking, covering every row of the view table. Tested in Playwright's Chromium
   with WebGPU disabled, where WebGL2 runs in software.
3. **Aether's full fixture on WebGL2.** The parity fixture (0057), fog (0058), tilemaps (0059), the
   dice (0054) with every manifest variant baked, and 0062's replacement plan run with
   `backend: 'webgl2'`, with its own approvals and budgets.

### Documents this changes on acceptance

- `VISION.md`'s stack table ("GPU API: WebGPU only. No WebGL2 fallback.") becomes "WebGPU first;
  WebGL2 fallback at the baseline tier (0064)".
- 0061's non-goal "WebGL fallback" is removed, and its `probeWebGpu` references point to
  `probeGraphics`.

### Agent surface

- `render.describe` → `backend`, `tier`, `capabilities`, the tier's limits, shader cache misses,
  and the reasons better options were skipped.
- `shard validate` reports baseline shader and feature errors with the module and line.
- `shard shaders bake --json` lists the variants baked, from scenes and from the manifest, and any
  that couldn't be translated.

## Decisions

- **A shim under one API, not a second renderer.** Every engine package and every host stays on
  one code path. What the shim can't do, the baseline tier designs around.
- **Baseline is a chosen subset, classified from capabilities.** WebGL2 and WebGPU compatibility
  mode have different limits, so neither defines the other. Shard picks one subset it can promise
  everywhere, and the probe decides from the device, not from the request.
- **Binding dimension fixed at creation; twins only for sampled assets.** That's the one rule that
  maps every view the engine uses onto GL. It's also the rule WebGPU compatibility mode imposes.
- **Format choice in the asset layer, not the shim.** Both baseline backends lack format
  reinterpretation, so a shim-only fix would leave compatibility-mode WebGPU broken. The import
  usage picks the format, so twins stay rare, and reloading the artifact keeps them from holding
  CPU memory.
- **The cache key covers everything the output depends on; the manifest covers what scenes don't
  show.** Otherwise a stale or missing variant shows up only in a user's browser.
- **Staged, and off the critical path.** The fallback shouldn't delay a replacement that works on
  WebGPU.

## Acceptance criteria

- [ ] `probeGraphics` classifies a Dawn core adapter as `full`, the same adapter forced to baseline
      as `baseline`, Chromium with WebGPU disabled as `webgl2`/`baseline`, and a simulated missing
      `EXT_color_buffer_float` as `none` with that reason. It never throws, and a compatibility
      request that returns a core adapter classifies as `full`.
- [ ] With WebGPU available, a session loads no `@shard/gpu-webgl2`, naga or shader cache bytes
      (network log). The full-tier WGSL for the forward pipeline is byte-identical before and after
      the accessor change, and full-tier goldens and `pnpm bench` timings are unchanged.
- [ ] Stage 1 runs on a Dawn compatibility adapter whose probe reports `core: false`. A canary
      test there creates an sRGB view of a linear texture and gets a validation error, proving the
      device enforces compatibility rules.
- [ ] Stage 1: the parity fixture, fog and tilemaps render at `tier: 'baseline'` on that adapter,
      with approved goldens, no validation errors, and no compute pass or vertex or fragment
      storage binding in their graphs.
- [ ] On baseline, on both backends: a `color` texture is created sRGB and a `data` texture linear,
      with no reinterpreting view. Binding a `data` texture to a base-color slot **after its CPU
      bytes were released** requests a twin from the reloaded artifact during material preparation.
      Until it's ready, the slot shows the loading fallback (or, with `deferUntilReady`, the draw is
      skipped), never the primary texture in the wrong color space. Once it's ready, the object
      renders correctly. The wait is recorded in `render.describe`, the dev build logs
      `render/texture-color-space-mismatch`, and the CPU bytes aren't kept afterwards
      (`texture.levels` stays undefined).
- [ ] Stage 2, one test per view row: a mismatched texture renders correctly through a counted
      twin; bloom samples mip *k − 1* while writing *k*; shadow cascades render
      into array layers; a texture-array material binding works; IBL renders into and samples a
      cube map. Creating a twin of a render target fails with `gpu-webgl2/unsupported`.
- [ ] Stage 3: the parity fixture, fog, tilemaps and a 32-die roll render on WebGL2 in Playwright's
      Chromium, and their captures are approved.
- [ ] Changing the naga version, a define, the entry point or a bind group layout changes the cache
      key; changing none of them keeps it.
- [ ] After baking the fixture and Aether's variant manifest, a WebGL2 session that shows every
      dice skin loads naga 0 times. A variant left out of the manifest loads naga once, within the
      stated budgets, shows as a counted miss, and loads naga 0 times in the next session.
- [ ] A token move on WebGL2 uploads one instance record to the instance data texture (0055
      accounting). `pick` returns the same entity as on WebGPU for 100 random pixels of the parity
      fixture.
- [ ] `shard validate` fails a material hook with a raw `var<storage>` read in a fragment shader, or
      a sampled single-layer view, naming the module and line. A `Planet` scene fails on baseline
      with `render/feature-unsupported`.
- [ ] A WebGL2 context loss recovers like a device loss: `RenderHealth` goes `ok → lost → ok`.
- [ ] Every registered render feature declares a baseline strategy or `baseline: 'unsupported'`
      (registry test).

## Open questions

- Should WebGPU compatibility-mode devices get an intermediate tier that keeps compute (GPU
  clustering, GPU particles) but follows compat's view and storage limits? Proposed: not now.
  Classify them as baseline, and add the tier if the probe shows enough such devices in real
  sessions.
- Should the baked cache be per project or per engine release? Proposed: per project, since
  material hooks, defines and manifests are project-specific.
