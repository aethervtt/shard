import { LIGHT2D_SHADERS } from './lighting-shaders'

/** WGSL for sprites and tilemaps (see render.ts), and 2D lighting (see lights2d.ts). */
export const SPRITE_SHADERS: Record<string, string> = {
  ...LIGHT2D_SHADERS,
  'shard::sprite::common': `
import shard::color::linear_to_srgb;
@if(LIT) import shard::sprite::light2d::light2d;

struct SpriteView {
  view_proj: mat4x4f,
  /** width, height, 1 / width, 1 / height. */
  viewport: vec4f,
  /** Texel snap (pixels per unit, 0: off), 0, 0, 0. */
  snap: vec4f,
}

struct Batch {
  /** 1 when the texture is already premultiplied. */
  premultiplied: u32,
  /** 0 alpha, 1 additive, 2 opaque. */
  blend: u32,
  _pad0: u32,
  _pad1: u32,
}

@group(0) @binding(0) var<uniform> sprite_view: SpriteView;
@group(2) @binding(0) var sprite_texture: texture_2d<f32>;
@group(2) @binding(1) var sprite_sampler: sampler;
@group(2) @binding(2) var<uniform> batch: Batch;
/** Lit views: the batch's normal map (a flat 1×1 when it has none). */
@if(LIT) @group(2) @binding(3) var normal_texture: texture_2d<f32>;

struct SpriteOutput {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) color: vec4f,
  /** Picking: the entity and the world normal (the sprite's +Z). */
  @location(2) @interpolate(flat) entity: u32,
  @location(3) normal: vec3f,
  /** Lit views: world XY, and where the normal map's +X and +Y point in world XY. */
  @if(LIT) @location(4) world: vec2f,
  @if(LIT) @location(5) basis: vec4f,
  /** Lit views: flags (1 lit, 2 normal map, light-layer band << 8), emissive and normal strength (f16 × 2). */
  @if(LIT) @location(6) @interpolate(flat) light: vec2u,
}

/** Corner k (0..5) of a quad as two triangles: (0,0) top left to (1,1) bottom right. */
fn corner(k: u32) -> vec2f {
  let c = array<vec2f, 6>(vec2f(0.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 0.0), vec2f(1.0, 0.0), vec2f(0.0, 1.0), vec2f(1.0, 1.0));
  return c[k];
}

/** Unpacks RGBA8 (straight) and premultiplies, so tints compose with premultiplied texels. */
fn unpack_color(packed: u32) -> vec4f {
  let c = unpack4x8unorm(packed);
  return vec4f(c.rgb * c.a, c.a);
}

/** The shaded texel, premultiplied. */
fn shade(uv: vec2f, tint: vec4f) -> vec4f {
  var t = textureSample(sprite_texture, sprite_sampler, uv);
  if (batch.premultiplied == 0u) { t = vec4f(t.rgb * t.a, t.a); }
  return t * tint;
}

/** The batch's normal map at uv, in tangent space (+Y up). Sample before any branching. */
@if(LIT)
fn sample_normal(uv: vec2f) -> vec3f {
  return textureSample(normal_texture, sprite_sampler, uv).xyz * 2.0 - 1.0;
}

/** Premultiplied color lit by the view's 2D lights (unlit sprites pass through). */
@if(LIT)
fn apply_light2d(in: SpriteOutput, c: vec4f, tangent: vec3f) -> vec4f {
  let flags = in.light.x;
  // Unlit sprites, and texels nothing shows through, skip the light loop.
  if ((flags & 1u) == 0u || c.a <= 0.0) { return c; }
  let extra = unpack2x16float(in.light.y);
  let has_normal = (flags & 2u) != 0u;
  var n = vec3f(0.0, 0.0, 1.0);
  if (has_normal) {
    let t = vec3f(tangent.xy * extra.y, tangent.z);
    n = normalize(vec3f(t.x * in.basis.xy + t.y * in.basis.zw, t.z));
  }
  let light = light2d(in.clip.xy, in.world, n, has_normal, 1u << ((flags >> 8u) & 31u));
  return vec4f(c.rgb * (light + extra.x), c.a);
}

/** Display targets without hardware sRGB encoding get it here. */
fn encode(c: vec4f) -> vec4f {
  @if(SRGB_TARGET) return c;
  @if(!SRGB_TARGET) {
    // Unpremultiply, encode, premultiply again: blending happens in display space here.
    let rgb = select(vec3f(0.0), c.rgb / c.a, c.a > 0.0);
    return vec4f(linear_to_srgb(rgb) * c.a, c.a);
  }
}`,

  'shard::sprite': `
import shard::sprite::common::{ SpriteOutput, sprite_view, batch, corner, unpack_color, shade, encode };
@if(LIT) import shard::sprite::common::{ sample_normal, apply_light2d };
import shard::pick::types::PickOutput;

/** One sprite: affine rows, uv rect, size, anchor, packed color. */
struct SpriteRecord {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  uv: vec4f,
  size: vec2f,
  anchor: vec2f,
  color: u32,
  flags: u32,
  entity: u32,
  _pad1: u32,
}

@data @group(1) @binding(0) var<storage, read> sprites: array<SpriteRecord>;
@data @group(1) @binding(1) var<storage, read> order: array<u32>;

@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> SpriteOutput {
  let s = sprites[order[i]];
  let c = corner(v);
  // Local space: x right, y up, the anchor at the origin.
  let local = vec4f((c.x - s.anchor.x) * s.size.x, (s.anchor.y - c.y) * s.size.y, 0.0, 1.0);
  var world = vec3f(dot(s.row0, local), dot(s.row1, local), dot(s.row2, local));
  if (sprite_view.snap.x > 0.0) {
    // Pixel-perfect: positions land on the texel grid.
    world = vec3f(round(world.xy * sprite_view.snap.x) / sprite_view.snap.x, world.z);
  }
  var out: SpriteOutput;
  @if(SCREEN) {
    // Screen space: pixels from the top left, y down.
    let px = vec2f(world.x, -world.y);
    out.clip = vec4f(px.x * sprite_view.viewport.z * 2.0 - 1.0, 1.0 - px.y * sprite_view.viewport.w * 2.0, 0.5, 1.0);
  }
  @if(!SCREEN) {
    out.clip = sprite_view.view_proj * vec4f(world, 1.0);
  }
  out.uv = mix(s.uv.xy, s.uv.zw, c);
  out.color = unpack_color(s.color);
  out.entity = s.entity;
  out.normal = vec3f(s.row0.z, s.row1.z, s.row2.z);
  @if(LIT) {
    out.world = world.xy;
    // Flips swap the uv rect's ends; the normal map's axes turn with them.
    let fx = select(1.0, -1.0, s.uv.x > s.uv.z);
    let fy = select(1.0, -1.0, s.uv.y > s.uv.w);
    let ax = vec2f(s.row0.x, s.row1.x);
    let ay = vec2f(s.row0.y, s.row1.y);
    out.basis = vec4f(ax / max(length(ax), 1e-8) * fx, ay / max(length(ay), 1e-8) * fy);
    out.light = vec2u(s.flags, s._pad1);
  }
  return out;
}

@fragment fn fs_pick(in: SpriteOutput, @builtin(front_facing) front: bool) -> PickOutput {
  let c = shade(in.uv, in.color);
  if (c.a < 0.5) { discard; }
  var out: PickOutput;
  out.id = in.entity;
  let n = normalize(in.normal);
  out.normal = vec4f(select(-n, n, front), in.clip.z);
  return out;
}

@fragment fn fs(in: SpriteOutput) -> @location(0) vec4f {
  var c = shade(in.uv, in.color);
  @if(LIT) {
    let tangent = sample_normal(in.uv);
    c = apply_light2d(in, c, tangent);
  }
  if (batch.blend == 2u) {
    if (c.a < 0.5) { discard; }
    c = vec4f(c.rgb / c.a, 1.0);
  }
  @if(SCREEN) { c = encode(c); }
  return c;
}`,

  'shard::tilemap': `
import shard::sprite::common::{ SpriteOutput, sprite_view, corner, shade };
@if(LIT) import shard::sprite::common::{ sample_normal, apply_light2d };

struct TilemapParams {
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  /** Tile size (world, xy), layer width and height in tiles (zw). */
  tile: vec4f,
  /** Chunk size, chunks across, light flags (1 lit, 2 normal map, band << 8), 0. */
  chunks: vec4u,
}

@data @group(1) @binding(0) var<storage, read> tiles: array<u32>;
@data @group(1) @binding(1) var<storage, read> visible_chunks: array<u32>;
@data @group(1) @binding(2) var<storage, read> regions: array<vec4f>;
@data @group(1) @binding(3) var<storage, read> remap: array<u32>;
@group(1) @binding(4) var<uniform> map: TilemapParams;

/**
 * One tile per instance: instance / chunk² picks the visible chunk (first_instance offsets into
 * this draw's list), the remainder the tile in it. Empty tiles collapse to nothing.
 */
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> SpriteOutput {
  let cs = map.chunks.x;
  let per = cs * cs;
  let chunk = visible_chunks[i / per];
  let local = i % per;
  let cx = chunk % map.chunks.y;
  let cy = chunk / map.chunks.y;
  let tx = cx * cs + local % cs;
  let ty = cy * cs + local / cs;
  var out: SpriteOutput;
  out.color = vec4f(1.0);
  let value = tiles[chunk * per + local];
  let raw = value & 0xffffu;
  if (raw == 0u || f32(tx) >= map.tile.z || f32(ty) >= map.tile.w) {
    out.clip = vec4f(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let tile = remap[min(raw, arrayLength(&remap) - 1u)];
  // A palette name the atlas lacks resolves to 0: nothing to draw.
  if (tile == 0u) {
    out.clip = vec4f(0.0, 0.0, 0.0, 0.0);
    return out;
  }
  let flags = value >> 16u;
  let c = corner(v);
  // Tile (x, y) covers [x, x + 1] × [-y - 1, -y] in tile units.
  let p = vec4f((f32(tx) + c.x) * map.tile.x, -(f32(ty) + c.y) * map.tile.y, 0.0, 1.0);
  let world = vec3f(dot(map.row0, p), dot(map.row1, p), dot(map.row2, p));
  out.clip = sprite_view.view_proj * vec4f(world, 1.0);
  var t = c;
  if ((flags & 4u) != 0u) { t = vec2f(t.y, 1.0 - t.x); }
  if ((flags & 1u) != 0u) { t.x = 1.0 - t.x; }
  if ((flags & 2u) != 0u) { t.y = 1.0 - t.y; }
  let r = regions[tile - 1u];
  out.uv = mix(r.xy, r.zw, t);
  @if(LIT) {
    out.world = world.xy;
    // The tile's uv transform m (quad → texture, y down), inverted (it's orthogonal) to turn the
    // normal map's axes back into the map's local X and Y.
    var m = mat2x2f(1.0, 0.0, 0.0, 1.0);
    if ((flags & 4u) != 0u) { m = mat2x2f(0.0, -1.0, 1.0, 0.0) * m; }
    if ((flags & 1u) != 0u) { m = mat2x2f(-1.0, 0.0, 0.0, 1.0) * m; }
    if ((flags & 2u) != 0u) { m = mat2x2f(1.0, 0.0, 0.0, -1.0) * m; }
    let a = vec2f(m[0].x, m[1].x);
    let b = vec2f(m[0].y, m[1].y);
    let mx = vec2f(map.row0.x, map.row1.x);
    let my = vec2f(map.row0.y, map.row1.y);
    let lx = mx / max(length(mx), 1e-8);
    let ly = my / max(length(my), 1e-8);
    out.basis = vec4f(a.x * lx - a.y * ly, -b.x * lx + b.y * ly);
    out.light = vec2u(map.chunks.z, pack2x16float(vec2f(0.0, 1.0)));
  }
  return out;
}

@fragment fn fs(in: SpriteOutput) -> @location(0) vec4f {
  var c = shade(in.uv, in.color);
  @if(LIT) {
    let tangent = sample_normal(in.uv);
    c = apply_light2d(in, c, tangent);
  }
  return c;
}`,
}
