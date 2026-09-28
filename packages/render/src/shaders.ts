import { defineComponent, t } from '@aethervtt/shard-core'
import { type ShaderLibrary, wgslLayout } from '@aethervtt/shard-shader'
import { StandardMaterial } from './assets'
import { CULLING_SHADERS } from './culling-shaders'

/** Per-view uniforms. A schema, so the WGSL struct and the CPU packing come from one place. */
export const ViewUniform = defineComponent('render/ViewUniform', {
  viewProj: t.mat4,
  view: t.mat4,
  invViewProj: t.mat4,
  cameraPosition: t.vec3,
  /** Scene luminance to pre-exposed HDR: what the HDR target stores. */
  exposure: t.f32,
  /** width, height, 1/width, 1/height. */
  viewport: t.vec4,
  /** Cluster slices: near, far, slices / ln(far / near), debug mode (1 clusters, 2 cascades). */
  clusterParams: t.vec4,
  /** Ambient luminance (cd/m²), linear color. */
  ambient: t.vec3,
  /** Environment: intensity (cd/m² per unit), cos and sin of its rotation, enabled (w). */
  envParams: t.vec4,
  /** viewProj without the TAA jitter, this frame and last (motion vectors). */
  viewProjNoJitter: t.mat4,
  prevViewProj: t.mat4,
  /** TAA jitter in pixels (xy), frames rendered (z). */
  jitter: t.vec4,
  /**
   * Per directional light (column i): the atmosphere's transmittance (rgb) between the camera and
   * that sun, applied to its light (spec 0044). All ones without an atmosphere.
   */
  sunTransmittance: t.mat4,
})

export const viewLayout = wgslLayout(ViewUniform)
export const materialLayout = wgslLayout(StandardMaterial)

