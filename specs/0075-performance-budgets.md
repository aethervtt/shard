# 0075 — Performance budgets

- **Status:** accepted
- **Packages:** `@aethervtt/shard-core` (test-env), `@aethervtt/shard-runtime`, `@aethervtt/shard-render`,
  `@aethervtt/shard-protocol`, `@aethervtt/shard-verify`, `apps/cli`, `apps/playground`, `bench/`
- **Depends on:** 0022, 0043, 0051, 0062, 0074

## Context

Specs set time budgets in prose ("2M blades under 3 ms on the reference GPU"), and tests check
them with literals (`budget(3)`). That has failed in four ways:

- **Nobody defined the reference machine.** 27 places in the specs mention a reference GPU,
  reference machine or dev machine. Work happens on two real machines, a Windows desktop and an
  M4 MacBook. `TODO.md` lists different misses on each and asks which hardware each budget
  assumes.
- **Numbers are guesses made before the code exists.** 0045 asked for 2 000 props spawned a
  frame. The implementation measured 3.5 µs a prop, so the 1 ms spawn budget allows about 285.
  The unit cost was the useful fact, and the spec had no place for it.
- **Features budget alone.** Each spec claims frame time as if it had the frame to itself, and
  nothing checks that the claims fit in one frame.
- **Per-pass GPU timings lie on tile-based GPUs.** On the M4 at render scale 0.5, the
  playground HUD showed six passes adding up to about 20 ms in a 9.4 ms GPU frame. Upscale,
  tonemap and an almost empty gizmo pass each read about 3 ms. Passes overlap on these GPUs, and a
  pass's timestamps include waiting for earlier work. `GpuTimer` says so in a comment, but the HUD
  ranks passes by these numbers anyway.

This spec makes budgets data. Machines are named. Each scenario's frame is split into slices
that features claim. Unit costs are first-class. A pass's GPU cost is measured in a way that
holds on every GPU.

## Goals

- `bench/perf/machines.json` names the machines budgets apply to. `pnpm bench` detects which one
  it's on. On an unknown machine it measures and reports, and doesn't fail.
- `bench/perf/budgets.json` holds every time budget, keyed by span name (0074) and machine, with
  a note on each. Tests read budgets from it by key, and no literals remain.
- Scenarios (fixture, camera path, resolution, render scale) each with a frame budget split into
  slices.
- Three kinds of budget: targets (from a slice), unit costs, and regression guards that ratchet.
- Honest GPU pass costs: ablation where timestamps overlap, flagged in `perf.describe` and the HUD.
- Features with variable cost adapt to their slice at runtime, as 0043's terrain does.
- A convention for budgets in specs, and every existing spec reference converted.

## Non-goals

- Enforcing budgets in CI. CI renders on software GPUs, and `pnpm test` stays correctness-only.
  A self-hosted bench runner is a later decision.
- Choosing quality presets for players. The slices are what presets would scale later.
- Size budgets. `bench/size/budgets.json` already works and stays as it is.

## Design

### Machines

```json
{
  "machines": {
    "laptop": { "cpu": "Apple M4", "gpu": "apple", "backend": "metal", "display": [2460, 1790] },
    "desktop": { "cpu": "AMD Ryzen 9 9950X3D", "gpu": "RTX 5060 Ti", "backend": "d3d12", "display": [2560, 1440] }
  }
}
```

- Detection matches the CPU model string and the adapter's vendor and description.
  `SHARD_MACHINE=laptop` overrides it. A match that disagrees with the override is a warning,
  not a failure.
- On an unknown machine, every `budget()` is unlimited, as in `pnpm test`, and `pnpm bench`
  prints what it measured against the closest named machine's budgets.

### Scenarios and slices

A scenario is a fixed, repeatable workload: a fixture scene, a scripted camera path, a resolution,
a pinned render scale (0051) and a target frame rate. The first set:

| Scenario | What it runs |
|---|---|
| `planet-descent` | 0043's Earth descent |
| `scatter-walk` | star-explorer's planet, walking through forest with grass |
| `crowd` | 0022's 200k instances |
| `tabletop-max` | 0055's max structure fixture |
| `open-world-fly` | 0071 and 0072's fixtures, once they exist |

