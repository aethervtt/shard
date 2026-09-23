# 0001 — ECS core

- **Status:** accepted
- **Packages:** `@shard/core`
- **Depends on:** 0002 (component definitions)

## Context

Everything in Shard lives in the ECS: game objects, cameras, lights, UI nodes, particles emitters,
generators' outputs. The target is 100k simulated entities at 60 fps with room left for
everything else, in a GC'd language. That rules out one-object-per-component designs. Data has to
live in TypedArrays, laid out so systems walk memory linearly and so columns can be uploaded to the
GPU without repacking.

## Goals

- Archetype storage with struct-of-arrays TypedArray columns for numeric fields.
- Entities as plain numbers with generation checks (stale handles are detected, not reused).
- Cached queries with `with` / `without` / `optional` filters and zero-allocation iteration.
- Deferred structural changes (commands) so systems can spawn/despawn while iterating.
- Resources (world singletons), events (double-buffered), and observers (lifecycle + custom).
- Change detection per row (added / changed since a system last ran).
- Parent/child relationship, since transforms need it immediately.
- Fully headless and deterministic: no DOM, no GPU, no timers, no `Math.random`.

## Non-goals

- Multithreading. The layout should not prevent moving columns to `SharedArrayBuffer` later.
- General many-to-many relationships (only `ChildOf` for now).
- Sparse-set storage as an alternative per component. Revisit if add/remove churn shows up in
  profiles.

## Design

### Entities

An entity is a JS number: `index + generation * 2^22`. That allows 4,194,304 live entities and a
31-bit generation, and it stays a safe integer. GPU-side data uses the index only.

The world keeps, per index: `generation` (Uint32Array), `archetype` (Uint32Array), and `row`
(Uint32Array). Freed indices go on a free list; the generation increments on despawn.
`world.isAlive(e)` compares generations.

### Archetypes and tables

An archetype is the sorted set of component ids an entity has. Each archetype owns a table:

- `entities: Float64Array` (the entity id in each row)
- one column per component field:
  - numeric scalars → `Float32Array`, `Int32Array`, `Uint8Array`, etc.
  - vectors/quaternions/colors → one TypedArray with stride N (`x0 y0 z0 x1 y1 z1 …`)
  - strings, lists, JSON, handles → plain JS arrays ("object columns")
- `changedTick` and `addedTick` per component: `Uint32Array` per row

Tables grow by doubling capacity. Removal is swap-remove, which updates the moved entity's `row`.

Adding or removing a component moves the row to another archetype. Transitions are cached as
graph edges on each archetype (`addEdges[componentId]`, `removeEdges[componentId]`), so repeated
moves cost a lookup, not a set computation.

Tags (components with no fields) take part in archetype identity but have no columns.

### Queries

```ts
const moving = world.query({ with: [Position, Velocity], without: [Frozen] })
```

A query keeps the list of matching archetypes and updates it when new archetypes are created
(the world notifies registered queries). Queries are created once, typically at system setup.

Hot-path iteration walks tables directly and does not allocate:

```ts
// Position and Velocity are defined as { value: t.vec3 }
for (let t = 0; t < moving.tables.length; t++) {
  const table = moving.tables[t]!
  const pos = table.column(Position, 'value') // Float32Array, stride 3
  const vel = table.column(Velocity, 'value')
  for (let i = 0, n = table.count * 3; i < n; i++) {
    pos[i]! += vel[i]! * dt
  }
  table.markChanged(Position)
}
```

A convenience `query.each((entity, row, table) => …)` exists for cold code.

### Change detection

The world has a monotonically increasing `tick`, incremented once per system run. Each system
remembers the tick it last ran at. `added(C)` and `changed(C)` filters compare row ticks against
that.

TypedArray writes can't be intercepted, so marking is explicit:
- `table.markChanged(C)` marks every row in the table (coarse, cheap, the common case in systems
  that update everything they iterate).
- `table.markChanged(C, row)` marks one row.
- `world.set(e, C, values)` and command-based writes mark automatically.

### Commands

Structural changes during iteration go through a command buffer:

