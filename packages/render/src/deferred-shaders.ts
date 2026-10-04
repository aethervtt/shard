/** WGSL for the deferred path: G-buffer packing, the G-buffer pass, and the lighting pass. */
export const DEFERRED_SHADERS: Record<string, string> = {
  'shard::pbr::gbuffer': `
import shard::pbr::types::PbrInput;

/**
 * The G-buffer layout, in one place:
 *   gbuffer0 (rgba8unorm-srgb): base color, occlusion
 *   gbuffer1 (rgba16float): octahedral normal (xy), roughness, metallic (+2 when shadows are off)
 *   gbuffer2 (rg11b10ufloat): emissive, pre-exposed
 */
struct GBufferOutput {
  @location(0) albedo: vec4f,
  @location(1) normal: vec4f,
  @location(2) emissive: vec4f,
}

fn oct_wrap(v: vec2f) -> vec2f {
  return (1.0 - abs(v.yx)) * select(vec2f(-1.0), vec2f(1.0), v >= vec2f(0.0));
}

fn oct_encode(n: vec3f) -> vec2f {
  let p = n.xy / (abs(n.x) + abs(n.y) + abs(n.z));
  return select(p, oct_wrap(p), n.z < 0.0);
}

fn oct_decode(e: vec2f) -> vec3f {
  var n = vec3f(e, 1.0 - abs(e.x) - abs(e.y));
  let t = max(-n.z, 0.0);
  n.x += select(t, -t, n.x >= 0.0);
  n.y += select(t, -t, n.y >= 0.0);
  return normalize(n);
}

fn pack_gbuffer(p: PbrInput, receives_shadows: bool, exposure: f32) -> GBufferOutput {
  var out: GBufferOutput;
  out.albedo = vec4f(p.base_color, p.occlusion);
  out.normal = vec4f(oct_encode(p.normal), p.roughness, p.metallic + select(2.0, 0.0, receives_shadows));
  out.emissive = vec4f(p.emissive * exposure, 1.0);
  return out;
}

struct GBufferSample {
  p: PbrInput,
  receives_shadows: bool,
  /** Pre-exposed emissive. */
  emissive: vec3f,
}

fn unpack_gbuffer(albedo: vec4f, normal: vec4f, emissive: vec4f) -> GBufferSample {
  var s: GBufferSample;
  s.p.base_color = albedo.rgb;
  s.p.alpha = 1.0;
  s.p.occlusion = albedo.a;
  s.p.normal = oct_decode(normal.xy);
  s.p.roughness = normal.z;
  s.receives_shadows = normal.w < 1.5;
  s.p.metallic = select(normal.w - 2.0, normal.w, s.receives_shadows);
  s.p.emissive = vec3f(0.0);
  s.emissive = emissive.rgb;
  return s;
}`,
  'shard::pbr::gbuffer_pass': `
import shard::view::view;
import shard::pbr::types::VertexOutput;
import shard::mesh::mesh_vertex_at;
import shard::pbr::material::pbr_input;
import shard::pbr::standard::material;
import shard::pbr::gbuffer::{ GBufferOutput, pack_gbuffer };
@if(CUTAWAY) import shard::cutaway::cutaway_clip;

const FLAG_RECEIVER: u32 = 4u;

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

/** The surface stage only: what the material makes of the surface, packed for lighting. */
@fragment fn fs(in: VertexOutput) -> GBufferOutput {
  @if(CUTAWAY) cutaway_clip(in.world_position, in.clip.xy, in.flags);
  let p = pbr_input(in);
  @if(MASK) if (p.alpha < material.alphaCutoff) { discard; }
  return pack_gbuffer(p, (in.flags & FLAG_RECEIVER) != 0u, view.exposure);
}`,

  'shard::pbr::deferred_lighting': `
import shard::view::view;
import shard::pbr::gbuffer::unpack_gbuffer;
import shard::pbr::lighting::apply_lighting;

@group(1) @binding(0) var gbuffer0: texture_2d<f32>;
@group(1) @binding(1) var gbuffer1: texture_2d<f32>;
@group(1) @binding(2) var gbuffer2: texture_2d<f32>;
@group(1) @binding(3) var gbuffer_depth: texture_depth_2d;

const FLAG_RECEIVER: u32 = 4u;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}

/** One lighting evaluation per pixel: the same lighting stage the forward path runs. */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let depth = textureLoad(gbuffer_depth, px, 0);
  // Reversed-Z: 0 is the far background, left for the sky.
  if (depth <= 0.0) { discard; }
  let ndc = vec2f(frag.x * view.viewport.z * 2.0 - 1.0, 1.0 - frag.y * view.viewport.w * 2.0);
  let world = view.invViewProj * vec4f(ndc, depth, 1.0);
  let position = world.xyz / world.w;
  let s = unpack_gbuffer(textureLoad(gbuffer0, px, 0), textureLoad(gbuffer1, px, 0), textureLoad(gbuffer2, px, 0));
  let flags = select(0u, FLAG_RECEIVER, s.receives_shadows);
  let color = apply_lighting(s.p, position, frag, flags) * view.exposure + s.emissive;
  return vec4f(color, 1.0);
}`,

  'shard::debug::gbuffer': `
import shard::pbr::gbuffer::unpack_gbuffer;

@group(0) @binding(0) var gbuffer0: texture_2d<f32>;
@group(0) @binding(1) var gbuffer1: texture_2d<f32>;
@group(0) @binding(2) var gbuffer2: texture_2d<f32>;
@group(0) @binding(3) var<uniform> channel: vec4u;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}

/** A G-buffer channel as a viewable image: albedo, normal, roughness, metallic, emissive. */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let s = unpack_gbuffer(textureLoad(gbuffer0, px, 0), textureLoad(gbuffer1, px, 0), textureLoad(gbuffer2, px, 0));
  switch channel.x {
    case 0u: { return vec4f(s.p.base_color, 1.0); }
    case 1u: { return vec4f(s.p.normal * 0.5 + 0.5, 1.0); }
    case 2u: { return vec4f(vec3f(s.p.roughness), 1.0); }
    case 3u: { return vec4f(vec3f(s.p.metallic), 1.0); }
    default: { return vec4f(s.emissive / (1.0 + s.emissive), 1.0); }
  }
}`,
}