/**
 * Engine shader modules. Shading is split in two, so every path can reuse every material: the
 * surface stage (`shard::pbr::material`, hook `pbr_input`) produces a `PbrInput`; the lighting stage
 * (`shard::pbr::lighting`) is the only code that evaluates lights. Views render pre-exposed HDR
 * (radiance × exposure); the tonemap pass turns it into display values.
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
  /** Instance flags (shard::mesh::FLAG_*). */
  @location(5) @interpolate(flat) flags: u32,
  /** Material-defined, from the vertex_extra hook (zero unless a material overrides it). */
  @location(6) extra: vec4f,
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

  'shard::mesh': `
import shard::pbr::types::VertexOutput;

/** One persistent instance slot: affine rows, batch, flags, packed visibility range, entity. */
struct Instance {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  batch: u32,
  flags: u32,
  range: u32,
  entity: u32,
}

const FLAG_VISIBLE: u32 = 1u;
const FLAG_CASTER: u32 = 2u;
const FLAG_RECEIVER: u32 = 4u;

@group(2) @binding(0) var<storage, read> instances: array<Instance>;
/** The view's culled slots; a draw's instance_index indexes this. */
@group(2) @binding(1) var<storage, read> visible: array<u32>;

/** Visible-list entries: slot in the low 28 bits, LOD level in the top 4. */
const SLOT_MASK: u32 = 0x0fffffffu;

fn instance_at(instance_index: u32) -> Instance {
  let entry = visible[instance_index];
  var inst = instances[entry & SLOT_MASK];
  // The LOD level rides in the flags' top byte, for debug views.
  inst.flags = inst.flags | ((entry >> 28u) << 24u);
  return inst;
}

fn instance_world(inst: Instance, position: vec3f) -> vec3f {
  let p = vec4f(position, 1.0);
  return vec3f(dot(inst.row0, p), dot(inst.row1, p), dot(inst.row2, p));
}

/** Last frame's transform of each slot (three affine rows), for motion vectors. */
@group(2) @binding(2) var<storage, read> previous: array<vec4f>;

/** Where an object-space position was last frame, in world space. */
fn previous_world(instance_index: u32, position: vec3f) -> vec3f {
  let slot = visible[instance_index] & SLOT_MASK;
  let p = vec4f(position, 1.0);
  return vec3f(dot(previous[slot * 3u], p), dot(previous[slot * 3u + 1u], p), dot(previous[slot * 3u + 2u], p));
}

/** The vertex mesh_vertex is processing, for vertex_position overrides (see vertex_uv1). */
var<private> mesh_current_instance: Instance;
var<private> mesh_current_uv1: vec2f;
var<private> mesh_current_tangent: vec4f;

/** In vertex_position: the vertex's second uv set. */
fn vertex_uv1() -> vec2f {
  return mesh_current_uv1;
}

/** In vertex_position: the vertex's tangent (xyz, handedness in w) after deformation. */
fn vertex_tangent() -> vec4f {
  return mesh_current_tangent;
}

/** In vertex_position: the instance's render/InstanceData (x, y). */
fn vertex_instance_data() -> vec2f {
  return unpack2x16float(mesh_current_instance.range);
}

/** In vertex_position: an object-space point in world space, by this instance's transform. */
fn vertex_world(p: vec3f) -> vec3f {
  return instance_world(mesh_current_instance, p);
}

/**
 * Object-space displacement, applied in every pass that draws the mesh (forward, depth, shadows,
 * G-buffer), so a swaying mesh's shadow sways with it. Override it in a material's shader; it can
 * read the vertex's uv1 and tangent and its world position with vertex_uv1(), vertex_tangent(),
 * and vertex_world(p).
 */
@hook fn vertex_position(position: vec3f, normal: vec3f, uv: vec2f) -> vec3f {
  return position;
}

/**
 * Anything a material's surface stage needs from its vertices beyond the standard outputs, handed
 * to it as VertexOutput.extra (interpolated). Override it next to vertex_position; it can read the
 * same accessors (vertex_uv1(), vertex_tangent(), vertex_instance_data()).
 */
@hook fn vertex_extra(position: vec3f, normal: vec3f, uv: vec2f) -> vec4f {
  return vec4f(0.0);
}

/**
 * Skinned and morphed slots (see deform.ts). Records per slot; poses hold this frame's joint
 * matrices (three affine rows each) and morph (target, weight) pairs; deform_data holds each mesh's
 * joints and weights (6 words per vertex) and morph deltas (9 floats per vertex per target).
 */
struct Deform {
  sphere: vec4f,
  joint_base: u32,
  joint_count: u32,
  skin_base: u32,
  morph_base: u32,
  vertex_count: u32,
  morph_count: u32,
  weights_base: u32,
  _pad: u32,
}

const FLAG_SKINNED: u32 = 32u;
const FLAG_MORPH: u32 = 64u;

@group(2) @binding(3) var<storage, read> deforms: array<Deform>;
@group(2) @binding(4) var<storage, read> poses: array<vec4f>;
@group(2) @binding(5) var<storage, read> deform_data: array<u32>;

struct Deformed {
  position: vec3f,
  normal: vec3f,
  tangent: vec4f,
}

fn deform_f32(i: u32) -> f32 {
  return bitcast<f32>(deform_data[i]);
}

fn deform_vec3(i: u32) -> vec3f {
  return vec3f(deform_f32(i), deform_f32(i + 1u), deform_f32(i + 2u));
}

/** Morph targets, then skinning (linear blend, 4 influences), in the mesh's object space. */
fn deform_vertex(instance_index: u32, vertex_index: u32, position: vec3f, normal: vec3f, tangent: vec4f) -> Deformed {
  var out: Deformed;
  out.position = position;
  out.normal = normal;
  out.tangent = tangent;
  let slot = visible[instance_index] & SLOT_MASK;
  let flags = instances[slot].flags;
  if ((flags & (FLAG_SKINNED | FLAG_MORPH)) == 0u) { return out; }
  let d = deforms[slot];
  if (vertex_index >= d.vertex_count) { return out; }
  for (var k = 0u; k < d.morph_count; k++) {
    let pair = poses[d.weights_base + k / 2u];
    let odd = (k & 1u) == 1u;
    let target_index = u32(select(pair.x, pair.z, odd));
    let w = select(pair.y, pair.w, odd);
    let o = d.morph_base + (target_index * d.vertex_count + vertex_index) * 9u;
    out.position += deform_vec3(o) * w;
    out.normal += deform_vec3(o + 3u) * w;
    out.tangent = vec4f(out.tangent.xyz + deform_vec3(o + 6u) * w, out.tangent.w);
  }
  if ((flags & FLAG_SKINNED) != 0u && d.joint_count > 0u) {
    let s = d.skin_base + vertex_index * 6u;
    let j01 = deform_data[s];
    let j23 = deform_data[s + 1u];
    let joints = vec4u(j01 & 0xffffu, j01 >> 16u, j23 & 0xffffu, j23 >> 16u);
    let weights = vec4f(deform_f32(s + 2u), deform_f32(s + 3u), deform_f32(s + 4u), deform_f32(s + 5u));
    var r0 = vec4f(0.0);
    var r1 = vec4f(0.0);
    var r2 = vec4f(0.0);
    for (var i = 0u; i < 4u; i++) {
      let m = d.joint_base + min(joints[i], d.joint_count - 1u) * 3u;
      r0 += poses[m] * weights[i];
      r1 += poses[m + 1u] * weights[i];
      r2 += poses[m + 2u] * weights[i];
    }
    let p = vec4f(out.position, 1.0);
    out.position = vec3f(dot(r0, p), dot(r1, p), dot(r2, p));
    out.normal = vec3f(dot(r0.xyz, out.normal), dot(r1.xyz, out.normal), dot(r2.xyz, out.normal));
    let t = out.tangent.xyz;
    out.tangent = vec4f(dot(r0.xyz, t), dot(r1.xyz, t), dot(r2.xyz, t), out.tangent.w);
  }
  return out;
}

/** Object space to world space, with normals through the cofactor (correct under any scale). */
fn mesh_vertex(inst: Instance, position: vec3f, normal: vec3f, uv: vec2f, uv1: vec2f, tangent: vec4f) -> VertexOutput {
  mesh_current_instance = inst;
  mesh_current_uv1 = uv1;
  mesh_current_tangent = tangent;
  let world = instance_world(inst, vertex_position(position, normal, uv));
  let c0 = vec3f(inst.row0.x, inst.row1.x, inst.row2.x);
  let c1 = vec3f(inst.row0.y, inst.row1.y, inst.row2.y);
  let c2 = vec3f(inst.row0.z, inst.row1.z, inst.row2.z);
  let n = normal.x * cross(c1, c2) + normal.y * cross(c2, c0) + normal.z * cross(c0, c1);
  var out: VertexOutput;
  out.world_position = world;
  out.world_normal = normalize(n);
  out.uv = uv;
  out.uv1 = uv1;
  let wt = c0 * tangent.x + c1 * tangent.y + c2 * tangent.z;
  out.world_tangent = vec4f(select(vec3f(0.0), normalize(wt), dot(wt, wt) > 1e-12), tangent.w);
  out.flags = inst.flags;
  out.extra = vertex_extra(position, normal, uv);
  return out;
}

/** mesh_vertex for a draw's vertex: deformed first when the slot is skinned or morphed. */
fn mesh_vertex_at(instance_index: u32, vertex_index: u32, position: vec3f, normal: vec3f, uv: vec2f, uv1: vec2f, tangent: vec4f) -> VertexOutput {
  let d = deform_vertex(instance_index, vertex_index, position, normal, tangent);
  return mesh_vertex(instance_at(instance_index), d.position, d.normal, uv, uv1, d.tangent);
}`,

  'shard::pbr::standard': `
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

/** What StandardMaterial makes of a surface. Material shaders call it and adjust the result. */
fn standard_input(in: VertexOutput) -> PbrInput {
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

`,

  'shard::pbr::material': `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;

/** Surface stage. Override this hook to change what a surface looks like, not how it's lit. */
@hook fn pbr_input(in: VertexOutput) -> PbrInput {
  return standard_input(in);
}

/** Last chance to change a fragment's color: pre-exposed HDR, before tonemapping. */
@hook fn fragment_output(color: vec4f) -> vec4f {
  return color;
}`,

  'shard::globals': `
struct Globals {
  /** Seconds since the app started. */
  time: f32,
  delta_time: f32,
  frame: u32,
  _pad: u32,
}

@group(0) @binding(14) var<uniform> globals: Globals;`,

  'shard::unlit::shading': `
import shard::pbr::types::VertexOutput;

/**
 * The whole fragment for materials with extends: 'none': returns scene-referred radiance (cd/m²)
 * and alpha. No lighting runs; the engine only applies exposure.
 */
@hook fn shade(in: VertexOutput) -> vec4f {
  return vec4f(1.0, 0.0, 1.0, 1.0);
}`,

  'shard::unlit::forward': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::unlit::shading::shade;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = mesh_vertex_at(instance_index, vertex_index, position, normal, uv, uv1, tangent);
  out.clip = view.viewProj * vec4f(out.world_position, 1.0);
  return out;
}

