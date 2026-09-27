# 0044 — Atmosphere scattering

- **Status:** implemented
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-terrain`
- **Depends on:** 0019, 0021, 0023, 0040, 0043

## Context

0019's `ProceduralSky` is single scattering with Earth constants baked into the shader and the
viewer fixed 10 m above the ground. It lights a scene well, but it can't be seen from space, can't
belong to a planet that isn't Earth, and can't tint mountains 20 km away. 0023's `Fog` is flat
exponential height fog along world Y, which is wrong on a sphere.

The proof project needs an atmosphere per planet that looks right from the surface at noon and
dusk, from a ship at 30 km, and from orbit as a glowing limb. It should also tint distant terrain
(aerial perspective) consistently with the sky. The standard real-time approach is Hillaire's
"A Scalable and Production Ready Sky and Atmosphere Rendering Technique" (2020). It uses a
transmittance LUT, a multiple-scattering LUT, a sky-view LUT around the camera, and a froxel volume
for aerial perspective, all cheap enough to recompute every frame, with any planet radius and any
viewer altitude.

## Goals

- `Atmosphere` on a planet entity: radii, Rayleigh, Mie, and ozone-like absorption profiles, ground
  albedo, in physical units, with presets (`earth`, `mars`, `thin`, `thick-haze`, `alien-violet`).
- Correct from any altitude: surface, flight, orbit, and deep space (limb only).
- Any planet size, from small moons through Earth and super-Earths to gas giants, including diving
  into a gas giant's clouds.
- Multiple scattering (Hillaire's LUT), so twilight and thick atmospheres don't go black.
- Aerial perspective: terrain and objects inside or seen through an atmosphere are attenuated and
  in-scattered, in both forward and deferred.
- Several atmospheres at once (a planet and its moon, or a neighbor seen from orbit).
- The sky from the camera's current atmosphere bakes into the environment map (0019), so IBL
  matches the sky at every altitude and time of day.
- Physical units throughout, consistent with exposure and the sun's illuminance in lux.
- `ProceduralSky` becomes a thin wrapper: an Earth atmosphere with the viewer pinned near the
  ground, so existing scenes look the same.

## Non-goals

- Volumetric clouds (a later spec: a cloud layer raymarched against these LUTs).
- Light shafts from terrain occlusion in the atmosphere (later; needs shadow-map sampling in the
  froxel pass).
- Night sky, stars, and nebulae. That's the background, from 0046's star field.
- Weather (rain, sandstorms) beyond changing the atmosphere's parameters at runtime.

## Design

### Components

```ts
Atmosphere {
  bottomRadius: f64 = 0          // 0: the entity's Planet.radius (0043), else 6360 km;
                                 // a gas giant sets its cloud top (0046)
  thickness: f32 = 60000         // top radius = bottom + thickness, metres
  rayleighScattering: vec3 = [5.802e-6, 13.558e-6, 33.1e-6]   // per metre at sea level
  rayleighScale: f32 = 8000      // exponential scale height, metres
  mieScattering: f32 = 3.996e-6
  mieAbsorption: f32 = 4.4e-6
  mieScale: f32 = 1200
  mieG: f32 = 0.8
  mieGOffset: vec3 = [0, 0, 0]   // added to mieG per channel (Mars: blue scatters more forward)
  absorption: vec3 = [0.65e-6, 1.881e-6, 0.085e-6]           // ozone-like, per metre
  absorptionCenter: f32 = 25000  // tent profile center and width, metres
  absorptionWidth: f32 = 30000
  groundAlbedo: color = [0.3, 0.3, 0.3]
  intensity: f32 = 1             // artistic multiplier; 1 is physical
  deckDepth: f32 = 0             // gas giants: haze-to-opaque depth below bottomRadius, metres
}
```

- The atmosphere is centered on its entity's `GlobalTransform` origin, so it works with or without a
  `Planet` and moves with the planet's grid (0040).
- Presets live on the schema, like `LightPresets`. `gas-giant` is a hydrogen-helium profile: tall
  (27 km Rayleigh scale height, 2 000 km thick), weakly absorbing, and with a methane-like red
  absorption for Neptune-style blues when `absorption` is raised. `mars` is a thin, dusty
  Mie-dominated profile
  with a blue sunset, `thick-haze` has high Mie and low visibility, and `alien-violet` raises red
  Rayleigh scattering next to blue (a violet sky). A preset is whole component values
  (`AtmospherePresets.mars`); only `gas-giant` sets `bottomRadius`.
- Mars' blue sunset needs a per-channel phase: fine dust scatters blue more strongly forward. A
  scalar `mieG` can't do it, so `mieGOffset` adds a per-channel offset (Mars `[-0.15, 0, 0.2]`), and
  the butterscotch sky is dust absorption in the tent layer (center 0, 44 km wide).
- Camera opt-outs: `AtmosphereSettings { aerialPerspective: bool = true, skyViewSize: vec2 =
  [192, 108], froxels: vec3 = [32, 32, 32], maxDistance: f32 = 32000 }` on a camera tunes quality.

### Size and depth

- Nothing in the LUTs depends on planet size. Transmittance and multiple scattering are
  parameterized by altitude within `[bottomRadius, bottomRadius + thickness]`, so a 1 000 km moon,
  Earth, a super-Earth, and a 70 000 km gas giant use the same passes. Shader math runs in km,
  relative to the atmosphere's center, which keeps f32 precise at gas-giant radii too.
- For a gas giant, `bottomRadius` is the visible cloud top, and rays that hit it return the cloud
  shading from 0046 instead of ground albedo. A camera that descends below the cloud top is inside
  the **deck**: `Atmosphere.deckDepth` (default 0, meaning a solid bottom; gas giants set it) fades
  view distance to zero over that depth, so diving into Jupiter is a dim, thickening haze that ends
  in opaque cloud. What happens to a ship down there is game code.

### Which atmosphere, where

- Per camera and per frame, `render/atmosphere-select` sorts atmospheres by the distance from the
  camera to their top radius. The **primary** is the one the camera is inside, or else the nearest
  one whose limb is visible. Only the primary gets the sky-view LUT and aerial-perspective volume.
- **Secondary** atmospheres (up to 3 more whose bounding sphere is on screen and larger than 4 px)
  draw as limbs. The sky pass and the aerial-perspective pass composite every listed atmosphere far
  to near, marching each secondary with its own LUTs in 8 steps; a ray-sphere test against its top
  skips pixels that miss it, so no separate per-rectangle pass is needed. A distant planet has a
  glowing rim (and a lit disk where no terrain is drawn) without its own sky-view.
- Coordinates: every atmosphere computation runs relative to the atmosphere's center in km, with
  the camera position computed as `camera − center` from `GlobalTransform` (0040). That's
  origin-relative, so it's precise for a camera near the planet and good enough for one far away.
  View rays and pixel positions come from the inverse view-projection *without* the camera's
  translation: world-space f32 positions a few thousand km from the origin have ~0.5 m precision,
  and rays built from them fell apart.

### LUTs

Per atmosphere, recomputed only when its parameters change (layers of two `rgba16float` texture
arrays, 8 atmospheres resident, least recently used first):

- **Transmittance LUT** (256×64, `rgba16float`): optical depth to the top of the atmosphere, by
  altitude and zenith angle.
- **Multiple-scattering LUT** (32×32): Hillaire's isotropic second-order approximation, integrated
  over 64 directions.

Per camera, every frame, for the primary:

- **Sky-view LUT** (`skyViewSize`, nonlinear latitude parameterization around the horizon):
  single plus multiple in-scattering for every view direction from the camera's position, with sun
  transmittance. About 0.1 ms at the default size.
- **Aerial-perspective volume** (`froxels`, camera-aligned, exponential depth slices out to
  `maxDistance`): in-scattering and colored transmittance per froxel (two 3D textures), written by
  one compute dispatch, so the froxel range and the marched range beyond it agree in color.
  From inside, the range stretches past `maxDistance` to the horizon plus the 10 km peaks beyond
  it: from a few km up most terrain is past 32 km, and marching every such pixel cost 2 ms at
  2.5 MP; with the longer volume the haze costs 1.1 ms there.
- LUT and froxel luminance is stored in kcd/m², so `rgba16float` holds a noon sky.

Suns: the brightest two directional lights (0018), each with its own illuminance and angular radius
(`DirectionalLight.angularDiameter`, new, default 0.53°), so binary stars light the sky and both
disks draw.

### Drawing

- **Sky.** The atmosphere's sky pass (in 0019's sky slot, before transparents, so they still blend
  over it) samples the sky-view LUT from inside the primary, and marches the LUTs from outside it.
  It adds sun disks, and composites over the environment background: the camera's EnvironmentMap
  with a Skybox, or the default map, attenuated by transmittance. The star field from 0046 shows
  through as transmittance falls. From space it's just the limb.
- **Aerial perspective** is a post pass (`post/atmosphere`) at the head of the HDR chain, where fog
  was: from depth, `color × transmittance + inScatter` from the froxel volume by distance, and
  beyond `maxDistance` (planets seen from orbit), and for secondaries, the LUTs marched per pixel
  (24 steps from inside, 12 from space with samples bunched toward the ground, 8 for secondaries).
  Forward and deferred cameras run the same pass, so they match by construction.
  - Changed from applying it in material shaders: with the marched path compiled into every forward
    material, register pressure slowed all shading, with or without an atmosphere (1080p,
    Apple M4: 0.67 → 0.86 ms with no atmosphere, 1.4 → 3.4 ms with one). The pass costs a
    fullscreen read and write instead, which is what Unreal does too. Transparent surfaces take the
    haze of what's behind them, like fog.
- **Terrain from orbit.** It's the same aerial perspective with the raymarch path, so a planet seen
  from 1 000 km has a blue haze over its continents that matches its limb.
- **Fog** (0023) stays for flat scenes. When a camera has a primary atmosphere, `Fog` is ignored
  with the warning `render/fog-with-atmosphere` unless it has `mode: 'add'` (new field, default
  `'default'`), for artistic ground fog. ProceduralSky's pinned atmosphere doesn't count: flat scenes
  keep their fog.

### Lighting and IBL

- **Sun light at the surface.** Directional light illuminance is top-of-atmosphere. Before light
  shading, the renderer multiplies each sun's color by transmittance from the camera's position
  toward it. The CPU integrates the same density profiles in 40 steps per sun per camera, so there's
  no readback and it works headless. This is what makes the sun orange at dusk and dims light to
  nothing at night. It's also available to gameplay as
  `sunTransmittanceAt(world, atmosphere, position)`. Each view's uniform carries the factor per
  directional light (`sunTransmittance`), so two cameras in different atmospheres each get their
  own; the lighting stage and fog multiply by it.
- **IBL.** When the camera's primary atmosphere changes, or the camera moves more than 2% of
  (altitude + 1 km), or its local up or a sun turns more than 0.25° (0019's threshold), the
  environment bake marches the atmosphere from the camera into the source cube with the same
  integrator as the sky-view LUT (so it runs once per frame for every camera, without waiting on
  per-view passes), then prefilters as today. The sky and reflections stay consistent from surface
  to orbit; from orbit, ships are lit by the planet below. The + 1 km keeps walking over bumpy
  ground from rebaking every frame, and a moving camera rebakes at most every 8 frames (a bake is
  ~1.5 ms of GPU; climbing rebaked every frame); new atmosphere settings rebake at once.
- **`ProceduralSky`** keeps its fields and maps them onto an Earth atmosphere: Mie is scaled by
  `mie × turbidity / 2` (the default turbidity 2 is Earth), `rayleigh` multiplies Rayleigh, and the
  viewer is pinned 10 m above `bottomRadius` under the camera. `sunDiskSize` multiplies the light's
  `angularDiameter`. Its goldens are re-baselined and kept next to 0019's (`sky-0019-*`): mean
  CIE76 ΔE is 7.6 at a 60° sun and 7.0 at 10° (a lighter blue from multiple scattering), and 24
  at −2°, where 0019's single scattering went black and the twilight sky now stays lit.

### Agent surface

- `render.describe` reports each camera's primary and secondary atmospheres, the sun
  transmittance, the resulting sun illuminance at the camera, and the LUT timings.
- `atmosphere.sample { entity, position?, direction }` returns sky radiance (cd/m²) and
  transmittance for a view direction, so an agent can check "is the sky still visible at 40 km"
  without a screenshot.
- MCP `sample_atmosphere` forwards `atmosphere.sample`. Without a GPU it reads DirectionalLights
  from their components.
- The `Atmosphere` schema documents each field with real-world reference values (Earth, Mars), and
  the `.agents/skills/tune-an-atmosphere.md` skill says which knob changes the sunset color, which
  one the haze (there's no `.agents/rendering.md`; skills are where recipes live).
- Deferred to 0046: `procgen.preview` of a planet with its atmosphere and the
  `{ view: 'surface-noon' | 'surface-dusk' | 'orbit' }` option (planet generators arrive there), and
  cloud-top shading for gas giants (until then the deck floor is `groundAlbedo`).
- **Errors:** `render/atmosphere-inside-ground` (thickness ≤ 0; logged once, the atmosphere isn't
  drawn), `render/fog-with-atmosphere` (warning), `render/not-an-atmosphere`,
  `render/which-atmosphere`, `render/bad-vector` (`atmosphere.sample`).

## Decisions

- **Hillaire 2020.** It handles every altitude and any planet with one set of LUTs, includes multiple
  scattering, and costs well under a millisecond. It's also the model Unreal and Bevy ship, so its
  failure modes are known.
- **One primary per camera, limbs for the rest.** Full sky-view and froxels for several atmospheres
  would multiply cost for almost no visible gain. Only the one you're in fills the screen.
- **Atmosphere replaces fog on planets.** Two haze models on one planet disagree at the horizon.
- **Transmittance-scaled suns.** The sun's light and the sky's color come from one model, so dusk
  lighting on terrain matches the dusk sky without artist tuning.
- **`ProceduralSky` stays as a wrapper.** Scenes and specs that use it keep working, and the old
  single-scattering shader is deleted.

## Acceptance criteria

- [x] Earth preset: goldens at sun elevations 60°, 10°, 0°, −4° from 2 m, 10 km, and 400 km
      altitude. ~~Sky luminance at zenith (60° sun, 2 m) within 15% of 8 000 cd/m².~~ Changed:
      8 000 cd/m² is Preetham's clear sky at turbidity ≈ 2.5, with real aerosols; this spec's Earth
      coefficients (Hillaire's) have an aerosol optical depth of 0.01. With a 100 klux sun they give
      1.55 kcd/m² at the zenith: Rayleigh single scattering alone is E·τ·P ≈ 100 000 × 0.108 ×
      0.105 ≈ 1.1 kcd/m² (green), and multiple scattering adds the rest. The test holds the CPU model
      within 15% of 1 550 cd/m² and the GPU within 3% of the CPU.
- [x] Mars preset at sunset is bluish near the sun (hue 180°–260°) and butterscotch overhead
      (25°–60°): golden, and the sampled radiance's hue checked numerically.
- [x] A camera flying from 2 m to 400 km and back in 20 s (1 200 frames) shows no discontinuity:
      frame-to-frame mean luminance change stays under 3% at a constant sun.
- [x] Terrain 20 km away is visibly hazier (closer to the horizon sky, bluer) than terrain 1 km
      away, identically in forward and deferred cameras (image diff < 1%). A planet seen from
      1 500 km has bluer terrain and a glowing limb (`@aethervtt/shard-terrain`).
- [x] A moon with its own atmosphere, seen from the planet's surface (at night there: a thin limb
      can't beat a day sky) and from orbit, shows its limb. Four atmospheres on screen cost ≤ 1.2 ms
      total, measured as what they add over a Skybox background (every sky has a background pass;
      0019's costs 0.43 ms here) at 1080p, MSAA 4×, frame by frame against it: 0.43–0.55 ms on an
      Apple M4.
- [x] Sun illuminance at the surface with the sun at 2° elevation is below 15% of noon (11.7% of
      the top of the atmosphere), and `sunTransmittanceAt` matches the shader's transmittance LUT,
      read back and sampled, within 1%.
- [x] A scene using `ProceduralSky` from 0019 renders within the documented ΔE of its old golden
      (see Lighting and IBL).
- [x] Per-frame atmosphere cost for one primary with aerial perspective is ≤ 0.6 ms, measured as
      above: 0.30–0.34 ms. Nothing is recomputed per frame on the CPU beyond selection (and its sun
      transmittance): the LUT count stays put, and `render/atmosphere-select` stays under 0.1 ms.

## Open questions

- Should secondary atmospheres also contribute aerial perspective to their own planet's terrain
  when seen from orbit? Proposed: yes, via the raymarch path per pixel of that planet only, if 0046
  shows planets looking flat from orbit without it.
- None blocking. Deferred: clouds, light shafts, and eclipse shadows from moons on the atmosphere.
