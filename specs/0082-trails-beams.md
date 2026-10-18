# 0082 — Trails and beams

- **Status:** draft (implementation authorized in this session)
- **Packages:** `@aethervtt/shard-render`, effects, project, playground
- **Depends on:** 0004, 0020, 0052, 0056, 0061, 0064, 0081

## Context

Particle sprites do not form a continuous sword slash, projectile ribbon or lightning tether.
0081 schedules presentation but deliberately did not add new visual primitives. Trails and beams
share ribbon geometry without requiring a particle simulation. Bone attachments use the existing
entity transform hierarchy.

## Goals

- Schema-authored `Trail` and `Beam` components, optional renderer plugin, headless simulation.
- Bounded history, width/color curves, host-catalog textures, UV scrolling, alpha/additive blend.
- World-space history for trails; moving endpoints or an authored local polyline for beams.
- Sequence activation, pause, cancellation and ownership; both graphics tiers and multiple views.

## Non-goals

A visual graph/timeline editor, GPU particle-to-ribbon spawning, fluid simulation, collision,
network synchronization, automatic weapon geometry inference, or gameplay hit detection.

## Design

Components live in renderer core; `ribbonsPlugin` depends on `render/forward`. `forwardPlugin()`
includes it. A minimal forward renderer without it reports `render/feature-missing` when used.
Nothing registers on import. The plugin's graph node draws into resolved HDR, depth-tested
without depth writes. Vertex attributes and uniforms work identically on full and baseline tiers.

`Trail` samples its entity's transformed local `offset`, after transform propagation. A bounded
TypedArray ring stores world positions, birth times and cumulative distance. A minimum distance
avoids duplicate points; a maximum distance breaks the strip after a teleport. Points expire by
lifetime. Stopping emission drains the existing trail; removing the component/entity clears it.
Capacity changes reset history. Origin shifts translate history without introducing a segment.

`Beam` starts at the entity's transformed local `start`. With `target`, its `end` is relative to
that entity; otherwise `end` is relative to itself. An optional local `points` polyline overrides
endpoints. Subdivided endpoint beams support bounded seeded displacement, keeping endpoints fixed.
A dead target produces a diagnostic and no beam. Zero-length/duplicate segments produce no NaNs.

Both have `playing`, `paused`, `width`, `opacity`, start/end colors and a bounded piecewise-linear
width curve. Trail curves use normalized point age; beam curves use normalized distance. Geometry
uses shared point tangents and camera-facing extrusion, including orthographic and edge-on views.
Texture coordinates use cumulative world distance, a repeat scale and simulation-time scroll.
A missing texture uses an explicit white fallback while asset loading is reported. Handles are
ordinary catalog GUID/path references; no URL or filesystem loader is added.

Each world owns its simulation and GPU caches. Steady sampling and geometry generation reuse
arrays; creation, resizing and command/diagnostic reads may allocate. Limits: 256 trail/beam records,
2–256 points each, 16 width-curve keys and 256 authored beam points. Invalid curves or capacity
excess report structured errors; no unbounded growth or silent truncation. Resource inspection
reports points, vertices, active/paused status, errors and retained TypedArray bytes. Unused GPU records are destroyed;
device recovery rebuilds from CPU state. Alpha blending follows stable record creation order
(no per-view depth sort). Colors are display-referred unlit overlays in the resolved HDR pass. Empty/paused worlds release frame demand appropriately.

### API sketch

```ts
world.spawn(Transform, [Trail, { lifetime: 0.4, width: 0.3, color: '#60dfff' }])
world.spawn(Transform, [Beam, { target, width: 0.08, segments: 24, noise: 0.15, seed: 42 }])
```

### Agent surface

The component schemas supply scene validation, inspector fields and generated project schemas.
`render.describe` includes ribbons; public headless inspection is available. 0081 gains a `visual`
track naming `render/Trail`, `render/Beam` or `render/Decal` on an owned prefab target. It activates
that component for its interval, pauses its clock, stops it at end and destroys it through existing
owned-target cleanup. A Beam track may name an `endpoint` target binding; losing that
bound entity fails the instance and cleans up its owned targets. Overlapping visual tracks on one resolved component are rejected. Feature
plugins are checked during preparation. Borrowed visual components are not overwritten.

## Decisions

- **Separate from particle simulation.** Entity/bone trails and beams are useful independently.
- **World history, local authoring.** Attachments inherit transforms; old trail points stay behind.
- **Bounded CPU geometry.** Same semantics on WebGPU/WebGL2, inspectable and testable headlessly.
- **Frame-aligned sampling.** The same seed and sampled motion replay; different timesteps need not
  produce identical trail geometry. Displacement is seeded spatial shape, not an audio clock.

## Acceptance criteria

- [ ] Schemas, invalid curves, limits, endpoint/polyline semantics and duplicate/teleport behavior tested.
- [ ] History expiry, pause, stop/drain, origin shift, entity removal and isolated worlds tested headlessly.
- [ ] Real WebGPU and WebGL2 evidence shows a moving slash and lightning tether, texture/curve controls,
  depth occlusion, camera variants, sequence replay/cancellation, and no GPU errors.
- [ ] Scene/catalog/project schemas and sequence lifecycle integration are exercised by tests.
- [ ] `render/ribbons-update` benchmarks 128 trails × 64 points; proposed 2 ms named-machine budget,
  steady-state allocation checks, hosted CI measurements recorded honestly.
- [ ] Typecheck, correctness, lint, builds/size/package checks pass; renderer-min stays within budget.

## Implementation evidence

See [the implementation record](research/vfx-implementation-evidence.md) for test coverage,
browser captures, hosted measurements, bundle cost and product boundaries.

## Open questions

None for this slice. Particle-generated trails and visual authoring are deferred.