@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  let c = shade(in);
  @if(MASK) if (c.a < 0.5) { discard; }
  @if(OPAQUE) return vec4f(c.rgb * view.exposure, 1.0);
  @if(!OPAQUE) return vec4f(c.rgb * view.exposure, c.a);
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

  'shard::pbr::lights': `
/** A clustered light (point or spot). 80 bytes; packed by LightStore. */
struct Light {
  position: vec3f,
  range: f32,
  /** Color times luminous intensity (candela = lm / 4π). */
  color: vec3f,
  radius: f32,
  /** Spot axis: the direction light travels. */
  direction: vec3f,
  kind: u32,
  spot_scale: f32,
  spot_offset: f32,
  shadow: u32,
  shadow_bias: f32,
  shadow_normal_bias: f32,
  shadow_softness: f32,
  _pad0: f32,
  _pad1: f32,
}

struct DirectionalLight {
  /** Toward the light. */
  direction: vec3f,
  shadowed: u32,
  /** Color times illuminance (lux), at the top of any atmosphere. */
  color: vec3f,
  /** Sun disk angular radius (rad). */
  angular_radius: f32,
}

struct DirectionalLights {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  lights: array<DirectionalLight, 4>,
}

const LIGHT_SPOT: u32 = 1u;
const NO_SHADOW: u32 = 0xffffffffu;
const CLUSTER_X: u32 = 16u;
const CLUSTER_Y: u32 = 9u;
const CLUSTER_Z: u32 = 24u;
const CLUSTER_COUNT: u32 = 3456u;
const MAX_PER_CLUSTER: u32 = 128u;

@group(0) @binding(1) var<storage, read> lights: array<Light>;
/** counts[CLUSTER_COUNT], then MAX_PER_CLUSTER light indices per cluster. */
@group(0) @binding(2) var<storage, read> clusters: array<u32>;
@group(0) @binding(3) var<storage, read> directional: DirectionalLights;`,

  'shard::pbr::shadows': `
import shard::color::ign;

struct ShadowData {
  cascade_view_proj: array<mat4x4f, 4>,
  /** Far view depth of each cascade. */
  cascade_splits: vec4f,
  /** World size of one texel, per cascade. */
  cascade_texel: vec4f,
  /** count, bias (m), normal bias (texels), softness. */
  cascade_params: vec4f,
  /** Toward the light (xyz), enabled (w). */
  cascade_light: vec4f,
  spot_view_proj: array<mat4x4f, 8>,
  /** Position (xyz), near plane (w). */
  point_position: array<vec4f, 4>,
  point_view_proj: array<mat4x4f, 24>,
  /** Cascade map size, local map size, tan(half angle) of point faces. */
  sizes: vec4f,
  /** tan(half angle), near plane. */
  spot_params: array<vec4f, 8>,
}

@group(0) @binding(4) var<storage, read> shadows: ShadowData;
@group(0) @binding(5) var cascade_maps: texture_depth_2d_array;
@group(0) @binding(6) var spot_maps: texture_depth_2d_array;
@group(0) @binding(7) var point_maps: texture_depth_2d_array;
@group(0) @binding(8) var shadow_sampler: sampler_comparison;

const POISSON: array<vec2f, 16> = array<vec2f, 16>(
  vec2f(-0.94201624, -0.39906216), vec2f(0.94558609, -0.76890725),
  vec2f(-0.09418410, -0.92938870), vec2f(0.34495938, 0.29387760),
  vec2f(-0.91588581, 0.45771432), vec2f(-0.81544232, -0.87912464),
  vec2f(-0.38277543, 0.27676845), vec2f(0.97484398, 0.75648379),
  vec2f(0.44323325, -0.97511554), vec2f(0.53742981, -0.47373420),
  vec2f(-0.26496911, -0.41893023), vec2f(0.79197514, 0.19090188),
  vec2f(-0.24188840, 0.99706507), vec2f(-0.81409955, 0.91437590),
  vec2f(0.19984126, 0.78641367), vec2f(0.14383161, -0.14100790),
);

/**
 * Percentage-closer filtering on a comparison sampler (reversed-Z: lit where the receiver is at
 * least as close as the occluder). 3x3 bilinear taps; with softness, a Poisson disk rotated per pixel.
 */
fn pcf(map: texture_depth_2d_array, layer: i32, uv: vec2f, depth: f32, size: f32, softness: f32, frag: vec2f) -> f32 {
  let texel = 1.0 / size;
  var sum = 0.0;
  if (softness <= 0.0) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        sum += textureSampleCompareLevel(map, shadow_sampler, uv + vec2f(f32(x), f32(y)) * texel, layer, depth);
      }
    }
    return sum / 9.0;
  }
  let angle = ign(frag) * 6.2831853;
  let c = cos(angle);
  let s = sin(angle);
  let radius = (1.5 + softness) * texel;
  for (var i = 0; i < 16; i++) {
    let p = POISSON[i];
    let o = vec2f(c * p.x - s * p.y, s * p.x + c * p.y) * radius;
    sum += textureSampleCompareLevel(map, shadow_sampler, uv + o, layer, depth);
  }
  return sum / 16.0;
}

fn clip_to_uv(clip: vec4f) -> vec3f {
  let ndc = clip.xyz / clip.w;
  return vec3f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5, ndc.z);
}

fn in_unit(uv: vec2f) -> bool {
  return all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
}

/** The cascade a view depth falls in, or -1 beyond the last. */
fn cascade_index(view_depth: f32) -> i32 {
  let count = i32(shadows.cascade_params.x);
  for (var i = 0; i < count; i++) {
    if (view_depth < shadows.cascade_splits[i]) { return i; }
  }
  return -1;
}

fn directional_shadow(world: vec3f, n: vec3f, view_depth: f32, frag: vec2f) -> f32 {
  let i = cascade_index(view_depth);
  if (i < 0) { return 1.0; }
  let l = shadows.cascade_light.xyz;
  let biased = world + l * shadows.cascade_params.y + n * shadows.cascade_params.z * shadows.cascade_texel[i];
  let p = clip_to_uv(shadows.cascade_view_proj[i] * vec4f(biased, 1.0));
  if (!in_unit(p.xy)) { return 1.0; }
  return pcf(cascade_maps, i, p.xy, p.z, shadows.sizes.x, shadows.cascade_params.w, frag);
}

fn spot_shadow(index: u32, world: vec3f, n: vec3f, light_pos: vec3f, bias: f32, normal_bias: f32, softness: f32, frag: vec2f) -> f32 {
  let to_light = light_pos - world;
  let d = length(to_light);
  let texel = 2.0 * d * shadows.spot_params[index].x / shadows.sizes.y;
  let biased = world + to_light / d * bias + n * normal_bias * texel;
  let p = clip_to_uv(shadows.spot_view_proj[index] * vec4f(biased, 1.0));
  if (!in_unit(p.xy) || p.z <= 0.0) { return 1.0; }
  return pcf(spot_maps, i32(index), p.xy, p.z, shadows.sizes.y, softness, frag);
}

fn point_shadow(index: u32, world: vec3f, n: vec3f, bias: f32, normal_bias: f32, softness: f32, frag: vec2f) -> f32 {
  let light_pos = shadows.point_position[index].xyz;
  let to_light = light_pos - world;
  let d = length(to_light);
  let texel = 2.0 * d * shadows.sizes.z / shadows.sizes.y;
  let biased = world + to_light / d * bias + n * normal_bias * texel;
  // The face whose axis is the major axis of the direction from the light (+X, -X, +Y, -Y, +Z, -Z).
  let v = biased - light_pos;
  let a = abs(v);
  var face = 0u;
  if (a.x >= a.y && a.x >= a.z) { face = select(1u, 0u, v.x > 0.0); }
  else if (a.y >= a.z) { face = select(3u, 2u, v.y > 0.0); }
  else { face = select(5u, 4u, v.z > 0.0); }
  let layer = index * 6u + face;
  let p = clip_to_uv(shadows.point_view_proj[layer] * vec4f(biased, 1.0));
  return pcf(point_maps, i32(layer), p.xy, p.z, shadows.sizes.y, softness, frag);
}`,

  'shard::pbr::lighting': `
import shard::view::view;
import shard::pbr::types::PbrInput;
import shard::pbr::brdf::{ PI, d_ggx, v_smith_ggx_correlated, f_schlick };
import shard::pbr::lights::{ lights, clusters, directional, LIGHT_SPOT, NO_SHADOW, CLUSTER_X, CLUSTER_Y, CLUSTER_Z, CLUSTER_COUNT, MAX_PER_CLUSTER };
import shard::pbr::shadows::{ directional_shadow, spot_shadow, point_shadow, cascade_index };
import shard::pbr::environment::environment_light;

const FLAG_RECEIVER: u32 = 4u;

/** Screen-space ambient occlusion (Ssao), full resolution; 1×1 white without it. */
@group(0) @binding(15) var ao_texture: texture_2d<f32>;

/** The cluster of a fragment, or -1 outside the clustered depth range. */
fn cluster_of(frag_coord: vec4f, view_depth: f32) -> i32 {
  let near = view.clusterParams.x;
  let far = view.clusterParams.y;
  if (view_depth < near || view_depth > far) { return -1; }
  let tx = min(u32(frag_coord.x * view.viewport.z * f32(CLUSTER_X)), CLUSTER_X - 1u);
  let ty = min(u32(frag_coord.y * view.viewport.w * f32(CLUSTER_Y)), CLUSTER_Y - 1u);
  let tz = min(u32(max(log(view_depth / near) * view.clusterParams.z, 0.0)), CLUSTER_Z - 1u);
  return i32(tx + ty * CLUSTER_X + tz * CLUSTER_X * CLUSTER_Y);
}

/** GGX specular (scaled by spec_scale) plus Lambert diffuse for one light direction. */
fn brdf(n: vec3f, v: vec3f, l: vec3f, a: f32, diffuse_color: vec3f, f0: vec3f, spec_scale: f32) -> vec3f {
  let h = normalize(v + l);
  let n_dot_l = max(dot(n, l), 0.0);
  let n_dot_v = max(dot(n, v), 1e-4);
  let n_dot_h = max(dot(n, h), 0.0);
  let v_dot_h = max(dot(v, h), 0.0);
  let specular = d_ggx(n_dot_h, a) * v_smith_ggx_correlated(n_dot_v, n_dot_l, a) * f_schlick(f0, v_dot_h);
  return (diffuse_color / PI + specular * spec_scale) * n_dot_l;
}

/** Heat map for the cluster debug view: blue (1 light) through red (32+). */
fn heat(count: u32) -> vec3f {
  if (count == 0u) { return vec3f(0.02); }
  let t = clamp(f32(count) / 32.0, 0.0, 1.0);
  return mix(mix(vec3f(0.0, 0.2, 1.0), vec3f(0.0, 1.0, 0.2), clamp(t * 2.0, 0.0, 1.0)), vec3f(1.0, 0.1, 0.0), clamp(t * 2.0 - 1.0, 0.0, 1.0));
}

/**
 * Lighting stage: the only place lights are evaluated. Returns scene-referred radiance.
 * Directional lights (with cascaded shadows), then clustered point and spot lights, then ambient.
 */
fn apply_lighting(p: PbrInput, world_position: vec3f, frag_coord: vec4f, flags: u32) -> vec3f {
  let n = p.normal;
  let v = normalize(view.cameraPosition - world_position);
  let a = p.roughness * p.roughness;
  let diffuse_color = p.base_color * (1.0 - p.metallic);
  let f0 = mix(vec3f(0.04), p.base_color, p.metallic);
  let receives = (flags & FLAG_RECEIVER) != 0u;
  let view_depth = -(view.view * vec4f(world_position, 1.0)).z;
  var color = vec3f(0.0);

  // Directional lights: illuminance (lux) times the BRDF.
  for (var i = 0u; i < directional.count; i++) {
    let light = directional.lights[i];
    let l = normalize(light.direction);
    var shadow = 1.0;
    if (receives && light.shadowed != 0u) {
      shadow = directional_shadow(world_position, n, view_depth, frag_coord.xy);
    }
    color += brdf(n, v, l, a, diffuse_color, f0, 1.0) * light.color * view.sunTransmittance[i].rgb * shadow;
  }

  // Point and spot lights from this fragment's cluster: intensity (cd) / d² × window.
  let cluster = cluster_of(frag_coord, view_depth);
  var count = 0u;
  if (cluster >= 0) {
    count = clusters[cluster];
    let base = CLUSTER_COUNT + u32(cluster) * MAX_PER_CLUSTER;
    for (var k = 0u; k < count; k++) {
      let light = lights[clusters[base + k]];
      let to_light = light.position - world_position;
      let d2 = max(dot(to_light, to_light), 1e-4);
      let d = sqrt(d2);
      let l = to_light / d;
      let ratio = d / light.range;
      let r4 = ratio * ratio * ratio * ratio;
      let window = clamp(1.0 - r4, 0.0, 1.0);
      var attenuation = window * window / d2;
      if (light.kind == LIGHT_SPOT) {
        let cd = dot(-l, light.direction);
        let spot = clamp(cd * light.spot_scale + light.spot_offset, 0.0, 1.0);
        attenuation *= spot * spot;
      }
      if (attenuation <= 0.0) { continue; }
      if (receives && light.shadow != NO_SHADOW) {
        if (light.kind == LIGHT_SPOT) {
          attenuation *= spot_shadow(light.shadow, world_position, n, light.position, light.shadow_bias, light.shadow_normal_bias, light.shadow_softness, frag_coord.xy);
        } else {
          attenuation *= point_shadow(light.shadow, world_position, n, light.shadow_bias, light.shadow_normal_bias, light.shadow_softness, frag_coord.xy);
        }
      }
      // A spherical emitter widens the highlight (Karis' roughness modification, energy-normalized).
      let a_light = clamp(a + light.radius / (2.0 * d), 0.0, 1.0);
      let norm = (a / a_light) * (a / a_light);
      color += brdf(n, v, l, a_light, diffuse_color, f0, norm) * light.color * attenuation;
    }
  }

  // Ambient: image-based lighting from the environment, or the uniform AmbientLight (cd/m²).
  // SSAO darkens it on opaque surfaces (it measures the depth buffer, which blended ones aren't in).
  var surface = p;
  if (p.alpha >= 0.999) {
    let dims = vec2i(textureDimensions(ao_texture));
    surface.occlusion *= textureLoad(ao_texture, min(vec2i(frag_coord.xy), dims - 1), 0).r;
  }
  if (view.envParams.w > 0.5) {
    color += environment_light(surface, n, v);
  } else {
    color += diffuse_color * view.ambient * surface.occlusion;
  }

  let debug = u32(view.clusterParams.w);
  if (debug == 1u) {
    color = heat(count) / max(view.exposure, 1e-12) * 0.5;
  } else if (debug == 3u) {
    // LOD levels: 0 green, 1 yellow, 2 orange, 3+ red.
    let tints = array<vec3f, 4>(vec3f(0.2, 1.0, 0.2), vec3f(1.0, 1.0, 0.2), vec3f(1.0, 0.5, 0.1), vec3f(1.0, 0.1, 0.1));
    color = (color + vec3f(0.05) / max(view.exposure, 1e-12)) * tints[min(flags >> 24u, 3u)];
  } else if (debug == 2u) {
    let tints = array<vec3f, 5>(vec3f(1.0, 0.3, 0.3), vec3f(0.3, 1.0, 0.3), vec3f(0.3, 0.5, 1.0), vec3f(1.0, 1.0, 0.3), vec3f(0.6));
    let i = cascade_index(view_depth);
    color *= tints[select(4, i, i >= 0)];
  }
  return color;
}`,

  'shard::lighting::cluster': `
import shard::view::view;

struct ViewLight {
  /** View-space position (xyz), range (w). */
  position: vec4f,
  /** View-space spot axis (xyz), cos(outer angle), or < -1 for point lights (w). */
  axis: vec4f,
  index: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
}

struct ViewLights {
  count: u32,
  _pad0: u32,
  _pad1: u32,
  _pad2: u32,
  lights: array<ViewLight>,
}

struct ClusterAabb { min: vec4f, max: vec4f }

const CLUSTER_COUNT: u32 = 3456u;
const MAX_PER_CLUSTER: u32 = 128u;

@group(0) @binding(1) var<storage, read> view_lights: ViewLights;
@group(0) @binding(2) var<storage, read> aabbs: array<ClusterAabb>;
@group(0) @binding(3) var<storage, read_write> clusters: array<u32>;
@group(0) @binding(4) var<storage, read_write> stats: array<atomic<u32>, 4>;

/** Sphere (or cone, for spots) against a cluster's view-space box. Mirrors lightTouchesCluster. */
fn touches(bmin: vec3f, bmax: vec3f, light: ViewLight) -> bool {
  let p = light.position.xyz;
  let range = light.position.w;
  let e = clamp(p, bmin, bmax) - p;
  if (dot(e, e) > range * range) { return false; }
  let cos_outer = light.axis.w;
  if (cos_outer < -1.0) { return true; }
  let center = (bmin + bmax) * 0.5 - p;
  let half = (bmax - bmin) * 0.5;
  let radius = sqrt(dot(half, half));
  let len_sq = dot(center, center);
  let v1 = dot(center, light.axis.xyz);
  let sin_outer = sqrt(max(0.0, 1.0 - cos_outer * cos_outer));
  let closest = cos_outer * sqrt(max(0.0, len_sq - v1 * v1)) - v1 * sin_outer;
  if (closest > radius) { return false; }
  if (v1 > radius + range) { return false; }
  if (v1 < -radius) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let c = id.x;
  if (c >= CLUSTER_COUNT) { return; }
  let bmin = aabbs[c].min.xyz;
  let bmax = aabbs[c].max.xyz;
  var n = 0u;
  let base = CLUSTER_COUNT + c * MAX_PER_CLUSTER;
  for (var i = 0u; i < view_lights.count; i++) {
    let light = view_lights.lights[i];
    if (!touches(bmin, bmax, light)) { continue; }
    if (n < MAX_PER_CLUSTER) { clusters[base + n] = light.index; }
    n++;
  }
  clusters[c] = min(n, MAX_PER_CLUSTER);
  atomicMax(&stats[0], n);
  if (n > MAX_PER_CLUSTER) { atomicAdd(&stats[1], 1u); }
}`,

  'shard::pbr::shadow': `
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::pbr::material::pbr_input;
import shard::pbr::standard::material;

struct ShadowView { view_proj: mat4x4f }
@group(0) @binding(0) var<uniform> shadow_view: ShadowView;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = mesh_vertex_at(instance_index, vertex_index, position, normal, uv, uv1, tangent);
  out.clip = shadow_view.view_proj * vec4f(out.world_position, 1.0);
  return out;
}

/** Masked materials cut holes in their shadows too. */
@fragment fn fs_mask(in: VertexOutput) {
  let p = pbr_input(in);
  if (p.alpha < material.alphaCutoff) { discard; }
}`,

  'shard::color': `
fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = 1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055;
  return select(hi, lo, c <= vec3f(0.0031308));
}

fn srgb_to_linear(c: vec3f) -> vec3f {
  let lo = c / 12.92;
  let hi = pow((c + 0.055) / 1.055, vec3f(2.4));
  return select(hi, lo, c <= vec3f(0.04045));
}

fn luminance(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

/** Interleaved gradient noise (Jimenez 2014): cheap, stable per pixel. */
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}`,

  'shard::tonemap': `
/** ACES filmic, Narkowicz's fit. Punchy contrast; saturated highlights shift toward white. */
fn tonemap_aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

fn agx_contrast(x: vec3f) -> vec3f {
  // Sigmoid fit of AgX's default base contrast (Wrensch's polynomial).
  let x2 = x * x;
  let x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

/**
 * AgX (Sobotka): inset toward the achromatic axis, log2 encoding, a sigmoid, then outset. Bright
 * saturated colors desaturate gracefully instead of skewing hue. Output is display-linear.
 */
fn tonemap_agx(c: vec3f) -> vec3f {
  let inset = mat3x3f(
    0.842479062253094, 0.0423282422610123, 0.0423756549057051,
    0.0784335999999992, 0.878468636469772, 0.0784336,
    0.0792237451477643, 0.0791661274605434, 0.879142973793104,
  );
  let outset = mat3x3f(
    1.19687900512017, -0.0528968517574562, -0.0529716355144438,
    -0.0980208811401368, 1.15190312990417, -0.0980434501171241,
    -0.0990297440797205, -0.0989611768448433, 1.15107367264116,
  );
  let min_ev = -12.47393;
  let max_ev = 4.026069;
  var x = inset * c;
  x = clamp(log2(max(x, vec3f(1e-10))), vec3f(min_ev), vec3f(max_ev));
  x = (x - min_ev) / (max_ev - min_ev);
  x = agx_contrast(x);
  x = outset * x;
  // The sigmoid produces gamma-2.2 display values; linearize for the common sRGB encode.
  return clamp(pow(max(x, vec3f(0.0)), vec3f(2.2)), vec3f(0.0), vec3f(1.0));
}

/** Khronos PBR Neutral: base colors come out as authored under neutral light; highlights roll off. */
fn tonemap_pbr_neutral(color: vec3f) -> vec3f {
  let start = 0.8 - 0.04;
  let desaturation = 0.15;
  let x = min(color.r, min(color.g, color.b));
  let offset = select(0.04, x - 6.25 * x * x, x < 0.08);
  var c = color - offset;
  let peak = max(c.r, max(c.g, c.b));
  if (peak < start) { return clamp(c, vec3f(0.0), vec3f(1.0)); }
  let d = 1.0 - start;
  let new_peak = 1.0 - d * d / (peak + d - start);
  c = c * (new_peak / peak);
  let g = 1.0 - 1.0 / (desaturation * (peak - new_peak) + 1.0);
  return clamp(mix(c, vec3f(new_peak), g), vec3f(0.0), vec3f(1.0));
}

fn tonemap_reinhard(x: vec3f) -> vec3f {
  return x / (1.0 + x);
}

/** Applies a curve by index: 0 aces, 1 agx, 2 pbr-neutral, 3 reinhard, 4 none. */
fn tonemap(x: vec3f, curve: u32) -> vec3f {
  switch curve {
    case 0u: { return tonemap_aces(x); }
    case 1u: { return tonemap_agx(x); }
    case 2u: { return tonemap_pbr_neutral(x); }
    case 3u: { return tonemap_reinhard(x); }
    default: { return clamp(x, vec3f(0.0), vec3f(1.0)); }
  }
}`,

  'shard::fullscreen': `
struct FullscreenOutput {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

/** One triangle that covers the screen; uv (0,0) is the top-left. */
@vertex fn vs(@builtin(vertex_index) i: u32) -> FullscreenOutput {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: FullscreenOutput;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}`,

  'shard::pbr::forward': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::pbr::material::{ pbr_input, fragment_output };
