# IK, sockets, and retargeting

IK runs on the animated pose each frame (after the clips, before rendering). Joint fields are
**paths** under the IK entity or its nearest ancestor that has them, like animation channels, so
put IK on the model root (or on an entity under it, one per leg). Targets and poles are entities.

```json
{ "name": "hero", "components": {
    "scene/SceneInstance": { "scene": { "path": "assets/hero.glb#Scene" },
      "overrides": { "Armature/Hips/Spine/Chest/Shoulder_R/UpperArm_R/LowerArm_R/Hand_R": {
        "animation/BoneSocket": { "name": "hand_r", "offset": [0, -0.07, 0] } } } },
    "animation/AnimationPlayer": { "layers": [{ "clip": { "path": "assets/hero.glb#Animation/Walk" } }] },
    "animation/FootPlacement": { "hips": "Armature/Hips", "maxStep": 0.4, "feet": [
      { "ik": "hero/leg-l", "footJoint": "Armature/Hips/UpLeg_L/Leg_L/Foot_L", "offset": 0.08 },
      { "ik": "hero/leg-r", "footJoint": "Armature/Hips/UpLeg_R/Leg_R/Foot_R", "offset": 0.08 } ] },
    "animation/LookAtIk": { "joint": "Armature/Hips/Spine/Chest/Neck/Head", "target": "player",
      "maxAngle": 70, "chain": [{ "joint": "Armature/Hips/Spine/Chest", "share": 0.2 }] } },
  "children": [
    { "name": "leg-l", "components": { "animation/TwoBoneIk": {
        "root": "Armature/Hips/UpLeg_L", "mid": "Armature/Hips/UpLeg_L/Leg_L",
        "tip": "Armature/Hips/UpLeg_L/Leg_L/Foot_L", "target": "hero/foot-l", "pole": "hero/knee-l",
        "tipRotation": 1 } } },
    { "name": "foot-l", "components": { "core/Transform": {} } },
    { "name": "knee-l", "components": { "core/Transform": { "translation": [-0.1, 0.5, -1] } } } ] }
```

(and the same for the right leg). Add a sword with
`"animation/Attach": { "owner": "hero", "socket": "hand_r" }`: it rides the hand, and comes back
to it when the model reloads.

- `TwoBoneIk`: legs and arms; bends toward `pole`. `ChainIk`: FABRIK for tails and tentacles.
  `LookAtIk`: `axis` is the joint's own forward (-Z by default), clamped to `maxAngle` degrees.
- `FootPlacement` needs `"physics"` in plugins. It casts down from each foot along the entity's
  up, lowers the hips (never raises), and moves each leg's target onto the ground, turned to its
  normal. Put the entity level with the soles; `offset` is the ankle height.
- `weight` (0 to 1) blends every solver with the animation: fade it for cutscenes or ragdolls.
- Retarget clips made for another skeleton: `"animation/Retarget": { "source": { "path":
  "assets/mixamo.glb#Skin/Skin0" }, "mode": "rotation-and-root" }` on the player. Names match after
  normalizing (`mixamorig:LeftUpLeg` = `UpLeg_L`); others go in a `*.jointmap.json`
  (`{ "joints": { "Spine1": "Chest" } }`, the `map` field).
- `animation_describe` on the model: `ik` (distance left to each target, foot hits, hips drop,
  problems like `ik/unknown-joint`) and `retarget` (hip ratio, unmapped joints). Screenshot with
  `"overlays": ["ik", "skeleton"]` to see targets, poles, and foot rays.
