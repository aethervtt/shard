# 0098 — Ocean waves

- **Status:** draft
- **Packages:** `@aethervtt/shard-water`, `@aethervtt/shard-render`, `@aethervtt/shard-shader`
- **Depends on:** 0064, 0086, 0096, 0097

## Context

0097's bodies are flat but for wind ripples in the normals. An ocean needs real waves: long swell
rolling in from far away, wind waves on top, and ripples, at every scale from a rowing boat to a
ship seen from a cliff, breaking into foam where they crest, flattening and rising as they reach
the shore.

The standard answer is Tessendorf's FFT ocean with an empirical spectrum. Current implementations
(Atlas, Crest, GodotOceanWaves, gasgiant's FFT-Ocean, Ultra-Water) agree on the shape:

- **Spectrum**: JONSWAP with the TMA depth correction and Donelan–Banner/Hasselmann directional
  spreading (Horvath, DigiPro 2015), often two of them: local wind sea plus swell (Atlas).
- **Cascades**: three or four small FFTs over different patch lengths (gasgiant uses 250, 17 and
  5 m at 256²), each keeping only its band of wavelengths, so tiling never shows.
- **Foam**: from the Jacobian of the horizontal displacement, accumulated over time.
- **Cost**: three 256² cascades take about 0.4–0.5 ms on a desktop GPU (Atlas, Arc Blanc). On
  WebGL2 the same FFT runs as ping-pong fragment passes (Ultra-Water: 4 × 256² in about 0.45 ms).

Unreal never shipped an FFT ocean; it sums 16 Gerstner waves on CPU and GPU. That's what makes
its buoyancy agree with what you see, at the cost of realism. Shard can have both: an FFT for the
picture, and a CPU evaluator over the same spectrum's strongest components for gameplay.

Multiplayer makes one more demand. Every client should see the same sea. The spectrum approach
helps: the surface is a pure function of `(seed, spectrum, time)` (Atlas: "can be simulated
independently on server and clients"). It can't be bit-exact on the GPU, though: WGSL lets `sin`
and `cos` be off by 2⁻¹¹ and lets implementations reassociate and fuse float maths. Three.js Water
Pro says the same ("a few ULPs" across vendors) and tells users to network boats directly.

## Goals

- `OceanWaves` on an ocean or lake body: a wind sea and an optional swell, each a JONSWAP + TMA
  spectrum with directional spreading, driven by 0096's `Wind` unless overridden.
- 3 cascades by default (1–4), at 128², 256² (default) or 512², with displacement, normals and
  foam.
- Shores: waves shorten, steepen and attenuate with depth from 0097's info texture.
- The same sea on WebGPU (compute) and WebGL2 (fragment passes): one FFT written once.
- A CPU evaluator: `waterAt` includes waves, deterministic and headless.
- Multiplayer: the same `(seed, spectrum, tick)` gives every client the same sea, to the precision
  the GPU allows, and exactly the same `waterAt`.

## Non-goals

- Interactive waves (wakes, ripples from objects): 0100.
- Breaking-wave geometry (curling barrels), surf and rip currents.
- Waves on rivers (they get flow-advected ripples, 0097).
- Bit-exact GPU surfaces across vendors (impossible under WGSL's precision rules).

## Design

### Spectrum

```ts
OceanWaves {
  seed: u32
  wind: 'body' | { speed: f32 (m/s), direction: vec3 }       // 'body': the body's wind (0097, 0096)
  fetch: f32 = 100 (km)                                       // distance the wind has blown over water
  gamma: f32 = 3.3                                            // JONSWAP peak enhancement
  spread: f32 = 1                                             // directional spreading (Donelan)
  swell?: { height: f32 (m), period: f32 (s), direction: vec3, spread: f32 }
  depth: 'zone' | f32 (m)                                     // TMA: from the info texture, or fixed
  choppiness: f32 = 1                                         // horizontal displacement λ
  cascades: list({ length: f32 (m) }) = [{ 250 }, { 17 }, { 5 }]
  resolution: 128 | 256 | 512 = 256
  foam: { threshold: f32, growth: f32, decay: f32 }
}
```

- α and ω_p come from wind speed and fetch (JONSWAP); σ is 0.07 below the peak and 0.09 above.
  The swell is a second JONSWAP with its peak set by `period` and its energy scaled to `height`
  (significant wave height). Small-wave suppression `exp(−k²ℓ²)` removes waves below a cascade's
  resolution.
- Each cascade keeps wavenumbers in its band: `[6·2π/L_this, 6·2π/L_next)` (gasgiant's edges), so
  no wavelength is counted twice. Lengths that aren't integer ratios of each other keep repeats out
  of sight; distant cascades fade by distance (Atlas: about 30 periods).
- Initial amplitudes `h0(k)` are drawn on the CPU from `Rng(hashSeed(seed, cascade))` with
  Gaussian pairs, in a fixed order, and uploaded. They change only when the spectrum does.

### Time and determinism

- Simulation time is `t = (tick × step) mod T`, with `T = 8192 s` and every ω snapped to a
  multiple of 2π/T, so the sea loops exactly and `sin(ωt)` keeps f32 precision forever (Tessendorf's
  repeat time; Water Pro does the same). `tick` and `step` are `FixedTime`'s, and on a networked
  client `NetClock.serverTick`'s, so clients agree on t without exchanging it.
- `OceanWaves` replicates as a component (0087), and wind through 0096's `WindState`. A change
  applies at a tick: the old and new `h0` are
  both kept and crossfaded over 120 ticks, so the sea doesn't pop and every client blends
  identically.
- The GPU surface agrees between clients to within float error. Foam is history (accumulated), so
  after a client joins or resyncs its foam converges within a few seconds; it's visual only.

### FFT

- Per cascade per frame: time evolution `h(k,t) = h0(k)e^{iωt} + conj(h0(−k))e^{−iωt}` and its
  derivatives, packed into 4 complex fields (gasgiant's packing: Dx+iDz, Dy+iDxz, Dyx+iDyz,
  Dxx+iDzz), then inverse 2D FFTs, then a resolve to:
  - displacement (`rgba16float`, xyz),
  - derivatives (`rgba16float`: slopes and Jacobian terms),
  - foam (`r16float`, ping-ponged: grows where `J < threshold`, decays otherwise).
- Cascades are layers of one 2D array texture. The water pass (0097) sums displacement in the
  vertex stage and derivatives in the fragment stage.
- **Compute tier**: Stockham radix-2, one row per workgroup in shared memory, all cascades and all
  4 fields per dispatch. Pipelines through `gpu.pipelines.compute`.
- **Baseline tier**: the same WGSL butterflies written as `fragmentKernel`s (0064): every cascade
  in one atlas texture, so each FFT stage is one draw with 4 colour targets, log₂N draws per
  direction. Float targets are always there (0064 requires `EXT_color_buffer_float`).
- `updateRate` can update one cascade per frame, round-robin, with time still exact.

### Shore and lakes

- Per vertex, waves attenuate by depth from the info texture: amplitude × `tanh(k·depth)`-weighted
  by cascade, and TMA reshapes the spectrum itself when `depth` is a number.
- Shore foam (0097) adds the wave height near the shore.
- Lakes use one cascade and a small fetch: chop, not swell.

### CPU evaluator

- `waterAt` (0097) sums the K strongest spectral components (default 64) across cascades as
  Gerstner-equivalent waves, with every sine and cosine from `sinCos` (0045), so its bytes are the
  same on every machine and on the server.
- Horizontal displacement means the surface at x came from somewhere else; it's inverted with 4
  fixed-point iterations (Atlas, Arc Blanc do the same).
- Its error against the GPU surface is bounded (below). Visual-only waves (the small cascades)
  aren't in it; they don't move boats.

### API sketch

```ts
import { oceanWavesPlugin, OceanWaves } from '@aethervtt/shard-water'

app.addPlugin(waterPlugin(), oceanWavesPlugin())
world.spawn([WaterBody, { kind: 'ocean', optics: oceanOptics }],
            [OceanWaves, { seed: 7, fetch: 300, swell: { height: 2, period: 11, direction: [1, 0, 0.2] } }],
            Transform)
```

### Agent surface

- `water.describe` adds per cascade: band, resolution, update time, significant wave height and
  peak period of the spectrum.
- `water.waves { seed?, wind?, … }` previews a spectrum: Hs, peak period, and a PNG of the
  height field.
- `render.capture { debug: 'water-cascades' | 'water-foam' }`.
- **Errors:** `water/bad-cascades` (lengths not decreasing, more than 4),
  `water/waves-need-ocean` (OceanWaves on a river or volume).

## Decisions

- **FFT for the picture, a reduced spectrum on the CPU for gameplay.** Realism where you look,
  determinism where it matters, from one spectrum.
- **One FFT, two tiers.** The butterflies are the same WGSL; only the dispatch differs. No Gerstner
  fallback is needed, since WebGL2 here always has float render targets.
- **Time from the tick, looped at 8192 s.** Clients agree without sending time, and f32 never loses
  precision.
- **No promise of a bit-exact GPU sea.** Boats are networked as state (0087), as Water Pro advises.

## Acceptance criteria

- [ ] With wind 15 m/s and fetch 300 km, the CPU evaluator's significant wave height is within 10%
      of JONSWAP's (`Hs ≈ 4 √m0`) over 600 s of samples.
- [ ] The CPU evaluator's height is within 5% of Hs RMS of the GPU's at 1 000 points (readback).
- [ ] Two clients in `shard run --net clients=2` report identical `waterAt` at the same ticks, and
      their GPU heights agree within 1 mm (screenshot readback at the same tick).
- [ ] Changing `Wind.speed` from 6 to 18 at tick 600 crossfades over 120 ticks with no frame
      where any vertex moves more than its wavelength / 10 (test).
- [ ] WebGPU and WebGL2 heights at the same tick agree within 1 mm RMS (golden readback).
- [ ] 3 cascades at 256² take under `gpu:water-waves` (proposed: 0.6 ms on `laptop`), and no tiling
      is visible from 200 m up (golden).
- [ ] Waves shorten and shrink toward a sloping beach, with foam along it (golden).

## Open questions

- A fourth "far swell" cascade for views from altitude? Proposed: allowed by `cascades`, off by
  default until a demo needs it.
- Should the CPU evaluator run off the main thread for many boats? Proposed: measure first; 64
  components × 16 points × 4 iterations per boat is small.
