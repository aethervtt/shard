# 0088 — Prediction, reconciliation, and lag compensation

- **Status:** accepted (Phase 2)
- **Packages:** `@aethervtt/shard-net`, `@aethervtt/shard-runtime`, `@aethervtt/shard-physics`,
  `@aethervtt/shard-input`
- **Depends on:** 0008, 0028, 0029, 0086, 0087

## Context

If a client waits for the server before moving its own character, every keypress takes a round
trip to show: 100 ms of RTT is a game that feels broken. Shooters and action games instead let the
client run its own character ahead with its own input (prediction), then correct it when the
server's answer for that input arrives (reconciliation). The server checks hits against where
targets were on the shooter's screen, not where they are now (lag compensation).

All three need the same thing: input as data per tick, per player, that both sides can replay.
Shard's input is per frame, merged over devices, and its action state is private, so it can't be
replayed. This spec adds a schema'd net input, a schedule of systems that can be re-run, and
history to rewind to. It's designed now so 0086 and 0087 leave room for it, and built after them.
Lockstep and rollback (a later spec) reuse the same input pipeline.

## Goals

- `defineNetInput`: a per-tick input struct with a schema, sampled from action maps, sent
  redundantly, buffered by tick on the server.
- `PredictedUpdate`: a schedule inside the fixed step that both sides run per tick, and that the
  client re-runs to reconcile.
- Prediction history: predicted components per tick for the client's own entities.
- Reconciliation: compare at the acked tick, rewind and re-simulate on mismatch, smooth the visual
  correction.
- Time dilation through `FixedTime.rate` so a client runs the right number of ticks ahead.
- Lag compensation: rewind `LagCompensated` colliders to a client's view time for queries.
- The character controller (0029) works as a predicted system.

## Non-goals

- Predicting other players or physics bodies the client doesn't own. They interpolate (0087).
  Predicted spawns (a projectile that appears at once) are a later addition.
- Rewinding the whole physics world. Prediction re-simulates only the client's predicted
  entities against the current static world.
- Lockstep and rollback of the whole world.

## Design

### Net input

```ts
const MoveInput = defineNetInput('fps/MoveInput', {
  move: t.vec2({ min: -1, max: 1 }), yaw: t.f32(), pitch: t.f32(), jump: t.bool(), fire: t.bool(),
})
// client, FixedUpdate, before net/send-input: sample action maps into this tick's input
writeInput(world, MoveInput, { move: actions.axis2d('move'), jump: actions.pressed('jump') })
// both sides, PredictedUpdate: read the input of the entity being simulated
const input = readInput(world, MoveInput, entity)
```

- An input is a `defineSchema` struct, so it's validated, quantized by 0087's codec, and covered
  by the handshake's schema hash.
- The client sends the inputs for its last 4 ticks in every message on the unreliable channel.
  One lost packet costs nothing.
- The server keeps a jitter buffer per peer of 2 to 6 ticks. On server tick T it reads the peer's
  input for T. A missing input repeats the last one and is counted in `net.stats`.
- `NetInputOf { peer }` on an entity says whose input drives it. `readInput` returns that peer's
  input for the tick being simulated, live or re-simulated.
- Input timing stays per tick. A hold or tap that the action map computes from `Time.elapsed` is
  resolved on the client before sampling, and only the result is sent.

### PredictedUpdate

A schedule that runs inside each fixed step, before `FixedUpdate`'s physics:

```ts
app.addSystems(PredictedUpdate, moveCharacter, fireWeapon)
```

- On the server it runs once per tick for every entity with `NetInputOf`.
- On the client it runs once per tick for the entities the client owns that have a
  `predicted: true` component. Other entities aren't simulated by it.
- Systems in it must read only: predicted components, net inputs, `FixedTime`, and static world
  data (colliders that don't move). That's what makes re-running them correct. A system that
  reads other state is still allowed but drifts, which `net.stats` reports as corrections.
- Runtime change: `App` runs registered sub-schedules at a position in the fixed step
  (`app.addFixedSchedule(PredictedUpdate, { before: 'physics' })`), and exposes
  `app.resimulate(schedule, fromTick, toTick, beforeEach)` for rollback. It advances
  `FixedTime.tick` and `elapsed` through the range and restores them after.

### History and reconciliation

- The client keeps a ring per predicted entity: for each of the last 64 ticks, the predicted
  components' values (encoded by 0087's codec into one preallocated buffer) and the input sent.
