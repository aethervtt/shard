# 0074 — Profiler: spans, captures and traces

- **Status:** accepted
- **Packages:** `@aethervtt/shard-core`, `@aethervtt/shard-runtime`, `@aethervtt/shard-render`,
  `@aethervtt/shard-gpu-webgl2`, `@aethervtt/shard-platform`, `@aethervtt/shard-protocol`,
  `@aethervtt/shard-verify`, `apps/cli`, `apps/playground`
- **Depends on:** 0003, 0005, 0011, 0012, 0013, 0041, 0055, 0062, 0064

## Context

Shard measures a lot already. The scheduler times every system into `core/Profiler`, a ring of
120 samples per name. `GpuTimer` times every render-graph pass with `timestamp-query`. The 0055
ledger counts GPU memory and uploads by category, and 0062's perf records hold frame-time
percentiles. Little of it gets out, though. No protocol method returns timings: an agent reads
fragments from `render.describe` or the raw ring through `resource.get`. There's no frame or
schedule total, no timeline, no GPU timing on WebGL2, and no trace a human can open.

A ring of averages answers "what's expensive on average". It can't answer the questions that
matter when something stutters: what happened in the one frame that took 40 ms, and which work
ran long in it. Streaming (0071–0073) makes that the common question. Spawns, page uploads and
asset loads are spiky by nature.

This spec keeps the cheap always-on aggregates and exposes them. It adds **captures**: a span
timeline over N frames across the main thread, workers and the GPU, returned as a summary an agent
can act on ("frame 212 took 31 ms; `partition/spawn` ran 18 ms against a 0.4 ms median") and as
a Chrome Trace Event file that opens in Perfetto. Sampling profilers are borrowed from V8, not
built.

## Goals

- `perf.describe`: per-system, per-schedule and per-frame CPU time, GPU per pass and per frame,
  GPU memory from the ledger, JS heap, and clock resolution. Through the protocol, MCP and
  `shard profile`.
- A span API for code inside systems that allocates nothing.
- Captures of N frames, or a rolling window kept until a hitch, with a summary that attributes the
  worst frames to the spans that grew, and a trace file for Perfetto and `chrome://tracing`.
- Worker jobs and GPU passes on their own tracks, aligned to the main thread's timeline.
- Accurate browser clocks: `shard dev` and the playground serve cross-origin isolated pages.
- Sampling: `--cpu-prof` in Node, and the JS Self-Profiling API in browsers that allow it.
- GPU timing on WebGL2 where `EXT_disjoint_timer_query_webgl2` exists.
- Perf records (0062) carry a breakdown, so `shard perf-check` names the span that regressed.

## Non-goals

- A profiler UI. Studio's (M9) reads the capture format defined here, and until then Perfetto is
  the viewer.
- A sampling profiler of our own. V8's and the browser's are better.
- GPU hardware counters (occupancy, cache misses). WebGPU doesn't expose them.
- Network profiling, and leak detection beyond heap and ledger totals.

## Design

### Clocks

- In a page that isn't cross-origin isolated, `performance.now()` is coarsened: to 100 µs in
  Chrome and as coarse as 1 ms elsewhere. Most systems run in less than that, so their timings
  are noise. Isolated pages get 5 µs in Chrome.
- `shard dev`, the playground and `shard capture`'s server send `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: credentialless`, so their pages are isolated.
- The profiler measures its clock's resolution at startup (the smallest non-zero step over a
  short spin). `perf.describe` reports it with `isolated`, and marks timings under four steps as
  `coarse`. A host that embeds Shard (0052) keeps its own headers, so its timings are coarse but
  never wrong.

### Spans

```ts
const ENCODE = defineSpan('terrain/encode')   // a name; interned per Profiler on first use
const t = profiler.begin(ENCODE)
// … work …
profiler.end(t)
profiler.record(ENCODE, ms)                   // for time measured elsewhere (GPU, workers)
```

- `defineSpan` returns a plain `{ name, id: -1 }` and registers nothing. The first `begin` interns
  the name into a `u16` id and allocates its ring. After that a span is two `now()` calls, a stack
  push and pop (an `Int32Array` of depth 64), and three array writes.
- An unbalanced `end` logs `perf/span-mismatch` once per span name and resets the stack at the
  frame boundary.
