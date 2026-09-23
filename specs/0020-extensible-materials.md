# 0020 — Extensible materials

- **Status:** implemented
- **Packages:** `@shard/render`, `@shard/shader`, `@shard/project`
- **Depends on:** 0002, 0006, 0007, 0014, 0016

## Context

Every mesh today is drawn with `StandardMaterial`. A game needs its own surfaces: lava that
glows along cracks, a force field that fades at glancing angles, terrain that blends four
texture sets by slope, grass that sways in the wind. The shader module system (0006) already has
hooks (`pbr_input`, `fragment_output`). What's missing is a way to define a material type with its
own parameters and shader, and have the renderer, the asset database, and agents treat it like
the built-in one.

VISION names the pattern: a PBR base plus user shader hooks, like Bevy's `ExtendedMaterial`, with
one schema driving everything.

## Goals

- `defineMaterial()` declares a material type: a parameter schema, texture slots, and a WESL module
  that overrides hooks. It works from engine packages and from project code (namespaced, hot
  reloadable through 0017).
- Parameters and textures come from the schema: uniform layout (`wgslLayout`), texture and sampler
  bindings, validation, JSON Schema, inspector data. Nothing is written by hand.
- Materials can extend the standard PBR material (keeping all its fields and lighting) or start from
  nothing (unlit or custom lighting).
- Hooks cover vertex displacement, surface, and final color, and they apply consistently to every
  pass that draws the mesh: forward, depth prepass, shadows, and G-buffer.
- Material assets name their type. Material files, scene inline assets, and glTF all use the same
  shape.

## Non-goals

- Node-graph material editing (no drag-and-drop editor, per VISION).
- Custom render passes defined by materials (a render-graph node does that).
- Per-material blend-equation zoos (opaque, mask, alpha, additive, and premultiplied cover v1).

## Design

### Defining a material

```ts
export const Lava = project.material('Lava', {
  extends: 'standard',                     // or 'none' for unlit/custom lighting
  fields: {
    crackColor: t.color({ default: [1, 0.3, 0.05, 1] }),
    crackLuminance: t.f32({ default: 20000, unit: 'cd/m²' }),
    flow: t.vec2({ default: [0.02, 0], description: 'UV scroll per second.' }),
    cracks: t.handle('Texture', { description: 'Crack mask (R).' }),
  },
  blend: 'opaque',
  shader: 'project::lava',                 // shaders/lava.wesl
})
```

```wesl
// shaders/lava.wesl
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import shard::globals::globals;
// The generated uniform and texture bindings.
import material::lava::{ Lava, Lava_cracks, Lava_cracks_sampler };

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);               // everything StandardMaterial would do
  let uv = in.uv + Lava.flow * globals.time;
  let crack = textureSample(Lava_cracks, Lava_cracks_sampler, uv).r;
  p.emissive += Lava.crackColor.rgb * Lava.crackLuminance * crack;
  return p;
}
```

- `project.material` / `defineMaterial` registers a `render/<name>`-style type (project types
  namespaced as usual). It's also a Material asset type, so `*.material.json` files and scene
  inline assets can use it.
- The generated `material::<name>` module declares the uniform struct (from `wgslLayout`), then the
  texture and sampler bindings for every `t.handle('Texture')` field. The inherited standard fields
  come from `shard::pbr::standard` (`standard_input`).
- Hooks are `vertex_position` (displacement in object space, applied in every pass), `pbr_input`,
  and `fragment_output`. With `extends: 'none'`, a `shade` hook replaces lighting entirely, and the
  material renders forward only (0021).

### Material assets

```json
{ "type": "my-game/Lava", "crackLuminance": 30000, "cracks": { "path": "assets/cracks.png" } }
```

- Material files and inline scene assets gain an optional `"type"`. Omitted, it's
  `render/StandardMaterial`, so existing files keep working. Validation uses that type's schema,
  and errors point into the file as before.
- glTF materials import as StandardMaterial. A project can map a glTF material name or extras to
  its own type through an importer setting (`materialTypes: { "Lava*": "my-game/Lava" }`).

### Rendering

- A pipeline is keyed by (material type, shader version, mesh vertex layout, pass, blend, cull,
  MSAA). Keys are cached, compiled asynchronously (0005), and skipped until ready, as today.
- Draw groups sort by (pass, pipeline, material, mesh), so switching pipelines stays rare.
- A shader edit hot reloads (0006), and a material type redefinition hot reloads with project code
  (0017). Existing assets of that type revalidate against the new schema and migrate their data
  like components do.

### Agent surface

- `schema.get` returns a material type's schema, and the component catalog lists material types
  with their fields.
- `asset.preview` of a material asset renders it with its own shader.
- Shader compile errors in `shaders/*.wesl` report file, line, and column (0006 source maps) in
  `errors.recent`, with the material type named.
- The generated skill `write-a-material.md` walks through fields, a hook, and a preview.

## Decisions

- **Hooks, not full shaders.** Overriding `pbr_input` keeps shadows, the G-buffer, lighting, and
  post effects correct for free. Full custom lighting is the explicit `extends: 'none'` escape
  hatch.
