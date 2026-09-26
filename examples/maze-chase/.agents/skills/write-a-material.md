# Write a material

A material type is a schema plus a shader that overrides hooks. Lighting, shadows, and post effects
keep working because the shader only changes the surface.

1. Define it in `scripts/`:

   ```ts
   export const Lava = project.material('Lava', {
     fields: {
       crackColor: t.color({ default: [1, 0.3, 0.05, 1] }),
       crackLuminance: t.f32({ default: 20000, unit: 'cd/m²' }),
       flow: t.vec2({ default: [0.02, 0], description: 'UV scroll per second.' }),
       cracks: t.handle('Texture', { description: 'Crack mask (R).' }),
     },
     shader: 'project::lava',
   })
   ```

2. Write `shaders/lava.wesl`. The generated module `material::lava` has the uniform (`Lava`)
   and one texture and sampler per texture field (`Lava_cracks`, `Lava_cracks_sampler`):

   ```wesl
   import shard::pbr::types::{ VertexOutput, PbrInput };
   import shard::pbr::standard::standard_input;
   import shard::globals::globals;
   import material::lava::{ Lava, Lava_cracks, Lava_cracks_sampler };

   override fn pbr_input(in: VertexOutput) -> PbrInput {
     var p = standard_input(in);
     let uv = in.uv + Lava.flow * globals.time;
     let crack = textureSample(Lava_cracks, Lava_cracks_sampler, uv).r;
     p.emissive += Lava.crackColor.rgb * Lava.crackLuminance * crack;
     return p;
   }
   ```

   Hooks: `vertex_position(position, normal, uv) -> vec3f` (object-space displacement, applied in
   every pass, shadows included), `pbr_input(in) -> PbrInput` (the surface), and
   `fragment_output(color) -> vec4f` (pre-exposed HDR, before tonemapping). With
   `extends: 'none'`, override `shade(in) -> vec4f` instead: it returns radiance in cd/m² and
   alpha, and no lighting runs. `noise: { detail: 'assets/noise/rock.noise.json' }` in the
   definition adds `noise_detail(p: vec3f, seed: u32) -> f32` to `material::lava` (see
   make-a-noise-graph.md). In `vertex_position`, `shard::mesh` also gives the vertex's
   `vertex_uv1()` and `vertex_tangent()`, `vertex_world(p)` (object to world), and
   `vertex_instance_data()`: the two numbers of the entity's `render/InstanceData` (a fade,
   flags). `arrays: ['layers']` binds a texture field as `texture_2d_array` (a
   `*.texarray.json`).

3. Use it in a material file: `{ "type": "maze-chase/Lava", "crackLuminance": 30000,
   "cracks": { "path": "assets/cracks.png" } }`. Leaving out `"type"` means the standard material.
4. Check it: `shard validate --json` (bad fields are reported by path), then MCP `preview_asset`
   on the material file. Shader errors appear in `recent_errors` as `shaders/lava.wesl:line:col`,
   and the last shader that compiled keeps running.
