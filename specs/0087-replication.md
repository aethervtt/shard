# 0087 — Replication (binary codec, net ids, deltas, interest, interpolation)

- **Status:** accepted (Phase 1 built)
- **Packages:** `@aethervtt/shard-core` (binary codec), `@aethervtt/shard-net`,
  `@aethervtt/shard-scene` (prefab spawns), `@aethervtt/shard-animation` (params)
- **Depends on:** 0001, 0002, 0030, 0033, 0040, 0086

## Context

Most multiplayer state is "the server's entities, as each client is allowed to see them". An MMO
sends thousands of positions filtered by distance. An FPS must not send an enemy behind a wall,
or a cheat will draw it. A card game must not send the front of a card in another player's hand.
All three are the same mechanism: the server decides per client which entities and which
components it sends, and sends only what changed.

Shard already has what this needs underneath. Components are typed columns, so a binary codec can
read them directly. Rows carry change ticks, so "changed since this client's last ack" is a query.
Prefabs spawn from a ref and overrides, so the server doesn't send meshes or materials. This spec
adds a network identity, a schema-derived binary codec, per-client deltas, interest and
redaction, and interpolation for remote entities.

## Goals

- A binary codec in core, derived from component schemas, with quantization.
- `NetId` identity, with entity fields remapped through it on the wire.
- A per-app replication registry: which components replicate, how, and to whom.
- Per-client deltas against an acked baseline, over unreliable or reliable channels.
- Interest policies (which entities a client receives) and redaction (which components).
- A per-client bandwidth budget with priorities.
- Snapshot interpolation for remote entities, and animation sync through graph parameters.
- Late join: a client that connects mid-game receives the current state through the same path.

## Non-goals

- Prediction and ownership of input-driven state (0088).
- Line-of-sight, PVS, and audibility interest policies. The interface supports them; they come
  with a later spec that uses physics queries.
- Zone sharding across server processes.
- Replicating resources. Game state that isn't an entity goes on a singleton entity, or through
  0089's events.

## Design

### Binary codec (core)

`packages/core/src/schema/binary.ts`:

```ts
class ByteWriter { constructor(initial?: number); reset(): void; u8(v); u16(v); u32(v); varuint(v);
  f32(v); f64(v); bits(v, n); bytes(view); string(s); finish(): Uint8Array }  // view into its buffer
class ByteReader { reset(bytes: Uint8Array): void; u8(); …; bits(n); string() }
interface Quantize { readonly step?: number; readonly bits?: number }   // per field
encodeRow(def, table, row, w, opts: { quantize?, mask?, entity?: (e: Entity) => number }): void
decodeRow(def, r, out: InitFields, opts: { quantize?, mask?, entity?: (id: number) => Entity }): void
```

- Numeric fields write from their columns, with no allocation. The format is byte-aligned:
  `u8`/`i8`/`bool`/`enum` take a byte, `u16`/`u32` are varuints, other integers zigzag varints,
  and `quat` is smallest-three (an index byte and three i16s, 7 bytes).
- Floats are full width unless the registry gives a `step`; then they travel as zigzag varints of
  multiples of it. (Bit packing and steps derived from `min`/`max` can come later if bandwidth
  needs them; the manifest hash covers the choice.)
- `entity` fields go through the `entity` callback (to and from `NetId`). An entity with no net id
  encodes as null and is reported once as `net/unreplicated-reference`.
- `string`, `handle` (guid), `list`, `struct` and `json` encode as length-prefixed UTF-8 of their
  JSON form. They're for rarely changing data; they allocate on decode.
- Updates send whole components (no field masks yet): core marks rows, not fields, changed.
- The codec knows nothing about networking. 0038 saves can use it later.

### Identity

- `net/NetId { id: u32 }`. The server allocates ids, never reuses one within a session, and adds
  `NetId` when an entity becomes replicated. `NetIds` resource: `id → Entity` and back.
- An entity replicates when it has `net/Replicated { prefab: string, owner: u32 }` (`owner` is a
  peer id, 0 for the server). The game adds it on the server; clients never author it. It is
  itself replicated (reliably), so ownership can change hands.