import shard::pbr::standard::material;
import shard::pbr::lighting::apply_lighting;

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @builtin(vertex_index) vertex_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> VertexOutput {
  var out = mesh_vertex_at(instance_index, vertex_index, position, normal, uv, uv1, tangent);
  out.clip = view.viewProj * vec4f(out.world_position, 1.0);
  return out;
}

@fragment fn fs(in: VertexOutput) -> @location(0) vec4f {
  let p = pbr_input(in);
  if (material.alphaMode == 1u && p.alpha < material.alphaCutoff) { discard; }
  let color = (apply_lighting(p, in.world_position, in.clip, in.flags) + p.emissive) * view.exposure;
  // Premultiplied blending expects color × alpha; additive and alpha blend multiply in hardware.
  @if(PREMULTIPLY) return fragment_output(vec4f(color * p.alpha, p.alpha));
  // Opaque and masked surfaces cover their pixel, whatever their base color's alpha (0052).
  @if(OPAQUE) return vec4f(fragment_output(vec4f(color, p.alpha)).rgb, 1.0);
  @if(!PREMULTIPLY && !OPAQUE) return fragment_output(vec4f(color, p.alpha));
}`,

  'shard::post::depth_resolve': `
@group(0) @binding(0) var depth_ms: texture_depth_multisampled_2d;

