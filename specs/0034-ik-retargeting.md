# 0034 — IK, bone attachments, and retargeting

- **Status:** implemented
- **Packages:** `@aethervtt/shard-animation`, `@aethervtt/shard-transform`, `@aethervtt/shard-scene`
- **Depends on:** 0028, 0032

## Context

Clips are authored on flat ground for one skeleton. The proof project's creatures are generated
with different proportions, walk on uneven terrain, and look at the player. That needs three
things on top of 0032: inverse kinematics to put feet on the ground and turn heads, retargeting so
one set of clips drives skeletons of different sizes, and attachments that hold a tool in a hand.

Attachments already work because joints are entities (0015): parenting to a joint is attaching.
This spec adds the offset sockets and IK targets that make attachments useful.

## Goals

- Two-bone IK (legs, arms) with a pole target, look-at IK for heads and turrets with limits, and
  FABRIK chains for tails and tentacles.
- Foot placement: raycast each foot against physics, then adjust the hips and plant the feet with
  two-bone IK, rotating them to the ground normal.
- Retargeting: play clips from a source skeleton on a target skeleton of different proportions,
  by joint name maps and rest-pose correction.
- `BoneSocket`: a named attachment point on a joint with an offset, so prefabs say
  `"attach": "hand_r"` instead of hard-coding joint paths.
- IK weights that blend with the animated pose, so IK fades in and out.

## Non-goals

- Full-body IK and physically based balance (VISION "Later").
- Automatic humanoid rig detection beyond name matching.

## Design

### IK components

```ts
TwoBoneIk { root: string, mid: string, tip: string, target: entity, pole: entity, weight: f32 = 1,
            tipRotation: f32 = 0 }
LookAtIk  { joint: string, target: entity, axis: vec3 = [0, 0, -1], maxAngle: f32 = 70 (deg),
            weight: f32 = 1, chain: list(struct { joint: string, share: f32 }) }
ChainIk   { root: string, tip: string, target: entity, iterations: u8 = 10, tolerance: f32 = 0.001,
            weight: f32 = 1 }
FootPlacement { feet: list(struct { ik: entity, footJoint: string, offset: f32 }),
                hips: string, maxStep: f32 = 0.4, mask: u32, weight: f32 = 1 }
```

- Joint fields are **paths**, resolved under the IK entity or its nearest ancestor that has the path
  (`Armature/Hips/UpLeg_L`), the way animation channels bind. Put IK on the model root, or on an
  entity under it (one per leg). Targets, poles, and `feet[].ik` are ordinary entity fields.
- Joints resolve again when one of them dies (the model respawned) and, when a path doesn't
  resolve yet (models load late), every 30 frames. A problem is logged once, not per retry.
- IK runs in `PostUpdate`, in `TransformSystems` right after propagation (`animation/ik`). It reads
  world poses from `GlobalTransform`, solves in world space, writes local rotations blended by
  `weight` (a slerp from the animated rotation), and re-propagates only the subtrees it changed
  (`propagateSubtree` in `@aethervtt/shard-transform`). Systems ordered after `TransformSystems` see the final
  pose.
- Order: foot placement (hips and leg targets), two-bone, FABRIK, look-at.
- IK remembers each joint's pre-IK value. A joint no clip re-animated since IK wrote it gets that
  value back before the next solve, so IK never stacks on its own output and weight 0 returns the
  animated pose.
- Two-bone uses the law of cosines with the pole setting the bend plane (no pole: the current
  bend). Out of reach, the chain straightens toward the target. `tipRotation` blends the tip's world
  rotation to the target's (feet planted by foot placement use 1).
- FABRIK iterates backward and forward with segment lengths from the current pose, stopping at
  `tolerance`; an unreachable target gets a straight chain. Positions become rotations top-down.
- Look-at turns the joint's `axis` toward the target, clamped to `maxAngle` from the animated
  forward. Chain entries (ancestors, top first) take `share` of the turn each; the joint aims the
  rest of the way.
