import { LABEL_FONT } from './gizmo-font'

/** WGSL for gizmos (gizmos.ts) and GPU picking (picking.ts). */
export const GIZMO_SHADERS: Record<string, string> = {
  'shard::gizmos::common': `
import shard::view::view;

@group(1) @binding(2) var scene_depth: texture_depth_2d;

/** Occluded parts of depth-tested gizmos draw at this opacity. */
const OCCLUDED: f32 = 0.25;

/** Opacity from the depth test: 1 in front, OCCLUDED behind, 1 when the test is off. */
fn depth_fade(frag: vec4f, no_depth: bool) -> f32 {
  if (no_depth) { return 1.0; }
  let size = textureDimensions(scene_depth);
  let p = min(vec2u(frag.xy), size - 1u);
  let scene = textureLoad(scene_depth, p, 0);
  // Reversed Z: nearer is larger.
  return select(OCCLUDED, 1.0, frag.z >= scene - 1e-6);
}

fn to_pixels(ndc: vec2f) -> vec2f {
  return (ndc * vec2f(0.5, -0.5) + 0.5) * view.viewport.xy;
}

fn to_ndc(px: vec2f) -> vec2f {
  return (px * view.viewport.zw - 0.5) * vec2f(2.0, -2.0);
}`,

  'shard::gizmos::lines': `
import shard::view::view;
import shard::gizmos::common::{ depth_fade, to_pixels, to_ndc };

struct Line {
  a: vec3f,
  b_x: f32,
  b_yz: vec2f,
  color: u32,
  bits: u32,
}

@group(1) @binding(0) var<storage, read> lines: array<Line>;

struct LineOutput {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
  /** Pixels across the line from its center (x), half width (y). */
  @location(1) across: vec2f,
  @location(2) @interpolate(flat) bits: u32,
}

/** Clip-space endpoints, the one behind the camera moved onto the near side. */
fn clip_segment(a: vec4f, b: vec4f) -> array<vec4f, 2> {
  let eps = 1e-4;
  var p = a;
  var q = b;
  if (p.w < eps) { p = mix(p, q, (eps - p.w) / (q.w - p.w)); }
  if (q.w < eps) { q = mix(q, p, (eps - q.w) / (p.w - q.w)); }
  return array<vec4f, 2>(p, q);
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> LineOutput {
  let l = lines[i];
  var out: LineOutput;
  let ca = view.viewProj * vec4f(l.a, 1.0);
  let cb = view.viewProj * vec4f(l.b_x, l.b_yz, 1.0);
  if (ca.w < 1e-4 && cb.w < 1e-4) {
    out.clip = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  let seg = clip_segment(ca, cb);
  let pa = to_pixels(seg[0].xy / seg[0].w);
  let pb = to_pixels(seg[1].xy / seg[1].w);
  var dir = pb - pa;
  let len = length(dir);
  dir = select(vec2f(1.0, 0.0), dir / len, len > 1e-6);
  let normal = vec2f(-dir.y, dir.x);
  let half_width = f32(l.bits >> 8u) / 16.0;
  // One pixel of feathering on every side.
  let extent = half_width + 1.0;
  // Corners: (end, side) for two triangles.
  let ends = array<f32, 6>(0.0, 0.0, 1.0, 1.0, 0.0, 1.0);
  let sides = array<f32, 6>(-1.0, 1.0, -1.0, -1.0, 1.0, 1.0);
  let end = ends[v];
  let side = sides[v];
  let base = select(seg[0], seg[1], end > 0.5);
  let px = select(pa, pb, end > 0.5) + normal * side * extent + dir * (end * 2.0 - 1.0) * extent;
  out.clip = vec4f(to_ndc(px) * base.w, base.z, base.w);
  out.color = unpack4x8unorm(l.color);
  out.across = vec2f(side * extent, half_width);
  out.bits = l.bits;
  return out;
}

@fragment fn fs(in: LineOutput) -> @location(0) vec4f {
  let coverage = clamp(in.across.y + 0.5 - abs(in.across.x), 0.0, 1.0);
  let a = in.color.a * coverage * depth_fade(in.clip, (in.bits & 1u) != 0u);
  if (a <= 0.0) { discard; }
  return vec4f(in.color.rgb * a, a);
}`,

  'shard::gizmos::labels': `
import shard::view::view;
import shard::gizmos::common::{ depth_fade, to_pixels, to_ndc };

struct Glyph {
  anchor: vec3f,
  offset_x: f32,
  offset_y: f32,
  _pad0: f32,
  size: vec2f,
  glyph: u32,
  color: u32,
  bits: u32,
  _pad1: u32,
}

@group(1) @binding(1) var<storage, read> glyphs: array<Glyph>;
@group(1) @binding(3) var atlas: texture_2d<f32>;

struct GlyphOutput {
  @builtin(position) clip: vec4f,
  @location(0) color: vec4f,
  /** Atlas texel (glyphs), or negative for a solid box. */
  @location(1) texel: vec2f,
  @location(2) @interpolate(flat) bits: u32,
}

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> GlyphOutput {
  let g = glyphs[i];
  var out: GlyphOutput;
  let c = view.viewProj * vec4f(g.anchor, 1.0);
  if (c.w < 1e-4) {
    out.clip = vec4f(0.0, 0.0, 2.0, 1.0);
    return out;
  }
  let corners = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  let k = corners[v];
  // Whole pixels, so glyphs sample the atlas 1:1.
  let origin = round(to_pixels(c.xy / c.w)) + vec2f(g.offset_x, g.offset_y);
  let px = origin + k * g.size;
  out.clip = vec4f(to_ndc(px) * c.w, c.z, c.w);
  out.color = unpack4x8unorm(g.color);
  if (g.glyph == 0xffffffffu) {
    out.texel = vec2f(-1.0);
  } else {
    let cell = vec2f(f32(g.glyph % ${LABEL_FONT.columns}u) * ${LABEL_FONT.cellWidth}.0, f32(g.glyph / ${LABEL_FONT.columns}u) * ${LABEL_FONT.cellHeight}.0);
    out.texel = cell + k * g.size;
  }
  out.bits = g.bits;
  return out;
}

@fragment fn fs(in: GlyphOutput) -> @location(0) vec4f {
  var coverage = 1.0;
  if (in.texel.x >= 0.0) { coverage = textureLoad(atlas, vec2u(in.texel), 0).r; }
  let a = in.color.a * coverage * depth_fade(in.clip, (in.bits & 1u) != 0u);
  if (a <= 0.0) { discard; }
  return vec4f(in.color.rgb * a, a);
}`,
}

