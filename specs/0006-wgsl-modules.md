# 0006 — WGSL module system

- **Status:** accepted
- **Packages:** `@shard/shader`
- **Depends on:** 0002, 0005

## Context

WGSL has no imports, no conditional compilation, and no way to override one function from another
file. A PBR renderer with extensible materials needs all three: shared shader libraries
(`shard::view`, `shard::pbr::lighting`), variants (`SKINNED`, `NORMAL_MAP`), and hooks a material
extension can override without copying the whole PBR shader. That last one is how Bevy's
`ExtendedMaterial` works, and it's in the vision.

There's a community standard for exactly this: **WESL** (WGSL Extended), with a JavaScript linker
published as the `wesl` npm package. Using a standard means editor tooling, existing docs, and
syntax an agent may already know.

## Goals

- Imports between shader modules (engine library, plugin shaders, project shaders).
- Conditional compilation with defines, producing pipeline variants keyed by define sets.
- Overridable functions (hooks) for material extensions.
- Compile errors mapped back to the original file and line.
- Hot reload: a changed shader re-links and rebuilds the pipelines that use it.
- WGSL struct generation from component/material schemas, with matching CPU-side packing.

## Non-goals

- HLSL, GLSL, or Slang input (decided in the vision: WGSL only).
- A shader graph or visual editor.
- Transpiling to GLSL for WebGL2.

## Design

### Syntax: WESL

```wgsl
import shard::view::View;
import shard::pbr::{ PbrInput, apply_lighting };

@group(0) @binding(0) var<uniform> view: View;

@if(NORMAL_MAP)
fn sample_normal(uv: vec2f) -> vec3f { … }
```

- Module paths: `shard::…` for engine shaders, `<plugin>::…` for plugin shaders, `project::…`
  for a project's `shaders/` folder.
- Conditional compilation uses WESL `@if(...)` attributes. Defines come from the pipeline's
  variant key.

**Implementation choice:** use the `wesl` linker if it passes the acceptance criteria below
(imports, `@if`, source maps, runs in the browser and in Node, links a PBR-sized shader in under
5 ms). If it doesn't, write our own linker for the same syntax subset. The syntax is the contract,
so the choice doesn't leak into user shaders.

### Hooks (overridable functions)

WESL doesn't define overrides, so this is our extension, kept small:

```wgsl
// shard::pbr::material
@hook fn pbr_input(in: VertexOutput) -> PbrInput { /* default: standard material */ }
@hook fn fragment_output(in: PbrInput, lit: vec4f) -> vec4f { return lit; }
```

```wgsl
// project::toon (a material extension)
import shard::pbr::material::{ pbr_input as base_pbr_input };

override fn shard::pbr::material::pbr_input(in: VertexOutput) -> PbrInput {
  var p = base_pbr_input(in);
  p.roughness = 1.0;
  return p;
}
```

- A pipeline is linked with a list of override modules. For each `@hook`, the last override in the
  list wins; the default stays reachable under an alias so extensions can wrap it.
- Signatures must match exactly (`shader/hook-signature-mismatch` otherwise).
- Implemented as a pre-pass that rewrites hooks and overrides into plain WESL/WGSL before
  linking.
- The materials spec (M5) defines which hooks the PBR shader exposes. This spec provides the
  mechanism.

### Variants and caching

`linkShader({ root: 'shard::pbr::main', defines: { NORMAL_MAP: true }, overrides: ['project::toon'] })`
returns WGSL plus a source map. Results are cached by (root, sorted defines, overrides, module
content hashes). The pipeline cache (0005) keys on this.

### Errors

WebGPU's `getCompilationInfo()` reports line/column in the linked output. The source map translates
them back to module path, file, line, and column, producing
`ShardError('shader/compile', message, { path: 'shaders/toon.wesl:14:9' })`. Link errors
(unknown import, cycle, missing hook) use `shader/link-*` codes with the importing file's path.

### Schema to WGSL

From a component or material schema (0002), generate a WGSL struct and a packer that writes a value
into a `Float32Array`/`DataView` using WGSL's alignment rules:

```ts
const ToonParams = defineComponent('game/ToonParams', { bands: t.u32, rim: t.color, width: t.f32 })
const layout = wgslLayout(ToonParams)
layout.wgsl    // "struct ToonParams { bands: u32, rim: vec4f, width: f32 }"
layout.size    // bytes, with padding
layout.write(view, offset, value)
```

Supported field types: numbers, bool (as u32), vectors, quat, color, mat3/mat4 (with mat3 padding),
affine3x4 (as `array<vec4f, 3>`, rows; see 0004), enums (as u32). Object-column types are rejected (`shader/unsupported-field`). One schema then drives
the CPU value, the GPU struct, and the byte layout; they can't drift.

### Hot reload

Shader modules are loaded through the platform file system. When one changes (platform `watch`),
every cached link that includes it is invalidated and dependent pipelines rebuild asynchronously
(0005 keeps drawing with the old pipeline until the new one is ready). Compile errors during hot
reload keep the old pipeline and surface the error; they never blank the screen.

### Agent surface

- `shader.describe(root)`: the module graph, available defines, hooks and who overrides them.
- Errors point at the user's file and line.
- Engine shader modules ship with doc comments on every hook, included in generated agent docs.

## Decisions

- **WESL syntax.** A community standard with a JS linker beats inventing one.
- **Hooks as a thin extension over WESL.** Keeps the standard parts standard; the extension is one
  pre-pass we own.
- **Schema-generated structs.** Removes the classic bug class of CPU/GPU layout mismatch.
- **Old pipeline survives failed reloads.** Iterating on a shader never breaks the running game.

## Acceptance criteria

- [ ] Imports, nested imports, and import cycles (`shader/link-cycle`) work in browser and Node.
- [ ] `@if` with defines produces distinct cached variants; equal inputs hit the cache.
- [ ] An override replaces a hook; the default is callable by alias; a signature mismatch throws
      `shader/hook-signature-mismatch`.
- [ ] A WGSL compile error reports the original file, line, and column.
- [ ] `wgslLayout` matches WGSL alignment rules for every supported type, verified by compiling
      the struct and comparing offsets from a shader that writes `offsetOf`-style probes.
- [ ] Editing a shader file rebuilds dependent pipelines without dropping frames; a broken edit
      keeps the previous pipeline and reports the error.
- [ ] Decision recorded: `wesl` package adopted or replaced, with the reason.

## Open questions

- **Deferred to implementation:** the exact hook syntax (`@hook` / `override fn` as above, or a
  variant that plays better with WESL tooling). The mechanism is fixed: last override wins, the
  default stays callable by alias, signatures must match. The chosen syntax is recorded here
  when this spec is built.
