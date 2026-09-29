# 0062 — Browser captures, approvals, and performance records

- **Status:** accepted
- **Packages:** `@aethervtt/shard-verify` (new), `@aethervtt/shard-runtime`, `@aethervtt/shard-render`,
  `@aethervtt/shard-gpu`, `@aethervtt/shard-assets`, `@aethervtt/shard-platform`,
  `@aethervtt/shard-platform-web`, `apps/cli`, `apps/playground`
- **Depends on:** 0012, 0052, 0056

## Context

Shard's golden images come from headless Dawn, which is right for regression tests but isn't what
a player sees. Replacing Aether's three.js renderer needs evidence from real browsers:

- captures at close and distant Map zoom, oblique Tabletop angles, light and dark scenes, and pixel
  ratios 1 and 2, with texture filtering, transparent edges, grid depth, color, shadows and
  missing-asset fallbacks each approved, and a reason recorded for any visible change;
- measured numbers on the same devices and fixtures as the current renderer: cold start, first
  usable frame, patch-to-visible latency, sustained p95 frame time, long tasks, GPU memory and
  download size.

Pixel identity with three.js isn't the goal. The goal is that a difference is seen and either
approved with a reason or fixed.

The comparison runs in Aether, which has both renderers. Shard provides the instruments, the
capture tool and the record format, so both renderers report the same numbers the same way.

## Goals

- Engine metrics for each of the numbers above, with the same names on every host.
- `shard capture`: scripted captures in real browsers (Chromium; WebKit where it has WebGPU) at
  given sizes, pixel ratios and camera states.
- `shard compare`: perceptual diffs against approved captures, an HTML report, and approvals that
  carry a reason.
- A versioned `perf-record.json` format, which Aether's three.js path can write too.
- Comparison conditions that are fair by construction: a fixed render scale, the same fixtures,
  and pass thresholds in the plan that make a run fail.
- Full-page runs, not just canvases: DOM labels and handles, several clients with different
  roles, and host scenarios such as a bounded mod object or a 32-die roll.

## Non-goals

- Picking the budget numbers. The host sets them in its plans (Aether, from its first recorded runs
  of the three.js path). This spec makes them enforceable.
- A device lab. Runs happen on the machines people have; the record says which.

## Design

### Presentation and startup (runtime)

`App` gets the hooks the metrics are built on, so a host calls them whether or not metrics are
installed:

- `app.markUsable()`: the host says the scene is interactive. The first complete frame presented
  after it is the first usable frame (`app.startup.usable`, `app.whenUsable()`).
- `app.trace(label)`: stamps a host write and resolves with the ms until the frame carrying it is
  presented. The next frame to start carries every trace stamped before it. `app.onTrace` sees each
  result.
- `app.whenPresented()`: the same wait, which no trace listener sees. Tools waiting on the screen
  use it, so their waits don't count as host writes.
- `app.startup`: `initStart`, `initEnd`, `usableMarked` and `usable`, on the app's clock.
- **Presented** means the frame's work was submitted, `onSubmittedWorkDone` resolved, and the next
  animation frame began. The render plugin installs this as the app's presenter
  (`app.setPresenter`). It resolves with that animation frame's timestamp, not with the time its
  callback ran, since other callbacks in the same frame run first. Headless, the GPU finishing is
  the whole of it. Without a renderer, a frame is presented when it ends.
- **Complete** means the frame didn't hold `LOADING_DEMAND` (`render/loading`: a draw skipped
  because a pipeline was compiling or a mesh or material was loading). A frame that did hands its
  traces and the usable mark to the next one. Latency therefore runs until the write is actually
  visible, and the first usable frame isn't the half-drawn one that starts compiling shaders.

### Metrics

`@aethervtt/shard-verify/metrics`, installed by `metricsPlugin({ performance, windowMs, renderer })`.
The host's own instruments come through `Platform.performance` (`HostPerformance`:
`userAgent`, `onLongTask`, `downloads`). `createWebPerformance()` in `@aethervtt/shard-platform-web`
implements them with a buffered `longtask` observer and resource timing, and three.js pages can use
it too.