- **Spawn.** If `prefab` is set, the client calls `netPlugin({ spawnPrefab })` with it, then applies
  replicated components on top. Visual-only components (meshes, materials, audio) come from the
  prefab and never cross the wire. A spawn carries the prefab ref and every visible replicated
  component, reliably.
- **Parents.** `ChildOf` replicates as a parent `NetId` when the game replicates it. A replicated
  child whose replicated parent isn't relevant to a client isn't sent to it.
- **Large worlds.** `GridCell` replicates like any component, so positions travel as cell plus
  f32 offset (0040), never as f64.

### Registry

```ts
netPlugin({
  replicate: [
    replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.005 } } }),
    replicate(Health),                                     // mode 'set' (default): written as received
    replicate(HandCard, { visibleTo: ownerOnly }),         // redaction
    replicate(AnimatorParams, { channel: 'reliable' }),
    replicate(CharacterState, { predicted: true }),        // 0088
  ],
  interest: anyOf(ownerInterest(), gridInterest({ cellSize: 64, range: 2 })),
  budget: { bytesPerTick: 1200 },
})
```

- A side table keyed by component definition, so engine components (Transform) need no edit and a
  game configures them its own way.
- `mode`: `set` writes the value; `interpolate` buffers it (below); `predicted` is 0088's.
- `channel`: `unreliable` (default) or `reliable`. Unreliable data is resent until acked; reliable
  data arrives in order.
- A component not in the registry never replicates. `Derived` components never replicate.
- Components replicated by the server are the server's: a client's write is overwritten by the
  next update. (Logging such writes as `net/not-authority` is not built yet.)

### Deltas

Per client, the server keeps the tick of its last acked state, and for each relevant entity the
change tick it last sent per component.

On each network tick, per client:

1. Interest updates the client's relevant set (below). Entities that left it get `despawn`.
2. For each relevant entity, in priority order: components whose row changed since the client
   last acked them are written as `update { netId, componentId, fieldMask, fields }`. New entities
   get `spawn { netId, prefab, parent, components }` with every replicated component.
3. Removed components and despawned entities come from an `onRemove` log (core has no removal
   ticks) and are sent reliably.
4. State messages carry a sequence number; the client acks the newest and a 32-bit mask of the
   ones before it. Unacked unreliable updates are resent after about an RTT when the row is still
   newer than the ack, so a lost packet costs about one RTT and old values are never resent.
5. An update naming an entity the client doesn't have yet isn't acked, so it comes again. An
   update too big for one unreliable message goes reliably, which fragments.

The encoder reuses one `ByteWriter` per connection and walks tables with `table.changedTicks`; it
allocates nothing per entity. A late joiner's ack is 0, so its first ticks are a full snapshot,
spread over ticks by the budget.

### Interest and redaction

```ts
interface InterestPolicy {
  /** Fills `out` with the entities `peer` should receive this tick. Batched over all entities. */
  update(world: World, peer: PeerInfo, out: RelevanceSet): void
}
ownerInterest()                         // entities the peer owns, and their children
gridInterest({ cellSize, range })       // cells within `range` of the peer's focus entities
teamInterest(component, field)          // entities whose team equals the peer's
alwaysInterest(filter?)                 // game state every client sees (turn, scores)
anyOf(...policies); allOf(...policies)
```

- A peer's **focus** is the entities it owns plus `net/Focus` entities (a spectator camera). The
  grid policy hashes entities into cells and only re-hashes tables whose Transform changed. Roots
  use Transform (set even where nothing propagates); children use GlobalTransform. An entity the
  peer had last tick stays relevant one cell further (hysteresis).
- An entity outside a client's set is never encoded for it. This is server-side culling: a
  modified client can't show what it never received. A later line-of-sight policy plugs in here.
- `visibleTo(world, peer, entity) => boolean` on a registry entry redacts one component. A redacted
  component is never sent; the client sees the entity without it. 0089 builds hidden cards on this.
- `net/Relevance { always: bool, priority: f32 = 1 }` lets a game pin an entity or raise it.

