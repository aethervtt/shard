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
   `*.texarray.json`). Values a system rewrites every frame (waves, contacts, a wake's points)
   go in `shard::shader_data`: `world.resource(ShaderData).reserve('star-explorer/sea', 82)` returns
   the first of 82 vec4 slots (`values[slot * 4]` to write), and the shader reads
   `shader_data[slot + i]` (`import shard::shader_data::shader_data;`), in every pass. The
   block holds 1024 vec4s for the whole game. `refraction: true` (clear water, glass) draws the
   type after the opaque scene and lets it see what's behind: `shard::refraction` gives
   `refraction_uv(in.clip)`, `refraction_color(uv, mip)` (luminance, put it in `emissive`) and
   `refraction_thickness(uv, in.world_position)` (meters to what's behind). It writes depth and
   is inked as an opaque surface; it never blends and casts no shadow.

3. Use it in a material file: `{ "type": "star-explorer/Lava", "crackLuminance": 30000,
   "cracks": { "path": "assets/cracks.png" } }`. Leaving out `"type"` means the standard material.
4. Check it: `shard validate --json` (bad fields are reported by path), then MCP `preview_asset`
   on the material file. Shader errors appear in `recent_errors` as `shaders/lava.wesl:line:col`,
   and the last shader that compiled keeps running.