```json
{
  "scenarios": {
    "scatter-walk": {
      "resolution": [1920, 1080], "renderScale": 1, "fps": 60,
      "frame": { "gpu": { "laptop": 16.6, "desktop": 8.3 }, "cpu": { "laptop": 8, "desktop": 6 } },
      "slices": {
        "gpu": { "gpu:forward-opaque": 0.30, "gpu:shadows": 0.15, "gpu:terrain": 0.12,
                 "gpu:foliage": 0.12, "gpu:post": 0.12, "headroom": 0.19 },
        "cpu": { "render": 0.15, "terrain": 0.15, "scatter": 0.15, "headroom": 0.55 }
      }
    }
  }
}
```

- A slice is a fraction of the scenario's frame, so one split serves every machine. A machine may
  override a slice with an absolute number where hardware differs unevenly (the noise kernel is
  fast on ARM, D3D12 compiles pipelines slowly).
- Slices plus `headroom` must sum to 1. `pnpm bench` fails a scenario whose slices don't, and
  reports any slice whose measured share is over.
- Slice keys are span names or prefixes (0074's automatic span names, and the rule for what a key
  covers). `gpu:foliage` covers every `gpu:foliage/*` span. A GPU slice is a share of `gpu:frame`
  and a CPU slice a share of `frame`.

### Kinds of budget

```json
{
  "spans": {
    "scatter/spawn": { "kind": "unit", "per": "prop", "laptop": 0.0035, "desktop": 0.0025,
                       "note": "0045 as built; propsPerFrame = 1 ms / this" },
    "noise/fbm6": { "kind": "rate", "per": "point", "laptop": 42e6, "desktop": 24e6,
                    "note": "f32x4 min/max are one instruction on NEON, several on SSE" },
    "ui/layout-2k": { "kind": "guard", "laptop": 0.9, "desktop": 1.3, "margin": 0.1 }
  }
}
```

- **Target**: a slice's share of a scenario frame. It says what the product wants.
- **Unit and rate**: cost per item, or items per second. They're measured after implementation
  and carry over between machines far better than totals. Settings derive from them
  (`propsPerFrame`) instead of being guessed.
- **Guard**: a measured value plus `margin`. It catches regressions and says nothing about what
  the product wants. `pnpm bench --ratchet` proposes lowering any guard the run beat by more than
  twice its margin.
- Every entry has a `note`. A change to a number is a diff with a reason, as in the size budgets.

### Tests

```ts
expect(p95(spawnMs)).toBeLessThan(budget('scatter/spawn', { count: props }))   // unit × count
expect(p95(gpuShare)).toBeLessThan(budget('scatter-walk', { slice: 'foliage', track: 'gpu' }))
```

- `budget(key, opts?)` resolves the machine's number, and returns unlimited outside `pnpm bench` or
  on an unknown machine. `budget(ms)` keeps working until migration ends.
  `scripts/budget-literals.mjs` lists the numeric calls that remain, and the goal is none.
- A test that measures a scenario runs its camera path through 0074's captures and reads spans
  from the summary, so tests, `shard profile` and the HUD measure the same thing.

### GPU pass costs

- Timestamps give a pass's own cost on immediate-mode GPUs (desktop NVIDIA and AMD on D3D12 or
  Vulkan). On tile-based GPUs (Apple, most mobile) passes overlap, and only `gpu:frame` is
  reliable.
- 0074's `perf.describe` gains `overlapping: true` when per-pass times sum to more than 110% of
  `gpu:frame`. The `perf` overlay and the playground HUD then show pass times in grey, labelled
  "overlapping", and rank by ablation results when they have them.
