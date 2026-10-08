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

## Budget misses (0075)

Scenario slices a machine doesn't meet. `bench/perf/budgets.json` overrides each on that machine
at what it measured, with a note; remove the override and the entry when the miss is fixed.

### scatter-walk's GPU frame on the laptop (2026-10-08)

- By ablation, `gpu:forward-opaque` costs 10.81 ms and `gpu:shadows` 12.81 ms at 1080p
  (`scatter/src/scenario.test.ts`): together past the 16.6 ms frame. The laptop overrides both
  (12 and 14 ms).
- Lead: shadows, 4 cascades over the forest's trees and props, redrawn every frame while foliage
  sways (0045). Then the opaque pass: terrain, rocks, bushes and trees.

### planet-descent's terrain/select on the laptop (2026-10-08)

- `terrain/select` is 5.6 ms p95 in the Earth descent (`terrain/src/scenario.test.ts`) against a
  0.8 ms slice, and puts the CPU frame at 8.25 ms against 8. The laptop overrides it at 6.2 ms.
- Lead: terrain/select at 5.6 ms in the descent; capture it (`shard profile`, or the scenario
  test's capture) to see whether it's the quadtree walk or the frames where selection changes most.

### tabletop-max's CPU frame (2026-10-08, a local probe, not a bench run)

- At 1080p a frame of the max fixture takes about 250 ms of CPU on the laptop:
  `render/shadows/cascades` encodes for about 160 ms and `forward-opaque` for 40. Its split is
  still a proposal: the first bench timed out before measuring it.
- Lead: per-batch draw encoding for thousands of structure chunks in four cascades (0022's note on
  one indirect draw per live batch).

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

