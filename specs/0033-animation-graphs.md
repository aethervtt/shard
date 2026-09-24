# 0033 — Animation state machines

- **Status:** implemented
- **Packages:** `@shard/animation`
- **Depends on:** 0031, 0032

## Context

A character plays idle, walk, run, jump, fall, and land, and chooses among them from its speed,
ground state, and inputs. Writing that in systems means every game rebuilds the same state
machine with crossfades and timing bugs. Every engine ships an animation graph for this.

For Shard the graph is a data asset: an agent writes states, transitions, and conditions in JSON,
validates it, and watches the state change through the protocol while a test drives parameters.

## Goals

- `*.animgraph.json` data assets: parameters, layers, states, transitions with conditions,
  durations, and exit times.
- States that play a clip, a 1D blend space (by speed), or a 2D blend space (by direction).
- Layers with masks and weights, reusing 0032's player.
- Parameters set from code or bound to component fields, so most graphs need no glue code.
- Current state, transition progress, and parameters visible through the protocol.

## Non-goals

- Visual graph editing. Nested state machines (sub-states): a layer is one flat state machine.
- Generic per-entity gameplay state machines (a separate core feature; this is for animation).

## Design

### Graph files

```json
{
  "parameters": {
    "speed": { "type": "float", "bind": { "component": "physics/CharacterState", "field": "velocity", "op": "length" } },
    "grounded": { "type": "bool", "bind": { "component": "physics/CharacterState", "field": "grounded" } },
    "attack": { "type": "trigger" }
  },
  "layers": [{
    "name": "base",
    "entry": "locomotion",
    "states": {
      "locomotion": { "blend1d": { "parameter": "speed", "clips": [[0, "#idle"], [1.5, "#walk"], [5, "#run"]] } },
      "fall": { "clip": "#fall", "loop": "loop" },
      "land": { "clip": "#land", "loop": "once" }
    },
    "transitions": [
      { "from": "locomotion", "to": "fall", "when": "!grounded", "duration": 0.15 },
      { "from": "fall", "to": "land", "when": "grounded", "duration": 0.05 },
      { "from": "land", "to": "locomotion", "exitTime": 0.8, "duration": 0.2 }
    ]
  }, {
    "name": "upper", "mask": { "path": "data/masks/upper-body.mask.json" }, "weight": 1,
    "entry": "none",
    "states": { "none": {}, "swing": { "clip": "#swing", "loop": "once" } },
    "transitions": [
      { "from": "none", "to": "swing", "when": "attack", "duration": 0.1 },
      { "from": "swing", "to": "none", "exitTime": 1, "duration": 0.2 }
    ]
  }],
  "clips": { "idle": { "path": "assets/hero.glb#Animation/Idle" } }
}
```

- `#name` refers to the file's `clips` table, so a graph can be pointed at another model's clips by
  changing one block. A clip can also be `{ "path": ... }` directly.
- `{}` is an empty state: it plays nothing, so the layers below show through (the upper layer's
  `none`).
- Binding ops: `value` (default), `length`, `horizontal` (xz length), `x`, `y`, `z`, `not`. The
  component is read from the animator's entity or its nearest ancestor that has it, so a model under
  a character controller entity finds its `CharacterState`.
- A state has `loop` (`loop`, `once`, `ping-pong`) and `speed`. `exitTime` is the source state's
  normalized time, unwrapped (1.5 is halfway through a loop's second cycle); an empty state's is in
  seconds. A layer has `weight`, `blend` (`override` or `additive`), and `mask`.
- An any-state transition doesn't re-enter the state it goes to.
- Conditions are a small expression language: parameter names, `!`, `&&`, `||`, comparisons with
  numbers (`speed > 0.1`), and triggers (consumed when a transition takes them). It's parsed at
  import, and errors point at the character in the condition.
- `from: "*"` is an any-state transition. Transitions are checked in file order, first match wins.
- Blend spaces: 1D interpolates the two nearest clips by the parameter, and syncs their normalized
  times so feet don't slide. 2D (`blend2d` with `x` and `y` parameters) uses the three nearest
  samples (barycentric in a Delaunay triangulation made at import). Outside the samples' hull (or
  with collinear samples) it blends the two ends of the nearest edge.