### Bandwidth

Each client has `bytesPerTick` (default unlimited). Entities are sorted by `priority × ticks since
last sent`, new ones first. (A distance multiplier for grid interest is not built yet.) The encoder writes until the budget is
spent; what doesn't fit ages and goes first next tick. `net.stats` reports bytes per component and
per client, and how many entities were deferred.

### Interpolation

Remote entities with `mode: 'interpolate'` keep a ring of the last 8 received values with their
server ticks. In PreUpdate (before game systems read them), the client renders at
`serverTick − rtt/2 − delay`, where `delay` is `max(2 network ticks, jitter × 2)`, and writes the
float fields from the two samples around it (lerp; nlerp on the short arc for quaternions). Past
the newest sample it holds it: updates are deltas, so no newer sample usually means the value
stopped changing, and extrapolating would overshoot and stay there. (Snapping on a teleport is not
built yet.)

### Animation

Poses never replicate. A character replicates the state its graph is bound to (`CharacterState`,
Transform) and `AnimatorParams` for unbound parameters. The client runs the graph locally. Triggers
go through 0089's events so they aren't lost. Exact state alignment (a long attack at the same frame
on every client) needs an `AnimatorSync` component with the active state and its start tick: not
built yet.

### Agent surface

- `net.inspect(entity)`: net id, owner, prefab, and per client whether it's relevant, redacted
  components, and last acked tick.
- `net.stats`: bytes per tick per client and per component, deferred entities, resends.
- `net.relevance(peer)`: the entity list a client currently receives.
- Errors: `net/not-replicable` (replicating a derived component), `net/duplicate-type`,
  `schema/binary-truncated`, `schema/invalid-quantize`.

## Decisions

- **Codec in core, derived from schemas.** One schema drives everything (VISION), and 0002 already
  reserves a binary format for saves and networking.
- **Registry is a side table, not a component option.** Engine components get replicated
  differently by different games, and core stays free of network concepts.
- **Spawns send the prefab, not the components.** Visual components are large and never change;
  the client already has the asset.
- **Acks, not a reliable stream, for state.** Lost state is resent only if it's still the newest,
  so a congested link catches up instead of replaying history.
- **Interest is on the server.** Hiding on the client is only presentation; cheats read memory.

## Acceptance criteria

Checked by `packages/core/src/schema/binary.test.ts`, `packages/net/src/net.test.ts` and
`packages/net/src/bench.test.ts`.

- [x] The codec round-trips every field kind. Quantized fields round-trip within their `step`;
      `quat` within 0.001 rad.
- [x] Encoding 10k Transforms with all rows changed stays within budget `net/encode` and allocates
      nothing; applying them stays within `net/apply` and allocates nothing. (Measured 3.9 ms and
      1.6 ms on an Apple M5 Max; the named machines haven't run it.)
- [x] `netHarness` with 2 clients at 100 ms ± 20 ms and 5% loss: 1 s after the server stops
      changing state, `converged(...)` holds for every replicated component.
- [x] An entity outside a client's `gridInterest` range is never encoded for it, and despawns on
      the client within two network ticks of leaving the range.
- [x] A component with `visibleTo: ownerOnly` never appears in another client's decoded traffic,
      and moves with ownership.
- [x] A late joiner reaches `converged` with the other clients within 2 s of connecting, for a
      world of 5k replicated entities at `bytesPerTick: 16000`.
- [x] With `bytesPerTick` too small for all changes, every entity is still sent within
      `ceil(total / budget) + 2` ticks, highest priority first.
- [x] A remote entity moving at constant velocity renders without visible steps: every frame
      advances by a third to three times its per-frame distance.
- [x] A prefab spawn sends only the prefab ref and replicated components.

## Open questions

- Per-field change detection: core marks whole rows changed. The first version diffs the row
  against the last sent value per client to build the field mask. A per-field dirty mask in core
  would be faster; measure first.
- Entity fields that point at an entity the client can't have encode as null (decided), so no
  information leaks. One that points at a relevant entity not spawned yet is resent once it is.
