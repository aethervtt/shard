# Find what's slow, or what stutters

The profiler is always on. Systems, schedules, the frame, render-graph encodes (`render/<node>`),
GPU passes (`gpu:<node>`), worker jobs and asset loads are spans.

- On average: `describe_perf` (or `shard profile`'s top spans) lists last, avg, p95 and max ms per
  span over 120 frames. `{ "spans": ["render"] }` keeps the spans a key covers.
- Against a budget: `describe_budgets` names the machine, lists every budget with its latest p95
  (over budget first), and splits a scenario's frame into slices, each measured share next to
  its budget share. Where `describe_perf` says `"overlapping": true` (Apple and other tile GPUs),
  pass times don't add up: `ablate_passes` measures what each pass costs.
- A stutter: `capture_perf { "frames": 300 }`, or a flight recorder that waits for one:
  `{ "until": { "frameMs": 30 } }`. Read `worst`: each slow frame lists `over`, the spans that ran
  longest above their median there. The first one is the lead.
- Your own code: `const SPAN = defineSpan('star-explorer/spawn')` once, then in a system
  `const t = profiler.begin(SPAN)` … `profiler.end(t)` with `world.resource(ProfilerResource)`.
- The line: `shard profile --cpu-prof` (or `"sample": true`) adds the hottest functions and
  writes a `.cpuprofile`. Traces go to `.shard/captures/*.trace.json`: open them in Perfetto.
- In a browser, `shard dev`'s pages are cross-origin isolated, so timings are to 5 µs. Turn on the
  `perf` overlay (`debug_overlays`) to watch frame time and the top spans live.
