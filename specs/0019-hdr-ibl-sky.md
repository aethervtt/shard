# 0019 — HDR, tonemapping, image-based lighting, and sky

- **Status:** implemented
- **Packages:** `@shard/render`, `@shard/texture`
- **Depends on:** 0007, 0016, 0018

## Context

Today every material shader applies ACES and the sRGB encode itself, at the end of the forward
pass, straight into the window. So post-processing can't happen, bloom can't see values above 1,
and metals look black because nothing reflects in them. The NormalTangentTest renders showed that
clearly.

This spec makes the frame HDR from start to finish. It moves tonemapping into its own pass with
several curves, and adds image-based lighting from environment maps plus a procedural sky that can
light a planet at any time of day.

## Goals

- Views render into an HDR target (`rgba16float`). A tonemap pass writes the display target.
- Tonemapping curves are chosen per camera: ACES (fitted), AgX, Khronos PBR Neutral, Reinhard, and
  none, with dithering against banding.
- `EnvironmentMap`: an HDR texture (equirectangular `.hdr` or cube KTX2) prefiltered on the GPU
  into diffuse irradiance and GGX specular mips, used for ambient light and reflections.
- A skybox draws the environment as the background.
- `ProceduralSky`: a single-scattering atmosphere driven by the sun (the brightest
  DirectionalLight). It's drawn as the background and baked into the environment map whenever the
  sun or its settings change.
- All of it is in physical units, consistent with exposure (0007).

## Non-goals

- Multiple-scattering atmospheres from space, clouds, volumetrics (later; the planet atmosphere is
  M7 work).
- Reflection probes and local cubemaps (later).
- Screen-space reflections (later).
- Color grading and auto exposure (0023, which sit next to tonemapping in the post stack).

## Design

### HDR views and tonemapping

- The render graph gains a `hdr` view resource (`rgba16float`, MSAA-resolved). Forward and
  deferred passes write it. The existing `view` target becomes the display output only.
- The `tonemap` node reads `hdr` and writes `view`. It applies exposure, then the curve, then
  dithering, then the sRGB encode for non-sRGB targets. The code that did this at the end of the
  material shader is removed. Custom `fragment_output` hooks (0006) keep working and run before
  tonemapping, in HDR.
- `Tonemapping { curve: 'aces' | 'agx' | 'pbr-neutral' | 'reinhard' | 'none', dither: bool }`
  goes on the camera. The default is `agx`, which handles saturated highlights (engine glows, lava)
  without hue shifts.

### Environment maps

```ts
EnvironmentMap {
  texture: handle('Texture')   // usage 'hdr': an equirect .hdr or a cube KTX2
  intensity: f32               // cd/m² that a texel value of 1.0 represents (default 5000)
  rotation: f32                // degrees about +Y
}
```

- It goes on a camera, or on the world through `DefaultEnvironment` (a resource). `AmbientLight`
  remains the fallback when neither is set.
- **Prefiltering:** compute passes run when the texture loads or changes. They convert
  equirectangular to a 512² cube, compute diffuse irradiance as 9-term spherical harmonics, and
  prefilter specular into GGX mips with importance sampling (6 mips, roughness 0…1). A 128² BRDF
  lookup table is generated once. The results are cached per texture version.
- **Lighting stage:** the ambient term becomes `irradiance(n) · albedo · (1 − F) · occlusion +
  prefiltered(r, roughness) · (F₀·A + B)`, with split-sum IBL. Materials don't change.

### Sky

- `Skybox { brightness }` on a camera draws its environment map behind everything, using a
  depth-equal full-screen pass after opaque geometry. That replaces `clearColor`.
- `ProceduralSky { turbidity, rayleigh, mie, groundAlbedo, sunDiskSize }` on a camera or as
  `DefaultEnvironment`. It evaluates single-scattering Rayleigh and Mie for view rays, draws the
  sun disk from the brightest DirectionalLight, and outputs luminance in cd/m² consistent with
  that light's illuminance.
  - Since 0044, `ProceduralSky` is an Earth `Atmosphere` pinned 10 m under the camera (multiple
    scattering, up to two suns); the single-scattering shader is gone.
