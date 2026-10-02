# 0060 — Camera controls, gestures, and object drag

- **Status:** implemented
- **Packages:** `@aethervtt/shard-controls` (new), `@aethervtt/shard-input`, `@aethervtt/shard-platform`, `@aethervtt/shard-platform-web`
- **Depends on:** 0008, 0027, 0057

## Context

Shard's input layer delivers raw pointer, touch and wheel events plus action maps (0008). Every
playground demo wrote its own camera code. A tabletop needs the controls Aether has now, working
the same on mouse, trackpad and touch:

- pan and zoom-to-cursor on the orthographic Map;
- orbit, pan and dolly on the perspective Tabletop;
- dragging tokens and props along the floor;
- a way to cancel a drag with Escape;
- never swallowing events the scene didn't use, so the host's DOM (context menus, panels) still
  gets them.

## Goals

- A gesture recognizer: tap, double tap, long press, drag (with a threshold), pinch, twist and
  two-finger pan, from pointers, in CSS pixels.
- `MapControls` (orthographic) and `OrbitControls` (perspective). Each moves only its own camera.
- `syncViews`, so switching between the Map and the Tabletop keeps the same place in view.
- `PlaneDrag`: drag a picked entity along a horizontal plane, keeping the grab offset, with cancel.
- Pass-through: `preventDefault` only on what the scene takes.

## Non-goals

- Gameplay character controls (0029), follow, first-person or fly cameras. They can be added as
  more controls later.
- Keyboard shortcuts beyond the cancel action. Those are the host's.
- Deciding what may be dragged, or committing a move. The host does both.

## Design

### Pointer events and the pointer policy

Sources report a `pointer` event (`down`, `move`, `up`, `cancel`) with the pointer id, kind
(`mouse`, `pen`, `touch`), button, `MODIFIERS` bits and a position in CSS pixels from the element's
top left. Wheel events carry their position and modifiers too, with line and page deltas already
in pixels. The `mouse-*` and `touch` events stay as they were: they feed the device resources and
action maps.

A source may take two calls from the engine:

- `claimPointer(id)`: a consumer took this pointer's gesture. Its later events are
  `preventDefault`ed, and it's captured (`setPointerCapture`), so the drag keeps reporting outside
  the element.
- `setPointerPolicy({ buttons, wheel, touch })`: what enabled controls take. A press with one of
  `buttons` is `preventDefault`ed and captured from `pointerdown` (the claim itself only lands a
  frame later); the context menu is stopped only while `'right'` is taken (with
  `createDomInputSource(el, { contextMenu: 'pass' })`, for a host with menus of its own; a game that
  owns its page keeps the default, `'block'`); the wheel is stopped
  only while `wheel` is set; the element has `touch-action: none` only while `touch` is set.

Nothing else is stopped, so with no enabled control a `'pass'` page behaves as if the scene
weren't there.

### Gestures

`gesturesPlugin` (in `shard-input`) turns the pointer stream into `Gesture` events
(`GestureEvent`), positions and deltas in CSS pixels:

- `tap` and `double-tap` (300 ms, 6 px);
- `long-press` (500 ms; it asks an on-demand runner for the frame it fires on);
- `drag-start`, `drag`, `drag-end`, after 4 px, with the button, the pointer kind and the
  modifiers held when it started, and `startX`/`startY`;
- `pinch` (`scale`), `twist` (`angle`) and `pan2` (`dx`, `dy`) about the two fingers' center, in
  that order per move: pan first, then scale and turn about where the fingers are now. A one-finger
  drag that gains a second finger ends as a drag, and the two-finger gesture takes over;
- `wheel`, and a ctrl wheel (a trackpad pinch) as `pinch` with id 0.

Every event has the gesture's `id`. The thresholds are `Gestures.settings`.

Claims (`world.resource(Gestures)`):

- `claim(id, owner)` takes a live, unowned gesture, and tells the source (`claimPointer`).
- `take(id, owner)` takes it from another owner, who sees `owner(id)` change.
- `hold(id)` / `release(id)`: a consumer is still deciding (an async `pick`).
- `free(id)`: live, unowned and not held. Fallback consumers (the controls) only claim free ones.
- `position(id, out)`: where its pointer is now, so a late claim catches up.
- A press the UI captured (`Mouse.captured`, `Touches.captured`) is owned by `'ui'`.

Order within a frame: gestures are recognized in `First`, hosts handle them in `Update`, the
controls in `PostUpdate`. A host's claim (or hold) therefore always comes before a control's.

`gestures.cancel()` ends every active drag with `drag-end { cancelled: true }`, and two-finger
gestures; their pointers are ignored until they lift. The built-in action
`input/GestureActions.cancel` is bound to Escape; a host rebinds or removes it with
`rebindAction`.

### Controls

```ts
OrbitControls {                       // on a perspective Camera3d
  target: vec3, distance: f32 = 10, yaw: f32 (deg, 0 looks from +Z), pitch: f32 = 45 (deg)
  minPitch = 15, maxPitch = 89, minDistance = 1, maxDistance = 100
  orbitButton: 'right', panButton: 'middle'          // Shift + orbit button pans (trackpads)
  leftDrag: 'orbit' | 'pan' | 'none' = 'orbit'       // left and one-finger drags nothing claimed
  rotateSpeed = 0.3 (deg/px), zoomSpeed = 1, autoRotate = 0 (deg/s, a turntable)
  smoothing = 0 (s), enabled = true
}
MapControls {                         // on an orthographic Camera3d
  target: vec3, zoom = 1, minZoom = 0.1, maxZoom = 8
  height = 20                         // orthoHeight = height / zoom
  elevation = 50                      // camera distance from the target along its view
  pitch = 90                          // tilt: 90 looks straight down; less looks from the south
  plane: 'xz' | 'xy' = 'xz'           // xy: a 2D world, seen along -Z
  bounded = false, boundsMin: vec2, boundsMax: vec2
  panButton: 'middle', leftDrag: 'pan' | 'none' = 'pan', zoomSpeed = 1
  smoothing = 0 (s), enabled = true
}
ControlsSettings { reducedMotion: false, viewport: [1280, 720] }   // headless view size
```

