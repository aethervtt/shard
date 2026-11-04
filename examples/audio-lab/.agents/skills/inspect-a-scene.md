# Find what's wrong in a scene

When a screenshot looks wrong, connect the pixels to entities:

1. `screenshot` with `"overlays": ["bounds", "labels"]`: every mesh gets its outline and its scene
   path. Add `"filter": "ship/"` to label one subtree. Other overlays: lights, cameras, cascades,
   normals, axes.
2. `pick` a pixel that looks wrong (same coordinates as the screenshot): its path, position, and
   normal. Or `raycast` from a point, e.g. straight down to find the ground.
3. `get_entity` on that path, `patch_entity` the fix, and screenshot again with the same overlays.

In your own systems, draw with gizmos (they last one frame, or `duration` seconds):

```ts
const g = world.resource(Gizmos)
g.line(from, to, [1, 0.2, 0.2, 1])
g.arrow(position, target, [1, 1, 0, 1], { width: 2 })
g.sphere(center, radius, [0, 1, 1, 1], { depthTest: false })
g.label(position, 'target', [1, 1, 1, 1])
```

`list_gizmos` shows what was drawn as data. `pick(world, camera, x, y)` and
`raycast(world, origin, direction)` from `@aethervtt/shard-render` do the same in code.