@fragment fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  return textureLoad(depth_ms, vec2i(p.xy), 0);
}`,
  // Shared with features: sampling the environment, the display stage, gbuffer packing.
  'shard::pbr::environment': `
import shard::view::view;
import shard::pbr::types::PbrInput;

@group(0) @binding(9) var env_specular: texture_cube<f32>;
@group(0) @binding(10) var env_lut: texture_2d<f32>;
@group(0) @binding(11) var env_sampler: sampler;
/** SH9, convolved with the cosine lobe and divided by π: dot with the basis = irradiance / π. */
@group(0) @binding(12) var<storage, read> env_sh: array<vec4f, 9>;
@group(0) @binding(13) var env_source: texture_cube<f32>;

const ENV_SPECULAR_MIPS: f32 = 5.0;

/** A direction in the environment's frame: rotated by -rotation about +Y. */
fn env_rotate(d: vec3f) -> vec3f {
  let c = view.envParams.y;
  let s = view.envParams.z;
  return vec3f(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
}

/** Irradiance / π from SH9 (a luminance, in the environment's units). */
fn env_irradiance(n: vec3f) -> vec3f {
  let d = env_rotate(n);
  var e = env_sh[0].rgb * 0.282095;
  e += env_sh[1].rgb * 0.488603 * d.y;
  e += env_sh[2].rgb * 0.488603 * d.z;
  e += env_sh[3].rgb * 0.488603 * d.x;
  e += env_sh[4].rgb * 1.092548 * d.x * d.y;
  e += env_sh[5].rgb * 1.092548 * d.y * d.z;
  e += env_sh[6].rgb * 0.315392 * (3.0 * d.z * d.z - 1.0);
  e += env_sh[7].rgb * 1.092548 * d.x * d.z;
  e += env_sh[8].rgb * 0.546274 * (d.x * d.x - d.y * d.y);
  return max(e, vec3f(0.0));
}

/**
 * Split-sum image-based lighting: irradiance(n) · diffuse · (1 − F) · occlusion
 * + prefiltered(r, roughness) · (F₀·A + B), in cd/m².
 */
fn environment_light(p: PbrInput, n: vec3f, v: vec3f) -> vec3f {
  let n_dot_v = clamp(dot(n, v), 1e-4, 1.0);
  let f0 = mix(vec3f(0.04), p.base_color, p.metallic);
  let diffuse_color = p.base_color * (1.0 - p.metallic);
  // Fresnel with roughness (Lagarde): rough surfaces don't reach full grazing reflectance.
  let f = f0 + (max(vec3f(1.0 - p.roughness), f0) - f0) * pow(1.0 - n_dot_v, 5.0);
  let r = reflect(-v, n);
  let prefiltered = textureSampleLevel(env_specular, env_sampler, env_rotate(r), p.roughness * ENV_SPECULAR_MIPS).rgb;
  let ab = textureSampleLevel(env_lut, env_sampler, vec2f(n_dot_v, p.roughness), 0.0).rg;
  // Specular occlusion from ambient occlusion (Lagarde & de Rousiers).
  let ao = p.occlusion;
  let spec_ao = clamp(pow(n_dot_v + ao, exp2(-16.0 * p.roughness - 1.0)) - 1.0 + ao, 0.0, 1.0);
  let diffuse = env_irradiance(n) * diffuse_color * (vec3f(1.0) - f) * ao;
  let specular = prefiltered * (f0 * ab.x + ab.y) * spec_ao;
  return (diffuse + specular) * view.envParams.x;
}

/** The environment's own radiance toward d (the background), in cd/m². */
fn environment_background(d: vec3f) -> vec3f {
  return textureSampleLevel(env_source, env_sampler, env_rotate(d), 0.0).rgb * view.envParams.x;
}`,
  'shard::post::tonemap': `
import shard::color::{ linear_to_srgb, srgb_to_linear, ign, luminance };
import shard::tonemap::tonemap;

struct TonemapParams {
  /** curve, dither, flags (1 grading, 2 vignette, 4 LUT, 8 sRGB LUT), 0. */
  mode: vec4u,
  /** White balance as LMS scale (xyz), 0. */
  balance: vec4f,
  /** saturation, contrast, 0, 0. */
  grade: vec4f,
  lift: vec4f,
  gamma: vec4f,
  gain: vec4f,
  /** Vignette intensity, smoothness, aspect, 0. */
  vignette: vec4f,
  /** 1 / width, 1 / height of the view. */
  texel: vec4f,
}

@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var<uniform> params: TonemapParams;
@group(0) @binding(2) var lut: texture_2d<f32>;
@group(0) @binding(3) var lut_sampler: sampler;

const LIN_TO_LMS = mat3x3f(
  vec3f(3.90405e-1, 7.08416e-2, 2.31082e-2),
  vec3f(5.49941e-1, 9.63172e-1, 1.28021e-1),
  vec3f(8.92632e-3, 1.35775e-3, 9.36245e-1),
);
const LMS_TO_LIN = mat3x3f(
  vec3f(2.85847, -2.10182e-1, -4.18120e-2),
  vec3f(-1.62879, 1.15820, -1.18169e-1),
  vec3f(-2.48910e-2, 3.24281e-4, 1.06867),
);

/** White balance, contrast around mid gray, saturation, then lift/gamma/gain, in scene-linear HDR. */
fn grade(c0: vec3f) -> vec3f {
  var c = LMS_TO_LIN * ((LIN_TO_LMS * c0) * params.balance.xyz);
  c = 0.18 * pow(max(c, vec3f(0.0)) / 0.18, vec3f(params.grade.y));
  let l = luminance(c);
  c = max(mix(vec3f(l), c, params.grade.x), vec3f(0.0));
  c = pow(max(c * params.gain.xyz + params.lift.xyz, vec3f(0.0)), 1.0 / params.gamma.xyz);
  return c;
}

/** A 32³ LUT stored as a 1024×32 strip: slices of red (x) by green (y), one per blue step. */
fn apply_lut(c: vec3f) -> vec3f {
  let x = clamp(c, vec3f(0.0), vec3f(1.0)) * 31.0;
  let slice = floor(x.b);
  let f = x.b - slice;
  let uv0 = vec2f((slice * 32.0 + x.r + 0.5) / 1024.0, (x.g + 0.5) / 32.0);
  let uv1 = uv0 + vec2f(select(32.0, 0.0, slice >= 31.0) / 1024.0, 0.0);
  var a = textureSampleLevel(lut, lut_sampler, uv0, 0.0).rgb;
  var b = textureSampleLevel(lut, lut_sampler, uv1, 0.0).rgb;
  // An sRGB-format texture decoded the stored values: encode them back.
  if ((params.mode.z & 8u) != 0u) { a = linear_to_srgb(a); b = linear_to_srgb(b); }
  return mix(a, b, f);
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let texel = textureLoad(hdr, vec2i(p.xy), 0);
  var hdr_color = max(texel.rgb, vec3f(0.0));
  @if(TRANSPARENT) var alpha = 1.0;
  @if(TRANSPARENT) {
    // Premultiplied (0052): light over less coverage raises alpha, so a glow shows over the page;
    // then the color is un-premultiplied for grading and the curve, and premultiplied again below.
    alpha = clamp(max(texel.a, max(hdr_color.r, max(hdr_color.g, hdr_color.b))), 0.0, 1.0);
    hdr_color = hdr_color / max(alpha, 1e-6);
  }
  let flags = params.mode.z;
  if ((flags & 1u) != 0u) { hdr_color = grade(hdr_color); }
  if ((flags & 2u) != 0u) {
    let uv = p.xy * params.texel.xy - 0.5;
    let d = length(uv * vec2f(params.vignette.z, 1.0)) / length(vec2f(params.vignette.z, 1.0) * 0.5);
    let fall = smoothstep(1.0 - params.vignette.y, 1.0 + params.vignette.y * 0.5, d);
    hdr_color *= 1.0 - params.vignette.x * fall;
  }
  var c = linear_to_srgb(tonemap(hdr_color, params.mode.x));
  if ((flags & 4u) != 0u) { c = apply_lut(c); }
  if (params.mode.y != 0u) {
    // Triangular noise of ±1 LSB, in display space: breaks up banding in gradients.
    let n = ign(p.xy) + ign(p.xy + vec2f(71.0, 13.0)) - 1.0;
    c = c + vec3f(n / 255.0);
  }
  // The page composites in display space, so premultiply there; it keeps rgb <= alpha.
  @if(TRANSPARENT) c = clamp(c, vec3f(0.0), vec3f(1.0)) * alpha;
  // sRGB targets encode in hardware: hand them linear values.
  @if(SRGB_TARGET) c = srgb_to_linear(clamp(c, vec3f(0.0), vec3f(1.0)));
  @if(TRANSPARENT) return vec4f(c, max(alpha, max(c.r, max(c.g, c.b))));
  @if(!TRANSPARENT) return vec4f(c, 1.0);
}`,
  'shard::post::upscale': `
struct Upscale {
  /** 1 / output size (xy), sharpening (z), 0. */
  params: vec4f,
}

@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(0) @binding(2) var<uniform> upscale: Upscale;

@if(!TRANSPARENT) alias Texel = vec3f;
@if(TRANSPARENT) alias Texel = vec4f;

fn at(uv: vec2f) -> Texel {
  @if(!TRANSPARENT) return textureSampleLevel(input, input_sampler, uv, 0.0).rgb;
  @if(TRANSPARENT) return textureSampleLevel(input, input_sampler, uv, 0.0);
}

/** Opaque views write alpha 1; premultiplied ones keep rgb <= alpha after sharpening (0052). */
fn out(c: Texel) -> vec4f {
  @if(!TRANSPARENT) return vec4f(c, 1.0);
  @if(TRANSPARENT) return vec4f(c.rgb, max(c.a, max(c.r, max(c.g, c.b))));
}

/**
 * The render-resolution image onto the display (0051): bilinear, then an unsharp mask over the
 * four neighbors one source texel away, clamped to their range so edges can't ring.
 */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let uv = frag.xy * upscale.params.xy;
  let c = at(uv);
  let k = upscale.params.z;
  if (k <= 0.0) { return out(c); }
  let texel = 1.0 / vec2f(textureDimensions(input));
  let n = at(uv + vec2f(0.0, -texel.y));
  let s = at(uv + vec2f(0.0, texel.y));
  let e = at(uv + vec2f(texel.x, 0.0));
  let w = at(uv + vec2f(-texel.x, 0.0));
  let lo = min(c, min(min(n, s), min(e, w)));
  let hi = max(c, max(max(n, s), max(e, w)));
  let sharp = c + (4.0 * c - (n + s + e + w)) * (0.25 * k);
  return out(clamp(sharp, lo, hi));
}`,
  'shard::post::common': `
