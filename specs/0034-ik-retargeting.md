# 0034 — IK, bone attachments, and retargeting

- **Status:** accepted
- **Packages:** `@shard/animation`
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
TwoBoneIk { root: entity, mid: entity, tip: entity, target: entity, pole: entity, weight: f32 = 1 }
LookAtIk  { joint: entity, target: entity, axis: vec3 = [0, 0, -1], maxAngle: f32 = 70 (deg),
            weight: f32 = 1, chain: list(struct { joint: entity, share: f32 }) }
ChainIk   { root: entity, tip: entity, target: entity, iterations: u8 = 10, tolerance: f32 = 0.001,
            weight: f32 = 1 }
FootPlacement { feet: list(struct { ik: entity, footJoint: entity, offset: f32 }),
                hips: entity, maxStep: f32 = 0.4, mask: u32, weight: f32 = 1 }
```

- Joint fields take entity paths relative to the scene (`hero/Armature/Hips/Leg_L`). In prefabs
  they're paths inside the prefab.
- IK runs in `PostUpdate` after sampling, in a set after a first propagation pass over the affected
  subtrees, and before the final propagation. It solves in world space and writes local rotations
  back, blended by `weight` with the animated pose.
- Two-bone uses the law of cosines with the pole setting the bend plane. FABRIK iterates with
  joint lengths from the current pose. Look-at spreads the rotation over the listed chain by
  `share` and clamps it to `maxAngle`.
- Foot placement casts down from each foot's animated position along the character's up (0029),
  moves the hips down by the lowest foot's offset (never up), and places each foot's IK target at
  the hit, oriented to the normal.

### Sockets

```ts
BoneSocket { joint: entity, name: string, offset: vec3, rotation: quat }
```

`attachToSocket(world, entity, owner, 'hand_r')` parents `entity` to the socket's joint with the
socket's offset. In scene files, `scene/Attach { socket: 'hand_r', owner: entity }` does the same
on load, and resolves again when the owner's model respawns on reload.

### Retargeting

```ts
Retarget {
  source: handle('Skin')                    // the skeleton the clips were authored for
  map: handle('JointMap')                   // optional: source joint → target joint names
  mode: 'rotation' | 'rotation-and-root'    // root translation scaled by leg length ratio
}
```

- Channels bind by the mapped name instead of the path. Without a map, names match after
  normalization (case, `mixamorig:` and similar prefixes, `_L`/`.L`/`Left` sides).
- Each joint's sampled rotation is carried from the source rest pose to the target rest pose:
  `target = targetRest × sourceRest⁻¹ × sampled`. Root translation is scaled by the ratio of hip
  heights.
- `JointMap` is a data asset (`*.jointmap.json`) of `{ source: target }` names.

### Agent surface

- `animation.describe` lists IK solvers with their target distance error and weight, and
  retargeting with unmapped joints.
- The `skeleton` overlay draws IK targets, poles, and foot rays.
- **Errors:** `ik/not-a-chain` (the joints aren't ancestors of each other), `ik/unknown-joint`,
  `retarget/unmapped-root`.

## Decisions

- **IK writes local rotations after sampling.** Everything downstream (skinning, attachments,
  physics) sees one final pose, and blending with `weight` is a slerp.
- **Retarget by rest pose, not by bone lengths alone.** Rest-pose correction handles different
  bind orientations, which is the common failure when sharing clips across rigs.
- **Sockets are data on the model.** A prefab places a weapon by socket name, so swapping the
  character model doesn't break attachments.

## Acceptance criteria

- [ ] Two-bone IK puts the tip within 1 mm of a reachable target and fully extends toward an
      unreachable one, bending toward the pole.
- [ ] FABRIK reaches a target within tolerance in at most 10 iterations on a 12-joint chain.
- [ ] Look-at turns a head toward a target and stops at `maxAngle`.
- [ ] On a 20° slope, foot placement puts both feet within 2 cm of the ground (raycast check) and
      lowers the hips, with the feet aligned to the normal.
- [ ] A walk clip retargeted from a tall skeleton to a short one with different bind orientations
      keeps feet on the ground plane (golden image) and scales root motion by the hip ratio.
- [ ] An entity attached to a socket follows the hand through a clip, and survives a model reload.
- [ ] 100 characters with two-bone foot IK solve in under 1 ms per frame (bench).

## Open questions

- None blocking.