- A server update for an owned predicted entity carries the tick of the last input the server
  applied for it.
- On receipt, the client compares the server's values with its history at that tick, field by
  field, within each field's quantization step.
  - **Match:** drop history up to that tick. Nothing else happens.
  - **Mismatch:** write the server's values, then `resimulate(PredictedUpdate, ack + 1, now)`
    feeding the stored inputs. Store the new history.
- **Smoothing.** The visual Transform keeps an offset from the corrected one that decays to zero
  over 0.1 s, so a correction doesn't show as a snap. Large errors (over 1 m, or `Teleported`)
  snap.
- Cost: re-simulating 64 ticks of one character is about 64 controller steps. 0029's budget is
  1 ms per 100 controllers, so the worst case is well within a frame.

### Character controller

`characterSystem` (0029) reads Transform and `CharacterState`, writes them, and queries the
Rapier world. As a predicted system it reads `CharacterIntent` from a net input instead of a
component written by game code, and its state is `predicted: true`.

- It re-simulates against the current collider set. Static geometry is exact; moving platforms
  and pushed bodies are what they are now, not at the rewound tick. Platform carry is reconciled
  like any other mismatch.
- `pushBody` impulses don't apply during re-simulation (`ResimulationState.active`), so dynamic
  bodies aren't pushed twice.

### Time dilation

The client aims to be `rtt / 2 + jitterBuffer` ticks ahead of the server, so its input for tick T
arrives before the server simulates T. The server reports in each update how many ticks of the
client's input it had buffered. The client sets `FixedTime.rate` between 0.95 and 1.05 to move the
buffer toward its target, and jumps (resets the tick) only when the error is above 10 ticks.

### Lag compensation

```ts
// server, in a PredictedUpdate system handling fire:
rewind(world, peer, () => {
  const hit = physics.raycast(origin, dir, maxDistance, { filter: Hitbox })
}, { tick: input.viewTick, alpha: input.viewAlpha })
```

- `net/LagCompensated` on an entity makes the server record its colliders' poses per tick in a
  ring of `maxRewind` (default 0.25 s).
- The client sends with each input the server tick it was rendering (`viewTick`, `viewAlpha`),
  which is what 0087's interpolation shows.
- `rewind` moves the recorded colliders to that time in the physics query pipeline, runs `fn`,
  and puts them back. It never changes rigid-body state, only query poses. A request older than
  `maxRewind` clamps to it.

### Agent surface

- `net.stats`: per peer predicted ticks, corrections per second, largest correction, missing
  inputs, input buffer depth, current `rate`.
- `net.inspect(entity)`: history depth and the last correction (tick, fields, size).
- Errors: `net/input-overflow` (a client sending inputs too far ahead), `net/rewind-clamped`
  (logged, not thrown).

## Decisions

- **Inputs, not actions or raw events, cross the wire.** A game-shaped struct is small, schema'd
  and replayable; raw device events aren't per player and depend on private action timers.
- **Re-simulate a schedule, not the world.** Only the client's own predicted entities run again,
  which is cheap and needs no world snapshot.
- **Rewind query poses only.** Lag compensation answers "what did the shooter see", so it never
  needs to roll physics back.
- **Dilation over snapping.** Changing the step rate by a few percent is invisible; resetting the
  tick isn't.

## Acceptance criteria

- [ ] At 150 ms RTT and 0% loss, a predicted character responds to input on the frame it's
      pressed, and the server reports zero corrections over 10 s of movement on flat ground.
- [ ] At 150 ms RTT and 5% loss, the server is missing no input over 10 s (redundancy covers it).
- [ ] A forced server-side change (the server teleports the character 0.5 m) is corrected on the
      client within one RTT, and the rendered position moves continuously (no frame jumps more
      than the decay allows).
- [ ] Re-simulating 64 ticks of one character controller stays within budget
      `net/resimulate` and allocates nothing.
- [ ] `rewind` at 100 ms RTT hits a target moving at 5 m/s that was under the crosshair on the
      shooter's client, and misses where the target is on the server at that moment.
- [ ] A client whose clock runs 3% fast settles to its target lead within 5 s without a tick
      reset.

## Open questions

- Predicted spawns (projectiles, effects) need a temporary id that the server's spawn later
  claims. Shape it once a game needs it.
- Should `PredictedUpdate` allow physics bodies the client owns (vehicles)? That needs per-body
  physics snapshots; a later spec, possibly shared with rollback.
