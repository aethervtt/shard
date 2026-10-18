# 0083 — Projected decals on rigid meshes

- **Status:** draft (implementation authorized in this session)
- **Packages:** `@aethervtt/shard-render`, effects, project, playground
- **Depends on:** 0020, 0056, 0061, 0064, 0081, 0082

## Context

Scorch marks, footprints and magic sigils need to conform to surfaces. A flat quad cannot wrap
across a floor/wall corner. Decals project texture/color onto eligible geometry and share the
same host assets and presentation lifetimes as other effects.

## Goals

- Schema-authored box projector, explicit receiver masks, texture/color/opacity and lifetime fade.
- Actual triangle clipping against projector volume, yielding surface-conforming geometry.
- Predictable bounds, lifecycle, diagnostics and equivalent full/baseline rendering.

## Non-goals

Skinned/morph/compute-deformed surfaces, terrain-specific projection, transparent receivers,
normal/roughness modification of the PBR G-buffer, permanent mesh painting, or a decal editor.
This slice provides unlit color/emissive overlays on rigid CPU-readable meshes.

## Design

`Decal` and `DecalReceiver` are renderer core components; `decalsPlugin` is optional and included
by `forwardPlugin()`. Missing plugin usage reports a structured feature warning.

A projector's Transform defines a local box: X/Y map texture UVs; local -Z is projection direction.
`size` defines its extent. A `DecalReceiver` marks eligible Mesh3d entities with a bit mask;
`receiverMask` selects them. Only eligible, visible rigid meshes contribute. An angle threshold
rejects back-facing/near-perpendicular triangles; a small surface-normal offset avoids z fighting.

CPU projection transforms receiver triangles into projector space and clips them against all six
box planes. It emits triangle fans with projector UVs and world-space positions. Static projections
are cached; projector/receiver transforms, mesh versions and masks invalidate them. Receiver removal
or hiding removes its contribution. Unsupported deformation is reported rather than silently
painting the undeformed bind pose. Mesh geometry remains owned by its original host.

Projection is bounded: at most 64 projectors, a fixed per-projector output vertex budget and a
fixed input triangle budget. Overflow produces a visible diagnostic and no partial decal. The
steady cache check/fade path reuses storage. Projection is cold/invalidation work and measured
separately. GPU buffers are freed after removal and regenerated after device recovery.

`playing` activates the projector and its clock. A zero `lifetime` is persistent; otherwise it
expires and fades over `fadeOut` seconds at its end. `paused` freezes age. `opacity` is animatable
through 0081 property tracks; a visual track controls activation. Deactivation removes the mark.
The scene owns the entity: expiration does not destroy host entities. Origin shifts preserve the
projected placement by invalidating geometry against the shifted receiver/projector transforms.

Textures are host catalog handles, including GUID-only entries. Rendering reuses 0082's bounded
vertex/texture draw infrastructure, with separate feature registration and diagnostics. Decals
draw after the resolved scene and before ribbons/particles; they test scene depth and do not
write depth. Camera layer filters and receiver visibility apply. Multiple decals use stable order.

### API sketch

```ts
world.add(floor, DecalReceiver, { mask: 1 })
world.spawn([Transform, projectorPose], [Decal, {
  size: [2, 2, 1], receiverMask: 1, texture: { guid: 'scorch' }, lifetime: 8, fadeOut: 2,
}])
```

### Agent surface

Scene/component schemas and `render.describe` expose projectors, projected triangles, rebuilds,
age, bytes and structured errors. Sequence visual tracks use the same lifecycle as 0082.
Project authoring documentation explains receiver masks, projection direction and supported meshes.

## Decisions

- **Clipped geometry, not a screen-space approximation.** Explicit receiver selection, no screen
  edge/disocclusion artifacts, shared behavior on both backends, headless geometry verification.
- **Rigid meshes first.** Supporting skin deformation requires a distinct vertex binding contract.
- **No host persistence assumptions.** Aether can store prefab/document data and textures in its
  asset system; the renderer only sees validated components and catalog handles.

## Acceptance criteria

- [ ] Projection clips against all six planes with finite UVs/positions; orientation, transforms,
  receiver masks, angle rejection, unsupported meshes and budget overflow have headless tests.
- [ ] Cached geometry rebuilds only when inputs change; removal/hiding, fade, pause, origin shifts
  and teardown leave no retained draw records or host state changes.
- [ ] Real WebGPU/WebGL2 captures show a mark wrapping a corner, excluded receivers unchanged,
  depth occlusion, fade and sequence cancellation; no browser/GPU errors.
- [ ] `render/decals-project` measures 32 projectors over bounded fixture geometry (proposed 8 ms
  named-machine budget); cached updates are included in steady-state allocation checks.
- [ ] All correctness/typecheck/lint and CI build/package/size gates pass, with evidence on disk.

## Implementation evidence

See [the implementation record](research/vfx-implementation-evidence.md) for test coverage,
browser captures, hosted measurements, bundle cost and product boundaries.

## Open questions

None for this slice. Deformed surfaces and PBR channel decals are explicit follow-up work.
