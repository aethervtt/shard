# 0007 — Cameras, meshes, and a basic forward renderer

- **Status:** implemented
- **Packages:** `@shard/render`, `@shard/mesh`
- **Depends on:** 0004, 0005, 0006

## Context

M2 ends with "a spinning PBR-lit cube driven by ECS". This spec is the smallest renderer that gets
there properly: cameras, meshes, a simple lit material, instancing, and frustum culling, all built
on the render graph and shader modules. Full PBR (shadows, IBL, extensible materials,
post-processing) is M5 and builds on this without replacing it.

It also has to render thousands of objects efficiently from the first day, since that's the
engine's promise.

## Goals

- `Camera3d` with perspective and orthographic projection, render order, and a target.
- A `Mesh` type with standard vertex attributes, plus procedural primitives.
- In-memory asset storage for meshes and materials until the asset database exists (M4).
- A basic lit material: base color, metallic, roughness, emissive; one directional light plus
  ambient.
- Physical units for light, and camera exposure to match: `Exposure` on every camera, and an
  optional `PhysicalCamera`.
- A shading structure (surface, then lighting) that lets a deferred path reuse every material.
- Automatic instancing of identical mesh + material pairs.
- CPU frustum culling from `GlobalTransform` and mesh bounds.
- `Visibility` with hierarchy inheritance.

## Non-goals

- Shadows, IBL, point/spot lights, HDR post-processing (M5).
- 2D sprites (M5 2D pipeline). `Camera2d` exists here only as an orthographic camera preset.
- The deferred rendering path (M5). This spec only keeps the door open; see "Shading structure".
- Auto exposure, depth of field, motion blur (M5 post-processing, driven by `PhysicalCamera`).
- GPU-driven culling.
- Loading meshes from files (glTF is M4).

## Design

### Components

```ts
Camera3d {
  projection: enum('perspective', 'orthographic'),
  fovY: f32 = 60 (degrees), near: f32 = 0.1, orthoHeight: f32 = 10,
  order: i32 = 0,            // lower renders first
  clearColor: color = '#101218',
  target: handle('RenderTarget') | null,  // null = the window
}                                          requires Transform, Exposure

Exposure { ev100: f32 = 12 }               // how bright the scene is allowed to be; see below
PhysicalCamera {                           // optional; when present it sets Exposure (and fovY)
  aperture: f32 = 4 (f-stops), shutterSpeed: f32 = 1/125 (s), iso: f32 = 100,
  sensorHeight: f32 = 24 (mm), focalLength: f32 | null = null (mm; sets fovY when given),
}

Mesh3d        { mesh: handle('Mesh') }                   requires Transform, Visibility
MeshMaterial  { material: handle('Material') }           defaults to a gray standard material
Visibility    { mode: enum('inherit', 'visible', 'hidden') }  requires ComputedVisibility
DirectionalLight { color: color = '#ffffff', illuminance: f32 = 10000 (lux) }  requires Transform
AmbientLight  (resource) { color, brightness: f32 (cd/m²) }
```

Every field has a description for agents. `Camera3d` looks down its transform's -Z.

### Physical units and exposure

Lights use real-world units: directional light in **lux**, ambient in **cd/m²**, emissive surfaces in
**cd/m²** (M5 adds point/spot lights in lumens). Real values span five orders of magnitude, so every
camera carries an `Exposure` in EV100 that maps scene light to the screen.

Presets come in matched pairs so an agent can light a scene correctly without knowing photography:

| Scene | Light preset | Illuminance | Exposure preset | EV100 |
|---|---|---|---|---|
| Direct sun | `'direct-sun'` | 100,000 lux | `'sunny'` | 15.3 |
| Daylight / bright overcast | `'daylight'` | 10,000 lux | `'daylight'` | 12 |
| Overcast | `'overcast'` | 1,000 lux | `'overcast'` | 8.6 |
| Office interior | `'indoor'` | 400 lux | `'indoor'` | 7.3 |
| Twilight | `'twilight'` | 10 lux | `'twilight'` | 2 |

The relationship is `EV100 = log2(lux / 2.5)` (incident-light meter, ISO 100), exposed as
`Exposure.fromIlluminance(lux)`. Presets are accepted anywhere a number is, in code and in scene
files.

