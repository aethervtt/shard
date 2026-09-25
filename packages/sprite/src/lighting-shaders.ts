/**
 * WGSL for 2D lighting: light records, tile binning, 1D polar shadow maps, and the per-fragment
 * light loop the lit sprite and tilemap variants call. Constants match lights2d.ts.
 */
export const LIGHT2D_SHADERS: Record<string, string> = {
  'shard::sprite::light2d::types': `
const TILE_PIXELS: u32 = 16u;
/** Per tile: a count, then up to 64 light indices. */
const TILE_STRIDE: u32 = 65u;
const TILE_MAX: u32 = 64u;
/** Angles per shadow row. */
const SHADOW_RES: u32 = 1024u;
/** Coarse bins per row (min and max over 32 angles each). */
const COARSE_RES: u32 = 32u;
const COARSE_SPAN: f32 = 32.0;
const TAU: f32 = 6.283185307179586;
const PI: f32 = 3.141592653589793;

struct Light2d {
  pos: vec2f,
  height: f32,
  radius: f32,
  /** Color × intensity. */
  color: vec3f,
  falloff: f32,
  /** Spot direction (unit), cos of the inner and outer half-angles; points: cos_outer < -1. */
  dir: vec2f,
  cos_inner: f32,
  cos_outer: f32,
  /** Shadow row, or -1. */
  row: i32,
  softness: f32,
  layers: u32,
  /** 1 / radius². */
  inv_r2: f32,
}

struct Lighting2dView {
  /** Ambient × intensity (rgb), 0. */
  ambient: vec4f,
  /** Lights, tiles across, tiles down, shadowed lights. */
  counts: vec4u,
  /** Occluder segments, 0, 0, 0. */
  extra: vec4u,
}

struct Segment2d {
  a: vec2f,
  b: vec2f,
  /** How far light reaches into the occluder (added to the stored distance). */
  penetration: f32,
  layers: u32,
  _pad0: u32,
  _pad1: u32,
}`,

  'shard::sprite::light2d': `
import shard::sprite::light2d::types::{ Light2d, Lighting2dView, TILE_PIXELS, TILE_STRIDE, TILE_MAX, SHADOW_RES, COARSE_RES, COARSE_SPAN, TAU, PI };

@group(3) @binding(0) var<uniform> light_view: Lighting2dView;
@group(3) @binding(1) var<storage, read> lights: array<Light2d>;
@group(3) @binding(2) var<storage, read> light_tiles: array<u32>;
@group(3) @binding(3) var<storage, read> shadow_map: array<u32>;
/** Per row, per 32 angles: the nearest and farthest occluder distance. */
@group(3) @binding(4) var<storage, read> shadow_coarse: array<vec2f>;

/** Min and max over the coarse bin holding continuous bin coordinate x. */
fn coarse_at(row: u32, x: f32) -> vec2f {
  let n = i32(COARSE_RES);
  let c = i32(floor(x / COARSE_SPAN));
  return shadow_coarse[row * COARSE_RES + u32(((c % n) + n) % n)];
}

/** Nearest occluder distance (plus penetration) in angle bin k of a shadow row. */
fn occluder_at(row: u32, k: i32) -> f32 {
  let n = i32(SHADOW_RES);
  let w = ((k % n) + n) % n;
  return bitcast<f32>(shadow_map[row + u32(w)]);
}

/** A filtered depth test at continuous bin coordinate x: blends the two nearest bins' results. */
fn lit_at(row: u32, x: f32, d: f32) -> f32 {
  let k = floor(x - 0.5);
  let a = select(0.0, 1.0, d <= occluder_at(row, i32(k)));
  let b = select(0.0, 1.0, d <= occluder_at(row, i32(k) + 1));
  return mix(a, b, x - 0.5 - k);
}

/**
 * How lit a fragment d from the light is (0..1). Hard shadows take one tap. Soft ones search
 * for blockers across the widest penumbra softness allows, then filter across a kernel whose width
 * grows with softness × (d − blocker) / blocker, so penumbras widen away from the occluder.
 */
fn shadow2d(l: Light2d, d: f32, to_frag: vec2f) -> f32 {
  let step = TAU / f32(SHADOW_RES);
  let fb = (atan2(to_frag.y, to_frag.x) + PI) / step;
  let row = u32(l.row) * SHADOW_RES;
  if (l.softness <= 0.0) {
    return select(0.0, 1.0, d <= occluder_at(row, i32(floor(fb))));
  }
  // Blocker search: 8 taps across the widest penumbra softness allows at this distance. The
  // search window spans at most three coarse bins; their min and max settle "fully lit" and "in
  // the umbra" without the taps, with the same answer the taps would give.
  let search = min(l.softness / max(d, 1e-3) / step, 32.0);
  let a = coarse_at(u32(l.row), fb - search);
  let b = coarse_at(u32(l.row), fb);
  let c = coarse_at(u32(l.row), fb + search);
  if (d <= min(a.x, min(b.x, c.x))) { return 1.0; }
  if (d > max(a.y, max(b.y, c.y))) { return 0.0; }
  var blockers = 0.0;
  var sum = 0.0;
  for (var i = 0; i < 8; i++) {
    let o = occluder_at(row, i32(floor(fb + (f32(i) / 7.0 * 2.0 - 1.0) * search)));
    if (o < d) {
      sum += o;
      blockers += 1.0;
    }
  }
  if (blockers == 0.0) { return 1.0; }
  // Every tap blocked: in the umbra.
  if (blockers == 8.0) { return 0.0; }
  let blocker = sum / blockers;
  let width = min(l.softness * (d - blocker) / max(blocker, 1e-3) / d / step, 32.0);
  var lit = 0.0;
  for (var i = 0; i < 24; i++) {
    lit += lit_at(row, fb + (f32(i) / 23.0 * 2.0 - 1.0) * width, d);
  }
  return lit / 24.0;
}

/**
 * Light reaching a fragment: ambient plus every light of its screen tile that reaches it, with
 * smooth falloff, the spot cone, N·L from the normal and the light's height (normal-mapped
 * sprites only; others get plain radial falloff), and shadows.
 */
fn light2d(frag: vec2f, world: vec2f, n: vec3f, has_normal: bool, bit: u32) -> vec3f {
  var sum = light_view.ambient.rgb;
  let tiles_x = light_view.counts.y;
  let tiles_y = light_view.counts.z;
  let tx = min(u32(max(frag.x, 0.0)) / TILE_PIXELS, tiles_x - 1u);
  let ty = min(u32(max(frag.y, 0.0)) / TILE_PIXELS, tiles_y - 1u);
  let base = (ty * tiles_x + tx) * TILE_STRIDE;
  let count = min(light_tiles[base], TILE_MAX);
  for (var k = 0u; k < count; k++) {
    let l = lights[light_tiles[base + 1u + k]];
    if ((l.layers & bit) == 0u) { continue; }
    let delta = l.pos - world;
    let q = 1.0 - dot(delta, delta) * l.inv_r2;
    if (q <= 0.0) { continue; }
    let d = length(delta);
    var att = pow(q, l.falloff);
    if (l.cos_outer > -1.5 && d > 1e-4) {
      att *= smoothstep(l.cos_outer, l.cos_inner, dot(-delta / d, l.dir));
    }
    if (has_normal) {
      att *= max(0.0, dot(n, normalize(vec3f(delta, l.height))));
    }
    if (l.row >= 0 && att > 0.0) {
      att *= shadow2d(l, d, -delta);
    }
    sum += l.color * att;
  }
  return sum;
}`,

  'shard::sprite::light2d::compute': `
import shard::sprite::light2d::types::{ Light2d, Lighting2dView, Segment2d, TILE_PIXELS, TILE_STRIDE, TILE_MAX, SHADOW_RES, COARSE_RES, TAU, PI };

@group(0) @binding(0) var<uniform> light_view: Lighting2dView;
@group(0) @binding(1) var<storage, read> lights: array<Light2d>;
/** Per light: its circle in pixels (center xy, radius), 0. */
@group(0) @binding(2) var<storage, read> circles: array<vec4f>;
@group(0) @binding(3) var<storage, read_write> light_tiles: array<u32>;
@group(0) @binding(4) var<storage, read_write> shadow_map: array<atomic<u32>>;
@group(0) @binding(5) var<storage, read> segments: array<Segment2d>;
/** The light index of each shadow row. */
@group(0) @binding(6) var<storage, read> shadowed: array<u32>;
@group(0) @binding(7) var<storage, read_write> shadow_coarse: array<vec2f>;

/** One thread per 16×16-pixel tile: the lights whose circle reaches it, up to 64. */
@compute @workgroup_size(64) fn bin(@builtin(global_invocation_id) id: vec3u) {
  let tiles_x = light_view.counts.y;
  let tiles = tiles_x * light_view.counts.z;
  let t = id.x;
  if (t >= tiles) { return; }
  let lo = vec2f(f32((t % tiles_x) * TILE_PIXELS), f32((t / tiles_x) * TILE_PIXELS));
  let hi = lo + vec2f(f32(TILE_PIXELS));
  let base = t * TILE_STRIDE;
  var n = 0u;
  for (var i = 0u; i < light_view.counts.x; i++) {
    let c = circles[i];
    let q = clamp(c.xy, lo, hi) - c.xy;
    if (dot(q, q) > c.z * c.z) { continue; }
    if (n < TILE_MAX) {
      light_tiles[base + 1u + n] = i;
    }
    n++;
  }
  // The full count (possibly over the cap) for stats; shading clamps to 64.
  light_tiles[base] = n;
}

/** Every shadow texel starts at "nothing in the way". */
@compute @workgroup_size(64) fn clear(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= light_view.counts.w * SHADOW_RES) { return; }
  atomicStore(&shadow_map[id.x], 0x7f7fffffu);
}

/**
 * One thread per (segment, shadowed light): for each angle bin the segment covers as seen from
 * the light, the distance along that bin's ray to the segment, kept with atomicMin on the
 * distance's bits (positive floats sort like their bits). Bins holding an endpoint count too, with
 * the ray clamped into the segment, so segments thinner than a bin still cast.
 */
@compute @workgroup_size(64) fn shadows(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= light_view.extra.x || id.y >= light_view.counts.w) { return; }
  let s = segments[id.x];
  let l = lights[shadowed[id.y]];
  if ((s.layers & l.layers) == 0u) { return; }
  let a = s.a - l.pos;
  let b = s.b - l.pos;
  let e = b - a;
  // Skip segments outside the light's circle.
  let len2 = dot(e, e);
  let t0 = select(0.0, clamp(-dot(a, e) / len2, 0.0, 1.0), len2 > 0.0);
  let near = a + e * t0;
  if (dot(near, near) >= l.radius * l.radius) { return; }
  let side = a.x * b.y - a.y * b.x;
  // A segment through the light (or edge-on to it) casts nothing useful.
  if (abs(side) < 1e-9) { return; }
  var start = atan2(a.y, a.x);
  var span = atan2(b.y, b.x) - start;
  if (span > PI) { span -= TAU; }
  if (span < -PI) { span += TAU; }
  if (span < 0.0) {
    start += span;
    span = -span;
  }
  let step = TAU / f32(SHADOW_RES);
  let first = i32(floor((start + PI) / step));
  let last = min(i32(floor((start + span + PI) / step)), first + i32(SHADOW_RES) - 1);
  let row = id.y * SHADOW_RES;
  let n = i32(SHADOW_RES);
  for (var k = first; k <= last; k++) {
    let theta = clamp(-PI + (f32(k) + 0.5) * step, start, start + span);
    let dir = vec2f(cos(theta), sin(theta));
    let den = dir.x * e.y - dir.y * e.x;
    if (abs(den) < 1e-12) { continue; }
    let t = (a.x * e.y - a.y * e.x) / den;
    if (t <= 0.0) { continue; }
    let w = ((k % n) + n) % n;
    atomicMin(&shadow_map[row + u32(w)], bitcast<u32>(t + s.penetration));
  }
}

/** One thread per (row, coarse bin): the min and max of its 32 angles. */
@compute @workgroup_size(64) fn coarse(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= light_view.counts.w * COARSE_RES) { return; }
  let row = id.x / COARSE_RES;
  let first = row * SHADOW_RES + (id.x % COARSE_RES) * (SHADOW_RES / COARSE_RES);
  var lo = 3.4028234e38;
  var hi = 0.0;
  for (var k = 0u; k < SHADOW_RES / COARSE_RES; k++) {
    let v = bitcast<f32>(atomicLoad(&shadow_map[first + k]));
    lo = min(lo, v);
    hi = max(hi, v);
  }
  shadow_coarse[id.x] = vec2f(lo, hi);
}`,
}