- When the sun direction or any sky setting changes by more than a threshold, the sky is baked
  into a 256² environment cube and prefiltered (a few milliseconds, spread over two frames), so
  IBL follows the time of day. The baked cube is available as a normal `EnvironmentMap` source.

### Agent surface

- `render.capture { buffer: 'hdr' }` returns the untonemapped frame as an RGBA16F PNG or EXR-like
  raw data, so an agent can measure luminance.
- `render.describe` reports the active tonemapping curve, the environment (source, intensity,
  prefilter state), and the sky parameters with the resulting sun luminance.
- The schemas carry presets: `EnvironmentMap.intensity` has `overcast-sky` 2 000 and
  `clear-sky` 8 000; `Tonemapping` documents what each curve is for.

## Decisions

- **Tonemapping is a pass, not a material stage.** Post effects need HDR input, and materials
  shouldn't know about display encoding.
- **AgX by default.** It keeps saturated emissive colors from turning white or shifting hue, which
  matters for a sci-fi palette of glowing panels, plasma, and neon.
- **Spherical harmonics for diffuse, mips for specular.** Standard split-sum IBL: cheap to sample,
  and good enough for rough and glossy surfaces alike.
- **The sky bakes into the environment.** One lighting path: a procedural sky lights the scene the
  same way an authored HDR does.
- **Environment intensity is in cd/m².** HDR files are relative. Tying them to physical units keeps
  exposure presets meaningful.

## Acceptance criteria

- [x] White furnace test: a rough white dielectric sphere under a uniform environment of luminance
      L reflects L within 5%, measured from the HDR capture.
- [x] A grid of spheres (metallic × roughness) under an HDR environment renders as a golden image
      with each tonemapping curve. Metals reflect the environment.
- [x] Prefiltering a 2048×1024 equirect HDR takes under 50 ms of GPU time on the dev machine.
- [x] A procedural sky at sun elevations of 60°, 10°, and −2° produces goldens with plausible color
      (blue at noon, orange at dusk, dark after sunset). Moving the sun rebakes the environment,
      and a rough sphere's ambient color follows.
- [x] Custom `fragment_output` hooks from 0006 still apply, now in HDR before tonemapping (the
      existing hook test passes).
- [x] Existing golden images are regenerated once, with the diff explained. After that, the
      forward output with `curve: 'aces'` matches the old in-shader path within tolerance.

## Implementation notes

- **HDR views:** a camera view renders into `scene-color` (rgba16float, multisampled when MSAA
  is on) and `scene-depth`. With MSAA, each scene pass resolves into `hdr` at its end. The graph
  stores the multisampled buffer only when a later pass loads it, so the last scene pass resolves
  for free on tile-based GPUs. Without MSAA, `scene-color` and `scene-depth` are aliases of `hdr`
  and `depth` (graph resource aliases), with no copy. `depth-resolve` makes a single-sample depth
  only when some pass reads it.
- **Pre-exposed HDR:** the HDR target stores radiance × exposure, which keeps sunlit highlights
  inside rgba16float's range. So the tonemap pass applies the curve, dithering, and the sRGB
  encode, but not exposure. `captureBuffer(world, view, 'hdr')` and
  `render.capture { buffer: 'hdr' }` divide the exposure back out, so they return cd/m²
  (`render.capture` sends raw rgba32float as base64).
- **Clear color:** it's an HDR background like any other, and goes through the curve. The M2
  path wrote it straight to the display target. That's the one difference in the ACES check:
  the M2 golden is kept as `reference-scene-m2`, and ACES output matches it within 2 levels on
  every non-background pixel (edges differ slightly, since MSAA now resolves before tonemapping).
