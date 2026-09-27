# 0008 — Input and action maps

- **Status:** implemented
- **Packages:** `@aethervtt/shard-input`
- **Depends on:** 0002, 0003

## Context

Games shouldn't read "the space key". They read "jump", and "jump" is bound to space, the gamepad's
south button, and a touch button, depending on the device. Action maps also make input something an
agent can author as data and drive in tests: an agent can press "jump" in a headless run without
simulating a keyboard.

Input also carries a determinism requirement from the vision: recorded input replayed in a headless
run must reproduce the same world.

## Goals

- Keyboard, mouse (including pointer lock and wheel), touch, and gamepad state as resources.
- Per-frame consistency: input sampled once at the start of the frame.
- Action maps as data: named actions (button, axis1d, axis2d) with bindings, dead zones, and
  context layers.
- Synthetic input for headless runs and agents.
- Recording and replay that reproduces world state exactly.

## Non-goals

- Picking entities under the pointer (render M5; input provides the pointer position and ray
  inputs).
- Text input and IME (UI spec).
- Rebinding UI (a game builds it on top of the action map API).

## Design

### Sources

Input comes from an `InputSource` provided by the platform, so the input plugin never touches the
DOM directly:

- `platform-web` and `platform-tauri` attach DOM listeners to the game canvas and poll the Gamepad
  API.
- The headless platform has no devices; input comes only from synthetic events.

Raw events are buffered by the source and drained in `First`, so every system in a frame sees the
same state.

### Device state

```ts
world.resource(Keyboard).pressed('KeyW')      // by KeyboardEvent.code: layout-independent
world.resource(Keyboard).justPressed('Space')
world.resource(Mouse).position                // canvas pixels
world.resource(Mouse).delta, .wheel, .justPressed('left')
world.resource(Gamepads).get(0)?.axis('leftStickX')
world.resource(Touches).active                // id, position, start position
```

Losing focus releases every held key and button (no stuck keys after alt-tab).

### Action maps

Defined in TS for type inference, or as a JSON data asset:

```ts
export const Controls = defineActions('game/Controls', {
  jump: { kind: 'button', bindings: ['Key:Space', 'Gamepad:South'] },
  move: {
    kind: 'axis2d',
    bindings: [{ composite: 'wasd' }, { composite: 'arrows' }, 'Gamepad:LeftStick'],
    deadZone: 0.15,
  },
  zoom: { kind: 'axis1d', bindings: ['Mouse:WheelY', { positive: 'Key:Equal', negative: 'Key:Minus' }] },
})

const actions = world.resource(Controls.resource)
actions.justPressed('jump')     // 'jump' is type-checked against the definition
actions.axis2d('move')          // [x, y], normalized to length ≤ 1
```

- Binding strings are a small, documented grammar (`Key:<code>`, `Mouse:<button|WheelY|DeltaX>`,
  `Gamepad:<button|stick|axis>`, `Touch:<zone>`), validated with `input/unknown-binding` errors that
  list valid names.
- **Interactions** on button actions, since timing logic is easy to get wrong in game code:
  `{ kind: 'button', bindings: ['Key:KeyE'], interaction: { hold: 500 } }` fires after 500 ms held;
  `{ tap: 200 }` fires on release within 200 ms; `{ multiTap: { count: 2, window: 300 } }` fires on a
  double tap. Actions expose `started`, `performed`, and `canceled` (a hold released early), plus
  `holdProgress` (0 to 1) for UI. Timing uses the frame clock (`Time`), so replays reproduce it.
- **Contexts**: action sets can be enabled/disabled (`gameplay`, `menu`), commonly tied to game
  states with `inState`.
- Action maps have JSON Schemas like everything else, so agents edit bindings as data.

### Synthetic input

```ts
input.inject(world, { action: 'game/Controls.jump', pressed: true })
input.inject(world, { key: 'KeyW', pressed: true })
```

Injected events go through the same buffer as real ones and apply at the start of the next frame.
The MCP layer (M3) exposes this so an agent can play the game.

### Recording and replay

- **Record**: per frame, store the drained raw events (not action states), so rebinding during
  analysis still works. Stored as compact JSON lines keyed by frame number.
- **Replay**: a replay source feeds recorded events frame by frame. Combined with the headless
  runner's fixed delta and seeded RNG (0004), the run is reproducible.

### Agent surface

- Action maps are data with schemas; bindings are validated with helpful errors.
- Agents can inject actions or raw input, and record/replay sessions for regression tests.
- `input.describe()`: connected devices, active contexts, current action values.

## Decisions

- **`KeyboardEvent.code`, not `key`.** Physical positions stay put across keyboard layouts (WASD
  works on AZERTY).
- **Record raw events, not actions.** Replays survive binding changes.
- **Input through the platform.** Keeps the engine free of DOM access (principle 6) and makes
  headless input the same code path as real input.
- **Sampled once per frame.** No input changing mid-frame between systems.
- **Hold, tap, and double-tap in v1.** Agents will ask for them constantly, and frame-clock timing
  keeps them deterministic.

## Acceptance criteria

- [x] Keyboard, mouse, wheel, touch, and gamepad state update once per frame with correct
      `pressed` / `justPressed` / `justReleased` semantics.
- [x] Blur releases all held inputs.
- [x] Action values combine bindings correctly: composites normalize diagonals, dead zones apply,
      the strongest binding wins.
- [x] Action names are type-checked; unknown binding strings fail validation with a list of valid
      names.
- [x] Disabled contexts produce no action values.
- [x] Hold, tap, and double-tap fire `started`/`performed`/`canceled` at the right frames, and
      behave identically in a replay.
- [x] Injected input behaves identically to real input.
- [x] A 600-frame recorded session replayed headless produces the same world hash as the original
      run.

## Implementation notes

- **Sources:** `InputSource` and `RawInputEvent` live in `@aethervtt/shard-platform`. `createDomInputSource`
  (in `platform-web`) serves both browsers and the Tauri webview. Headless apps omit the source.
- **Binding grammar as built:** `Key:<code>` (allowlisted codes, so typos fail), `Mouse:<Left|Middle|
  Right|Back|Forward|WheelX|WheelY|DeltaX|DeltaY>`, `Gamepad:<button|axis|LeftStick|RightStick>`
  (any connected pad), `Touch:Any`. Touch zones are deferred to the UI spec.
- **Contexts** are whole action maps: `state.enabled = false`. Tie them to game states from game
  systems.
- **Injected actions** (`injectInput(world, { action: 'game/Controls.jump', pressed })`) enter the
  same raw stream as `action` events, so they're recorded, replayed, and run through interactions.
- **Recording format:** JSON lines, a `{ "frames": n }` header then `{ "f": frame, "e": [events] }`
  for each frame with input. Replay ignores live input until it ends.
- Gamepad stick Y is up-positive (the DOM's is down-positive).
- Not yet wired into the playground demos; the next demo that needs controls will use it.

## Open questions

None.
