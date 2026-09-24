# Animate a model or a property

Add `"animation"` to `plugins` in `shard.json`. A `.glb` with animations imports each as an
`AnimationClip` sub-asset (`assets/ships/walker.glb#Animation/Walk`; MCP `get_asset` lists its
channels and duration). Skinned meshes and morph targets import tagged (`render/SkinnedMesh`,
`render/MorphWeights`) and deform on their own; the player moves the joints.

```json
{ "name": "walker", "components": {
  "core/Transform": {},
  "scene/SceneInstance": { "scene": { "path": "assets/walker.glb#Scene" } },
  "animation/AnimationPlayer": { "layers": [
    { "clip": { "path": "assets/walker.glb#Animation/Walk" } },
    { "clip": { "path": "assets/walker.glb#Animation/Wave" }, "weight": 1,
      "mask": { "path": "assets/masks/upper-body.mask.json" } } ] } } }
```

- Put the player on the model root (the SceneInstance entity). Channels bind joints by path under
  it; `animation_describe` lists channels that found no target.
- Layers blend in order: `override` lerps toward its pose by `weight`; `additive` adds its change
  since the clip's first frame. `loop`: `loop`, `once` (holds the end, sends
  `animation/AnimationFinished`), `ping-pong`. Seek with `time`, pause with `playing: false`.
- A mask is `{ "joints": { "Armature/Hips/Spine": 1, "Armature/Hips/Spine/Neck": 0 } }` in a
  `*.mask.json`: a path covers its subtree, the longest match wins, uncovered joints get 0.
- In code: `crossfade(world, entity, clipRef, 0.3, { loop: 'once' })` fades in a layer and fades
  the others out; `animationLayer(clipRef, { weight: 0.5 })` builds a full layer.
- Root motion: `"rootMotion": "character"` on an entity with `physics/CharacterController` turns
  the clip's root travel into `CharacterIntent.move` (walking collides); `"transform"` moves the
  entity directly. The root joint stays in place; `animation/RootMotion` has this frame's delta.
- See joints with `screenshot` `"overlays": ["skeleton"]`; `preview_asset` on a glTF clip shows
  its model at 5 times.

Property clips animate any numeric field by path (`""` is the player's entity):

```json
{ "duration": 2,
  "tracks": [
    { "path": "radar/dish", "component": "core/Transform", "field": "rotation",
      "keys": [[0, [0, 0, 0, 1]], [2, [0, 1, 0, 0]]] },
    { "path": "", "component": "render/PointLight", "field": "intensity",
      "keys": [[0, 800], [0.1, 0], [0.2, 800]], "interpolation": "step" } ],
  "events": [{ "time": 1, "name": "ping" }] }
```

Save it as `assets/anims/radar.anim.json`. Events arrive as `animation/AnimationEvent`
(`name`, `layer`, `time`). Unknown components or fields fail import with a pointer.