`PhysicalCamera`, when present, computes `EV100 = log2(N² / t · 100 / S)` from aperture `N`,
shutter `t`, and ISO `S`, and overwrites `Exposure` each frame. With `focalLength` set it also derives
`fovY` from the sensor height. M5 reuses the same component: aperture and a focus distance drive
depth of field, shutter speed drives motion blur, and auto exposure adjusts `Exposure` instead.

### Shading structure

Shading is split into two stages, and materials only ever implement the first:

1. **Surface**: the material produces a `PbrInput` (base color, normal, metallic, roughness,
   emissive, occlusion). This is where the `pbr_input` hook (0006) sits, and where material
   extensions plug in.
2. **Lighting**: `apply_lighting(PbrInput)` evaluates lights and returns color.

The forward path runs both stages in one fragment shader. The deferred path (M5) runs the surface
stage into a G-buffer and lighting in a separate pass. Because materials never see which path runs,
every material and extension works in both without changes. Transparent and alpha-blended objects
always use forward.

### Meshes

```ts
const mesh = Mesh.create({
  positions: Float32Array, normals?: Float32Array, uvs?: Float32Array,
  tangents?: Float32Array, colors?: Float32Array, indices?: Uint16Array | Uint32Array,
})
mesh.bounds  // AABB, computed on creation
```

Procedural primitives, parameterized so agents can build scenes without assets:
`cube({ size })`, `box({ x, y, z })`, `sphere({ radius, segments })`, `plane({ size, subdivisions })`,
`cylinder`, `capsule`, `cone`, `torus`. Each generates normals and UVs. These live in `@shard/mesh`,
the start of the procedural mesh toolkit (M7 builds furniture and rocks on top).

### In-memory assets

Until M4, `Assets<T>` resources hold meshes and materials by runtime-generated GUID:

```ts
const cubeRef = world.resource(Meshes).add(cube({ size: 1 }))  // AssetRef<'Mesh'>
world.spawn([Mesh3d, { mesh: cubeRef }], [Transform, { translation: [0, 1, 0] }])
```

The asset database later backs the same `AssetRef`s with files, so user code doesn't change.

### Standard material (basic)

```ts
StandardMaterial {
  baseColor: color, metallic: f32, roughness: f32 = 0.5,
  emissive: color = '#ffffff', emissiveLuminance: f32 = 0 (cd/m²; 0 = not emissive),
}
```

Shaded with Cook-Torrance GGX from one directional light plus ambient, in linear space, then a
simple tonemap (ACES fit) and sRGB output. Uniforms come from the schema through `wgslLayout`
(0006). The WGSL lives in `shard::pbr` modules, with the hooks M5 will open up to extensions.

### Extraction, instancing, culling

1. **Visibility** (`PostUpdate`, after propagation): `ComputedVisibility` from `Visibility` modes
   and the parent chain.
2. **Extract**: for each camera, compute the frustum; for each visible `Mesh3d`, transform the
   mesh AABB by `GlobalTransform` and test it. Survivors are grouped by (mesh, material, pipeline).
3. **Prepare**: each group writes its model matrices into one instance buffer (affine 3x4, 48 bytes
   per instance). When a whole table passes culling and its transforms are contiguous, the
   `GlobalTransform` column is copied directly, as in the galaxy demo.
4. **Queue/draw**: one instanced draw per group in `Opaque3d`, sorted by pipeline, then material,
   then front-to-back.

Depth: `depth32float`, reversed Z. MSAA 4x by default (configurable), skipped on displays of 1.5 pixels per CSS pixel or more (0051).

### Agent surface

- Primitives and materials are all schema-described, so an agent can build a lit scene entirely
  in data.
- `render.describe()` adds per-camera counts: visible, culled, draw calls, instances.
- `captureView` (0005) gives screenshots to verify results.

## Decisions

- **Instancing by default.** Draw calls are the bottleneck in WebGPU from JS; grouping identical
  mesh/material pairs is the single biggest win.
- **CPU culling now, GPU culling later.** CPU culling over TypedArray columns is fast enough for
  tens of thousands of objects and much simpler to debug.