| Metric | How it's measured |
|---|---|
| `coldStart` | `total`: navigation start to `app.init()` resolved. `modules`: navigation start to `init()` called. `device`: the GPU adapter and device request (`gpu.deviceMs`), wherever it was made. `pipelines` and `assets`: wall time some pipeline compile (`gpu.pipelines.busyMs`) or asset load (`AssetServer.busyMs`) was in flight until the first usable frame. Overlapping work counts once, and the phases overlap each other |
| `firstUsableFrame` | navigation start to the first complete frame presented after `app.markUsable()` |
| `patchToFrame` | `app.trace(label)` latencies over the window, as p50, p95 and n |
| `frameTime` | p50, p95 and p99 of intervals between consecutive frames over the window (default 30 s). An on-demand frame after an idle gap starts no interval. `gpuP95` comes from `timestamp-query` where it exists |
| `longTasks` | from `HostPerformance.onLongTask`: the count, total and longest over the window |
| `gpuMemory` | `gpu.memory()`: every live buffer and texture Shard created, by what its usage flags say it's for (`targets`, `textures`, `geometry`, `storage`, `uniforms`, `staging`, `other`). 0055's upload categories can refine this once they exist |
| `download` | transferred and decoded bytes of the document and every resource, from resource timing |
| `renderScale` | the `RenderScale` mode, and the smallest and largest scale any frame of the window ran at |

Recording into the metrics each frame allocates nothing. `metrics.reset()` starts a new window, and
`metrics.record(meta)` returns a `PerfRecord`. Before the first usable frame it throws
`verify/not-usable`.

```ts
interface PerfRecord {
  version: 1
  renderer: string                  // 'shard@<sha>' | 'three@0.160.1'
  fixture: string; scenario: string
  device: { ua: string; gpu: string; dpr: number; viewport: [number, number] }
  renderScale: { mode: 'fixed' | 'auto' | 'none'; min: number; max: number }
  coldStart: { total: number; modules: number; device: number; pipelines: number; assets: number }
  firstUsableFrame: number
  patchToFrame: { p50: number; p95: number; n: number }
  frameTime: { p50: number; p95: number; p99: number; n: number; gpuP95?: number }
  longTasks: { count: number; totalMs: number; maxMs: number }
  gpuMemory: { bytes: number; byCategory: Record<string, number> }
  download: { transferred: number; decoded: number }
}
```

`shard docs` writes its JSON Schema to `.shard/schemas/perf-record.schema.json`, next to
`capture-plan.schema.json`. Aether's three.js script can validate its own output against it.
`validateJson` checks a value against the keywords these schemas use, so `perf-check` reads records
through the same schema.

### Captures

`shard capture <plan.json> [--out captures/latest]` runs a plan with Playwright. Chromium runs as
the full browser in its new headless mode (`channel: 'chromium'`), because the headless shell has no
WebGPU adapter. It launches once per DPR with `--force-device-scale-factor` on top of the context's
`deviceScaleFactor`: emulation alone reports `devicePixelRatio` 2 with a device-pixel box of CSS
size, so the canvas would render at 1× and be scaled. A browser that won't launch or has no WebGPU
adapter is skipped and listed in the run's `skipped`. A plan that no browser could run fails with
`verify/no-browser`.

The page installs `installCapturePage(apps, { apply, steps, probe })` from
`@aethervtt/shard-verify/page`. That sets `window.__shardCapture`, and sets `window.__shardReady`
once every app has presented its first usable frame. `shard dev`'s runner adds `metricsPlugin` and
the page API, and calls `markUsable` once the start scene is loaded. For each shot, the tool applies
the state, waits for idle, and takes the image:

- **Idle** means no pipeline compiling, no `render/loading`, and on-demand apps asleep with no
  holders. Then one more complete frame is waited for (`whenPresented`).
- **Canvas scope** (the default) takes the canvas's own pixels with `canvas.toBlob`: straight alpha
  in a PNG, with no page behind it. A premultiplied (0.5, 0, 0, 0.5) clear comes out as
  (255, 0, 0, 127).
- **Page scope** is a viewport screenshot, DOM included.

Output: `<out>/<browser>/<client>/<shot>@<dpr>x.png`, `records/<scenario>/<browser>@<dpr>x-<client>.json`,
and `manifest.json`, which lists every shot with its size, SHA-256 and tolerance, the steps and
their failed checks, the records, and what was skipped.

```json
{ "url": "http://localhost:5180/verify.html", "browsers": ["chromium"], "dpr": [1, 2],
  "viewport": [1320, 720], "canvas": "#table",
  "shots": [
    { "name": "map-close",   "state": { "view": "map", "zoom": 4, "target": [-2.5, 0, 1.5] } },
    { "name": "map-far",     "state": { "view": "map", "zoom": 0.25 } },
    { "name": "table-oblique", "state": { "view": "tabletop", "pitch": 35, "yaw": 30 } },
    { "name": "dark",        "state": { "view": "tabletop", "lighting": "night" } },
    { "name": "missing",     "state": { "view": "map", "break": ["token-art"] } },
    { "name": "dice",        "canvas": "#dice" },
    { "name": "page",        "scope": "page" }
  ] }
```

