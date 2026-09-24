# 0028 — Physics 3D and 2D (Rapier)

- **Status:** implemented
- **Packages:** `@shard/physics` (new), `@shard/runtime`, `@shard/render`, `@shard/protocol`,
  `@shard/project`, `apps/cli`
- **Depends on:** 0003, 0004, 0014, 0015, 0027

## Context

The proof project flies a ship with thrusters, lands it on a planet, drops cargo, and scans rocks
by pointing at them. A 2D game needs platforms, pickups, and bullets that hit things. Both come
down to rigid bodies, colliders, contact events, and scene queries (raycasts, overlaps).

VISION picks Rapier through WASM, one plugin per dimension. Rapier is deterministic on one build
and platform, and it runs the same in Node, a browser tab, and Studio, so physics can be tested
headless like everything else.

## Goals

- `physics3d` and `physics2d` plugins over `@dimforge/rapier3d-compat` and `rapier2d-compat`,
  loaded in the plugin's `ready()` step.
- Rigid bodies (dynamic, fixed, kinematic by position or by velocity) and colliders written as
  components, so scenes, prefabs, and `entity.patch` create and change them.
- Shapes: ball, cuboid, capsule, cylinder, cone, convex hull and triangle mesh from a `Mesh` asset,
  and heightfield. 2D adds segment and polyline.
- Compound bodies: colliders on descendants of a body attach to it.
- Contact and sensor events as ECS events. Forces, impulses, velocities, damping, mass, locked
  axes, CCD, collision layers.
- Point gravity (`GravitySource`), so planets pull bodies toward their center.
- Scene queries: raycast, shape cast, point and shape overlap, with filters.
- A fixed step inside `FixedUpdate` with render interpolation, and exact replay: the same inputs
  give the same world hash.
- A collider overlay, and physics state an agent can read and query through the protocol.

## Non-goals

- The character controller (0029).
- Ragdolls, vehicles, and a joint editor (VISION "Later"). Joints are here as components only.
- Double-precision and floating-origin physics (M7, large worlds).
- Running Rapier on a worker. The step is synchronous in `FixedUpdate`.
- 2D and 3D physics in the same app.

## Design

### Components

```ts
RigidBody {
  kind: 'dynamic' | 'fixed' | 'kinematic-position' | 'kinematic-velocity'
  gravityScale: f32 = 1, linearDamping: f32, angularDamping: f32
  ccd: bool, canSleep: bool = true, dominance: i8
  lockTranslation: vec3 (1 locks the axis), lockRotation: vec3
}
Velocity { linear: vec3 (m/s), angular: vec3 (rad/s) }          // read and write
Collider {
  shape: 'ball' | 'cuboid' | 'capsule' | 'cylinder' | 'cone' | 'convex' | 'trimesh'
       | 'heightfield' | 'segment' | 'polyline'
  radius: f32, halfExtents: vec3, halfHeight: f32
  mesh: handle('Mesh')                                           // convex, trimesh, polyline
  friction: f32 = 0.5, restitution: f32, density: f32 = 1
  points: list(vec3), heightfield: struct { rows, cols, heights }
  sensor: bool, layers: u16 = 1, mask: u16 = 0xffff, events: bool, forceThreshold: f32
}
ExternalForce { force: vec3 (N), torque: vec3 }                 // applied every step
ExternalImpulse { impulse: vec3, torque: vec3 }                 // applied once, then zeroed
Mass { mass: f32 (kg) }                                          // optional; else from density
GravitySource { strength: f32 (m/s²) = 9.81, radius: f32, range: f32, falloff: 'inverse-square' | 'constant' }
Joint { kind: 'fixed' | 'revolute' | 'prismatic' | 'spherical' | 'rope', other: entity,
        anchor: vec3, otherAnchor: vec3, axis: vec3, limits: vec2, motorVelocity: f32, motorFactor: f32 }
```

- A `Collider` without a `RigidBody` on its entity attaches to the nearest ancestor that has one.
  With no body anywhere up the tree it's a fixed collider.
- The shape uses the entity's world transform, so scale bakes into the shape. Rapier has no
  scaled shapes, so a scale change rebuilds the collider.
- In 2D, the XY plane is the world, rotation is around Z, and `translation.z` stays as authored
  (it orders layers, 0024). Shapes 2D can't do fail with `physics/unsupported-shape`.
- `Mesh` colliders wait until their mesh loads. `whenSceneReady` waits for them.

### Stepping

```
FixedUpdate:
  physics/sync-in    create or remove bodies, colliders, and joints from component changes;
                     push changed Transforms (kinematic, or teleports), velocities, and forces
  physics/gravity    add GravitySource pulls as forces
  physics/step       rapier.step() with the FixedTime delta
  physics/sync-out   write poses of awake dynamic bodies to Transform and Velocity; drain events
PostUpdate (before transform propagation):
  physics/interpolate  optional: blend Transform between the last two steps by FixedTime.alpha
```

