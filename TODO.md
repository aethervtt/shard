# TODO

Known problems that aren't fixed yet. Each has what's known so far, so whoever picks it up doesn't
start over. Remove an entry in the change that fixes it.

## Skipped tests

### star-explorer: "the ship carries a laser; the heavy laser is a variant of it"

`examples/star-explorer/tests/main.test.ts`, skipped with `test.skip`.

- Fails about 1 full run in 8 when every package runs in parallel. It passes alone, and it passed
  15 minutes of runs under heavy CPU load on its own, so it needs the whole suite's contention to
  show up.
- The failing assertion was never captured. It reads `weapons.get(...)` for the laser and for its
  `upgradesTo` (the heavy laser) right after `game.load()`, so one of them isn't in its store yet.
- 0031 promises that handles are load dependencies (the heavy laser loads with the laser), and
  `loadEntry` does await them. There's no load cycle here: the heavy laser extends the laser, which
  is an import dependency, and its own `upgradesTo` is null.
- Lead: `game.load()` reloads the scene, and `reloadScene` runs `assetServer.collect()` right after
  spawning, while the scene's assets can still be loading. If collection decides the heavy laser
  is unreachable (the laser isn't in its store yet, so its handles aren't traced), it could unload
  it mid-load. That would be an engine bug, not a test bug.
- To fix: capture the failing assertion (a loop over `SHARD_CI=1 pnpm test --continue`, keeping
  the log of the first failure), confirm or rule out the collect race, then fix it with a test that
  forces the ordering.

## Budgets this machine misses under `pnpm bench`

On a Windows desktop (Ryzen 9 9950X3D, RTX 5060 Ti, D3D12 Dawn, 2026-09-29). None is a regression:
each misses by the same amount at the commit that set its budget.

- Noise, 6-octave fBm: 24.7M points/s (budget 40M), steady across runs; 28.3M on Node 22, 24–25M on
  24, 25, and 26. The `.wasm` hasn't changed since 0041 set the budget (e1c56ec), and V8 is already
  on TurboFan (`--no-liftoff` gives the same). The spec's 40–42M came from "the bench machine".
  Lead: `f32x4.min`/`max` (NaN-propagating) and `i32x4.trunc_sat_f32x4` in `lanes.rs` are one
  instruction on ARM NEON and several on x86 SSE, so the budget may only hold on ARM.
- UI layout of 2,001 nodes: bimodal, about 0.83 ms or 1.2 ms from run to run, the same at 49ddb15
  (0036) and now. Likely which CCD the process lands on (this CPU's two differ in clock and cache).
- Shader edit to re-render: 11–25 frames (budget 2), the same at e1c56ec. It waits for one pipeline
  compile, about 370 ms on D3D12; the budget assumes one under ~33 ms. This Dawn build finds no
  Vulkan adapter here, so D3D12 wasn't compared against Vulkan on the same GPU.

Decide per budget: hold it to the bench machine, or state what hardware each assumes.

On a MacBook (Apple M4, Metal Dawn, 2026-10-04):

- Cutaways (0070), 16 reveal points on the max fixture at 1280×720: +8–11% GPU time (budget 5%),
  measured as the median of interleaved rounds (`structure/src/cutaway.test.ts`); not measured on
  the Windows desktop. What's known: with the points cutting nothing it's +1% (only batches whose
  bounds reach a line of sight take the discarding variant), and one point costs nothing measurable.
  The rest is the cut chunks: a `discard` costs a tiled GPU its hidden-surface removal, so what's
  behind a cut wall is shaded too. Drawing those batches after the rest didn't change it. Lead: draw
  the cut batches depth-only (with the discard) first, then everything without one, cut batches at
  `depthCompare: 'equal'`. That needs `@invariant` clip positions, so the core shaders' code would
  change.

On the same MacBook (2026-10-07):

- GPU foliage (0045), 2.2M grass blades in view within 60 m at 960×540: about 18 ms of GPU time
  (budget 3 ms on the reference GPU; `scatter/src/bench.test.ts`); not measured on the Windows
  desktop. What's known: it was 70 ms before LODs (fewer, wider blades past 18 m and 36 m) and
  casting only into the nearest cascade; at 96×54 it's 8.7 ms, so about half is vertex work (12M
  vertices through the material's hooks) and half shading on overlapping blades. A cheaper wind
  sway changed nothing. Leads: compute each visible instance's transform once in the cull pass
  instead of per vertex (costs a buffer per visible instance), and shade the farthest level with a
  simpler material.

## CI speed

CI splits the tests across four runners (`scripts/test-shard.mjs`, balanced by
`scripts/test-weights.json`) and caches turbo's results, so an unchanged package replays its last
run. What's left:

- One file sets the floor: terrain's `detail.test.ts` took 10 minutes on a loaded runner. Splitting
  it (or shrinking what it renders on the software GPU) is the next win.
- Run only affected packages on pull requests (`turbo run test --affected`), and everything on main.

## WebKit captures (0062)

Playwright's WebKit (26.6) on Windows launches but has no `navigator.gpu` at all, even on a secure
localhost page: runs skip it ("no WebGPU in this build") and Chromium's shots still come through.
Not tried on macOS, where Safari ships WebGPU, or Linux. CI's browser job runs Chromium only.

## Gamepads don't wake an on-demand app (0052)

Gamepads are polled when the input plugin drains its source, and the Gamepad API has no event for
button or stick changes, so an idle `mode: 'on-demand'` runner never sees them. Keyboard, mouse,
touch and wheel wake it through `InputSource.onInput`. A game that plays with a gamepad holds a
frame demand while one is connected, or the input plugin could hold one itself (poll at a low rate
with `FrameDemand.after` while any pad is connected, full rate while one moved recently).

## Headless runs have no frames-in-flight limit

`app.update()` on an offscreen target submits GPU work without waiting, so a loop on a slow GPU
queues unbounded work. The terrain tests left 25 s of it for their cleanup to drain on software
Vulkan, and `shard run --frames 600` on a slow machine would pile up the same way. Browsers pace
frames with `requestAnimationFrame`. Belongs with 0052's frame pacing: cap frames in flight (2 or 3)
in the headless runner.