### Fair comparison, thresholds, and full-page scenarios

A plan's `conditions` apply to every renderer in the run:

- `renderScale: { mode: 'fixed', scale: 1 }` sets Shard's `RenderScale` (0051) for the run with
  `patchResource`, so dynamic resolution can't buy frame time with pixels. The record's
  `renderScale` shows that every frame ran at it. A three.js page is expected to pin its pixel ratio
  the same way, and the record stores both that and the DPR.
- `dpr`, `viewport`, the browser build (in `ua`) and the fixture are recorded in every `PerfRecord`.

`thresholds` hold the pass rules, per scenario and metric path:

```json
"thresholds": { "tabletop-pan": { "frameTime.p95": { "max": 16.7 }, "longTasks.maxMs": { "max": 50 },
                                  "patchToFrame.p95": { "maxRatioTo": "three", "ratio": 1.0 } } }
```

A threshold is absolute (`max`, `min`) or relative to a baseline renderer in the same run
(`maxRatioTo`, `ratio`). `shard perf-check <records...> --plan plan.json` applies them and exits 1
on any breach. Records and directories of records are both accepted. The report names the metric,
the two values and the budget. Absolute rules apply to every renderer that isn't a ratio baseline
in that scenario. A ratio rule compares with the baseline's record of the same scenario and fixture,
on the same device if the run has one. It fails when there's no baseline record, or when the metric
is missing.

`scope: 'page'` captures the whole page, not just the canvas. DOM labels, handles, chat and dialogs
are in the image, and in the long-task count. `clients` runs several browser contexts, each with a
`role` (passed as `?role=`), extra `query` parameters, and its own shots. `steps` drive the host
through its page API:

```json
{ "name": "out-of-vision", "run": "move", "args": { "name": "goblin", "to": [-6.5, 6.5] },
  "trace": true, "capture": true,
  "expect": { "gm": { "entities": { "includes": ["goblin"] } },
              "player": { "entities": { "excludes": ["goblin"], "sameAs": "fresh.entities" } } } }
```

A step runs in its `clients` (default all), in order. Then every client goes idle, and its
`probe()` result is checked against the step's `expect` for that client: a dotted path to a matcher
(`equals`, `includes`, `excludes`, `min`, `max`, `sameAs` another path). With `trace`, the step is
stamped with `app.trace`, and `step.latencyMs` is there to check. With `capture`, each client takes
a shot named after the step. A failed check names the step, the client, the path and what was
wrong. It doesn't stop the run, and a run with failures exits 1. `scenarios` reset every client's
metrics, run their steps, wait `seconds`, and record.

A replacement plan for Aether covers at least:

- the full Play page, at DPR 1 and 2;
- a GM and a player client;
- a bounded mod object;
- the 32-die path;
- Map and Tabletop views, with render scale fixed at 1;
- **a mandatory visibility flow.** The GM moves a token into the player's server-projected vision,
  then out of it. Then the session switches scenes, and both clients disconnect and reconnect. At
  each step, both clients' captures and entity sets are checked:
  - the player's world gains the token when it's projected and loses it when it isn't;
  - fog follows the new vision within the patch-to-frame budget;
  - the GM's view is unaffected;
  - after the scene switch, nothing from the old scene remains (0061 owner counts at baseline);
  - after the reconnect, each client matches a fresh load of the same state, and only documents
    that changed while it was away were re-applied (0055 mirror counts).

  The flow must pass for a replacement decision; the other scenarios inform it.

Shard's own fixture for all of this is the playground's `verify.html`, with plans in
`apps/playground/plans/` (`tabletop.json`, `visibility.json`). It's a tabletop with a textured grid,
tokens with transparent edges and shadows, day and night, map and tabletop views, a missing-asset
fallback, DOM labels, and a transparent dice surface. It has no server: every client applies the
same steps to its own copy of the session, and its world is that copy's projection for its role.
`?fault=keep-token` and `?fault=keep-scene` break the player's projection on purpose. Its probe
reports stand-ins for 0061's owner counts and 0055's mirror counts until those exist.

### Compare and approve

`shard compare [captures] [--approved captures/approved] [--report file]` diffs each capture against
its approved image:

