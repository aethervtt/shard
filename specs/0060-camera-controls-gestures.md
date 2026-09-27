# 0060 — Camera controls, gestures, and object drag

- **Status:** accepted
- **Packages:** `@aethervtt/shard-controls` (new), `@aethervtt/shard-input`, `@aethervtt/shard-platform-web`
- **Depends on:** 0008, 0027, 0057

## Context

Shard's input layer delivers raw pointer, touch and wheel events plus action maps (0008). Every
playground demo writes its own camera code. A tabletop needs the controls Aether has now, working
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
- Pass-through: `preventDefault` only on events a gesture consumed.

## Non-goals

- Gameplay character controls (0029), first-person or fly cameras. They can be added as more
  controls later.
- Keyboard shortcuts beyond the cancel action. Those are the host's.
- Deciding what may be dragged, or committing a move. The host does both.

## Design

### Gestures

`gesturesPlugin` turns the pointer stream into `Gesture` events, with positions and deltas in CSS
pixels:

- `tap` and `double-tap` (300 ms, 6 px);
- `long-press` (500 ms);
- `drag-start`, `drag`, `drag-end`, after 4 px of movement, with the button, the pointer type and
  modifiers;
- `pinch` (scale about a center), `twist` (angle) and `pan2` (two-finger translation);
- `wheel`, normalized: line and page deltas become pixels, and a trackpad pinch (a ctrl wheel)
  becomes `pinch`.

A consumer claims a gesture on its start (`gestures.claim(id)`). Unclaimed gestures pass through:
the DOM input source (`createDomInputSource`) calls `preventDefault` only for claimed pointers and
for wheel events over an enabled control. It sets `touch-action: none` on the element only while a
control is enabled. The pointer that starts a claimed drag is captured (`setPointerCapture`), so the
drag survives leaving the canvas.

`gestures.cancel()` ends the active gesture with `drag-end { cancelled: true }`. The built-in
`cancel` action is bound to Escape, and a host can rebind or remove it.

### Controls

```ts
MapControls {                             // on an orthographic Camera3d
  target: vec3, zoom: f32 = 1, minZoom: f32 = 0.1, maxZoom: f32 = 8
  bounds: { min: vec2, max: vec2 } | null
  panButton: 'left' | 'middle' | 'right' = 'middle', dragToPan: bool = true   // left drag on empty floor
  smoothing: f32 = 0                      // seconds; 0 = immediate (and forced under reduced motion)
}
OrbitControls {                           // on a perspective Camera3d
  target: vec3, distance: f32, yaw: f32, pitch: f32
  minPitch: f32 = 15°, maxPitch: f32 = 89°, minDistance: f32, maxDistance: f32
  orbitButton: 'right' = 'right', panButton: 'middle' = 'middle'
  smoothing: f32 = 0
}
```

Their systems run only on an `active` camera and write only that camera's `Transform` and
`Camera3d` fields.

- **Zoom to cursor:** the world point under the cursor stays under it (orthographic: scale about
  it; perspective: dolly along its ray).
- **Pan:** the grabbed floor point stays under the pointer (`screenToPlane`, 0057).
- **Touch:** `pinch` zooms, `pan2` pans, and `twist` yaws the orbit.
- **Frames:** controls hold a frame demand (0052) only while moving or smoothing.

Controls are components, so a host can save and restore a view.

`syncViews(world, from, to)` puts the `to` camera over the same `target`, with a scale that shows
about the same floor area: the orthographic height against the perspective distance × tan(fov/2).
The host calls it when switching views. It never runs by itself, so switching one reader's view
can't change another's.

### Object drag

```ts
const drag = world.resource(PlaneDrag)
drag.begin({ entity, pointer, plane: 'grab' | { y: number }, snap?: (p: Vec3) => void })
world.events(DragMoved)   // { entity, position, delta }
world.events(DragEnded)   // { entity, position, start, cancelled }
```

The host calls `begin` from its own `drag-start` handler after `pick()` says what's under the
pointer and the host decides it's movable. `PlaneDrag` claims the gesture, then projects the
pointer onto the plane each move, keeping the offset from the grab point. It runs `snap` (for
example to a grid cell center, with `@aethervtt/shard-grid/math`) and writes the entity's `Transform`: one
instance slot per move. On cancel it restores the start transform. The host commits on
`DragEnded`, as Aether patches on drop today.

### Agent surface

- `controls.describe`: each control's camera, its state, and whether it's moving.
- `input.simulate` (0011) accepts gesture sequences (`drag`, `pinch`, `wheel`), so gameplay tests
  can drive controls and drags headless.

## Decisions

- **Claiming instead of global capture.** A tabletop sits among DOM panels. Only the scene knows if
  a pointer hit something it uses, so only claimed events stop.
- **Controls write only their camera; views sync on request.** That's what "switching views doesn't
  change another reader's camera" requires, and it keeps each view's state intact while inactive.
- **Drag without commit.** The host is authoritative for moves. The engine gives it previews and
  final positions.

## Acceptance criteria

All driven headless through simulated input:

- [ ] Wheel zoom and pinch keep the world point under the cursor within 0.5 CSS px, in both
      controls.
- [ ] Panning keeps the grabbed floor point under the pointer within 0.5 CSS px over a 400 px drag.
- [ ] A 3 px pointer move is a tap; a 5 px move is a drag.
- [ ] A drag on an inactive camera's controls moves nothing, and switching `active` leaves both
      cameras' controls unchanged.
- [ ] `syncViews` from Map to Tabletop keeps `target`, and the visible floor width within 10%.
- [ ] `PlaneDrag` with a grid snap ends on cell centers. Escape mid-drag restores the start
      transform and emits `DragEnded { cancelled: true }`.
- [ ] A pointer down on empty space with no claiming consumer is not `preventDefault`ed. A claimed
      drag is, and it keeps receiving moves outside the canvas.
- [ ] Pitch stays within `[minPitch, maxPitch]`, and zoom within its limits, under any input
      sequence (property test).

## Open questions

- Should `MapControls` support rotation (Map views rotated to a scene's north)? Proposed: yes, as
  `rotation: f32`, left out of the first build.
