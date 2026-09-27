# 0003 — App, plugins, and scheduler

- **Status:** implemented
- **Packages:** `@aethervtt/shard-core` (scheduler), `@aethervtt/shard-runtime` (App, runners)
- **Depends on:** 0001, 0002

## Context

Every engine feature (rendering, physics, audio, the agent layer) is a plugin, and every piece of
game logic is a system. The app wires them together: it owns the world, runs systems in a known
order, handles fixed-timestep simulation, and drives frames from whatever host is running it
(browser rAF, Tauri, headless CLI, a test).

Agents need to see this structure: which plugins are loaded, which systems run in which order,
and how long each one took.

## Goals

- `App` owning a `World`, a plugin list, schedules, and a runner.
- Plugins with names, dependencies, and a `build(app)` step.
- Named systems with explicit ordering (`before`/`after`), system sets, and run conditions.
- Built-in schedules including a fixed-timestep loop.
- Runners: animation-frame (web/Tauri), headless (step N frames, deterministic), manual.
- Game states (`inState`, `onEnter`, `onExit`).
- Introspection: plugins, schedule graph, per-system timings.

## Non-goals

- Parallel system execution. Ordering data is kept so it can come later.
- Hot-reloading systems (belongs to the user-scripts spec).

## Design

### Schedules

Run in this order each frame:

`First → PreUpdate → FixedUpdate (0..N times) → Update → PostUpdate → Last`

Plus `Startup` (once, before the first frame). Rendering hooks in at `Last` through the render
plugin's own extraction step, defined in the renderer spec.

`FixedUpdate` uses an accumulator: default 60 Hz, clamped to at most 5 steps per frame to avoid a
spiral of death. `Time` and `FixedTime` resources expose `delta`, `elapsed`, `alpha`
(interpolation factor), and frame count.

Command buffers are applied after each system that used them (0001 sync points), so later systems
in the same schedule see the changes.

### Systems

```ts
export const movement = defineSystem({
  name: 'game/movement',
  setup: (world) => ({ q: world.query({ with: [Position, Velocity] }) }),
  run: ({ q }, world, ctx) => {
    const dt = world.resource(Time).delta
    // iterate q.tables …
  },
})

app.addSystems(Update, movement.after(physicsStep).runIf(inState(GameState, 'playing')))
```

- `setup` runs once and returns the system's local state (queries, scratch buffers). `run`
  receives it, so the hot path never recreates queries.
- `ctx` holds the system's command buffer, its last-run tick, and the event readers it declared.
- Names are required and unique. They appear in the profiler, logs, and the agent API.
- Ordering is resolved with a topological sort per schedule; cycles throw `app/system-cycle`
  listing the cycle.
- Systems with no ordering relation run in registration order, so behaviour is deterministic.

### Plugins

```ts
export const PhysicsPlugin = definePlugin({
  name: 'physics3d',
  dependencies: ['core/time', 'core/transform'],
  build(app) {
    app.insertResource(PhysicsConfig, { gravity: [0, -9.81, 0] })
    app.addSystems(FixedUpdate, [syncToPhysics, stepPhysics, syncFromPhysics.after(stepPhysics)])
  },
  // optional async step, awaited before Startup (e.g. loading WASM)
  async ready(app) {},
})
```

Missing dependencies throw `app/missing-plugin`; adding a plugin twice throws
`app/duplicate-plugin`.

### Runners

- **`animationFrameRunner({ maxDelta, signal })`** — `requestAnimationFrame`; the gap while the
  page is hidden doesn't count as one huge frame. Used by playground and Studio.
- **`headlessRunner({ frames, delta })`** — runs N frames as fast as possible with a fixed
  delta, so results are reproducible. Used by the CLI and tests.
- **manual** — `app.update(delta)` for tests and embedding.

The runner comes from the host; the app doesn't know which one it has. `await app.init()` (or
`app.run()`, which calls it) builds plugins and awaits `ready()`; `update` before that throws
`app/not-initialized`. The `core/time` plugin (`Time`, `FixedTime`) is always present.

### States

`defineState('game/State', ['loading', 'menu', 'playing'])` creates a resource plus
`OnEnter(state, value)` / `OnExit(state, value)` schedules and `inState(state, value)` run
conditions. `app.initState(state, initial?)` registers it; `OnEnter(initial)` runs at the start of
the first frame. `setState(world, state, value)` requests a transition, applied at the start of the
next frame. Unknown values are a type error and throw `app/invalid-state`.

### Agent surface

- `app.describe()` returns plugins (with dependencies), schedules, and each schedule's ordered
  system list with run conditions.
- The profiler records per-system CPU time (ring buffer, last N frames) exposed as a resource.
- All errors above are `ShardError` with codes `app/*`. A system that throws is wrapped in
  `app/system-failed` naming the system, with the original error as `cause`. Duplicate system
  names anywhere in the app are `app/duplicate-system`; plugin dependency cycles are
  `app/plugin-cycle`.

## Decisions

- **`setup` + `run` instead of closures.** Keeps per-frame code allocation-free and makes system
  state inspectable.
- **Deterministic ordering by default.** Unordered systems keep registration order, so headless
  runs and tests reproduce exactly.
- **Command buffers flush after each system.** Simpler mental model than Bevy's explicit
  `apply_deferred`; revisit if flush cost shows up in profiles.
- **`FixedUpdate` defaults to 60 Hz.** Matches most displays; configurable per app. When the step
  cap is hit, the excess whole steps are dropped.
- **The tick advances after every system run.** Anything written afterwards (the system's commands,
  later systems, code outside systems between frames) gets a newer tick than the run, so the system
  sees it as changed next time. (Originally the tick only advanced when commands were applied, which
  hid writes made between frames; found while building 0004.)
- **Plugins may add plugins in `build`.** They join the same dependency-ordered build pass.
- **Single world.** The renderer reads the main world during extraction; no separate render world.
  Revisit if pipelined rendering becomes necessary.

## Acceptance criteria

- [x] Systems run in the declared order; a cycle throws `app/system-cycle` naming every system in
      it.
- [x] `FixedUpdate` runs `floor(accumulated / step)` times, at most 5, and `alpha` is correct.
- [x] A headless run of N frames with a fixed delta produces identical world state on every run
      (hash compared in a test).
- [x] Plugins build in dependency order; missing dependencies and duplicates throw the right codes.
- [x] `ready()` hooks are awaited before `Startup` runs.
- [x] State transitions fire `OnExit` then `OnEnter` at the start of the next frame.
- [x] `app.describe()` output matches a snapshot for a sample app.
- [x] Per-system timings are recorded and exposed.

## Open questions

None.
