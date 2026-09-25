# Add physics

Add `"physics3d"` (or `"physics2d"` for a 2D game, never both) to `plugins` in `shard.json`.
Bodies and colliders are components, so scenes, prefabs, and `patch_entity` create and change them:

```json
{ "name": "crate", "components": {
  "core/Transform": { "translation": [0, 3, 0] },
  "physics/RigidBody": { "kind": "dynamic" },
  "physics/Collider": { "shape": "cuboid", "halfExtents": [0.5, 0.5, 0.5], "restitution": 0.2 } } }
```

- Kinds: `dynamic` (forces and contacts move it), `fixed`, `kinematic-position` (follows its
  Transform), `kinematic-velocity` (moves by `physics/Velocity`). A `Collider` without a body is fixed.
- Shapes: ball (`radius`), cuboid (`halfExtents`), capsule, cylinder, cone (`radius`, `halfHeight`
  along Y), convex and trimesh (`mesh`: a Mesh asset, or `points`), heightfield, segment, polyline.
  Scale in the Transform scales the shape. Colliders on children without their own body attach to
  the nearest ancestor body (one compound body).
- Move bodies with `physics/Velocity`, `physics/ExternalForce` (every step), or
  `physics/ExternalImpulse` (once). Writing a dynamic body's Transform teleports it.
- Layers: `layers` and `mask` are 16-bit masks; two colliders touch when each one's mask has the
  other's layer. Planets: `physics/GravitySource` on the planet, and `physics/Config` gravity `[0, 0, 0]`.
- Events: set `events: true` on a collider (sensors too) and read `physics/CollisionEvent`
  (`started` / `stopped`, the two collider entities and their bodies).
- Queries in code: `world.resource(Physics).raycast(origin, dir, { mask }, hit)`. From tools:
  `physics_raycast`, `physics_overlap`, `physics_describe`. See shapes with
  `screenshot` `"overlays": ["colliders"]`.

Check a fall with a gameplay test:

```ts
test('the crate lands', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(120)
  expect(game.get('crate', 'core/Transform').translation[1]).toBeCloseTo(0.5, 1)
})
```

## Characters

A walking player or NPC is `physics/CharacterController` with no RigidBody or Collider: it makes
its own kinematic capsule (centered on the entity), climbs steps and slopes, snaps to the ground,
pushes dynamic bodies, and rides kinematic platforms.

```json
{ "name": "player", "components": {
  "core/Transform": { "translation": [0, 1, 0] },
  "physics/CharacterController": { "height": 1.8, "radius": 0.35, "up": "gravity" } } }
```

- Write `physics/CharacterIntent`: `move` in m/s in the character's frame (x right, -z forward;
  2D: x), and `jump: true` to jump once at the next grounded step.
- Read `physics/CharacterState` (`grounded`, `groundEntity`, `velocity`, `up`, `airTime`) and
  `physics/CharacterGroundEvent` (landed or left the ground). `physics_describe` lists characters.
- `up: "gravity"` follows the strongest `physics/GravitySource` (walk around planets) and turns the
  entity to match; `"fixed"` uses `fixedUp` and `gravity`. Turn it by writing its rotation;
  writing its translation teleports it.

```ts
test('the player walks and lands', async ({ game }) => {
  await game.load('scenes/main.scene.json')
  await game.step(30)
  await game.patch('player', { 'physics/CharacterIntent': { move: [0, 0, -3] } })
  await game.step(60)
  expect(game.get('player', 'physics/CharacterState').grounded).toBe(true)
  expect(game.get('player', 'core/Transform').translation[2]).toBeLessThan(-2.5)
})
```