export const PICK_SHADERS: Record<string, string> = {
  'shard::pick::types': `
struct PickOutput {
  @location(0) id: u32,
  /** World normal facing the camera, and the (reversed-Z) depth: 0 where nothing drew. */
  @location(1) normal: vec4f,
}`,

  'shard::pick': `
import shard::view::view;
import shard::mesh::{ instance_at, mesh_vertex };
import shard::pick::types::PickOutput;

struct PickVertex {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) @interpolate(flat) entity: u32,
}

@vertex fn vs(
  @builtin(instance_index) instance_index: u32,
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) uv1: vec2f,
  @location(4) tangent: vec4f,
) -> PickVertex {
  let inst = instance_at(instance_index);
  let m = mesh_vertex(inst, position, normal, uv, uv1, tangent);
  var out: PickVertex;
  // Unjittered, so positions from depth match the camera exactly.
  out.clip = view.viewProjNoJitter * vec4f(m.world_position, 1.0);
  out.normal = m.world_normal;
  out.entity = inst.entity;
  return out;
}

@fragment fn fs(in: PickVertex, @builtin(front_facing) front: bool) -> PickOutput {
  var out: PickOutput;
  out.id = in.entity;
  let n = normalize(in.normal);
  out.normal = vec4f(select(-n, n, front), in.clip.z);
  return out;
}`,
}
