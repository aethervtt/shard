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

## Flaky only in local `pnpm test`

These miss their 3× time budgets now and then when every package runs in parallel on one machine.
`pnpm bench` (serial) and CI (`SHARD_CI`, budgets off) don't see them, but a local red run still
costs a rerun.

- `physics`: "runs physics for 5,000 awake bodies in under 8 ms per step"
- `nav`: "findPath on a 256×256 maze grid takes under 2 ms"
- `node` (procgen): "under 2 ms of main-thread procgen work per frame"
- `audio`: "48 moving spatial sources: under 0.1 ms a frame"

Options: run perf tests in their own serial turbo task, or make `pnpm test` skip time budgets and
leave them to `pnpm bench` alone, as CI already does.

## CI takes about 22 minutes

One job runs lint, typecheck and every test on a 4-core runner rendering on a software GPU. The GPU
tests dominate (terrain alone is several minutes).

- Cache turbo's task outputs between runs (`actions/cache` on `.turbo`), so packages that didn't
  change don't rerun.
- Split the job: lint and typecheck in one, tests sharded across several runners by package.
- Run only affected packages on pull requests (`turbo run test --affected`), and everything on main.

## Headless runs have no frames-in-flight limit

`app.update()` on an offscreen target submits GPU work without waiting, so a loop on a slow GPU
queues unbounded work. The terrain tests left 25 s of it for their cleanup to drain on software
Vulkan, and `shard run --frames 600` on a slow machine would pile up the same way. Browsers pace
frames with `requestAnimationFrame`. Belongs with 0052's frame pacing: cap frames in flight (2 or 3)
in the headless runner.