- **Procedural primitives in core packages.** Agents need geometry before assets exist, and
  procedural is the engine's default medium anyway.
- **GGX from the start.** The basic material uses the same BRDF full PBR will, so M5 extends it
  instead of replacing it.
- **Physical light units with matched exposure presets.** Correct for PBR from the first frame, and
  the presets make correct values easy to pick.
- **`Exposure` is required; `PhysicalCamera` is optional.** Most scenes only need one number.
  Photographic parameters are there for scenes that want them, and for M5 depth of field and
  motion blur.
- **Surface/lighting split.** The cost is one function boundary; the payoff is a deferred path in
  M5 that reuses every material.

## Acceptance criteria

- [x] A spinning, lit cube driven entirely by ECS data renders in the playground and in Studio.
- [x] 10k instanced cubes with individual transforms render at 60 fps; draw calls equal the number
      of distinct mesh/material pairs.
- [x] Frustum culling excludes off-screen objects (test: 10k objects, camera facing away, zero
      instances drawn) and agrees with a brute-force check.
- [x] `Visibility: hidden` on a parent hides its descendants; `visible` on a child of a hidden
      parent stays hidden only if its mode is `inherit`.
- [x] Two cameras with different `order` and targets render correctly in one frame.
- [x] Every primitive has correct normals (lit sphere shows no seams) and bounds.
- [x] A reference scene rendered headless matches a golden image within a small tolerance.
- [x] A scene lit with a light preset and the matching exposure preset renders with mid-gray
      surfaces near mid-gray on screen, for every preset pair.
- [x] `PhysicalCamera` with f/16, 1/125 s, ISO 100 yields EV100 ≈ 15 (sunny 16 rule).
- [x] Materials contain only the surface stage: the shared lighting function is the only code that
      evaluates lights.

## Implementation notes

- **Verified:** the playground scene draws 10,006 entities at 60 fps (9,100+ visible, ~850 culled,
  6 draw calls, one per mesh/material pair); CPU culling+instancing ~1.1 ms, GPU pass ~0.5 ms.
  Studio renders the lit spinning cube in the Tauri webview, checked with a self-capture
  (`VITE_SHARD_CAPTURE=1` writes the camera view to `~/Library/Caches/shard-studio-capture.rgba`),
  since screen capture isn't available in this environment.
- **Calibration test:** an 18% gray card under each matched light/exposure preset pair renders at
  sRGB ≈ 115/255 (photographic mid-gray is ~118), and all pairs land within 2 values of each other.
- **Golden image:** `packages/render/src/__golden__/reference-scene.rgba`, rendered headless on Dawn;
  compared with a mean-difference tolerance so other GPUs pass.
- **Where it lives:** the forward renderer is part of `@shard/render` (`forwardPlugin`, name
  `render/forward`, options `{ msaa: 1 | 4 }`); primitives are `@shard/mesh`.
- **Presets in code:** `lux('direct-sun')`, `ev100('sunny')`, `LightPresets`, `ExposurePresets`,
  `exposureScale(ev)`. Accepting preset names inside scene files belongs to the scene spec (M3).
- **Schema additions:** `Camera3d.far` (orthographic only; perspective stays infinite reversed-Z).
  `Exposure` defaults to the daylight preset (EV100 12); `AmbientLight` defaults to 0 cd/m².
  `camera2d()` returns spawn inits for an orthographic camera.
- **Graph extensions:** transient textures can use `format: 'view'` (MSAA color matches each
  target), and color clears can be a function of the view (per-camera clear colors).
- **View and material uniforms** are generated with `wgslLayout` from schemas (`ViewUniform`,
  `StandardMaterial`), so the WGSL structs and CPU packing come from one definition.
- **Not done:** copying a whole `GlobalTransform` column into the instance buffer when a table fully
  passes culling. Instances are copied per row; at 10k objects that's already ~1 ms. Revisit if
  profiles ask for it.
- **Expected look:** pure metals render dark with a highlight until image-based lighting (M5).
- `RenderStats` (per view: visible, culled, hidden, draw calls) is exposed and included in
  `describeRender`.

## Open questions

None.
