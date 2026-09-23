# 0004 — Math, transforms, and hierarchy propagation

- **Status:** accepted
- **Packages:** `@shard/core` (math, RNG, required components), `@shard/transform`
- **Depends on:** 0001, 0002, 0003

## Context

Everything that renders, collides, or makes a sound has a position. Before the renderer can draw
anything from the ECS, the engine needs a math library, a transform component, and a system that
turns local transforms plus the `ChildOf` hierarchy into world matrices.

The math library runs in hot loops over strided columns, so it can't allocate. It also has to agree
with WebGPU and glTF on conventions, or every downstream system pays for conversions.

## Goals

- Allocation-free math for vec2/3/4, quat, mat3, mat4, AABB, ray, plane, and frustum.
- Functions that work on both plain tuples and strided column offsets.
- One `Transform` component for 2D and 3D, plus a computed `GlobalTransform`.
- Propagation that skips unchanged subtrees.
- A seeded RNG in core, since determinism is a principle.
- Required components: adding `Transform` brings `GlobalTransform` with it.

## Non-goals

- SIMD (WebAssembly SIMD kernels can come later behind the same API).
- Double-precision world coordinates / floating origin.
- Physics-specific math (inertia tensors etc.), which belongs to physics.

## Design

### Conventions

Right-handed, **Y up**, **-Z forward**, meters, radians. Matches glTF, so imported assets need no
conversion. Matrices are **column-major** (matches WGSL). Clip-space depth is WebGPU's 0..1;
perspective projections use **reversed Z** with an infinite far plane for depth precision.

### Math API

Functions in namespaces, gl-matrix style, writing into an `out` argument:

```ts
import { mat4, quat, vec3 } from '@shard/core/math'

vec3.add(out, a, b)
quat.fromEuler(out, x, y, z)
mat4.fromTRS(out, translation, rotation, scale)
mat4.perspectiveReversedZ(out, fovY, aspect, near)
```

- Arguments are `ArrayLike<number>`, so tuples, `Float32Array`s, and column views all work.
- Strided variants take offsets for column work without subarrays:
  `mat4.fromTRSAt(out, outOffset, t, tOffset, r, rOffset, s, sOffset)`.
- Every function returns `out` for chaining. None allocate. Constructors (`vec3.create()`) exist
  for setup code.
- Geometry: `aabb.fromPoints`, `aabb.transform(out, box, mat)`, `ray.fromScreen(...)`,
  `ray.intersectAabb`, `frustum.fromViewProjection`, `frustum.intersectsAabb`.

### Seeded RNG

`Rng` in core: PCG32 (small state, good quality, fast in JS with `Math.imul`).

```ts
const rng = new Rng(seed)
rng.float()          // [0, 1)
rng.range(min, max)
rng.int(min, max)
rng.pick(array)
rng.fork('terrain')  // independent child stream derived from the parent seed and a label
```

`fork` lets systems get their own streams, so adding a random call in one system doesn't change
the output of another. A `GlobalRng` resource holds the app's root stream, seeded from `AppOptions`.

### Required components (ECS addition)

```ts
defineComponent('core/Transform', fields, { requires: [GlobalTransform] })
```

When a component with `requires` is spawned or added, each missing required component is added
with its defaults, in the same archetype move (no extra table hop). Requirements are transitive.
Agents benefit most: spawning `Mesh3d` gets `Transform`, `GlobalTransform`, and `Visibility`
without knowing the list. `describe()` output lists requirements.

### Transform components

```ts
Transform       { translation: vec3, rotation: quat, scale: vec3 = [1, 1, 1] }  requires GlobalTransform
GlobalTransform { matrix: affine3x4 }   // computed; readonly for users
```

2D uses the same `Transform`: `translation.z` orders layers, rotation is around Z. Helpers make
2D code read naturally: `transform2d({ x, y, angle, scale })` returns a `Transform` value.

This needs new schema field types: `t.mat4` (stride 16, JSON as 16 numbers column-major),
`t.mat3` (stride 9), and `t.affine3x4` (stride 12: the top three rows of an affine matrix, stored
row by row; the implied fourth row is `0 0 0 1`). Row storage is deliberate: in WGSL it reads as
three `vec4f` with no padding (a column-major `mat4x3` would pad each column to 16 bytes, 64 in
total), and shaders transform with three dot products.

### Propagation

`core/transform-propagate` runs in `PostUpdate`:

1. **Roots** (`Transform`, no `ChildOf`): if `Transform` changed since last run,
   `GlobalTransform = fromTRS(Transform)`. Hot loop over strided columns.
2. **Children**: for each root with `Children`, walk depth-first. A child recomputes if its own
   `Transform` changed or any ancestor recomputed this run.
3. Entities with `ChildOf` but no `Transform` pass their parent's matrix through unchanged.

Also exposed: `transformHelpers.worldPosition(world, e)` and `lookAt` for cold code.

### Agent surface

- `Transform` JSON is readable (`translation: [x, y, z]`, `rotation` as a quaternion). The scene
  loader additionally accepts `rotationEuler: [x, y, z]` in degrees for authoring; it's converted on
  load and never written back.
- Errors: `transform/non-uniform-scale-in-hierarchy` is a warning, not an error, logged once per
  entity when skewed children would result.

## Decisions

- **One Transform for 2D and 3D.** One hierarchy, one propagation path, one set of tools. The
  memory cost (quaternion + vec3 scale for sprites) is small next to the simplicity.
- **Column-major, -Z forward, Y up.** Matches WGSL and glTF; conversions never leak into user code.
- **Reversed-Z infinite perspective.** Standard for modern renderers; better depth precision.
- **Functions, not classes.** Classes allocate and don't work on column offsets.
- **PCG32 with labeled forks.** Deterministic, cheap, and robust to adding new random calls.
- **`GlobalTransform` is an affine 3x4 (48 bytes), not a mat4.** It's the layout GPU instance
  buffers use, so the renderer can copy the column directly (0007), and it's 25% smaller.

## Acceptance criteria

- [ ] Math functions match reference values (gl-matrix or hand-computed) for a fixture set,
      including quaternion slerp and matrix inversion.
- [ ] No math function allocates (checked with the GC-observer harness from 0001's benchmarks).
- [ ] `requires` adds missing components in a single archetype move, transitively.
- [ ] Propagating 100k root transforms that all changed takes under 2 ms.
- [ ] A 10k-entity hierarchy (depth 10) with 1% of transforms changed propagates in under 0.5 ms.
- [ ] Unchanged entities keep their `GlobalTransform` change tick (no false `changed`).
- [ ] Reparenting via `ChildOf` updates world matrices on the next propagation.
- [ ] `rng.fork(label)` streams are independent: adding draws to one doesn't change another.
- [ ] `frustum.intersectsAabb` agrees with a brute-force corner test on 10k random boxes.

## Open questions

None.
