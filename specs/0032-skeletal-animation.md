# 0032 — Skeletal animation

- **Status:** implemented
- **Packages:** `@aethervtt/shard-animation` (new), `@aethervtt/shard-render`, `@aethervtt/shard-gltf`, `@aethervtt/shard-mesh`
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
    mask: handle('AnimationMask'), playing: bool = true,
    fadeTo: f32 = 1, fadeSpeed: f32   // weight per second toward fadeTo; faded to 0 = removed
  })
  rootMotion: 'none' | 'transform' | 'character'
  rootJoint: string   // '' = the highest joint a translation channel animates
}
```

List items written from code get no defaults, so `animationLayer(clip, { weight })` builds a full
layer.

- Layers blend in order: an `override` layer lerps (slerps rotations) toward its pose by
  `weight`, and an `additive` layer adds its difference from the clip's first frame. The first
  layer blends from the rest pose (each field's value when it was bound). Fields no layer animates
  this frame aren't written, so code and IK keep what they set.
- A mask is a data asset (`*.mask.json`) of joint paths with weights, where a path covers its
  subtree and the longest match wins; paths nothing covers get 0
  (`{ "joints": { "Armature/Hips/Spine": 1, "Armature/Hips/Spine/Neck": 0 } }`).
- `crossfade(world, entity, clip, seconds)` adds a layer and fades the others out (`fadeTo` 0,
  removed at 0). It's what the state machine uses. `play` is a crossfade over 0 s.
- A `once` layer at its end holds the last pose and sends `AnimationFinished { entity, layer }`.
- Clip events at authored times arrive as `AnimationEvent { entity, layer, name, time, data }`,
  after every loop, and both ways in ping-pong.

### Binding and sampling

- A channel is `{ target, component, field }`: an entity path relative to the player's entity
  (`''` is the entity itself), a component, and a numeric field. glTF TRS channels target
  `core/Transform`; weights channels target `render/MorphWeights` on every entity the node's
  primitives became. On first play, the player binds each channel to the entity at that path and
  caches its table, row, and columns, refetching when the entity moves table or the table grows
  and rebinding when a bound entity dies (a respawned model). Missing targets are skipped, retried
  every 30 frames (instances spawn late), and listed in `animation.describe`.
- Sampling runs in `PostUpdate` before transform propagation: keyframe search starts from the last
  frame's key (a cursor per channel), and interpolation is linear (slerp for rotations), step, or
  cubic spline. Results write straight into the component columns and mark them changed.
- Scratch pose buffers are TypedArrays sized at bind time, and doubles passed between the
  sampler's functions ride in `Float64Array`s (V8 boxes doubles passed to calls it doesn't
  inline), so a frame of sampling doesn't allocate.

### Skinning

- Skinning belongs to `@aethervtt/shard-render`, so any posed skeleton draws (IK, code, the player): the
  glTF importer tags skinned nodes with `render/SkinnedMesh { skin: handle('Skin'), joints:
  list(entity) }`; empty joints resolve from the skin's paths under the nearest ancestor that has
  them, once the instance spawns. Code can set `joints` to drive a mesh with other entities.
- In render's prepare step, a system writes joint matrices (`inverse(mesh) × joint ×
  inverseBind`, so the instance transform still applies) for every visible skinned mesh into one
  storage buffer. Each slot has a deform record (first joint, joint count, where its mesh's
  data sits, morph weights), flagged in the instance record (`Skinned`, `Morph`).
- Per-vertex joints and weights (and morph deltas) live in one storage buffer indexed by
  `vertex_index`, not vertex attributes, so every material and pass keeps one pipeline. All
  engine vertex stages (forward, deferred, shadows, prepass, picking, unlit) call
  `mesh_vertex_at`, which deforms (morphs, then skins position, normal, and tangent) before the
  `vertex_position` hook. Motion vectors use this frame's pose with last frame's transform.
- Culling bounds come from the joints' world positions, each padded by the farthest vertex it
  mainly moves (in joint space, computed once per mesh and skin): a per-slot sphere the CPU and GPU
  cullers use instead of the mesh bounds.

### Morph targets

The importer reads primitive `targets` (position, normal, tangent deltas) into the mesh artifact
(mesh format version 2; meshes without targets stay version 1), and `render/MorphWeights {
weights: list(f32) }` holds the current weights (the node's or mesh's `weights` at import). Each
frame the 8 heaviest non-zero weights go to the vertex stage, which adds their deltas from a
storage buffer. Mesh bounds cover every blend of weights in [0, 1]. glTF `weights` channels
animate `MorphWeights`.

### Root motion

With `rootMotion` set, the root joint's travel on the ground plane (the model's XZ, through the
joint's parent chain) and yaw are taken out of the pose, which is pinned where the clip starts,
and written to the `animation/RootMotion { translation, rotation }` component each frame (in the
entity's frame, so entity plus pose retrace the clip's path). Travel is sampled at both ends of
the step, across loop wraps, and weighted by each override layer's share of the root.
`'transform'` applies it to the entity's `Transform`. `'character'` adds it to
`CharacterIntent.move` as a velocity (taking back last frame's share, so the game's own intent
stays), so animated walking stays on the ground and collides; yaw turns the entity.

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
color, or number-list field, validated against the component schema with pointers into the file.
Interpolation is `linear`, `step`, or `cubic` (Catmull-Rom tangents). Duration defaults to the
last key or event. glTF clips and property clips play through the same player.

### Agent surface

- `animation.describe { entity }` (MCP `animation_describe`): layers with clip, time, duration,
  weight, loop, blend, mask, and fade, bound targets, unbound channels, and root motion. Without
  an entity: every player. `asset.get` on a clip lists channels, duration, and events.
- `asset.preview` of a glTF clip renders its model (the file's `#Scene`) at 5 evenly spaced times
  in a row. Property clips have no model (`animation/no-model`).