- `profiler.record(name: string, ms)` keeps working for existing callers and interns the string.
- **Automatic spans.** Packages add their own (`terrain/select`, `partition/spawn`, and so on),
  but these names are fixed. They're the contract with 0075, whose budget keys are span names:

  | Span | Track | What it times |
  |---|---|---|
  | `frame` | main | One `App.update`, once a frame |
  | `schedule/<Label>` | main | One run of a schedule: `schedule/First`, `schedule/PreUpdate`, `schedule/FixedUpdate` (once per fixed step), `schedule/Update`, `schedule/PostUpdate`, `schedule/Last`, `schedule/Startup`, and state schedules by their label's name |
  | `<system name>` | main | One run of a system, by its name, as today |
  | `commands/<Label>` | main | Command application across one run of that schedule, recorded once per run |
  | `render/<node>` | main | A render-graph node's CPU encode (pass begin, `run`, pass end), summed over views, once a frame per node that ran |
  | `assets/apply` | main | Asset results applied in `First` |
  | `gpu:frame` | GPU | First pass start to last pass end, as today |
  | `gpu:<node>` | GPU | A render-graph pass, as today |
  | `gpu:span/post`, `gpu:span/ssao` | GPU | The pass groups `GpuTimer` already times |
  | `worker/<kind>` | worker | One pool job, timed inside the worker |

  A key **covers** a span when it equals the name or is a prefix of it ending at a `/`: `gpu:foliage`
  covers `gpu:foliage/place` and `gpu:foliage/cull`, and `render` covers every `render/*` span. Time
  covered twice (a `render/<node>` span inside the `render/execute-graph` system) counts once.
- **Aggregates are always on**, kept per id as now: last, average and max over 120 frames, plus
  p95. `ProfilerSettings { enabled: true, window: 120 }` turns the whole profiler off for builds
  that want every microsecond.

### Tracks

- **Main**: everything above, nested.
- **Workers**: the pool (0041) times each job inside the worker and returns `(kind, start,
  duration)` with the job's result, so it costs no extra messages. Times are converted to the main
  timeline with the difference between the two contexts' `performance.timeOrigin`.
- **GPU**: `GpuTimer`'s pass timings, tagged with their frame. WebGPU's clock isn't linked to the
  CPU's, so a frame's GPU spans are placed starting at that frame's submit time. The trace marks
  the track as approximate. Chrome quantizes timestamps to 100 µs unless WebGPU developer features
  are on. The profiler detects quantized values and reports `gpuQuantized`.
- **Async**: work that starts in one frame and ends in another (an asset load, a cell read, a page
  fetch) is an async span with `profiler.beginAsync(SPAN, key)` and `endAsync(SPAN, key)`.
- **GC**: in Node during a capture, a `PerformanceObserver` on `gc` entries adds collections and
  their pauses. Browsers don't expose this.

### Captures

```ts
perf.capture({ frames: 300 })                                   // the next 300 frames
perf.capture({ until: { frameMs: 50 }, before: 120, after: 30, timeout: 60 })  // flight recorder
```

- A capture preallocates its event buffer when it starts: 16 bytes an event (start `f64`,
  duration `f32`, id `u16`, track `u8`, depth `u8`), 2²⁰ events (16 MB) by default. When the
  buffer fills, recording stops and the summary says `truncated`. Nothing is allocated per frame.
- **Flight recorder.** `until` keeps a rolling window and stops `after` frames past the first
  frame over `frameMs`. That catches a hitch nobody can time by hand.
- The result is a summary and a trace:

```ts
interface CaptureSummary {
  frames: { count: number; cpu: Stats; gpu?: Stats; interval: Stats }   // Stats: p50, p95, max
  clock: { resolutionMs: number; isolated: boolean; gpuQuantized: boolean }
  top: SpanStats[]       // 20 spans by total time: track, calls, total, per-frame p50/p95/max
  worst: {               // the 5 slowest frames
    frame: number; cpuMs: number; gpuMs?: number
    over: { span: string; ms: number; medianMs: number }[]   // the spans most above their median
  }[]
  memory: { gpu: { bytes: number; byCategory: Record<string, number> }; heap?: HeapStats }
  truncated: boolean
}
```

- `worst[].over` is the part that matters for agents. It lists the spans that ran longer than
  usual in that frame, not just the long ones, so a frame where `partition/spawn` jumped from
  0.4 ms to 18 ms names it, even if the render passes took longer in absolute terms.
- The trace is Chrome Trace Event JSON: `X` events for spans, `b`/`e` for async spans, a thread
  per track, and frame numbers in `args`. It goes to `.shard/captures/<timestamp>.trace.json` on
  hosts that can write the project, and is returned inline otherwise. Perfetto and
  `chrome://tracing` open it.
- `devtools: true` also emits each span as `performance.measure` with `detail.devtools` track
  data, so Chrome's Performance panel shows Shard tracks next to its own sampling. It allocates,
  so it's off unless asked for.

### Sampling

- **Node:** `shard run --cpu-prof` and `shard test --cpu-prof` start the runner with V8's
  `--cpu-prof` and write a `.cpuprofile` next to the trace (DevTools and speedscope open it).
  `perf.capture { sample: true }` in Node uses `node:inspector`'s profiler for the capture window
  and adds the 20 hottest functions to the summary.
- **Browser:** `sample: true` uses the JS Self-Profiling API (`new Profiler({ sampleInterval:
  1 })`), which needs a `Document-Policy: js-profiling` header. The dev server and playground send
  it. Samples go into the trace, with the hottest functions in the summary. Where the API is
  missing, the summary carries `perf/sampling-unavailable`.

### GPU timing on WebGL2