The fields are where the camera is going. Input changes them, a host may write them (to restore a
saved view), and with `smoothing` the camera eases toward them (`snapControls` jumps). Reduced
motion forces immediate moves. Controls are components, so a host can save and restore a view.

`controls/update` runs in `PostUpdate` before transform propagation, only for a control that is
`enabled` on an `active` camera, and writes only that camera's `Transform` (and the Map's
`orthoHeight`). Cameras with controls are unparented. The controls reason in a view built from
their own fields, not last frame's matrices, so they work headless and within the frame.

- **Zoom to cursor:** the floor point under the cursor stays under it. Both cameras scale about
  it: the target moves toward it by the zoom factor, so it stays on the same ray.
- **Pan:** the floor point grabbed at the drag's start stays under the pointer.
- **Touch:** `pinch` zooms and `pan2` pans, the floor following the fingers; `twist` yaws the
  orbit about the floor point between them.
- **Frames:** a `controls` frame demand (0052) is held only while a camera eases or turns.

`syncViews(world, from, to)` puts the `to` camera over the same `target`, with a scale that shows
the same floor height: the orthographic `height / zoom` against `2 × distance × tan(fovY / 2)`.
Between two orbit controls yaw and pitch carry over. `to` jumps there. The host calls it when
switching views. It never runs by itself, so switching one reader's view can't change another's.

### Object drag

```ts
const drag = world.resource(PlaneDrag)
drag.begin({ entity, gesture, plane: 'grab' | { y }, grab?: Vec3, snap?: (p: Vec3) => void, camera? })
world.reader(DragMoved)   // { entity, position, delta }
world.reader(DragEnded)   // { entity, position, start, cancelled }
```

The host calls `begin` from its own `drag-start` handler after `pick()` says what's under the
pointer and the host decides it's movable. A host that decides asynchronously `hold`s the gesture
first, so a control doesn't pan meanwhile. `begin` takes the gesture (from a control, if one had
it), then projects the pointer onto the plane each move, keeping the offset from the grab point
(`grab`, or the start pixel on the plane). It runs `snap` (for example to a grid cell center, with
`@aethervtt/shard-grid/math`) and writes the entity's `Transform`: one instance slot per move. On
cancel it restores the start transform. The host commits on `DragEnded`, as Aether patches on drop
today. The camera defaults to the active one drawn first.

### Agent surface

- `controls.describe`: each control's camera, kind, fields and eased state, whether it's active,
  moving and dragging, plus the PlaneDrag.
- `input.simulate` (0011) plays `{ drag }`, `{ pinch }`, `{ wheel }`, `{ tap }` and `{ wait }`
  gestures a step per frame, so gameplay tests (`game.input.gesture(...)`) and agents
  (`simulate_gestures`) drive controls and drags headless.
- Projects enable `"controls"` (or `"gestures"`) in `shard.json`.

## Decisions

- **Claiming instead of global capture.** A tabletop sits among DOM panels. Only the scene knows if
  a pointer hit something it uses, so only claimed pointers, and what enabled controls take, stop.
- **Hosts first, controls as fallback.** Hosts claim in `Update` and may `hold` while an async pick
  runs; controls only claim free gestures in `PostUpdate`. A drag over a token moves the token,
  one over the floor moves the camera, whatever order the answers arrive in.
- **Gestures live in `shard-input`.** They're useful without cameras (UI, 2D games); the controls
  package adds the cameras.
- **Controls write only their camera; views sync on request.** That's what "switching views doesn't
  change another reader's camera" requires, and it keeps each view's state intact while inactive.
- **Fields are the goal.** Saving, restoring and easing need one source of truth; the eased state
  lives in `ControlsState` and never in the component.
- **Drag without commit.** The host is authoritative for moves. The engine gives it previews and
  final positions.

## Acceptance criteria

All driven headless through simulated input:

- [x] Wheel zoom and pinch keep the world point under the cursor within 0.5 CSS px, in both
      controls.
- [x] Panning keeps the grabbed floor point under the pointer within 0.5 CSS px over a 400 px drag.
- [x] A 3 px pointer move is a tap; a 5 px move is a drag.
- [x] A drag on an inactive camera's controls moves nothing, and switching `active` leaves both
      cameras' controls unchanged.
- [x] `syncViews` from Map to Tabletop keeps `target`, and the visible floor width within 10%.
- [x] `PlaneDrag` with a grid snap ends on cell centers. Escape mid-drag restores the start
      transform and emits `DragEnded { cancelled: true }`.
- [x] A pointer down on empty space with no claiming consumer is not `preventDefault`ed. A claimed
      drag is, and it keeps receiving moves outside the canvas.
- [x] Pitch stays within `[minPitch, maxPitch]`, and zoom within its limits, under any input
      sequence (property test).

## Open questions

- Should `MapControls` support rotation (Map views rotated to a scene's north)? Proposed: yes, as
  `rotation: f32`, left out of the first build. `pitch` (a tilted Map) and `plane: 'xy'` (2D) went
  in instead: the playground's Map is tilted 10° so wall faces show.