### Runtime

```ts
Animator { graph: handle('AnimationGraph') }
AnimatorParams { values: json }                   // parameters set from code, readable and patchable
setAnimParam(world, entity, 'attack', true)       // triggers reset once consumed
createAnimationGraph(json)                        // a graph made in code (tests, tools)
```

- `AnimatorParams.values` holds the unbound parameters (a trigger turns false when a transition
  takes it). Bound parameters aren't mirrored into it: storing a changing number into a JSON object
  allocates every frame. `animation.describe` shows every value, and what each binding reads.
- It's read only when something else changed the component (its change tick), since loading a
  number out of a JSON object can allocate too.

- The `animation/graph` system runs in `PostUpdate` before sampling. It reads bound parameters,
  evaluates transitions per layer, and writes the resulting layers (with crossfade weights) into
  the entity's `AnimationPlayer`. The player then samples as in 0032.
- Each graph layer keeps a stack of up to four states: the newest fades in over the ones below it,
  so a transition can interrupt a transition. Each clip in it gets a share of the layer's pose;
  because override layers lerp in order, share `c_k` is written as weight `c_k / (1 − T + S_k)`
  (`T` the total, `S_k` the running sum), which leaves `1 − T` for the layers below. The graph
  sets each clip's time and speed from the state's normalized time, and the player advances it.
  Player layers it no longer needs are left with no clip and weight 0 rather than removed, so the
  list doesn't churn.
- Entering a state sends `AnimatorStateEntered { entity, layer, state, from }` (`from` is null for
  the entry state on the first frame), so gameplay can hook "landed" or "swing hit" without
  polling. `layer` and `state` are names.
- A reloaded graph (hot reload) restarts its animators at their entry states.
- Parsed conditions compile to a flat opcode array per transition, evaluated without allocation.

### Agent surface

- `animation.describe` adds, per layer: current state, the transition in progress and its
  progress, time in state, and the parameter values.
- The graph's JSON Schema is published (`animgraph.schema.json`) and `shard validate` checks
  graphs: unknown states, clips, and parameters, unreachable states (a warning), and conditions
  that don't parse. Clip and mask paths, and bound components and fields, are checked after the
  scan through a new importer hook, `ImporterDef.check`, which `validateDataAssets` runs.
  `shard validate` now lists import warnings too.
- A skill, `animate-a-character.md`: import a model, write a graph, bind speed, test that the
  state changes when the character moves.
- **Errors:** `animgraph/unknown-state`, `animgraph/unknown-parameter`, `animgraph/bad-condition`,
  `animgraph/unreachable-state` (warning), plus `animgraph/unknown-clip`, `animgraph/unknown-mask`,
  `animgraph/unknown-component`, `animgraph/unknown-field`, `animgraph/bad-parameter`,
  `animgraph/bad-state`, `animgraph/bad-blend`, `animgraph/bad-transition` (neither `when` nor
  `exitTime`), `animgraph/duplicate-layer`, `animgraph/invalid-json`, `animgraph/no-animator`.
  Unknown names come with a "did you mean".

## Decisions

- **Parameters can bind to component fields.** Most locomotion graphs read speed and ground state,
  which already live in components. Binding them keeps glue systems out of games.
- **Graphs drive the player; they don't replace it.** Everything 0032 can do is available to
  graphs, and a game can still play clips directly for cutscenes.
- **Condition strings, compiled once.** They're shorter to write than nested JSON, and parsing at
  import means runtime cost is a few opcodes.

## Acceptance criteria

- [x] A test graph moves locomotion → fall → land → locomotion as the bound `grounded` flips, with
      each transition's duration, and sends `AnimatorStateEntered` for each.
- [x] A 1D blend space at `speed` 3.25 plays walk and run at weights 0.5 each, with synced times.
- [x] A 2D blend space at a direction between samples weights the three nearest clips
      barycentrically.
- [x] A trigger fires one transition and resets. An any-state transition takes priority by order.
- [x] A condition with a typo fails validation with a pointer to the condition and the column.
- [x] 200 animators evaluate in under 0.5 ms per frame (bench), with no steady-state allocations.

## Open questions

- None blocking.
