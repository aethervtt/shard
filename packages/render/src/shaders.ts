import { defineComponent, t } from '@shard/core'
import { type ShaderLibrary, wgslLayout } from '@shard/shader'
import { StandardMaterial } from './assets'

/** Per-view uniforms. A schema, so the WGSL struct and the CPU packing come from one place. */
export const ViewUniform = defineComponent('render/ViewUniform', {
  viewProj: t.mat4,
  cameraPosition: t.vec3,
  exposure: t.f32,
  lightDirection: t.vec3,
  lightColor: t.vec3,
  ambient: t.vec3,
})

export const viewLayout = wgslLayout(ViewUniform)
export const materialLayout = wgslLayout(StandardMaterial)

/**
 * Engine shader modules. Shading is split in two, so a deferred path (M5) can reuse every material:
 * the surface stage (`shard::pbr::material`, hook `pbr_input`) produces a `PbrInput`; the lighting
 * stage (`shard::pbr::lighting`) is the only code that evaluates lights.
 */
export const ENGINE_SHADERS: Record<string, string> = {
  'shard::view': `${viewLayout.wgsl}
@group(0) @binding(0) var<uniform> view: ViewUniform;`,

  'shard::pbr::standard_material': materialLayout.wgsl,

  'shard::pbr::types': `
struct VertexOutput {
  @builtin(position) clip: vec4f,
  @location(0) world_position: vec3f,
  @location(1) world_normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  /** xyz: world tangent (zero when the mesh has none), w: bitangent sign. */
  @location(4) world_tangent: vec4f,
}

/** What a material produces; all lighting works from this. */
struct PbrInput {
  base_color: vec3f,
  alpha: f32,
  normal: vec3f,
  metallic: f32,
  roughness: f32,
  emissive: vec3f,
  occlusion: f32,
}`,

  'shard::pbr::material': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard_material::StandardMaterial;

@group(1) @binding(0) var<uniform> material: StandardMaterial;

/** Per slot: a = (offset.xy, scale.xy); b = (rotation, uv set, has texture, 0). */
struct TextureSlot { a: vec4f, b: vec4f }
struct MaterialTextures { slots: array<TextureSlot, 5> }
@group(1) @binding(1) var<uniform> material_textures: MaterialTextures;
@group(1) @binding(2) var base_color_texture: texture_2d<f32>;
@group(1) @binding(3) var metallic_roughness_texture: texture_2d<f32>;
@group(1) @binding(4) var normal_texture: texture_2d<f32>;
@group(1) @binding(5) var occlusion_texture: texture_2d<f32>;
@group(1) @binding(6) var emissive_texture: texture_2d<f32>;
@group(1) @binding(7) var base_color_sampler: sampler;
@group(1) @binding(8) var metallic_roughness_sampler: sampler;
@group(1) @binding(9) var normal_sampler: sampler;
@group(1) @binding(10) var occlusion_sampler: sampler;
@group(1) @binding(11) var emissive_sampler: sampler;

/** A slot's UVs: its UV set, then KHR_texture_transform (translation * rotation * scale). */
fn slot_uv(index: u32, in: VertexOutput) -> vec2f {
  let slot = material_textures.slots[index];
  let uv = select(in.uv, in.uv1, slot.b.y > 0.5) * slot.a.zw;
  let c = cos(slot.b.x);
  let s = sin(slot.b.x);
  // Rotation direction verified against Khronos' TextureTransformTest (arrows hit "Correct").
  return vec2f(c * uv.x + s * uv.y, -s * uv.x + c * uv.y) + slot.a.xy;
}

/** Surface stage. Override this hook to change what a surface looks like, not how it's lit. */
@hook fn pbr_input(in: VertexOutput) -> PbrInput {
  // Empty slots bind 1x1 defaults (white, flat normal), so sampling is always valid.
  let base = textureSample(base_color_texture, base_color_sampler, slot_uv(0u, in));
  let mr = textureSample(metallic_roughness_texture, metallic_roughness_sampler, slot_uv(1u, in));
  let occ = textureSample(occlusion_texture, occlusion_sampler, slot_uv(3u, in));
  let emit = textureSample(emissive_texture, emissive_sampler, slot_uv(4u, in));
  let nm = textureSample(normal_texture, normal_sampler, slot_uv(2u, in));
  var p: PbrInput;
  p.base_color = material.baseColor.rgb * base.rgb;
  p.alpha = material.baseColor.a * base.a;
  var n = normalize(in.world_normal);
  let t = in.world_tangent.xyz;
  if (material_textures.slots[2].b.z > 0.5 && dot(t, t) > 1e-8) {
    // Tangent-space normal: z rebuilt from xy, so two-channel formats (BC5, EAC RG11) work too.
    let xy = (nm.xy * 2.0 - 1.0) * material.normalScale;
    let z = sqrt(max(0.0, 1.0 - dot(xy, xy)));
    let tangent = normalize(t - n * dot(n, t));
    let bitangent = cross(n, tangent) * in.world_tangent.w;
    n = normalize(tangent * xy.x + bitangent * xy.y + n * z);
  }
  p.normal = n;
  p.metallic = material.metallic * mr.b;
  p.roughness = clamp(material.roughness * mr.g, 0.045, 1.0);
  p.emissive = material.emissive.rgb * material.emissiveLuminance * emit.rgb;
  p.occlusion = mix(1.0, occ.r, material.occlusionStrength);
  return p;
}

/** Last chance to change the final display color. */
@hook fn fragment_output(color: vec4f) -> vec4f {
  return color;
}`,

  'shard::pbr::brdf': `
const PI: f32 = 3.14159265359;

fn d_ggx(n_dot_h: f32, a: f32) -> f32 {
  let a2 = a * a;
  let d = n_dot_h * n_dot_h * (a2 - 1.0) + 1.0;
  return a2 / (PI * d * d);
}

fn v_smith_ggx_correlated(n_dot_v: f32, n_dot_l: f32, a: f32) -> f32 {
  let a2 = a * a;
  let gv = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - a2) + a2);
  let gl = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - a2) + a2);
  return 0.5 / (gv + gl);
}

