# 0019 — HDR, tonemapping, image-based lighting, and sky

- **Status:** accepted
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

- [ ] White furnace test: a rough white dielectric sphere under a uniform environment of luminance
      L reflects L within 5%, measured from the HDR capture.
- [ ] A grid of spheres (metallic × roughness) under an HDR environment renders as a golden image
      with each tonemapping curve. Metals reflect the environment.
- [ ] Prefiltering a 2048×1024 equirect HDR takes under 50 ms of GPU time on the dev machine.
- [ ] A procedural sky at sun elevations of 60°, 10°, and −2° produces goldens with plausible color
      (blue at noon, orange at dusk, dark after sunset). Moving the sun rebakes the environment,
      and a rough sphere's ambient color follows.
- [ ] Custom `fragment_output` hooks from 0006 still apply, now in HDR before tonemapping (the
      existing hook test passes).
- [ ] Existing golden images are regenerated once, with the diff explained. After that, the
      forward output with `curve: 'aces'` matches the old in-shader path within tolerance.

## Open questions

- None blocking. Deferred: reflection probes (local cubemaps with parallax correction).
