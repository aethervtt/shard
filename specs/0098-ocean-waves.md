# 0098 — Ocean waves

- **Status:** implemented (one criterion open: waves don't yet shorten toward a beach)
- **Packages:** `@aethervtt/shard-water`, `@aethervtt/shard-project` (the `water/waves` manifest
  plugin), `apps/cli` (`preview_waves`)
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
  seed: u32 = 1
  wind: 'body' | 'own' = 'body', windSpeed: f32 = 10 (m/s), windDirection: vec3   // 'body': the body's wind (0097, 0096)
  fetch: f32 = 100 (km)                                       // distance the wind has blown over water
  gamma: f32 = 3.3                                            // JONSWAP peak enhancement
  spread: f32 = 1                                             // directional spreading (Donelan)
  swell: bool = false, swellHeight: f32 (m), swellPeriod: f32 (s), swellDirection: vec3, swellSpread: f32
  depth: f32 = 0 (m)                                          // 0: deep, attenuated by the info texture; > 0: TMA
  choppiness: f32 = 1                                         // horizontal displacement λ
  cascades: list({ length: f32 (m) }) = [{ 250 }, { 17 }, { 5 }]
  resolution: u32 = 256                                       // 128, 256 or 512
  foamThreshold: f32 = 0.2, foamGrowth: f32 = 2, foamDecay: f32 = 0.35
  changedAt: i32 = -1                                         // the tick the spectrum changed (multiplayer)
}
```

- *As built*, the drafted unions and optional structs are flattened into fields (`wind`, `swell`,
  `depth`, `foam`), as 0096's `WindZone.override` is: component fields are columns. The body's wind
  is its own (`WaterBody.wind: 'own'`) or `wind/Wind`'s uniform speed and direction (gusts and
  `WindZone`s don't reshape the spectrum).

- α and ω_p come from wind speed and fetch (JONSWAP); σ is 0.07 below the peak and 0.09 above.
  The swell is a second JONSWAP with its peak set by `period` and its energy scaled to `height`
  (significant wave height). Small-wave suppression `exp(−k²ℓ²)` removes waves below a cascade's
  resolution.
- Each cascade keeps wavenumbers in its band: `[6·2π/L_this, 6·2π/L_next)` (gasgiant's edges), so
  no wavelength is counted twice. Lengths that aren't integer ratios of each other keep repeats out
  of sight; distant cascades fade by distance (Atlas: about 30 periods).
- Initial amplitudes `h0(k)` are computed on the CPU and uploaded; they change only when the
  spectrum does. *As built*, each texel's amplitude is the spectrum's own (its cosine carries
  `S(k)Δk²` of variance) and only its phase is random: a hash of `hashSeed(seed, cascade)` and the
  wave's own indices, integer maths only. Gaussian amplitudes made a seed's Hs swing by 10–20%
  (at 15 m/s the energy sits in a few dozen peak cells), the size of the evaluator's 10% criterion;
  hashing by index rather than drawing in row order keeps the same strong waves at any
  resolution, so a smaller sea zero-pads exactly into a larger texture.

### Time and determinism

- Simulation time is `t = (tick × step) mod T`, with `T = 8192 s` and every ω snapped to a
  multiple of 2π/T, so the sea loops exactly and `sin(ωt)` keeps f32 precision forever (Tessendorf's
  repeat time; Water Pro does the same). `tick` and `step` are `FixedTime`'s, and on a networked
  client `NetClock.serverTick`'s, so clients agree on t without exchanging it.
- `OceanWaves` replicates as a component (0087), and wind through 0096's `WindState`. A change
  applies at a tick: the old and new `h0` are
  both kept and crossfaded over 120 ticks, so the sea doesn't pop and every client blends
  identically. *As built*, the crossfade starts at `WindState.fromTick` when the wind changed, at
  `OceanWaves.changedAt` when the component carries one (a server sets it a few round trips ahead,
  as `scheduleWind` does; nothing stamps it automatically), and otherwise at the tick the change
  was seen. Rendering reads the tick plus the fraction toward the next; `waterAt` reads the tick.
- The GPU surface agrees between clients to within float error. Foam is history (accumulated), so
  after a client joins or resyncs its foam converges within a few seconds; it's visual only.

### FFT

- Per cascade per frame: time evolution `h(k,t) = h0(k)e^{−iωt} + conj(h0(−k))e^{iωt}` (waves
  travel along k) and its
  derivatives, packed into 4 complex fields (gasgiant's packing: Dx+iDz, Dy+iDxz, Dyx+iDyz,
  Dxx+iDzz), then inverse 2D FFTs, then a resolve to:
  - displacement (`rgba16float`, xyz),
  - derivatives (`rgba16float`: slopes and Jacobian terms),
  - foam (`r16float`, ping-ponged: grows where `J < threshold`, decays otherwise).
- Cascades are layers of one 2D array texture. The water pass (0097) sums displacement in the
  vertex stage and derivatives in the fragment stage.
- *As built*, the textures are 2D arrays at the largest resolution any sea asks for (a smaller one
  is zero-padded): the spectrum (`rgba32float`, three layers a cascade: new h0, old h0, and
  `(ω new, ω old, kx, kz)`), the FFT's ping-pong fields (`rgba32float`, two a cascade), and the
  resolved waves (`rgba16float`, two a cascade: displacement with foam in `w`, then derivatives),
  also ping-ponged so foam carries over. Foam doesn't need its own `r16float` target, which isn't a
  storage format in core. Up to 8 cascade layers draw, across every body's sea
  (`water/too-many-cascades` past that).
- Evolve, the FFT and resolve are image kernels: each writes one storage texture at its invocation
  id, so **baseline** runs the same WGSL through `fragmentKernel` (0064), a fragment pass a layer:
  `water::waves::fft` is one radix-2 Stockham stage (Govindaraju et al.'s FftIteration, inverted
  to one output a texel), 2 log₂N of them. The **compute tier** runs evolve and resolve as
  written and the FFT as `water::waves::fft_line`: a workgroup a line holds the line in workgroup
  memory and runs every stage there, the same butterflies in the same order, two dispatches in
  all. Per-stage dispatches took 0.75 ms; the line kernel 0.38 ms. WebGPU and baseline agree to
  0.000 mm RMS.
- `updateRate` (a cascade a frame) isn't built: the whole sea takes 0.38 ms.

### Shore and lakes

- Per vertex, waves attenuate by depth from the info texture: amplitude × `tanh(k·depth)`-weighted
  by cascade, and TMA reshapes the spectrum itself when `depth` is a number. *As built*, k is each
  cascade's own (`2π·4 / L`, a quarter of its patch), the same in `waterAt` and on the GPU.
- Shore foam (0097) adds the wave height near the shore. *As built* (0097's shore foam is its part
  2): the water pass foams where the water is shallower than half the sea's Hs, broken up by the
  slopes, on top of the cascades' own foam.
- Waves don't yet **shorten** toward the shore: an FFT sea has one wavelength per texel, and
  shortening by place needs the phase integrated across the shore, not a scaled lookup (which
  stretches the pattern with distance from the origin). Open.
- Far away, a cascade fades out between 15 and 30 of its patch lengths (Atlas's ~30 periods), and
  the fragment stage fades a cascade whose texels are smaller than a pixel, where its normals only
  alias. No tiling shows from 200 m up.
- Lakes use one cascade and a small fetch: chop, not swell.

### CPU evaluator

- `waterAt` (0097) sums the K strongest spectral components (default 128) across cascades as
  Gerstner-equivalent waves, with every sine and cosine from `sinCos` (0045), so its bytes are the
  same on every machine and on the server. *As built*, 64 components left 5.4% of a 15 m/s,
  300 km sea's height out (its spectrum has a long tail), past the 5% criterion; 128 leave 4%.
  Their ω and k are recomputed in f64 (the GPU's are f32), so every ω is a whole number of turns
  in 8192 s.
- Horizontal displacement means the surface at x came from somewhere else; it's inverted with 4
  fixed-point iterations (Atlas, Arc Blanc do the same). *As built*, the iterations sum the 16
  strongest components (they carry nearly all the displacement) and the height after them all
  128: 9 µs a call, allocating nothing.
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
  peak period of the spectrum. *As built*: a `waves` section (through `water/Describers`, which
  plugins add sections to) with each sea's Hs and peak period, the sampled and the evaluator's Hs,
  its wind, any crossfade, and per cascade its band (wavelengths), resolution and Hs; and the GPU's
  resolution, layers and `gpu:water-waves`.
- `water.waves { seed?, wind?, … }` previews a spectrum: Hs, peak period, and a PNG of the
  height field (the CPU evaluator's, over a square; MCP `preview_waves`).
- `render.capture { debug: 'water-cascades' | 'water-foam' }`: each cascade's heights, or foam,
  side by side.
- **Errors:** `water/bad-cascades` (lengths not decreasing, more than 4),
  `water/waves-need-ocean` (OceanWaves on a river or volume; part 1 of 0097 has neither yet), and
  `water/too-many-cascades` (warning: past 8 layers a body's sea doesn't draw).
- **Installation:** `oceanWavesPlugin()` after `waterPlugin()`; projects list `water/waves`, which
  includes `water`. The water pass picks the waves up through a `water/SurfaceWaves` hook and a
  `WAVES` define, so the surface's WGSL without waves is byte for byte 0097's.
- **Budgets:** `gpu:water-waves` (0.6 ms; 0.38 measured on an M5 Max) and `water/at-waves`
  (20 µs a call; 9 µs measured).

## Decisions

- **FFT for the picture, a reduced spectrum on the CPU for gameplay.** Realism where you look,
  determinism where it matters, from one spectrum.
- **One FFT, two tiers.** The butterflies are the same WGSL; only the dispatch differs. No Gerstner
  fallback is needed, since WebGL2 here always has float render targets.
- **Time from the tick, looped at 8192 s.** Clients agree without sending time, and f32 never loses
  precision.
- **No promise of a bit-exact GPU sea.** Boats are networked as state (0087), as Water Pro advises.

## Acceptance criteria

- [x] With wind 15 m/s and fetch 300 km, the CPU evaluator's significant wave height is within 10%
      of JONSWAP's (`Hs ≈ 4 √m0`) over 600 s of samples. (5.30 m against 5.65 m, 6% low:
      `water/src/waves/waves.test.ts`.)
- [x] The CPU evaluator's height is within 5% of Hs RMS of the GPU's at 1 000 points (readback).
      (4.1%: `water/src/waves/gpu.test.ts`.)
- [x] Two clients in `shard run --net clients=2` report identical `waterAt` at the same ticks, and
      their GPU heights agree within 1 mm (screenshot readback at the same tick). (`netHarness`,
      the harness behind `--net`, with 50 ms latency, jitter and 5% loss: the server and both
      clients report bit-identical `waterAt` at three points every tick from 560 to 780, through a
      gale scheduled for tick 600. Two apps at the same tick, after different numbers of frames:
      0 m apart on the GPU.)
- [x] Changing `Wind.speed` from 6 to 18 at tick 600 crossfades over 120 ticks with no frame
      where any vertex moves more than its wavelength / 10 (test). (Per cascade, the most a texel
      moves in a tick against a tenth of the cascade's shortest wave: 0.070 / 0.283, 0.008 / 0.083
      and 0.004 / 0.008 m, while the height changes 5.5 m over the fade.)
- [x] WebGPU and WebGL2 heights at the same tick agree within 1 mm RMS (golden readback).
      (0.000 mm RMS between the compute path and the baseline fragment path on Dawn's
      compatibility adapter; on WebGL2 the shim translates every wave kernel with naga and the
      `water` demo runs in Chromium, but nothing reads WebGL2's heights back.)
- [x] 3 cascades at 256² take under `gpu:water-waves` (proposed: 0.6 ms on `laptop`), and no tiling
      is visible from 200 m up (golden). (0.38 ms on an M5 Max; the `waves-from-200m` golden.)
- [ ] Waves shorten and shrink toward a sloping beach, with foam along it (golden). (They shrink
      and foam: RMS height 0.20, 0.085 and 0.019 m over water 10, 3 and 1 m deep, and the
      `waves-beach` golden. They don't shorten; see Shore and lakes.)

## Open questions

- A fourth "far swell" cascade for views from altitude? Proposed: allowed by `cascades`, off by
  default until a demo needs it.
- Should the CPU evaluator run off the main thread for many boats? Proposed: measure first; 64
  components × 16 points × 4 iterations per boat is small.