- Foot placement: up is the entity's world +Y (a character controller keeps it on the gravity up,
  0029). Each foot casts down from `maxStep` above its animated position through the physics world
  (found by resource name, so animation doesn't depend on physics; the character's own body is
  skipped). The ankle goal is `hit + normal × offset`, lifted by the foot's animated clearance above
  the entity's ground plane, so swinging feet still swing. The hips move down by the lowest goal's
  offset (never up, at most `maxStep`), then each leg's IK target is set to its goal, turned by the
  ground normal (fully when planted, less the higher the foot is).

### Sockets

```ts
BoneSocket { name: string, joint: entity, offset: vec3, rotation: quat }
Attach     { owner: entity, socket: string }
```

- `BoneSocket.joint` null means the entity it's on: put sockets on the joint itself (on a model,
  through a SceneInstance override on the joint's path), so they respawn with the model.
- `attachToSocket(world, entity, owner, 'hand_r')` finds the socket on `owner` or under it and
  parents `entity` to its joint at the socket's offset and rotation. `animation/unknown-socket`
  names the sockets there are.
- `animation/Attach` (in scene files) does the same once the socket exists, and again whenever the
  joint it was on is gone or it was moved off it (`animation/attach`, before propagation).
- When an instance respawns (hot reload, override edits), entities the game parented under its
  generated entities move to the instance root instead of being despawned with them; Attach then
  puts them back on the new joint.

### Retargeting

```ts
Retarget {
  source: handle('Skin')                    // the skeleton the clips were authored for
  map: handle('JointMap')                   // optional: source joint → target joint names
  mode: 'rotation' | 'rotation-and-root'    // root translation scaled by the hip height ratio
  align: bool = true                        // carry rotations onto a pose with limbs aligned to the source's
}
```

- On the player's entity. Transform channels bind by joint name: the map entry (by source path or
  name) if there is one, else the exact name, else the normalized name (`jointKey`: last segment,
  no `mixamorig:`/`Armature|` prefix, lowercased, separators dropped, sides written `_L`, `.L`,
  `L_`, `Left…`, `…Left` all become `.l`). Other channels bind by path as before.
- Rest-pose correction handles different bind orientations, including the parents':
  `target = C⁻¹ · sampled · sourceRest⁻¹ · C · targetRest`, where `C = sourceParentRest⁻¹ ·
  targetParentRest` (model-space rest rotations). With parents that agree (`C = 1`) this is
  `sampled · sourceRest⁻¹ · targetRest`. Source rest poses come from the skin's rest pose, with the
  top joint placed by its inverse bind matrix; the target's are its pose when the clip binds. In
  model space the target joint ends up at `Δ · targetPose`, where `Δ` is the source joint's turn
  from its rest.
- **Retarget pose (`align`, on by default).** Rigs whose rest poses differ (an A-pose model playing
  clips of an arms-down one) would keep the difference: the clip turns each limb from where it
  rests. With `align`, rotations are carried onto a retarget pose instead of the target's rest
  pose: each animated target joint with exactly one child joint both rigs share (a limb link:
  upper arm to forearm, thigh to shin, foot to toe) is turned by the shortest arc that points its
  bone (joint to that child, model space at rest) like the source's. Joints with several shared
  children (hips, chest, a hand with fingers) or none turn with their parent, keeping their own
  rest relative to it. `targetPose` and the parent's pose in `C` are this pose's model-space
  rotations, so the formula above is unchanged. With identical rest poses every turn is identity.
  Twist about the bone isn't touched.
- **Models that spawn after the player binds.** A clip on a SceneInstance whose model hasn't spawned
  binds against nothing. Unbound channels (no Retarget) retry; a retargeted clip whose source joints
  matched nothing retries too, and replans when the paths under the player changed. Retries come
  every 30 frames, or every frame while nothing is under the player yet. `retarget/unmapped-root` is
  logged only once the model is there.
- The source root is the shallowest skin joint the clip animates. In `rotation-and-root` its
  translation is carried into the target parent's frame and scaled by the ratio of hip heights
  (target / source, model space), so root motion scales too. Other translations and scales are
  dropped: the target keeps its own bone lengths. In `rotation` only rotations carry over.