```ts
cmd.spawn([Position, { value: [0, 0, 0] }], [Velocity, { value: [1, 0, 0] }])
cmd.despawn(e)
cmd.add(e, Frozen)
cmd.remove(e, Velocity)
```

The scheduler applies buffers at sync points (0003). Commands are stored in flat arrays, not
closures, so a frame of commands doesn't allocate per command after warm-up.

### Resources

Typed singletons keyed by a resource definition: `world.insertResource(Time, value)`,
`world.resource(Time)`. Resources are plain objects; they're rarely hot.

### Events

`defineEvent<T>(name)`. Double-buffered: events written in frame N are readable in frames N and
N+1, then dropped. Readers track their own cursor, so multiple systems can read the same events.

### Observers

Observers run synchronously when something happens:

- lifecycle: `onAdd(C)`, `onRemove(C)`, `onSet(C)`
- custom: `world.trigger(event, targetEntity?)`

Observers run at command-application time, never mid-iteration. They're the place for "when X
happens, do Y" logic that would otherwise be polling.

### Hierarchy

`ChildOf { parent: entity }` component plus a `Children` list maintained by observers.
Despawning a parent despawns its descendants (`despawnRecursive` is the default for `despawn`
when `Children` is present; `despawnSingle` opts out).

### What is not an entity

High-count, low-individuality data lives in buffers owned by one entity, not in entities:
particles (GPU buffers owned by an emitter), foliage and scattered props (instance buffers owned
by a terrain chunk or generator), tiles (data inside a tilemap component). Engine plugins and
generated agent docs follow this rule, so entity counts stay in the range the ECS is built for.

### API sketch

```ts
const world = new World()

const e = world.spawn([Position, { value: [1, 2, 3] }], Player)
world.add(e, Velocity, { value: [0, 1, 0] })
world.get(e, Position) // { value: [1, 2, 3] } (copy; cold path)
world.set(e, Position, { value: [5, 2, 3] }) // partial write per field, marks changed
world.has(e, Velocity) // true
world.remove(e, Velocity)
world.despawn(e)
world.isAlive(e) // false

const q = world.query({ with: [Position], without: [Frozen], changed: [Position] })
```

### Agent surface

- Every entity, archetype, component value, and resource is readable through the protocol
  (later spec), because storage is schema-driven (0002).
- `world.stats()` returns entity count, archetype count, table sizes, and memory per column.
- Invalid operations throw `ShardError`: `ecs/dead-entity`, `ecs/missing-component`,
  `ecs/entity-limit`, `ecs/unknown-component`.

## Decisions

- **Archetypes over sparse sets.** Linear iteration and GPU-uploadable columns matter more than
  cheap add/remove for this engine's workload.
- **Explicit change marking.** Proxies or setters on the hot path would cost more than the
  feature is worth.
- **Entity is a number, not an object.** No allocation, trivially serializable, safe as a map key.

## Acceptance criteria

- [ ] Spawn 100k entities with `Position` + `Velocity` in under 50 ms (Node benchmark, M-series
      or equivalent desktop CPU).
- [ ] Integrate 100k `Position += Velocity * dt` in under 1 ms per frame.
- [ ] Stretch: spawn 1M entities in under 500 ms and integrate them in under 10 ms per frame.
- [ ] Steady-state iteration over a query allocates nothing (verified with a heap snapshot test or
      `--trace-gc` benchmark run showing no scavenges over 1,000 frames).
- [ ] Using a despawned entity throws `ecs/dead-entity`; its index is reused with a new generation.
- [ ] Commands issued during iteration apply at the next sync point, in issue order.
- [ ] `added` / `changed` filters return exactly the rows touched since the system's last run.
- [ ] Observers fire for add/remove/set and custom triggers, after the command buffer applies.
- [ ] Despawning a parent despawns all descendants.
- [ ] Events are readable for exactly two frames and by multiple independent readers.
- [ ] `@shard/core` builds with `lib: ["ES2023"]` only.

## Open questions

- Is 4M live entities the right ceiling, or should the split be 24/29 bits?
- Should strided vector columns expose `pos.x[i]` style split arrays instead? Split arrays read
  nicer; strided arrays upload to the GPU without repacking. Current lean: strided, with the
  schema deciding per component (`layout: 'aos' | 'soa'`).
