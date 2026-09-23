# 0032 — Skeletal animation

- **Status:** accepted
- **Packages:** `@shard/animation` (new), `@shard/render`, `@shard/gltf`, `@shard/mesh`
- **Depends on:** 0007, 0015, 0020, 0022

## Context

0015 imports skins and animation clips and spawns every joint as an entity, but nothing plays
them. Creatures, the player's body, a ship's landing gear, a door that opens: they all need clips
sampled onto joints, several clips blended, parts of a body masked (wave while walking), meshes
deformed on the GPU, and root motion to move the character with its feet.

The same machinery can animate any component field, not just joints. A clip that dims a light,
spins a radar dish, or fades a material is data an agent can write by hand.

## Goals

- `AnimationPlayer` plays clips on an entity's hierarchy: time, speed, loop mode, and weighted
  layers with blending, crossfades, additive layers, and joint masks.
- GPU skinning (linear blend, 4 influences) in both render paths, with shadows, and culling bounds
  that follow the pose.
- Morph targets: imported from glTF, blended on the GPU, animated by clip weight channels.
- Root motion: a clip's root translation and rotation extracted as a per-frame delta that moves
  the entity (or feeds the character controller) instead of the root joint.
- Property clips (`*.anim.json`) that animate any numeric field of any component by path.
- Clip events at authored times, sent as ECS events.
- 200 animated characters of 60 joints at 60 fps.

## Non-goals

- State machines and blend spaces (0033). IK and retargeting (0034).
- Dual-quaternion skinning, more than 4 influences, and GPU-side animation sampling.
- Animation compression beyond what glTF gives. Motion matching and ragdolls (VISION "Later").

## Design

### Playing

```ts
AnimationPlayer {
  layers: list(struct {
    clip: handle('AnimationClip'), time: f32, speed: f32 = 1, weight: f32 = 1,
    loop: 'loop' | 'once' | 'ping-pong', blend: 'override' | 'additive',
    mask: handle('AnimationMask'), playing: bool = true
  })
  rootMotion: 'none' | 'transform' | 'character'
}
```

- Layers blend in order: an `override` layer lerps (slerps rotations) toward its pose by
  `weight`, and an `additive` layer adds its difference from the clip's first frame.
- A mask is a data asset (`*.mask.json`) of joint paths with weights, where a path covers its
  subtree (`{ "Armature/Hips/Spine": 1, "Armature/Hips/Spine/Neck": 0 }`).
- `crossfade(world, entity, clip, seconds)` adds a layer and fades the others out. It's what the
  state machine uses.
- A `once` layer at its end holds the last pose and sends `AnimationFinished { entity, layer }`.

### Binding and sampling

- A clip's channels target node paths relative to the model root. On first play, the player binds
  each channel to the joint entity at that path and caches (table, row) per channel, rebinding
  when the hierarchy changes. Missing targets are skipped and listed in `animation.describe`.
- Sampling runs in `PostUpdate` before transform propagation: keyframe search starts from the last
  frame's key (a cursor per channel), and interpolation is linear, step, or cubic spline. Results
  write straight into the joints' `Transform` columns and mark them changed.
- Scratch pose buffers are TypedArrays sized at bind time, so a frame of sampling doesn't allocate.

### Skinning

- The glTF importer tags skinned nodes with `SkinnedMesh { skin: handle('Skin'), joints: list(entity) }`,
  with joints resolved from the skin's paths when the instance spawns.
- After propagation, a system writes joint matrices (`jointWorld × inverseBind`, relative to the
  mesh) for every visible skinned mesh into one storage buffer, and the mesh's instance record
  points at its first joint. The vertex stage of the standard material (and extended materials,
  0020) skins position, normal, and tangent when the mesh has joints and weights.
- Culling bounds come from the joints' positions, padded by the largest distance any vertex sits
  from its main joint, computed at load.

### Morph targets

The importer reads primitive `targets` (position, normal, tangent deltas) into the mesh artifact,
and `MorphWeights { weights: list(f32) }` holds the current weights. The vertex stage adds up to 8
active targets from a storage buffer. glTF `weights` channels animate `MorphWeights`.

### Root motion

With `rootMotion` set, the root joint's translation delta (on the ground plane) and yaw delta are
removed from the pose and emitted as `RootMotion { translation: vec3, rotation: quat }` each
frame. `'transform'` applies it to the entity's `Transform`. `'character'` adds it to
`CharacterIntent.move` (0029), so animated walking stays on the ground and collides.

### Property clips

```json
{
  "duration": 2,
  "tracks": [
    { "path": "radar/dish", "component": "core/Transform", "field": "rotation",
      "keys": [[0, [0, 0, 0, 1]], [2, [0, 1, 0, 0]]], "interpolation": "linear" },
    { "path": "", "component": "render/PointLight", "field": "intensity",
      "keys": [[0, 800], [0.1, 0], [0.2, 800]] }
  ],
  "events": [{ "time": 1, "name": "ping" }]
}
```

`*.anim.json` imports as an `AnimationClip`. Tracks target any numeric scalar, vector, quaternion,
or color field, validated against the component schema with pointers into the file. glTF clips
and property clips play through the same player.

### Agent surface

- `animation.describe { entity }`: layers with clip, time, weight, and mask, unbound channels, and
  root motion. `asset.get` on a clip lists channels, duration, and events.
- `asset.preview` of a clip renders its model at 5 evenly spaced times in a row.
- The `skeleton` debug overlay draws joints and bones as gizmos.
- **Errors:** `animation/unknown-target` (property clip track), `animation/invalid-track` (field
  not animatable), `animation/too-many-joints` (over 256 per skin).

## Decisions

- **Sample into joint entities.** Joints are already entities (0015), so attachments, IK, and
  debugging use paths and parenting. Writing columns directly keeps it cheap.
- **One player for skeletal and property clips.** A door and a character use the same component,
  the same events, and the same state machine.
- **Joint matrices in one storage buffer.** Skinned meshes stay in the instanced path (0022) and
  cost one extra buffer read per vertex.
- **Root motion feeds the controller.** Applying it to the transform would walk characters
  through walls.

## Acceptance criteria

- [ ] `CesiumMan` walks: sampled joint rotations match the glTF reference values at 10 times, and
      the skinned mesh renders as a golden image mid-stride, with its shadow.
- [ ] A 50/50 blend of two clips gives the halfway pose (slerp) on a test skeleton. An additive
      layer adds its delta, and a masked layer changes only its subtree.
- [ ] `crossfade` over 0.3 s reaches the target clip's pose at 0.3 s and sends `AnimationFinished`
      for a `once` clip.
- [ ] Morph weights animated by a glTF clip deform the mesh (golden image of `AnimatedMorphCube`).
- [ ] With root motion on `'character'`, a walk clip moves a character controller the clip's
      distance, and the root joint stays in place.
- [ ] A property clip rotates an entity and blinks a light as authored. A track naming an unknown
      field fails with a pointer.
- [ ] 200 characters of 60 joints: sampling under 2 ms per frame, and the frame holds 60 fps at
      1080p (bench and `#animation` demo). Steady-state sampling allocates nothing.

## Open questions

- None blocking.