- Corrections are computed when a clip binds and applied per channel in the sampler (and to the
  samples root motion takes), without allocating. A changed Retarget rebinds.
- Additive layers aren't corrected: their delta is taken from the uncorrected clip.
- `JointMap` is a data asset (`*.jointmap.json`): `{ "joints": { "source": "target" } }`.

### Agent surface

- `animation.describe` lists IK solvers under the player (and all of them without an entity):
  kind, weight, whether it solved, distance left to the target (angle for look-at, clamped),
  FABRIK iterations, each foot's hit and normal and how far the hips dropped, and any problem. With
  a Retarget: the source skin, root mapping, hip ratio, source joints that matched nothing, and
  `alignedJoints` (target joint → degrees `align` turned it, past half a degree).
- The `ik` overlay draws IK targets, poles, solved chains, and foot rays (green hits, red misses).
  The `skeleton` overlay (render) still draws the joints.
- **Errors:** `ik/not-a-chain` (the joints aren't ancestors of each other), `ik/unknown-joint`
  (no joint at a path, or a foot without TwoBoneIk), `retarget/unmapped-root`,
  `animation/unknown-socket`, `animation/invalid-joint-map`.

## Decisions

- **IK writes local rotations after sampling.** Everything downstream (skinning, attachments,
  physics) sees one final pose, and blending with `weight` is a slerp.
- **Retarget by rest pose, not by bone lengths alone.** Rest-pose correction handles different
  bind orientations, which is the common failure when sharing clips across rigs.
- **Align limbs at bind, by default.** Rigs from one generator (Tripo's Mixamo skeletons) come in
  different rest poses, and fixing each model offline is a step per model. Aligning bone directions
  is what Unreal's retarget pose and Unity's Humanoid T-pose normalization do; with matching rest
  poses it changes nothing, so it's the default. `align: false` keeps the old behavior.
- **Align only single-child links.** A joint with several children has no one bone direction, and
  averaging them (hips: spine and both legs) gives a direction that means little. Those joints turn
  with their parent instead.
- **Sockets are data on the model.** A prefab places a weapon by socket name, so swapping the
  character model doesn't break attachments.
- **Joints are paths, not entity fields.** Scene files and prefabs can't reference a model's
  generated joints (they spawn after load, and overrides resolve only `.`), so entity-typed joint
  fields could only be set from code. Paths resolve at runtime like animation channels, and resolve
  again after the model respawns.
- **Attach is `animation/Attach`, not `scene/Attach`.** The scene package knows nothing about
  sockets; the component lives with them.
- **The overlay is `ik`.** `skeleton` belongs to render, which can't see IK state.

## Acceptance criteria

- [x] Two-bone IK puts the tip within 1 mm of a reachable target and fully extends toward an
      unreachable one, bending toward the pole.
- [x] FABRIK reaches a target within tolerance in at most 10 iterations on a 12-joint chain.
- [x] Look-at turns a head toward a target and stops at `maxAngle`.
- [x] On a 20° slope, foot placement puts both feet within 2 cm of the ground (raycast check) and
      lowers the hips, with the feet aligned to the normal.
- [x] A walk clip retargeted from a tall skeleton to a short one with different bind orientations
      keeps feet on the ground plane (golden image) and scales root motion by the hip ratio.
- [x] An entity attached to a socket follows the hand through a clip, and survives a model reload.
- [x] 100 characters with two-bone foot IK solve in under 1 ms per frame (bench).
- [x] A target rested in an A-pose (arms 36° out) plays an idle authored on an arms-down rig with
      its upper arms and forearms within 2° of the source's; with `align: false` they stay 36° off.
- [x] An entity spawned with SceneInstance, AnimationPlayer, and Retarget in one go animates once
      its model loads, posed exactly as when the player is added after the model spawned.

## Open questions

- Source poses are in the skin's space (the top joint placed by its inverse bind matrix) and the
  target's in the model's. A model whose skin space isn't its model space (CesiumMan's `Z_UP` node)
  retargets wrongly with or without `align`. See `TODO.md`.