- **Displacement applies in every pass.** A swaying mesh whose shadow doesn't sway is the classic
  bug. The same `vertex_position` hook is compiled into the shadow and prepass pipelines.
- **The material type is in the asset.** Files stay self-describing, and old files default to
  standard.
- **The schema drives bindings.** Texture fields become bindings automatically, so a material type
  can't declare a texture its shader can't see.

## Acceptance criteria

- [x] A project material (fields, one texture, `pbr_input` override) renders as a golden image in
      forward and deferred.
- [x] A `vertex_position` displacement moves the mesh and its shadow identically (golden image).
- [x] An `extends: 'none'` material with a `shade` hook renders forward in a deferred view.
- [x] A `*.material.json` with `"type": "my-game/Lava"` validates against the Lava schema, with a
      bad field reported by pointer, and old files without `type` load as StandardMaterial.
- [x] Editing the WESL file changes the running game within a frame of compiling. A compile error
      keeps the previous shader and reports file:line:col.
- [x] Adding a field to a project material hot reloads, and existing assets of that type gain its
      default.
- [x] 10 material types × 1000 meshes cost at most 10 pipeline switches per pass (draw-order check).

## Implementation notes

- **Defining:** `defineMaterial(name, { extends, fields, blend, shader, description })` in
  `@shard/render`, and `project.material(name, options)` in project code, which namespaces the
  name. The type's schema is a normal component definition (standard fields plus the type's own
  for `extends: 'standard'`), so `schema.get`, the component catalog, validation, and JSON Schema
  all work on it. A type's own field can't reuse a standard field's name
  (`render/material-field-clash`).
- **The generated module** is `material::<snake_name>` (`my-game/Lava` → `material::lava`). WESL
  imports need explicit names, so a shader imports what it uses:
  `import material::lava::{ Lava, Lava_cracks, Lava_cracks_sampler };`. The uniform is the
  PascalName, packed from the numeric fields with `wgslLayout`. Every `t.handle('Texture')` field
  gets a texture and a sampler (linear, repeat). For standard extensions they follow the standard
  material's 12 bindings in group 1; for `extends: 'none'` they start at 0.
- **The standard surface** is `standard_input(in)` in `shard::pbr::standard`, where the standard
  bindings now live. The `pbr_input` hook defaults to it.
- **Hooks:**
  - `vertex_position(position, normal, uv) -> vec3f` (in `shard::mesh`, so every pass runs it)
  - `pbr_input(in) -> PbrInput`
  - `fragment_output(color) -> vec4f` (pre-exposed HDR)
  - `shade(in) -> vec4f` (in `shard::unlit::shading`, for `extends: 'none'`: radiance in cd/m²
    and alpha; the engine applies exposure)

  Overrides can name a hook without its module (`override fn pbr_input(...)`) when exactly one
  module declares it; otherwise it's `shader/ambiguous-hook`. `shard::globals` (time, delta
  time, frame) is available in every pass, including shadows.
- **Blend modes:** `StandardMaterial.alphaMode` gained `alpha`, `additive`, and `premultiplied`.
  A type's fixed `blend` overrides it. Blended materials draw in `forward-transparent` after the
  sky: back to front by instance origin, consecutive instances of one batch merged into a draw,
  depth-tested with no writes. They cast no shadows.
- **Pipelines** are cached per pass, type, blend mode, culling, and MSAA under a numeric key, so a
  draw looks one up without allocating. Batches sort by type and variant. 10 types × 1000 meshes
  (spawned interleaved) draw in 10 calls with at most 10 pipeline switches. `render.describe`'s
  stats now report `pipelineSwitches` per view.
- **Assets:**
  - `MaterialAsset` carries its `type`. A redefinition (project hot reload, inside the
    redefinition scope) updates the type in place and bumps its version. Each asset `sync`s on
    its next use: new fields get their defaults, and the GPU copy and pipelines rebuild.
  - Material files and scene inline assets read `"type"` (default standard). Validation uses that
    type's schema and errors point into the file. A type the importer can't see (project code
    isn't loaded there) imports with a warning and is validated when the game loads it.
  - glTF has a `materialTypes` import setting (`{ "Lava*": "my-game/Lava" }`, glob on the
    material name) and honors `extras.shardMaterial`.
- **Project shaders:** hosts load `shaders/**/*.wesl` as `project::…`. The headless host uses
  `loadProjectShaders`, and watches with `watch`. `shard dev` serves `/@shard/shaders.json`,
  pushes edits over its socket, and the page relinks them. A broken edit keeps the last good shader.
  The error names the material type (`material my-game/Lava: …`) and points at
  `shaders/lava.wesl:line:col`, including WESL parse errors, whose location only appears in the
  message text.
- **Previews:** `asset.preview` shares the game's shader library, so a material type previews
  with its own shader.
- **Generated skill:** `write-a-material.md` covers fields, the lava shader, the hooks, a material
  file, and checking it.

## Open questions

- None blocking. Deferred: material instancing of per-entity parameters (a per-instance storage
  buffer), until a use case needs it beyond what components can do.