- **The metric** is per-pixel ΔE2000 in Lab, reported as the share of pixels over a threshold, plus
  mean SSIM over 8×8 windows of luminance. Pixels are compared composited over black and over white,
  and the larger ΔE wins, so alpha changes count too. Dithering and driver noise don't count, but a
  shifted grid line or a lost shadow does.
- **Tolerance** is per shot in the plan: `deltaE` (default 2.3, one just-noticeable difference),
  `maxShare` (0.001) and `minSsim` (0.98).
- **Outcome.** A shot with no approved image is `new`, and fails like a changed one; the command
  exits 1 on either.
- **The report** is `report.html`: side-by-side images, heatmaps (written to `diff/`), the numbers,
  and each shot's latest approval.

`shard approve <shot> --reason "…" [--captures dir] [--approved dir] [--by name]` copies the capture
into `approved/` and appends `{ shot, hash, reason, by, date }` to `approvals.json`. `by` defaults to
git's `user.name`. An approval without a reason is refused (`verify/approval-needs-reason`) before
anything is written. The file shows in review: every visible change has a sentence next to it.

### Agent surface

- `shard capture`, `shard compare`, `shard approve` and `shard perf-check` take `--json`.
- The protocol's `metrics.record` returns a `PerfRecord` from a running app, and `metrics.reset`
  starts a window. They're MCP tools `metrics_record` and `metrics_reset`, so an agent can measure
  after a change the same way the scripts do.
- The generated `check-in-browsers` skill walks through the loop.

## Decisions

- **Real browsers for fidelity; Dawn stays for unit goldens.** Filtering, color management and
  canvas compositing differ from headless, and those are exactly what the gates ask about.
- **Perceptual diff with recorded approvals.** Exact pixels can't match across renderers. What
  matters is that every visible difference was seen and explained.
- **Aether runs the comparison.** It has both renderers and the fixtures. Shard's job is making the
  numbers comparable.
- **Presentation hooks live in the runtime, the instruments in `verify`.** A host calls
  `markUsable` and `trace` in production code whether or not metrics are installed, and they cost
  nothing without traces pending. The percentiles, rings and records are a plugin.
- **A frame still loading doesn't count as presented.** Found building it: counted, the first
  usable frame came 130 ms after init, before any shader loaded, and `coldStart.pipelines` read 0.
- **Presentation time is the animation frame's timestamp.** Taking "now" in its callback measured
  up to 7.7 ms late on a 165 Hz display, which is more than a refresh. With the timestamp, the
  page's latency lands within a refresh of the compositor frame that first shows the change.
- **Canvas shots come from `toBlob`, not an element screenshot.** An element screenshot composites
  the page behind a transparent canvas, and the alpha is lost.
- **One Chromium launch per DPR.** Chromium's DPR emulation alone renders canvases at 1×, see
  Captures.
- **GPU memory by usage flags.** Labels are free-form (`${view}/${name}`), usage flags aren't.

## Acceptance criteria

The browser criteria run in `apps/playground/src/verify.test.ts` against Chromium with a WebGPU
adapter (`pnpm exec playwright install chromium`). CI runs them in its browser job, on Mesa's
software Vulkan driver. The patch-to-frame criterion is a timing check, so it holds under
`pnpm bench` only.

- [x] `metricsPlugin` records every `PerfRecord` field in the playground, and the record validates
      against its schema.
- [x] `patchToFrame` for a scripted token move matches, within one refresh period, the latency
      Playwright measures from outside by watching for the token's pixels to change.
- [x] `shard capture` produces the same PNG hash twice in a row for a static shot in Chromium at
      DPR 1 and 2.
- [x] `shard compare` flags a 1 px grid shift and a missing shadow, and passes a re-dithered
      identical frame.
- [x] `shard approve` without `--reason` fails, and with it records the hash and reason.
- [x] Canvas-only captures of a transparent dice surface (0052) keep alpha in the PNG.
- [x] A run with `renderScale` fixed records scale 1 for every frame, and the controller never
      changes it.
- [x] `shard perf-check` fails on a scripted breach of an absolute threshold and of a ratio
      threshold, and passes when both are met.
- [x] A two-client plan (GM and player) against one session produces separate captures, and a page
      capture includes DOM elements drawn over the canvas.
- [x] The visibility flow runs as a plan step sequence. A scripted fault (the player's client keeps
      a token after it leaves vision, or keeps an old-scene entity after a switch) makes the run
      fail, naming the step and the client.

## Open questions

- Should Firefox join `browsers` once its WebGPU ships in release? Proposed: yes, added to plans
  when it does, with no spec change.