import shard::view::view;

/** A pixel's uv from its fragment coordinate. */
fn uv_of(frag: vec2f) -> vec2f {
  return frag * view.viewport.zw;
}

/** World position of a uv at a (reversed-Z) depth. Depth 0 is infinitely far: pass a floor. */
fn world_at(uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let w = view.invViewProj * vec4f(ndc, depth, 1.0);
  return w.xyz / w.w;
}

/** Distance along the view axis, in meters. */
fn view_depth(world: vec3f) -> f32 {
  return -(view.view * vec4f(world, 1.0)).z;
}

/**
 * Screen motion of a pixel in uv units: the prepass's value for geometry, the camera's own
 * rotation for the background (depth 0), which the prepass leaves empty.
 */
fn motion(uv: vec2f, depth: f32, stored: vec2f) -> vec2f {
  if (depth > 0.0) { return stored; }
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let dir = (view.invViewProj * vec4f(ndc, 0.0, 1.0)).xyz;
  let now = view.viewProjNoJitter * vec4f(dir, 0.0);
  let before = view.prevViewProj * vec4f(dir, 0.0);
  return (now.xy / now.w - before.xy / before.w) * vec2f(0.5, -0.5);
}`,
}

/** Registers a group of engine WGSL modules. Each render feature registers its own. */
export function registerShaders(library: ShaderLibrary, modules: Record<string, string>): void {
  for (const [path, source] of Object.entries(modules))
    library.register(path, source, `engine:${path}`)
}

/** Core render's WGSL. Features (atmosphere, post, deferred, ...) register theirs in their plugins. */
export function registerEngineShaders(library: ShaderLibrary): void {
  registerShaders(library, ENGINE_SHADERS)
  registerShaders(library, CULLING_SHADERS)
}