- `@aethervtt/shard-gpu-webgl2` offers `timestamp-query` when `EXT_disjoint_timer_query_webgl2`
  exists. A pass's `timestampWrites` becomes a `TIME_ELAPSED_EXT` query around the pass (passes
  don't overlap, so queries don't nest). `resolveQuerySet` writes the begin as 0 and the end as the
  elapsed time, so `GpuTimer` works unchanged.
- Results arrive frames later, like WebGPU readbacks. `GPU_DISJOINT_EXT` drops that frame's
  results. Without the extension, `perf.describe` reports `gpu: 'unavailable'`.

### Memory

- **GPU:** the ledger's totals by category and owner (0055). `GpuMemory` in `render.describe`
  switches from textures only to the ledger's total, so the two numbers agree.
- **JS heap:**
  - Node: `v8.getHeapStatistics()`.
  - Isolated pages: `performance.measureUserAgentSpecificMemory()`, at most every 5 s, because
    it's slow and asynchronous.
  - Otherwise Chrome's `performance.memory` where present, and absent anywhere else.
- **ECS:** table memory from `world.stats`.

### Perf records

- `PerfRecord` version 2 adds `breakdown: { cpu: SpanStats[], gpu: SpanStats[] }`, the top 10 of
  each by p95. Version 1 records still read.
- Thresholds in a 0062 plan may name a span: `{ "span": "partition/spawn", "p95": 2 }`. When a
  record fails against a baseline, `shard perf-check` lists the spans that grew the most.

### Agent surface

- `perf.describe { spans?, top? }`: aggregates by track, the frame and schedule totals, GPU
  passes, memory and clock.
- `perf.capture { frames | until, sample?, devtools? }` returns the summary and the trace's path.
  `perf.reset` clears aggregates.
- `shard profile [scene] --frames 600 [--until-ms 50] [--cpu-prof] [--attach] [--json]` runs a
  scene headless, or attaches to a running app, and prints the summary.
- MCP tools: `describe_perf` and `capture_perf`.
- `debug.overlays` gains `perf`: frame time, the top 8 spans, and the GPU frame, drawn by the
  engine. The playground HUD switches to it.
- **Errors:** `perf/capture-running`, `perf/span-mismatch`, `perf/sampling-unavailable`, and
  `perf/clock-coarse` (a warning in summaries from non-isolated pages).

## Decisions

- **Chrome Trace Event JSON, not our own viewer.** Perfetto is better than anything we'd build,
  and Studio's profiler can read the same files later.
- **The summary is the product.** An agent can't look at a flame chart. A list of frames, each
  with the spans that ran long, turns "it stutters" into a lead.
- **Interned ids and preallocated buffers.** Profiling has to be on in every run to be useful, so
  it follows the hot-path rules it measures.
- **Borrow sampling.** V8's sampler is accurate and free. Instrumentation finds the system, and
  sampling finds the line.
- **Isolate dev pages.** A per-system profiler on a 100 µs clock reports noise.
- **Worker spans ride on job results.** Extra messages would cost more than the timing.

## Acceptance criteria

- [ ] `perf.describe` on a headless star-explorer run returns systems, schedules and frame
      totals. The schedules sum to within 5% of `frame`.
- [ ] Always-on profiling allocates nothing over 1 000 frames of the 100k-entity ECS bench (with
      `allocationChecks`), and neither does a running capture after it starts.
- [ ] Overhead in `pnpm bench`: under 1% of frame time always on, and under 5% while capturing.
- [ ] A fixture system that busy-waits 20 ms on frame 150: a 300-frame capture's `worst[0]` is
      frame 150, with that system first in `over`. A flight-recorder capture with `frameMs: 15`
      stops 30 frames after it, with 120 frames before.
- [ ] A capture with a fake clock produces a trace identical to a golden. The trace opens in
      Perfetto with main, worker, GPU and async tracks (checked once by hand, then by the golden).
- [ ] A noise job on the pool appears on a worker track inside the main-thread span that awaited
      it, aligned within 1 ms.
- [ ] Playground and `shard dev` pages report `isolated: true` and a resolution under 0.02 ms in
      Chrome.
- [ ] Captures in Node (Dawn) and Chrome have a GPU span per render-graph pass. On WebGL2 with the
      timer extension, `gpu:frame` is non-zero, and without it `perf.describe` says unavailable.
- [ ] `shard profile --cpu-prof` writes a `.cpuprofile` whose hottest function is the fixture's
      busy-wait.
- [ ] `shard perf-check` fails a record whose `partition/spawn` p95 exceeds its threshold, and
      names that span.
- [ ] `render.describe`'s `memory` total equals the ledger's.

## Open questions

- Answered: only dev, playground and capture pages are isolated (`credentialless` COEP). Exports
  and embedding hosts choose their own headers, and the profiler reports a coarse clock there.
- Answered: exports keep the aggregates (they're cheap, and the `perf` overlay needs them).
  Captures, sampling and trace writing load with `import()`, so `renderer-min` (0056) doesn't grow.
