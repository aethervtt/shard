# 0099 — Underwater and water optics

- **Status:** draft
- **Packages:** `@aethervtt/shard-water`, `@aethervtt/shard-render`
- **Depends on:** 0018, 0044, 0064, 0097, 0098

## Context

0097 shades water seen from above or through a tank's side. Going under is a different picture:
the world turns blue-green with distance, light comes down in shafts, caustics dance on the floor,
and looking up you see the sky only through a cone (Snell's window), with the underwater world
mirrored outside it. At the waterline the screen splits, and the split follows the waves.

Unreal does this with a per-body post-process material, chosen by a collision test. It has no
proper waterline split, and users report it failing as waves pass the camera. Crest renders
underwater as a fullscreen effect before transparents, with a meniscus at the near-plane
waterline, and portals and volumes so an aquarium's water is only inside its glass. This spec
follows Crest's structure.

## Goals

- Underwater per pixel, not per camera: the waterline across the screen follows the waves, with a
  meniscus.
- Underwater fog: Beer–Lambert absorption per channel and in-scattering of sun and sky light, from
  the body's `WaterOptics`.
- The surface seen from below: Snell's window, total internal reflection outside it.
- Caustics on everything under water, from the actual waves.
- Light shafts (god rays) under water.
- Aquariums and tanks both ways: looking into a `WaterVolume` from outside, and a camera inside
  one, where the water ends at its walls.
- Transparent materials under water fog correctly (opt-in hook).
- Both tiers; each effect is opt-in.

## Non-goals

- Bubbles, particulates, marine snow (particles, 0026; a preset can come later).
- Volumetric light shafts above water (atmospheric god rays: 0044/0049's business).
- Refraction at a tank's glass wall (the glass is a material; the wall is flat).

## Design

### Where the water is, per pixel

- A fullscreen **water mask** pass after the water pass (0097): for each pixel, the length of the
  view ray inside water and where it enters, from the water depth (the water pass wrote it), the
  opaque depth, the volume back faces (0097's thickness target), and whether the near-plane point
  of the pixel is under the surface. That last test reads the displaced surface height at the
  near-plane position (the info texture plus 0098's cascades), so the waterline follows waves.
- **Meniscus**: where the near-plane under/over state changes between neighbouring pixels, a thin
  darkened, slightly refracting band.
- Water masks (0097) apply: a diving bell's interior isn't under water.
- The camera is "under water" for gameplay and audio when `waterAt(camera)` says so (0097), not by
  collision.

### Fog and scattering

- Over the in-water ray length `d`: `colour × T + inscatter × (1 − T)`, `T = exp(−σ_a d)` per
  channel. In-scattering takes the sun's light, attenuated by the water above the scattering point
  (its depth below the surface), with a Henyey–Greenstein phase, plus the sky's ambient.
- Deeper is darker: ambient and sun fall with depth by the same absorption, so 30 m down is dim
  blue even looking sideways.
- Runs as a fullscreen pass before transparents (Crest's order). Transparent materials opt in to
  being fogged by importing `shard::water::fog` in `fragment_output` (0020 hook); particles get a
  `waterFog: bool` module (0026).

### The surface from below

- The water pass draws the surface's back faces when the camera is under it, with Fresnel for
  n = 1/1.333: inside Snell's window (about 97° across) it refracts the sky; outside it reflects
  the underwater scene, approximated by the fog colour and the opaque copy mirrored along the
  normal.

### Caustics

- A caustics texture per directional light, covering the area around the camera in the light's
  view: a grid over the surface is refracted toward the ground along the sun direction, and each
  cell splats the ratio of its area before and after refraction (Evan Wallace's method). On the
  compute tier it splats with atomics into a 512² `r32uint` buffer; on the baseline tier, a
  `fragmentKernel` draws the refracted grid as triangles with additive blending into a 256²
  `r16float` target.
- Applied in a screen pass over opaque pixels under water: world position from depth, the
  caustics texture sampled at its light-space position, scaled by the light reaching that depth
  and by the sun's shadow (so caustics stop under a dock). Above-water objects get none.
- Inside a `WaterVolume`, caustics come from its lid.

### Light shafts

- Half resolution, 16 steps (24 on high) along the in-water segment: the sun's shadow map is
  sampled at each step, weighted by HG phase and the transmittance to the camera and to the
  surface, with blue-noise jitter and a temporal blend. Shafts appear where something blocks the
  sun (a boat, a cliff) and where waves focus it (modulated by the caustics texture).
- Both tiers; it's a fragment pass.

### Tanks and aquariums

- From outside, a `WaterVolume`'s sides already shade by thickness (0097). With this plugin they
  also get fog in-scattering, caustics on what's inside, and light shafts within the volume's
  depth range.
- A camera inside a `WaterVolume` is under water only inside the shape: rays leaving through a
  wall stop being fogged at the wall, so you see the room outside the glass, tinted by the water
  you looked through.

### Settings

```ts
Underwater {                                  // on a camera; defaults from the body's optics
  fog: bool = true, surfaceFromBelow: bool = true, caustics: 'off' | 'low' | 'high' = 'low',
  shafts: 'off' | 'low' | 'high' = 'low', meniscus: bool = true
}
```

### Agent surface

- `water.describe` adds per camera: under water or not, the body, depth, and each effect's time.
- `render.capture { debug: 'water-mask' | 'caustics' | 'shafts' }`.
- **Errors:** `water/underwater-needs-water` (Underwater with no `waterPlugin`), and 0056's
  `render/feature-missing` when `Underwater` is set without `underwaterPlugin()`.

## Decisions

- **Per-pixel water mask, not a camera flag.** The waterline is the moment players notice water
  rendering most; it has to follow the waves.
- **Caustics computed from the waves, not a scrolling texture.** They move with the sea you see
  and focus where its waves do; the cost is one splat pass.
- **Fog before transparents, opt-in after.** As Crest does: correct for everything opaque, and
  transparents choose.

## Acceptance criteria

- [ ] A camera half under water in 2 m swell shows the waterline following the waves frame to
      frame, with a meniscus and no frame where the whole screen flips (capture of 10 s).
- [ ] Looking up from 5 m down shows the sky inside a cone of 97° ± 2°, and the reflected sea
      outside it (golden).
- [ ] With clear-water optics, a white object 20 m away under water keeps under 5% of its red and
      over 50% of its blue (pixel test).
- [ ] Caustics on a sloped seabed move with the waves, stop in the shadow of a moored boat, and
      fade with depth (golden at two times).
- [ ] From outside an aquarium, fish inside are fogged and caustic-lit; from inside, the room
      through the glass is visible and only tinted (goldens both ways).
- [ ] All effects together take under `gpu:underwater` (proposed: 1.5 ms on `laptop`, 1080p,
      `low`), and run on WebGL2.

## Open questions

- Underwater audio (low-pass, muffling)? Proposed: 0050 reads `waterAt(camera)`; nothing here.
- Should caustics reach above-water objects near the surface (a dock's pillars)? Proposed: no in
  v1.
