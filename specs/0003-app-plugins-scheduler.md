# 0003 — App, plugins, and scheduler

- **Status:** accepted
- **Packages:** `@shard/core` (scheduler), `@shard/runtime` (App, runners)
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

app.addSystems(Update, movement.after(physicsStep).runIf(inState(GameState.Playing)))
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

- **`rafRunner`** — `requestAnimationFrame`, pauses when hidden. Used by playground and Studio.
- **`headlessRunner({ frames, fixedDelta })`** — runs N frames as fast as possible with a fixed
  delta, so results are reproducible. Used by the CLI and tests.
- **manual** — `app.update(delta)` for tests and embedding.

The runner comes from the host; the app doesn't know which one it has.

### States

`defineState('game/State', ['loading', 'menu', 'playing'])` creates a resource plus `OnEnter(s)` /
`OnExit(s)` schedules and `inState(s)` run conditions. Transitions requested during a frame apply
at the start of the next frame.

### Agent surface

- `app.describe()` returns plugins (with dependencies), schedules, and each schedule's ordered
  system list with run conditions.
- The profiler records per-system CPU time (ring buffer, last N frames) exposed as a resource.
- All errors above are `ShardError` with codes `app/*`.

## Decisions

- **`setup` + `run` instead of closures.** Keeps per-frame code allocation-free and makes system
  state inspectable.
- **Deterministic ordering by default.** Unordered systems keep registration order, so headless
  runs and tests reproduce exactly.
- **Command buffers flush after each system.** Simpler mental model than Bevy's explicit
  `apply_deferred`; revisit if flush cost shows up in profiles.
- **`FixedUpdate` defaults to 60 Hz.** Matches most displays; configurable per app.
- **Single world.** The renderer reads the main world during extraction; no separate render world.
  Revisit if pipelined rendering becomes necessary.

## Acceptance criteria

- [ ] Systems run in the declared order; a cycle throws `app/system-cycle` naming every system in
      it.
- [ ] `FixedUpdate` runs `floor(accumulated / step)` times, at most 5, and `alpha` is correct.
- [ ] A headless run of N frames with a fixed delta produces identical world state on every run
      (hash compared in a test).
- [ ] Plugins build in dependency order; missing dependencies and duplicates throw the right codes.
- [ ] `ready()` hooks are awaited before `Startup` runs.
- [ ] State transitions fire `OnExit` then `OnEnter` at the start of the next frame.
- [ ] `app.describe()` output matches a snapshot for a sample app.
- [ ] Per-system timings are recorded and exposed.

## Open questions

None.
