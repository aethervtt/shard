# 0126 — Transforms replicated relative to a parent

- **Status:** draft (built 2026-11-16). Implemented once its criteria pass in CI.
- **Packages:** `@aethervtt/shard-net`
- **Depends on:** 0087 (replication, interpolation)

## Context

Clients interpolate replicated Transforms in world space (0087), so each one is drawn a few ticks
behind the server. That suits things that move on their own. It breaks for something standing on a
platform each client poses itself, on its own clock. Stranded floats its raft on every machine from
the sea and the world's clock, so the raft isn't replicated and each client draws it where it is
now; castaways standing on it arrive late. In a headless session with no latency their feet sat
4–9 cm off the deck the client draws, and more over a real network.

Stranded worked around it (`apps/game/scripts/raft/aboard.ts`, its spec 0003): the server adds
`stranded/Aboard { raft, local }` to each character grounded on a raft, replicated and
interpolated, and a client system after `NetSystems.interpolate` overwrites the Transform with
raft × local, finding the raft by a game-level id because entity ids differ across machines. This
spec moves that into net, with the parts the workaround lacks: a change of platform or stepping off
without a pop, and rotation.

## Goals

- A replicated entity can name a parent its Transform is replicated relative to. The server sends
  the pose in the parent's space; each client interpolates it and composes it with the parent's
  Transform as that client has it this frame.
- The parent needn't be replicated: each machine may spawn its own copy (a raft, a partition cell's
  generated entity). It is named by a key that resolves on every machine.
- The parent can change or go away (stepping on and off) without a pop.
- Entities without a parent replicate exactly as before.

## Non-goals

- Parents in a hierarchy. An anchor's Transform is read as its world pose: anchors are roots.
- The parent's scale. Poses are translation and rotation; the entity's own scale replicates with
  its world Transform.
- Predicted entities (0088) and `OwnerSimulated` ones: the owner draws them itself.
- Choosing the parent. The game decides what an entity stands on (Stranded: the character's
  `groundEntity`).

## Design

```
server                                   client
------                                   ------
RelativeTo { parent } ──► net/relate      RelativeTransform (interpolated)
  parent has Anchor { key }                 │   anchor key ──► the local entity with that Anchor
  ──► RelativeTransform                     ▼
      { anchor: key, translation,         Transform = anchor (now) × local (+ easing offset)
        rotation }  (in parent space)
```

**Anchors.** `net/Anchor { key }` names an entity on every machine. Each side adds it to its own
copy (a raft prefab, a generator), or the anchor is replicated with it. Keys are unique per machine.

**Server.** The game adds `net/RelativeTo { parent }` to a replicated entity on the server. In
`Last`, before `net/send`, `net/relate` writes `net/RelativeTransform { anchor, translation,
rotation }`: the parent's key and the entity's pose in the parent's space, parent⁻¹ × Transform.
It marks the row changed only when a value changed, so a body standing still on a moving deck sends
nothing new. When `RelativeTo` goes, or its parent dies or has no Anchor, `RelativeTransform` goes.

`RelativeTransform` is net's own entry in every manifest, after `Replicated`: interpolated,
translation quantized to 0.5 mm. The world Transform keeps replicating as before, alongside it.

**Client.** `RelativeTransform` arrives and interpolates like any component, except that its
samples start over when its anchor key changes or it is added again: a pose in another space
doesn't interpolate from the old one. Then:

- `net/compose` (PreUpdate, after `net/interpolate`) finds each anchor by key (a cache, rescanned at
  most once a frame when a key misses) and writes Transform = anchor × local, so Update systems
  read it.
- `net/recompose` (PostUpdate, before `TransformSystems`) composes again with the anchor where it
  is by then, so a client that poses anchors in FixedUpdate or Update still draws the body on them.

An entity whose anchor this client doesn't have stays in world space (its replicated Transform).

**No pops.** A body's drawn pose changes space when it steps on (world → anchor), across (anchor A
→ B), or off (anchor → world). The world pose is a few ticks late and the anchored one isn't, so the
two disagree by the platform's speed × the delay. At the change, the client takes the difference
between where the body was being drawn (its old anchor now × its last local, or its last drawn pose
if that anchor is gone) and where it should be now, and adds it as an offset that eases to nothing
(exponentially, time constant `SETTLE_SECONDS` = 0.1 s; dropped below 0.01 mm). Rotation eases the
same way. The body lands where it was and slides into place.

### API sketch

```ts
import { Anchor, RelativeTo, RelativeTransform, NetSystems } from '@aethervtt/shard-net'

// Every machine: its own raft, named the same.
world.spawn([Anchor, { key: 'raft:0' }], Transform, …)

// Server, after physics: whoever stands on a raft rides it.
if (isRaft(ground)) world.add(e, RelativeTo, { parent: ground })
else world.remove(e, RelativeTo)

// Client: pose the raft before NetSystems.compose (or before NetSystems.recompose at the latest).
app.addSystems(PreUpdate, floatRaft.before(NetSystems.compose))
```

### Agent surface

The three components appear in `shard docs` component references and `net.describe`'s
`components` (`net/RelativeTransform`, mode `interpolate`). Errors: none new.

## Decisions

- **Anchors are named by a string key component, not an entity id, scene path or 0113 binding.**
  The parent may not be replicated at all, and each machine spawns its own; a key the game chooses
  (`raft:0`, a cell ref) resolves without a net id, an interest decision or a scene. A replicated or
  bound entity can carry an Anchor too.
- **The server authors `RelativeTo { parent: Entity }`, not a key.** The game knows the entity it
  stands on (`groundEntity`); net reads the key from it.
- **The world Transform keeps replicating.** A client without the anchor falls back to it, stepping
  off has a current world track to land on, and the cost is one extra component on bodies aboard.
- **A separate component, not a relative Transform on the wire.** Interpolation buffers never mix
  world and local samples, and entities without a parent are untouched.
- **Easing offsets instead of matching clocks.** The world track is late by design; recording past
  anchor poses to compose at the render tick would need every game's platform history. An offset
  that eases out over ~0.1 s hides the change and costs nothing per frame once settled.
- **Compose twice.** Once after interpolation for gameplay code, once before propagation for what
  is drawn, so the game needn't order its anchor posing against net's.
- **Always in the manifest.** Opting in would need the same flag on both sides; an unused entry
  costs one component check per entity per send.

## Acceptance criteria

- [x] A server and two clients, each spawning two platforms locally and moving them by a function of
  the server tick, with a replicated body standing on one: on each client, the body's position in
  the platform's space matches the server's within 3 mm every frame for 2 s, while a world-space
  pose a few ticks late would be more than 10 cm off (`relative.test.ts`).
- [x] Stepping across to the other platform, back, and off onto the ground: no frame moves the body
  more than 1.25 × its speed before or after plus 1 cm (without the easing offset the switch moves
  7.5 cm in one frame and fails). Off the platform it lands where the server has it, within 3 mm.
- [x] An entity without RelativeTo gets no RelativeTransform on either side, and replicates as
  before (the existing net tests pass unchanged).
- [x] `pnpm typecheck && pnpm test && pnpm lint` pass.

## Open questions

- Snapping instead of easing when a body teleports onto a platform far from where it was drawn
  (0087 doesn't snap teleports either).