- The `skeleton` debug overlay draws joints and bones as gizmos.
- The `animation` manifest plugin; the `animate` agent skill.
- **Errors:** `animation/unknown-target` (property clip track: unknown component or field),
  `animation/invalid-track` (field not animatable, bad keys), `animation/invalid-clip`,
  `animation/invalid-mask`, `animation/no-player`, `render/too-many-joints` (over 256 per skin: the
  glTF import fails with a pointer; skins made in code draw in bind pose and log it).

## Decisions

- **Sample into joint entities.** Joints are already entities (0015), so attachments, IK, and
  debugging use paths and parenting. Writing columns directly keeps it cheap.
- **One player for skeletal and property clips.** A door and a character use the same component,
  the same events, and the same state machine.
- **Joint matrices in one storage buffer.** Skinned meshes stay in the instanced path (0022) and
  cost one extra buffer read per vertex.
- **Skin data by vertex index, not vertex attributes.** One pipeline per material and pass, no
  skinned variants; meshes that don't deform pay one flag check per vertex.
- **Skinning in render, clips in animation.** A skeleton posed by anything deforms its mesh.
- **Root motion is a component.** It's per-entity state every frame, read without allocation.
- **Root motion feeds the controller.** Applying it to the transform would walk characters
  through walls.

## Acceptance criteria

- [x] `CesiumMan` walks: sampled joint rotations match the glTF reference values at 10 times, and
      the skinned mesh renders as a golden image mid-stride, with its shadow.
- [x] A 50/50 blend of two clips gives the halfway pose (slerp) on a test skeleton. An additive
      layer adds its delta, and a masked layer changes only its subtree.
- [x] `crossfade` over 0.3 s reaches the target clip's pose at 0.3 s and sends `AnimationFinished`
      for a `once` clip.
- [x] Morph weights animated by a glTF clip deform the mesh (golden image of `AnimatedMorphCube`).
- [x] With root motion on `'character'`, a walk clip moves a character controller the clip's
      distance, and the root joint stays in place.
- [x] A property clip rotates an entity and blinks a light as authored. A track naming an unknown
      field fails with a pointer.
- [x] 200 characters of 60 joints: sampling under 2 ms per frame, and the frame holds 60 fps at
      1080p (bench and `#animation` demo). Steady-state sampling allocates nothing. Measured
      (M-series, `pnpm bench`): sampling 1.0 ms, 1080p frame 8.3 ms (CPU + GPU, one draw), no GC.

## Open questions

- None blocking.
