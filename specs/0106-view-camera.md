# 0106 — The view camera

- **Status:** draft (built)
- **Packages:** `@aethervtt/shard-render`, `@aethervtt/shard-terrain`, `@aethervtt/shard-water`,
  `@aethervtt/shard-particles`, `@aethervtt/shard-wind`
- **Depends on:** 0007, 0057, 0043, 0071, 0097

## Context

Some work happens once per frame for one camera, not per view: terrain picks its chunks (0043,
0071), water centres its info clipmap (0097), particles simulate and sort (0026), spot and point
lights are ranked for shadow maps (0018), wind uploads the zones nearest the camera (0096). Each
picked that camera by its own rule. Terrain took the active camera with the lowest `order`; water
and wind took the first camera in the query, by table, ignoring `active` and `order`; particles,
shadow ranking and the debug overlays took the view with the lowest render order.

None of them skipped cameras that don't show the world. A game rendering thumbnails with an
offscreen camera (its own render layer, `Camera3d.target` set) moved the terrain's chunks and the
water's clipmap to the thumbnail for as long as it existed: the main view's terrain flickered and
its water disappeared.

## Goals

- One rule, one exported helper, for the camera that drives view-dependent work.
- Offscreen cameras (thumbnails, previews, warm-up renders) don't take it from the window camera.
- A camera whose `layers` leave out a system's renderables doesn't drive that system.
- An offscreen camera that is a real view (a minimap, split screen) can opt in.

## Non-goals

- Selecting terrain or water per view. Several views of one world still share one selection, the
  driving camera's.

## Design

`viewCamera(cameras, layers = 1)` returns the entity of the driving camera, or undefined:

1. It is active, and its `Camera3d.layers` share a bit with `layers` (the layers the system's
   renderables draw on; 1, like an absent RenderLayers).
2. A camera showing on the window (`target` null) or with `DrivesView` wins over one rendering
   offscreen. An offscreen camera only drives when nothing else can: worlds that render only to
   targets (tests, previews) keep working.
3. Then the lowest `order`, then the lowest entity.

`cameras` is a query with Camera3d, made once in a system's setup; the helper doesn't allocate.
`drivingView(world, cameras, layers)` returns that camera's RenderView, for code that reads
extracted camera data: undefined while the camera has no view this frame.

Users:

| Work | Layers |
|---|---|
| Terrain selection, planets and heightfields (`terrain/select`, `terrain/heightfield-select`) | 1 |
| Water's info clipmap (`water/prepare`) | 1 |
| Wind's uploaded zones (`wind/field`) | 1 |
| Particle simulation, sorting, culling (`particles/prepare`) | all |
| Shadowed spot and point light ranking (`render/prepare-lights`) | all |
| The debug overlays' primary camera, and the wind overlay | all |

Particles and lights have no render layer of their own, so any camera may drive them.

### API sketch

```ts
export const DrivesView: TagDef // render/DrivesView, requires Camera3d
export function viewCamera(cameras: Query, layers?: number): Entity | undefined
export function drivingView(world: World, cameras: Query, layers?: number): RenderView | undefined

// A minimap that's a real view: terrain and water follow it when its order is lowest.
world.spawn([Camera3d, { target: minimap, order: -1 }], DrivesView, Exposure, Transform)
```

### Agent surface

`render/DrivesView` is a component in the schemas, with a description.

## Decisions

- **Offscreen is a preference, not a filter.** A filter would hide terrain and water in every world
  that renders only to offscreen targets.
- **A tag, not a Camera3d field.** Only offscreen cameras need it, and a tag leaves every scene's
  Camera3d as it was.
- **Returns an entity.** Systems that run before extraction (terrain, water, wind) read the ECS;
  `drivingView` maps it to the view for the ones that read camera data.

## Acceptance criteria

- [x] A world with a terrain, a lake and a window camera at order 0, plus an offscreen camera at
  order -10, layers 2, 4 km away: terrain selection and the water's info clipmap stay on the window
  camera, also when the offscreen camera shows layer 1 (`water/src/gpu.test.ts`).
- [x] With DrivesView, that offscreen camera drives both.
- [x] The rule holds whatever order the cameras' tables come in, skips inactive cameras and cameras
  without the layers, and falls back to an offscreen camera when no other can drive
  (`render/src/view-camera.test.ts`).

## Open questions

- Split screen with two window cameras still selects terrain for one of them. Per-view selection
  is its own spec when a project needs it.