- **Curves:** ACES is Narkowicz's fit. AgX is Sobotka's inset/outset matrices with Wrensch's
  polynomial sigmoid (display-linear output). Khronos PBR Neutral, Reinhard, and none (clamp) are
  also available. `DEFAULT_CURVE` is `agx`. Dithering is triangular ±1 LSB noise from interleaved
  gradient noise, applied in display space, and it works on sRGB targets too.
- **Goldens regenerated once:** every existing golden (render, gltf, scene, cli) was rewritten when
  AgX became the default. The diff: AgX is less saturated than ACES (the textured box reads paler),
  and backgrounds are darker because the clear color now goes through the curve.
- **Environments:** `EnvironmentMap` goes on a camera, and `DefaultEnvironment` (a resource:
  `{ map, sky, background }`) covers cameras that have none. Otherwise `AmbientLight` is used.
  Prefiltering runs in compute, all in the `environment` node, once per frame for whatever changed:
  1. The source becomes a 512² cube (equirect with 2×2 supersampling, or cube KTX2).
  2. Box-filtered mips are built.
  3. SH9 comes from the 32² level, in one workgroup: the cosine lobe is applied and the result
     divided by π, so the shader reads irradiance/π directly.
  4. A 256² specular cube gets 6 GGX mips (roughness 0…1), from 64 samples with filtered
     importance sampling (Křivánek).

  A 128² BRDF LUT (rgba16float, since rg16float isn't a storage format) is generated once, with
  the same visibility term as direct lighting. Prefiltering the 2048×1024 environment of the
  `#ibl` playground demo takes 4.4 ms of GPU time in Chrome on the dev machine (Apple M4).
- **IBL term:** as specified, plus Lagarde's specular occlusion from `occlusion`, and Fresnel
  with roughness for the diffuse weight. The white furnace test reflects L within 5%.
- **Cube maps:** `@shard/texture` gained cube KTX2 support (`faces: 6`, uncompressed; Basis cube
  maps come later). Fixing this also fixed a latent bug: `readKtx2` ignored the usage tag when
  ktx-parse returned it as bytes, so `.hdr` artifacts loaded as 8-bit data. An RGBA16F format now
  always means `hdr`.
- **Skybox:** a fullscreen triangle at depth 0 with `depthCompare: 'equal'` against read-only scene
  depth, sampling the 512² source cube. Cameras with a procedural sky, or with a default
  environment whose `background` is true, draw it without a `Skybox` component.
- **Procedural sky:** single scattering over Earth-like Rayleigh (8 km) and Mie (1.2 km) layers:
  16 view samples, bunched near the viewer, with 8-sample sun optical depths. The ground is lit
  below the horizon. `turbidity` scales the aerosols. It's baked without the sun disk into a
  256² cube, which is then prefiltered like a map. It rebakes when the sun moves more than about
  0.25° or its illuminance changes more than 1%. The bake happens in one frame (a few ms) rather
  than spread over two. The background adds an analytic sun disk: luminance E / solid angle,
  attenuated by the view ray's transmittance, with limb darkening.
- **Brightness:** the sky's brightness comes from the brightest DirectionalLight's illuminance,
  treated as the top-of-atmosphere value. Single scattering alone gives about 900 cd/m² at 50°
  elevation under a 100 000 lux sun, about half of measured clear skies, since there's no
  multiple scattering.
- **Agent surface:** `render.describe` gains an `environment` section per view: the curve, the
  source (map, procedural sky, or ambient light), intensity, rotation, prefilter state, bake
  count, and, for skies, their parameters, the sun direction and illuminance, and the sun disk
  luminance.
- **Hooks:** `fragment_output` now runs on pre-exposed HDR, before tonemapping. The 0006 hook
  tests pass unchanged. 0020 adds a renderer test that overrides it on a material.
- **Playground:** `#ibl` shows spheres under a generated 2048×1024 HDR environment. `#sky` runs a
  40-second day with cascaded shadows and IBL following the sun.

## Open questions

- None blocking. Deferred: reflection probes (local cubemaps with parallax correction).
