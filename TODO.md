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

## Tests that fail on Windows

CI runs Linux only, so these fail on a Windows checkout and nothing catches it. Each looks like a
real bug on Windows, not a flake:

- `save`, settings.test.ts (3 tests): `Storage key "settings.json" leaves the data folder`. The
  key check probably compares against a `/`-separated path.
- `node`, reload.test.ts: "a system that throws logs the project source line" (no source line)
  and "rebuilds and swaps star-explorer" (the bundle path is `.shard\build\…`, the test wants `/`).
- `cli`, cli.test.ts: both `shard check` tests (exit 2 instead of 1: `check` itself errors) and
  "dev serves the runner with an engine import map" (`/@fsC:/…`: the URL needs a `/` before the
  drive letter).
- `render`, render.test.ts: "captures a cleared view with correct pixels" reads 127 where it wants
  128, on D3D12 Dawn. Rounding of 0.5 differs by backend; the test could allow ±1.
- `terrain`, budget.test.ts: most runs generate no chunks at all over the 1,920-frame descent
  (`jobs` 0, expected over 200); one run alone passed. Not a time budget: nothing was generated.
  Lead: the jobs wait on something (a pipeline, the heightfield kernel) that never becomes ready
  under D3D12 Dawn, or `lastFrameJobs` is read before the frame that runs them.

To fix: each on its own, then a `windows-latest` CI job for the tests that don't need a GPU.

## Budgets this machine misses under `pnpm bench`

Seen on a Windows desktop (NVIDIA, 2026-09-29): noise's 6-octave fBm at 25M points/s (budget 40M),
UI layout of 2,000 nodes at 1.11 ms (budget 1 ms), and a shader edit that re-renders 16 frames
later (budget 2). Unrelated to recent changes (the same on 211d4aa). Either
the budgets are for faster hardware, or these regressed: worth bisecting before loosening them.

## CI speed

CI splits the tests across four runners (`scripts/test-shard.mjs`, balanced by
`scripts/test-weights.json`) and caches turbo's results, so an unchanged package replays its last
run. What's left:

- One file sets the floor: terrain's `detail.test.ts` took 10 minutes on a loaded runner. Splitting
  it (or shrinking what it renders on the software GPU) is the next win.
- Run only affected packages on pull requests (`turbo run test --affected`), and everything on main.

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
