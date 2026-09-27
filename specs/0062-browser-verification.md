# 0062 — Browser captures, approvals, and performance records

- **Status:** draft
- **Packages:** `@shard/verify` (new), `@shard/runtime`, `@shard/render`, `@shard/platform-web`,
  `apps/cli`
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

### Metrics

`@shard/verify/metrics`, installed by `metricsPlugin()`:

| Metric | How it's measured |
|---|---|
| `coldStart` | `performance.now()` from navigation start to `app.init()` resolved, split into `modules`, `device`, `pipelines` and `assets` |
| `firstUsableFrame` | from navigation start to the first frame presented after the host calls `app.markUsable()` (for Aether, once the scene is interactive) |
| `patchToFrame` | `app.trace(label)` stamps a host write. It resolves when the frame containing it is presented: submitted, `onSubmittedWorkDone`, then the next animation frame. Kept as a distribution |
| `frameTime` | p50, p95 and p99 of frame intervals over a sustained window (default 30 s), plus GPU frame time where `timestamp-query` exists |
| `longTasks` | `PerformanceObserver('longtask')`: the count, total and longest over the window |
| `gpuMemory` | `gpu.stats()` bytes: every buffer and texture Shard created, by category (0052, 0055) |
| `download` | transferred and decoded bytes of scripts, WASM and assets, from resource timing, next to 0056's build sizes |

`metrics.record(meta)` returns a `PerfRecord`:

```ts
interface PerfRecord {
  version: 1
  renderer: string                  // 'shard@<sha>' | 'three@0.160.1'
  fixture: string; scenario: string
  device: { ua: string; gpu: string; dpr: number; viewport: [number, number] }
  coldStart: {...}; firstUsableFrame: number
  patchToFrame: { p50: number; p95: number; n: number }
  frameTime: { p50: number; p95: number; p99: number; gpuP95?: number }
  longTasks: { count: number; totalMs: number; maxMs: number }
  gpuMemory: { bytes: number; byCategory: Record<string, number> }
  download: { transferred: number; decoded: number }
}
```

A JSON Schema for it ships under `.shard/schemas`, so Aether's three.js script can validate its own
output against it.

### Captures

`shard capture <plan.json>` launches Playwright with WebGPU enabled, opens the given URL (a Shard
project's `shard dev`, or a host page), and waits for a readiness signal (`window.__shardReady`,
set by `markUsable`). For each shot, it applies a state through a small page API (`__shardCapture.
apply(state)`: the camera, the active view, scene toggles) and waits for on-demand frames to go
idle (0052). It then takes a canvas-only screenshot, so DOM chrome is excluded unless the plan asks
for the page.

```json
{ "url": "http://localhost:5180/#tabletop", "browsers": ["chromium"], "dpr": [1, 2],
  "viewport": [1320, 720],
  "shots": [
    { "name": "map-close",   "state": { "view": "map", "zoom": 4, "target": [12, 0, 8] } },
    { "name": "map-far",     "state": { "view": "map", "zoom": 0.25 } },
    { "name": "table-oblique", "state": { "view": "tabletop", "pitch": 35, "yaw": 30 } },
    { "name": "dark",        "state": { "view": "tabletop", "lighting": "night" } },
    { "name": "missing",     "state": { "view": "map", "break": ["token-art"] } }
  ] }
```

### Fair comparison, thresholds, and full-page scenarios

A plan's `conditions` apply to every renderer in the run:

- `renderScale: { mode: 'fixed', scale: 1 }` sets Shard's `RenderScale` (0051) for the run, so
  dynamic resolution can't buy frame time with pixels. A three.js page is expected to pin its pixel
  ratio the same way, and the record stores both values.
- `dpr`, `viewport`, the browser build and the fixture are recorded in every `PerfRecord`.

`thresholds` hold the pass rules, per scenario and metric:

```json
"thresholds": { "tabletop-pan": { "frameTime.p95": { "max": 16.7 }, "longTasks.maxMs": { "max": 50 },
                                  "patchToFrame.p95": { "maxRatioTo": "three", "ratio": 1.0 } } }
```

A threshold can be absolute or relative to a baseline renderer in the same run. `shard perf-check
<records>` fails on any breach, and its report names the metric, the two values and the budget.

`scope: 'page'` captures and measures the whole Play page, not just the canvas: DOM labels, handles,
chat and dialogs are in the image and in the long-task count. `clients` runs several browser
contexts against one host session, each with a role and its own capture set. That's how a GM and a
player can be checked for different projections of the same scene, for example that the player's
capture shows fog where the GM's shows the hidden token. A plan's `steps` drive the host through its
own page API: spawning a bounded mod object, rolling 32 dice, switching views or scenes.

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

### Compare and approve

`shard compare <captures> --approved captures/approved` diffs each capture against its approved
image. The diff uses a perceptual metric (per-pixel ΔE2000 in Lab, reported as the share of pixels
over a threshold, plus SSIM), so dithering and driver noise don't count but a shifted grid line or
a lost shadow does. Each shot's tolerance lives in the plan. The report is an HTML page of
side-by-sides, diff heatmaps and numbers.

`shard approve <shot> --reason "…"` copies the capture into `approved/` and appends to
`approvals.json` `{ shot, hash, reason, by, date }`. An approval without a reason is refused. The
file shows in review: every visible change has a sentence next to it.

### Agent surface

- `shard capture`, `shard compare` and `shard approve` take `--json`.
- The protocol's `metrics.record` returns a `PerfRecord` from a running app, so an agent can
  measure after a change the same way the scripts do.

## Decisions

- **Real browsers for fidelity; Dawn stays for unit goldens.** Filtering, color management and
  canvas compositing differ from headless, and those are exactly what the gates ask about.
- **Perceptual diff with recorded approvals.** Exact pixels can't match across renderers. What
  matters is that every visible difference was seen and explained.
- **Aether runs the comparison.** It has both renderers and the fixtures. Shard's job is making the
  numbers comparable.

## Acceptance criteria

- [ ] `metricsPlugin` records every `PerfRecord` field in the playground, and the record validates
      against its schema.
- [ ] `patchToFrame` for a scripted token move matches, within one refresh period, the latency
      Playwright measures from outside by watching for the token's pixels to change.
- [ ] `shard capture` produces the same PNG hash twice in a row for a static shot in Chromium at
      DPR 1 and 2.
- [ ] `shard compare` flags a 1 px grid shift and a missing shadow, and passes a re-dithered
      identical frame.
- [ ] `shard approve` without `--reason` fails, and with it records the hash and reason.
- [ ] Canvas-only captures of a transparent dice surface (0052) keep alpha in the PNG.
- [ ] A run with `renderScale` fixed records scale 1 for every frame, and the controller never
      changes it.
- [ ] `shard perf-check` fails on a scripted breach of an absolute threshold and of a ratio
      threshold, and passes when both are met.
- [ ] A two-client plan (GM and player) against one session produces separate captures, and a page
      capture includes DOM elements drawn over the canvas.
- [ ] The visibility flow runs as a plan step sequence. A scripted fault (the player's client keeps
      a token after it leaves vision, or keeps an old-scene entity after a switch) makes the run
      fail, naming the step and the client.

## Open questions

- Should Firefox join `browsers` once its WebGPU ships in release? Proposed: yes, added to plans
  when it does, with no spec change.
