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