- **Ablation.** `perf.ablate { passes, frames: 120, rounds: 5 }` alternates rounds with each
  pass disabled and enabled, and reports each pass's cost as the median difference in
  `gpu:frame`. Interleaving rounds cancels thermal drift, as `structure/src/cutaway.test.ts`
  already does. A node disabled for measurement skips its draws and dispatches, but its
  passes still begin and end, so the textures it writes stay valid for what reads them. The
  image is wrong during those rounds, which is fine for a measurement. GPU slice budgets are checked by
  ablation on tile-based machines and by timestamps on the others, and `machines.json` says
  which (`"passTiming": "ablation" | "timestamps"`).

### Features that adapt

- A feature whose cost grows with content (terrain chunks, foliage blades, particles, shadow
  casters) exposes a budget resource with a millisecond target, and adjusts its own detail to stay
  inside it, as `TerrainBudget.triangles` steers 0043's LOD bias.
- The target defaults to the feature's slice in the scenario the app declares
  (`App.perfScenario`, default none, which means no adaptation). Acceptance criteria then say
  "stays inside its slice and fills 60 m at the density that affords", not "2.2M blades in 3 ms".
- 0045's foliage is the first to gain one: density thinning and range driven by GPU time, the
  cause of its open miss in `TODO.md`.

### Specs

- A spec states budgets as slices of a named scenario, or as unit costs with their basis
  ("measured", or "proposed: like X"). Acceptance criteria name budget keys, not hardware.
- "As built" records measured unit costs per machine, and the numbers go into `budgets.json` in
  the same change.
- `specs/README.md` gains this convention. The 27 existing references are rewritten to name a
  machine or a key. The misses in `TODO.md` become per-machine budget entries with their notes,
  and leave `TODO.md` once the numbers are settled.

### Agent surface

- `perf.budgets { scenario? }`: the detected machine, the resolved budgets, and the latest
  measurements against each, over budget first.
- `perf.ablate` as above. MCP tool `ablate_passes`.
- `pnpm bench` writes `bench/perf/report.json` (budget, measured and verdict per key) like the size
  report, and `pnpm bench --scenario scatter-walk` runs one scenario.
- The `perf` overlay (0074) shows each slice's measured share against its budget, red when over.
- **Errors:** `perf/unknown-budget` (a key missing from `budgets.json`), `perf/slices-overflow`,
  `perf/unknown-machine` (a warning).

## Decisions

- **Budgets per named machine.** No single number holds on an ARM laptop and an x86 desktop. The
  `TODO.md` misses show that.
- **Slices of a scenario frame.** Trade-offs become visible: more for grass is less for shadows,
  in one file.
- **Unit costs are first-class.** They're what an implementation learns, they carry between
  machines, and limits derive from them.
- **Ablation on tile-based GPUs.** It's the only per-pass number that's true there. Timestamps
  stay where they're accurate, because ablation is slow.
- **Budgets in one data file.** Reviewable, diffable, and read by tests, perf-check and the
  overlay alike.

## Acceptance criteria

- [ ] `pnpm bench` detects both named machines and reports which. With `SHARD_MACHINE` unset on
      another machine it runs, reports, and passes.
- [ ] No `budget(<number>)` call remains (`scripts/budget-literals.mjs` reports zero).
- [ ] Every scenario's slices sum to 1, and `bench/perf/report.json` lists each slice's measured
      share on both machines.
- [ ] On the laptop, `perf.describe` marks the scatter page's pass times overlapping, and the HUD
      stops ranking them. `perf.ablate` gives the gizmo, upscale and tonemap passes costs that
      sum to within 15% of `gpu:frame` with all three disabled together.
- [ ] Ablating any node of the scatter page's graph raises no validation error, and the frames
      after `perf.ablate` returns match the frames before it.
- [ ] 0045's foliage holds its `scatter-walk` slice on the laptop at 1080p (p95 over the walk),
      thinning density to do it, and goes back to full density on the desktop if it fits.
- [ ] No spec mentions an undefined reference machine.

## Open questions

- Answered: the frame splits above are placeholders. The perf pass measures where time goes
  today with ablation and captures, and the splits are set once from those measurements, in
  the same change that records them.
- Answered: scenarios target 60 Hz, with the 120 Hz budget reported alongside, until a project
  asks for 120.
