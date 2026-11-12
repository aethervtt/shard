# 0109 — Graph states placed by a parameter (distance matching)

- **Status:** draft (built)
- **Packages:** `@aethervtt/shard-animation`
- **Depends on:** 0033

## Context

A walking character whose clips play by the clock steps in place: a start or stop transition, or
a one-tile move, plays its footfalls whether or not the body covers the ground they cover. Games fix
this with **distance matching**: the clip's time follows the distance the body has actually moved,
so a foot only lifts when the body advances. 0033's states play at a fixed `speed`, so a graph can't
express it, and a game would have to drive `AnimationPlayer` itself and lose the graph.

## Goals

- A state's normalized time can be a float parameter: the state plays exactly where it says.
- A state's playback rate can be a float parameter, for clips matched to speed instead of distance.
- Everything else (transitions, exit times, blends, layers, crossfades) keeps working on such states.

## Non-goals

- Reading distance from root motion inside the engine. The game knows how far its character has
  gone (a navmesh path, a server); it sets the parameter.
- Pose matching (choosing the frame that best matches the current pose).

## Design

```json
"walk":  { "clip": "#walk",  "time": "cycle" },
"start": { "clip": "#start", "loop": "once", "time": "startT" },
"run":   { "clip": "#run",   "speed": "runRate" }
```

- `time`: a float parameter. The state's normalized time is its value each frame (0 the start, 1
  the end; a loop wraps, `once` clamps, `ping-pong` folds), and nothing advances it, so a state whose
  parameter stops changing holds its pose. Player layers get `speed: 0` and the placed time.
- `speed`: a number (as before) or a float parameter whose value is the rate.
- Exit times read the placed time: `{ "from": "start", "to": "walk", "exitTime": 1 }` fires when
  the parameter reaches 1.
- A blend space placed by `time` places all its synced clips at that normalized time.
- Validation: unknown parameters (`animgraph/unknown-parameter`, with a suggestion) and non-float
  ones (`schema/type-mismatch`) at `/layers/i/states/name/time` or `/speed`. The JSON Schema allows
  a string for `speed` and adds `time`.

## Decisions

- **Normalized time, not seconds.** Distance matching maps distance to a fraction of a clip; the
  graph shouldn't need the clip's length.
- **Placed states don't advance.** Mixing a placed time with the clock would bring back the steps
  in place the feature exists to remove.

## Acceptance criteria

- [x] A `once` state placed at 0.25 shows the clip's pose at a quarter, and holds it while time
  passes; placed past 1 it holds the last pose. A loop placed at 2.75 shows 0.75.
- [x] A state at `speed: "rate"` with rate 0.5 plays a two-second clip a quarter through in a second,
  and holds still at rate 0.
- [x] An exit time of 1 waits for the placed time, not the clock.
- [x] A bool `time` and an unknown `speed` parameter fail validation at their paths.