fn f_schlick(f0: vec3f, v_dot_h: f32) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}`,

  'shard::pbr::lighting': `
import shard::view::view;
import shard::pbr::types::PbrInput;
import shard::pbr::brdf::{ PI, d_ggx, v_smith_ggx_correlated, f_schlick };

/** Lighting stage: the only place lights are evaluated. Returns scene-referred radiance. */
fn apply_lighting(p: PbrInput, world_position: vec3f) -> vec3f {
  let n = p.normal;
  let v = normalize(view.cameraPosition - world_position);
  let a = p.roughness * p.roughness;
  let diffuse_color = p.base_color * (1.0 - p.metallic);
  let f0 = mix(vec3f(0.04), p.base_color, p.metallic);

  let l = normalize(view.lightDirection);
  let h = normalize(v + l);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_v = max(dot(n, v), 1e-4);
  let n_dot_h = max(dot(n, h), 0.0);
  let v_dot_h = max(dot(v, h), 0.0);
  let specular = d_ggx(n_dot_h, a) * v_smith_ggx_correlated(n_dot_v, n_dot_l, a) * f_schlick(f0, v_dot_h);
  let diffuse = diffuse_color / PI;

  // Directional light: illuminance (lux) times the BRDF. Ambient: uniform sky luminance (cd/m²).
  var color = (diffuse + specular) * view.lightColor * n_dot_l;
  color += diffuse_color * view.ambient * p.occlusion;
  return color;
}`,

  'shard::pbr::tonemap': `
fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}`,

  'shard::pbr::forward': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::pbr::material::{ pbr_input, fragment_output, material };
import shard::pbr::lighting::apply_lighting;
import shard::pbr::tonemap::{ aces, linear_to_srgb };

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) row0: vec4f,
  @location(4) row1: vec4f,
  @location(5) row2: vec4f,
  @location(6) uv1: vec2f,
  @location(7) tangent: vec4f,
) -> VertexOutput {
  let p = vec4f(position, 1.0);
  let world = vec3f(dot(row0, p), dot(row1, p), dot(row2, p));
  // Normal matrix = cofactor of the 3x3 part: correct under non-uniform scale.
  let c0 = vec3f(row0.x, row1.x, row2.x);
  let c1 = vec3f(row0.y, row1.y, row2.y);
  let c2 = vec3f(row0.z, row1.z, row2.z);
  let n = normal.x * cross(c1, c2) + normal.y * cross(c2, c0) + normal.z * cross(c0, c1);
  var out: VertexOutput;
  out.clip = view.viewProj * vec4f(world, 1.0);
  out.world_position = world;
  out.world_normal = normalize(n);
  out.uv = uv;
  out.uv1 = uv1;
  let wt = c0 * tangent.x + c1 * tangent.y + c2 * tangent.z;
  out.world_tangent = vec4f(select(vec3f(0.0), normalize(wt), dot(wt, wt) > 1e-12), tangent.w);
  return out;
}

@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  let p = pbr_input(in);
  if (material.alphaMode == 1u && p.alpha < material.alphaCutoff) { discard; }
  var color = apply_lighting(p, in.world_position) + p.emissive;
  color = aces(color * view.exposure);
  @if(!SRGB_TARGET) color = linear_to_srgb(color);
  return fragment_output(vec4f(color, p.alpha));
}`,
}

export function registerEngineShaders(library: ShaderLibrary): void {
  for (const [path, source] of Object.entries(ENGINE_SHADERS))
    library.register(path, source, `engine:${path}`)
}