- Changes come through change detection (0001), so a frame where nothing moved costs a query walk
  and no Rapier calls. Writing a dynamic body's `Transform` teleports it.
- Bodies are top-level in Rapier. When a body's entity has a parent, sync-out converts the world
  pose back to a local Transform against the parent's `GlobalTransform`.
- Rapier handles map to entities through `Map`s keyed by handle (handles aren't dense indices), so
  reading events and query hits is a lookup.
- Determinism: bodies are created in table order (deterministic, 0003), and the step is fixed.
  `worldHash` covers Transform and Velocity, so the replay test is the existing hash.

### Events

```ts
CollisionEvent { kind: 'started' | 'stopped', a: Entity, b: Entity, sensor: bool }
ContactForceEvent { a: Entity, b: Entity, force: f32 }          // above Collider.forceThreshold
```

Only colliders with `events: true` report, which keeps the event queue small in dense scenes.

### Queries

```ts
const physics = world.resource(Physics)
physics.raycast(origin, direction, { maxDistance, mask, exclude, solid }, out)  // → boolean
// out: { entity, distance, point, normal } (reused, no allocation)
physics.raycastAll(origin, direction, options): RayHit[]        // cold path
physics.shapeCast(shape, position, rotation, velocity, options, out)
physics.overlapPoint(point, options, visit)                     // visit(entity) → false stops
physics.overlapShape(shape, position, rotation, options, visit)
```

The same API serves 2D with `vec2` arguments. Queries see the state after the last step.

### Agent surface

- The components are in the catalog with units, and the scene and prefab schemas include them.
- **Protocol:** `physics.raycast` (the query above, with scene paths in hits), `physics.overlap`,
  and `physics.describe` (bodies by kind and sleep state, colliders by shape, contacts, step time).
  The plugin contributes these methods, so the protocol package doesn't import physics.
- **Overlay:** `debug.overlays ["colliders"]` draws every collider's outline as gizmos, colored by
  body kind (sleeping bodies dimmed), plus contact points and normals.
- **Errors:** `physics/unsupported-shape`, `physics/invalid-shape` (no volume or points, or a mesh
  that failed to load), `physics/both-dimensions`, `physics/not-ready`.
- A generated skill, `add-physics.md`: bodies, colliders, layers, events, and checking a fall with a
  gameplay test.

## Decisions

- **One component set for both dimensions.** A 2D game and a 3D game write the same
  `RigidBody` and `Collider`. The enabled plugin decides how they're read, and agents learn one
  vocabulary.
- **Shape fields are flat.** `radius`, `halfExtents`, and `halfHeight` sit on `Collider` rather than
  a tagged union, so they're TypedArray columns and patches stay one field deep. Fields a shape
  doesn't use are ignored.
- **Scale bakes into shapes.** Rapier has no scaled shapes. Rebuilding on scale changes is rare and
  keeps the result exact.
- **Contributed protocol methods.** The protocol gets a registry that plugins add methods to, so
  new systems (audio, UI, navigation) expose themselves without the protocol importing them.
- **Events are opt-in per collider.** Most contacts don't matter to gameplay, and reporting all of
  them costs an event per contact pair per step.

## Acceptance criteria

- [x] A body dropped from 10 m under default gravity lands at the time free fall predicts, within
      one step (headless test, 3D and 2D).
- [x] 1,000 boxes dropped in a pile settle and sleep. 5,000 dynamic bodies step in under 8 ms per
      60 Hz step on the dev machine (bench).
- [x] Two headless runs of the same scene for 600 frames give the same world hash.
- [x] A trimesh collider built from a mesh asset stops a falling ball on its surface. A convex hull
      rolls. A heightfield holds up a body.
- [x] A sensor reports `started` and `stopped` for a body that passes through it, once each.
- [x] Colliders on child entities form one compound body that moves as a unit.
- [x] A body with `GravitySource` on a planet entity falls toward the planet's center from any side.
- [x] `physics.raycast` returns the entity, scene path, point, and normal of the nearest collider,
      and respects `mask`. `Physics.raycast` writes into a reused hit and allocates nothing of its
      own (Rapier's bindings allocate one result object per query; see notes).
- [x] Patching `Collider.radius` through `entity.patch` changes the shape on the next step.
- [x] The `colliders` overlay draws a golden image of a mixed-shape scene.
- [x] Render interpolation makes a body at 60 Hz physics move smoothly at 144 Hz frames
      (positions differ every frame in a stepped test).

## Implementation notes

- **Package:** `packages/physics`: `components.ts`, `pose.ts` (world poses composed from
  Transforms, world-to-local against a parent's GlobalTransform), `world.ts` (`PhysicsWorld`: the
  Rapier world, entity and handle maps, body, collider, and joint lifecycle, stepping, queries),
  `plugin.ts` (systems, observers, the `colliders` overlay), and `methods.ts`. Rapier is
  `@dimforge/rapier3d-compat` and `rapier2d-compat` 0.20, loaded once per process in `ready()`
  (about 40 ms).
- **Component changes from the design:**
  - `layers` and `mask` are `u16`: Rapier's interaction groups are 16 bits of membership and
    16 of filter.
  - `Collider` gained `points` (convex, polyline, and segment without a mesh; 2D reads x and y),
    `heightfield { rows, cols, heights }` (row by row, scaled by `halfExtents`), and
    `forceThreshold` (turns on `ContactForceEvent`).
  - `GravitySource` gained `range` (no pull beyond it). `Joint` gained `motorFactor`, and `limits`
    are off when both ends are equal.
  - `Mass` is only `mass`: it rescales the collider densities so the body weighs exactly that.
    A center-of-mass override is deferred.
  - Segment and polyline work in 3D too. 2D rejects cylinder, cone, and spherical joints with
    `physics/unsupported-shape`, logged once per entity.
- **Sync:**
  - Bodies, colliders, and joints rebuild when their component's change tick is newer than
    sync-in's last run, so there's no add observer. Removal goes through `onRemove` observers, and
    parent changes through `ChildOf` observers that queue the entity for the next sync. A body
    whose kind changes is rebuilt rather than updated in place.
  - A game's write is told apart from physics' own by tick: Transform or Velocity changed after
    sync-out's (and interpolation's) last write means a teleport or a new velocity.
    `kinematic-position` bodies also follow `GlobalTransform` changes (a moving parent), one frame
    behind. Systems that move bodies belong in `Update`, or in `FixedUpdate` before
    `PhysicsSystems`: a write after sync-in is overwritten by sync-out.
  - Sync-out walks only Rapier's active bodies, so sleeping bodies cost nothing. It uses Rapier
    0.20's getters that write into a passed object, caches the columns of the last table it
    wrote to, and sets change ticks directly. Forces reuse one `RawVector` through the raw body
    set, so gravity sources and thrust don't allocate per body.
  - Interpolation stores the last two poses per body in dense `Float64Array` slots and writes the
    blend in `PostUpdate`. The next sync-in puts the simulated pose back first, so fixed-step code
    sees true positions. Parented bodies aren't interpolated.
- **Queries:** `raycast`, `raycastAll`, `shapeCast` (ball, cuboid, capsule), `overlapPoint`, and
  `overlapShape`. Results write into a caller's `RayHit`. The one object Rapier's bindings create
  per query can't be avoided without reaching past the public bindings.
- **Extension points** added for this spec and the rest of M6:
  - `app.addMethod(...)` and `app.methods` in `@shard/runtime`. The protocol server looks up app
    methods per request, after its built-in ones, and lists them in `methods`.
  - `defineOverlay({ name, draw })` in `@shard/render`. `debug.overlays` and `render.capture`
    accept registered names, and `overlayNames()` lists them all.
- **Agent surface as built:** MCP tools `physics_raycast`, `physics_overlap`, and
  `physics_describe`. The CLI takes their schemas from `physicsMethods`. Manifest plugins are
  `physics3d` and `physics2d`, and the `add-physics.md` skill is generated. The overlay draws
  shapes from Rapier's own dimensions (after scale), and trimesh, hull, and polyline edges from
  its vertices. Heightfields aren't drawn yet. Contact normals are drawn only around awake bodies,
  at most 1,000 pairs a frame: each pair costs several calls into Rapier, and the whole pile of the
  playground demo (7,600 pairs) took the overlay from 3 ms to 13 ms of CPU.
- **Tests:** the mesh collider tests use `plane` and `sphere` meshes and a scene's
  `procedural:plane` ref. glTF meshes are the same `Mesh` asset, loaded the same way. Free fall is
  checked against the continuous-time landing (`sqrt(2h/g)`, 85.7 steps). Rapier resolves the
  contact one step after the ball first reaches the ground.
- **Playground:** `#physics` drops 1,500 boxes, balls, and capsules (`?count=`) onto the ground
  next to a chain of spherical joints: Space explodes the pile, R keeps it raining, C shows the
  colliders overlay. `#planet` drops them onto a planet with a `GravitySource` and no global
  gravity. Both run at 60 fps in Chrome (about 5 ms per step with 7,000–10,000 contact pairs).
- **Measured** on the dev machine (Apple M4, Node): 5,000 awake balls in resting contact cost
  4.0 ms of Rapier step, 1.5 ms of sync-out, and 0.1 ms of sync-in per 60 Hz step. 1,000 tumbling
  boxes dropped from up to 25 m all sleep within 3 simulated seconds.

## Open questions

- None blocking. Deferred: joints beyond the five kinds here, a center-of-mass override, drawing
  heightfields in the overlay, and Rapier's deterministic build (only needed for cross-machine
  replay, a non-goal).
