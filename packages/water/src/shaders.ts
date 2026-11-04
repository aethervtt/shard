import { MAX_WATER_BODIES } from './bodies'

// WGSL for the water (0097 part 1): the info texture's raster (`water::info`), and the surface
// (`water::surface`): camera-centred rings that read their height from the info texture, shaded
// completely in the water pass with the forward view group (lights, shadows, environment, wind).

/** Clipmap levels of the info texture, and texels per side of each. */
export const INFO_LEVELS = 4
export const INFO_SIZE = 256
/** Metres per texel of level 0; each level is four times the last (4, 16, 64, 256 m). */
export const INFO_TEXEL = 4
/** Surface height where there's no water, and ground height where none is known. */
export const NO_WATER = -1e9
export const NO_GROUND = -1e9

/** Cells per side of a surface ring, and of the hole each ring leaves for the one inside it. */
export const RING_CELLS = 64
/** Rings at most, each twice the scale of the one inside it. */
export const MAX_RINGS = 16
/** Where a ring starts morphing toward the next ring's grid (fraction of its half width). */
export const MORPH_START = 0.6
/** How far the ocean's outermost ring reaches (m): past any view distance that matters. */
export const HORIZON = 1e6

/** vec4s of the water uniform: rings (2 each), levels, params, bodies (4 each). */
export const WATER_UNIFORM_VEC4S = MAX_RINGS * 2 + INFO_LEVELS + 4 + MAX_WATER_BODIES * 4

const COMMON = `
const NO_WATER: f32 = ${NO_WATER.toExponential()};
const NO_GROUND: f32 = ${NO_GROUND.toExponential()};
const WET: f32 = ${(NO_WATER / 2).toExponential()};
const LEVELS: u32 = ${INFO_LEVELS}u;
const SIZE: i32 = ${INFO_SIZE};
`

export const WATER_SHADERS: Record<string, string> = {
  'water::info': `${COMMON}
struct InfoLevel {
  /** First texel's world x and z (its corner), metres per texel, the level. */
  origin: vec4f,
  /** The ground texture's toroidal offset of texel (0, 0): origin cell mod SIZE (xy). */
  wrap: vec4f,
}

@group(0) @binding(0) var<uniform> level: InfoLevel;
@group(0) @binding(1) var ground: texture_2d_array<f32>;

struct InfoOut {
  @location(0) info: vec4f,
  @location(1) body: vec4f,
}

/** A level's first draw: no water anywhere, and the ground (filled on the CPU, toroidally addressed). */
@fragment fn ground_copy(@builtin(position) p: vec4f) -> InfoOut {
  let t = vec2i(p.xy);
  let w = vec2i(level.wrap.xy);
  let g = vec2i((t.x + w.x) % SIZE, (t.y + w.y) % SIZE);
  var out: InfoOut;
  out.info = vec4f(NO_WATER, textureLoad(ground, g, i32(level.origin.w), 0).r, 0.0, 0.0);
  out.body = vec4f(0.0);
  return out;
}

struct BodyVertex {
  @builtin(position) clip: vec4f,
  @location(0) @interpolate(flat) value: vec2f,
}

/** A body's triangles (world x, z; its level and draw slot), over the level's square. */
@vertex fn body_vs(@location(0) xz: vec2f, @location(1) value: vec2f) -> BodyVertex {
  let extent = level.origin.z * f32(SIZE);
  let uv = (xz - level.origin.xy) / extent;
  var out: BodyVertex;
  // Texel rows run along +z: row 0 at the level's min z, the top of the target.
  out.clip = vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, 0.5, 1.0);
  out.value = value;
  return out;
}

@fragment fn body_fs(in: BodyVertex) -> InfoOut {
  var out: InfoOut;
  out.info = vec4f(in.value.x, 0.0, 0.0, 0.0);
  out.body = vec4f((in.value.y + 1.0) / 255.0, 0.0, 0.0, 0.0);
  return out;
}`,

  'water::surface': `
import shard::view::view;
import shard::pbr::brdf::{ PI, d_ggx, v_smith_ggx_correlated };
import shard::pbr::lights::directional;
import shard::pbr::shadows::directional_shadow;
import shard::pbr::environment::{ env_specular, env_sampler, env_rotate, env_irradiance, ENV_SPECULAR_MIPS };
import shard::wind::{ wind_at, wind_time };
${COMMON}
const RINGS: u32 = ${MAX_RINGS}u;
const BODIES: u32 = ${MAX_WATER_BODIES}u;
const MORPH_START: f32 = ${MORPH_START};
const HORIZON: f32 = ${HORIZON.toExponential()};
/** Fresnel at normal incidence for water (n = 1.333): ((1 − n) / (1 + n))². */
const F0: f32 = 0.0204;
/** Metres of water over which the surface fades in from the shore. */
const SHORE_FADE: f32 = 0.35;
/** Screen-space refraction offset per unit of normal tilt (uv). */
const REFRACTION: f32 = 0.06;
/** Water thickness reported for sky behind the surface (m). */
const DEEP: f32 = 1.0e4;

struct Ring {
  /** World x, z of its centre; metres per cell; whether it's the last ring (horizon). */
  a: vec4f,
  /** The info level it reads (by its cell size), unused. */
  b: vec4f,
}

struct Level {
  /** First texel's corner (world x, z), metres per texel, texels per metre. */
  origin: vec4f,
}

struct BodyOptics {
  /** Absorption per metre (rgb), phase g (w). */
  absorption: vec4f,
  /** Scattering per metre (rgb), roughness (w). */
  scattering: vec4f,
  /** Own wind velocity (xyz, m/s); w 1 with its own wind, 0 for the global wind. */
  wind: vec4f,
  /** Ripple strength (x), level (y). */
  params: vec4f,
}

struct Water {
  rings: array<Ring, ${MAX_RINGS}>,
  levels: array<Level, ${INFO_LEVELS}>,
  /** The far surface (an unbounded ocean's level, or NO_WATER), dry vertices' height, ring cells, the far body. */
  params: vec4f,
  /** Mips of the opaque copy (x; baseline has no textureNumLevels). */
  params2: vec4f,
  params3: vec4f,
  params4: vec4f,
  bodies: array<BodyOptics, ${MAX_WATER_BODIES}>,
}

@group(1) @binding(0) var<uniform> water: Water;
@group(1) @binding(1) var info: texture_2d_array<f32>;
@group(1) @binding(2) var body_index: texture_2d_array<f32>;
@group(1) @binding(3) var opaque_color: texture_2d<f32>;
@group(1) @binding(4) var opaque_depth: texture_2d<f32>;
@group(1) @binding(5) var ripple_map: texture_2d<f32>;
@group(1) @binding(6) var repeat_sampler: sampler;
@group(1) @binding(7) var clamp_sampler: sampler;

struct SurfaceOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
}

/** The finest info level whose square holds xz with a texel and a half to spare, or LEVELS. */
fn level_of(xz: vec2f, first: u32) -> u32 {
  for (var l = first; l < LEVELS; l++) {
    let o = water.levels[l].origin;
    let t = (xz - o.xy) * o.w;
    if (all(t >= vec2f(1.5)) && all(t <= vec2f(f32(SIZE) - 1.5))) { return l; }
  }
  return LEVELS;
}

fn texel(l: u32, t: vec2i) -> vec4f {
  return textureLoad(info, clamp(t, vec2i(0), vec2i(SIZE - 1)), i32(l), 0);
}

/**
 * A vertex's surface height (x), whether water is near (y, 1 or 0), and ground (z): the wet texels
 * of the four nearest, bilinear; else, so dry vertices next to the water keep its level, any wet
 * texel of the 4×4 around.
 */
fn vertex_surface(xz: vec2f, l: u32) -> vec3f {
  if (l >= LEVELS) {
    return vec3f(water.params.x, select(0.0, 1.0, water.params.x > WET), NO_GROUND);
  }
  let o = water.levels[l].origin;
  let uv = (xz - o.xy) * o.w - 0.5;
  let base = vec2i(floor(uv));
  let f = uv - floor(uv);
  var h = 0.0;
  var hw = 0.0;
  var g = 0.0;
  var gw = 0.0;
  for (var k = 0; k < 4; k++) {
    let d = vec2i(k & 1, k >> 1);
    let w = mix(1.0 - f.x, f.x, f32(d.x)) * mix(1.0 - f.y, f.y, f32(d.y));
    let t = texel(l, base + d);
    if (t.x > WET) { h += t.x * w; hw += w; }
    if (t.y > WET) { g += t.y * w; gw += w; }
  }
  let ground = select(NO_GROUND, g / max(gw, 1e-6), gw > 0.0);
  if (hw > 0.0) { return vec3f(h / hw, 1.0, ground); }
  var n = 0.0;
  for (var y = -1; y <= 2; y++) {
    for (var x = -1; x <= 2; x++) {
      let t = texel(l, base + vec2i(x, y));
      if (t.x > WET) { h += t.x; n += 1.0; }
    }
  }
  if (n > 0.0) { return vec3f(h / n, 1.0, ground); }
  return vec3f(0.0, 0.0, ground);
}

@vertex fn vs(@builtin(instance_index) ring_index: u32, @location(0) grid: vec2f) -> SurfaceOut {
  let ring = water.rings[ring_index];
  let half = water.params.z * 0.5;
  let s = ring.a.z;
  let local = grid - vec2f(half);
  var xz = ring.a.xy + local * s;
  // Toward the outer edge, odd vertices slide onto their even neighbours: the next ring's grid.
  let d = max(abs(local.x), abs(local.y)) / half;
  let m = clamp((d - MORPH_START) / (1.0 - MORPH_START), 0.0, 1.0);
  xz -= fract(grid * 0.5) * 2.0 * s * m;
  if (ring.a.w > 0.5 && d >= 0.999) {
    // The ocean's last ring runs to the horizon.
    xz = ring.a.xy + local * (HORIZON / (half * s));
  }
  let l = level_of(xz, u32(ring.b.x));
  let surface = vertex_surface(xz, l);
  var y = surface.x;
  if (surface.y < 0.5) {
    // Dry: below the ground (or the lowest water), where the depth test and discard hide it.
    y = water.params.y;
    if (surface.z > WET) { y = min(y, surface.z - 2.0); }
  }
  var out: SurfaceOut;
  out.world = vec3f(xz.x, y, xz.y);
  out.clip = view.viewProj * vec4f(out.world, 1.0);
  return out;
}

/** The body texel (t) of level l: its draw slot, or -1 where dry. */
fn body_at(l: u32, t: vec2i) -> i32 {
  let v = textureLoad(body_index, clamp(t, vec2i(0), vec2i(SIZE - 1)), i32(l), 0).r;
  return i32(round(v * 255.0)) - 1;
}

/** Where a fragment is: how wet (bilinear, 0..1), and its optics blended over the wet texels. */
struct Here {
  wet: f32,
  body: BodyOptics,
}

fn here(xz: vec2f) -> Here {
  var out: Here;
  let l = level_of(xz, 0u);
  if (l >= LEVELS) {
    out.wet = select(0.0, 1.0, water.params.x > WET);
    out.body = water.bodies[min(u32(max(water.params.w, 0.0)), BODIES - 1u)];
    return out;
  }
  let o = water.levels[l].origin;
  let uv = (xz - o.xy) * o.w - 0.5;
  let base = vec2i(floor(uv));
  let f = uv - floor(uv);
  var wet = 0.0;
  var sum = 0.0;
  var b: BodyOptics;
  b.absorption = vec4f(0.0);
  b.scattering = vec4f(0.0);
  b.wind = vec4f(0.0);
  b.params = vec4f(0.0);
  for (var k = 0; k < 4; k++) {
    let d = vec2i(k & 1, k >> 1);
    let w = mix(1.0 - f.x, f.x, f32(d.x)) * mix(1.0 - f.y, f.y, f32(d.y));
    let i = body_at(l, base + d);
    if (i >= 0) {
      let o2 = water.bodies[min(u32(i), BODIES - 1u)];
      wet += w;
      b.absorption += o2.absorption * w;
      b.scattering += o2.scattering * w;
      b.wind += o2.wind * w;
      b.params += o2.params * w;
      sum += w;
    }
  }
  let inv = 1.0 / max(sum, 1e-6);
  b.absorption *= inv;
  b.scattering *= inv;
  b.wind *= inv;
  b.params *= inv;
  out.wet = wet;
  out.body = b;
  return out;
}

fn unproject(uv: vec2f, depth: f32) -> vec3f {
  let h = view.invViewProj * vec4f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0, depth, 1.0);
  return h.xyz / h.w;
}

/** Water along the view ray from the surface point to what the opaque copy has at uv. */
fn thickness(uv: vec2f, depth: f32, surface: vec3f) -> f32 {
  if (depth <= 0.0) { return DEEP; }
  return distance(unproject(uv, depth), surface);
}

fn opaque_depth_at(uv: vec2f) -> f32 {
  let size = vec2i(textureDimensions(opaque_depth));
  let p = clamp(vec2i(uv * vec2f(size)), vec2i(0), size - 1);
  return textureLoad(opaque_depth, p, 0).r;
}

/**
 * Whether what the opaque copy has at uv (its depth d) can be seen through the water: behind the
 * surface point (reversed-Z depth z) and below the surface (height h). Sky is above it. Depth alone
 * isn't enough: something floating over the water can be behind the surface point and still above
 * it.
 */
fn submerged(uv: vec2f, d: f32, z: f32, h: f32) -> bool {
  if (d <= 0.0 || d > z) { return false; }
  return unproject(uv, d).y <= h + 0.01;
}

/** Whether every full-resolution pixel under half-resolution texel t of the copy is submerged. */
fn texel_submerged(t: vec2i, z: f32, h: f32) -> bool {
  let size = vec2i(textureDimensions(opaque_depth));
  let p = t * 2;
  for (var k = 0; k < 4; k++) {
    let q = clamp(p + vec2i(k & 1, k >> 1), vec2i(0), size - 1);
    let uv = (vec2f(q) + 0.5) / vec2f(size);
    if (!submerged(uv, textureLoad(opaque_depth, q, 0).r, z, h)) { return false; }
  }
  return true;
}

/**
 * The opaque copy at uv, from what's under the water (surface depth z, height h) only. A mip's
 * footprint that reaches anything else falls back to mip 0, whose texels are weighed by whether all
 * they cover is under the water: so nothing above the surface bleeds into it.
 */
fn refraction(uv: vec2f, lod: f32, z: f32, h: f32) -> vec3f {
  let size = vec2f(textureDimensions(opaque_color, 0));
  if (lod > 0.05) {
    // Trilinear reaches a texel of the coarser mip either way: 2^ceil(lod) half-res texels, and
    // a texel of that mip covers as many again.
    let r = 2.0 * exp2(ceil(lod)) / size;
    var clear = true;
    for (var k = 0; k < 8; k++) {
      let a = f32(k) * 0.7853982;
      let o = vec2f(cos(a), sin(a)) * r;
      if (!submerged(uv + o, opaque_depth_at(uv + o), z, h)) { clear = false; }
      if (!submerged(uv + o * 0.5, opaque_depth_at(uv + o * 0.5), z, h)) { clear = false; }
    }
    if (clear) { return textureSampleLevel(opaque_color, clamp_sampler, uv, lod).rgb; }
  }
  let t = uv * size - 0.5;
  let base = vec2i(floor(t));
  let f = t - floor(t);
  let top = vec2i(size) - 1;
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var k = 0; k < 4; k++) {
    let d = vec2i(k & 1, k >> 1);
    let q = clamp(base + d, vec2i(0), top);
    if (!texel_submerged(q, z, h)) { continue; }
    let w = max(mix(1.0 - f.x, f.x, f32(d.x)) * mix(1.0 - f.y, f.y, f32(d.y)), 1e-4);
    sum += textureLoad(opaque_color, q, 0).rgb * w;
    weight += w;
  }
  if (weight > 0.0) { return sum / weight; }
  return textureLoad(opaque_color, clamp(vec2i(uv * size), vec2i(0), top), 0).rgb;
}

/** Henyey–Greenstein phase (per steradian). */
fn phase_hg(g: f32, cos_theta: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * cos_theta, 1e-4), 1.5));
}

/** Two scrolling ripple layers' slope (xz) at a point, for a wind velocity (m/s). */
fn ripple_slope(xz: vec2f, wind: vec2f, strength: f32, dx: vec2f, dy: vec2f) -> vec2f {
  let speed = length(wind);
  let dir = select(vec2f(1.0, 0.0), wind / max(speed, 1e-4), speed > 1e-4);
  let side = vec2f(-dir.y, dir.x);
  let t = wind_time();
  // Wind-aligned coordinates: ripples run downwind, the second layer finer and slower.
  let p = vec2f(dot(xz, dir), dot(xz, side));
  let scale1 = 1.0 / 5.0;
  let scale2 = 1.0 / 1.7;
  let uv1 = p * scale1 - vec2f(t * (0.04 + speed * 0.012), 0.0);
  let uv2 = p * scale2 * mat2x2f(0.8, 0.6, -0.6, 0.8) - vec2f(t * (0.03 + speed * 0.008), t * 0.01);
  let g1 = vec2f(dot(dx, dir), dot(dx, side));
  let g2 = vec2f(dot(dy, dir), dot(dy, side));
  let s1 = textureSampleGrad(ripple_map, repeat_sampler, uv1, g1 * scale1, g2 * scale1).xy * 2.0 - 1.0;
  let s2 = textureSampleGrad(ripple_map, repeat_sampler, uv2, g1 * scale2, g2 * scale2).xy * 2.0 - 1.0;
  let local = (s1 + s2 * 0.6) * strength;
  // Back to world xz.
  return dir * local.x + side * local.y;
}

@fragment fn fs(in: SurfaceOut) -> @location(0) vec4f {
  let p = in.world;
  // Derivatives first, in uniform control flow (the discard below isn't).
  let dx = dpdx(p.xz);
  let dy = dpdy(p.xz);
  let at = here(p.xz);
  if (at.wet < 0.5) { discard; }
  let optics = at.body;

  // Wind ripples: the body's own wind, or the shared wind (0096) at the surface.
  var wind = optics.wind.xyz;
  if (optics.wind.w < 0.5) { wind = wind_at(p, wind_time()).xyz; }
  let speed = length(wind.xz);
  let strength = optics.params.x * clamp(speed / 10.0, 0.0, 1.0) * 0.16;
  let slope = ripple_slope(p.xz, wind.xz, strength, dx, dy);
  let n = normalize(vec3f(-slope.x, 1.0, -slope.y));
  let v = normalize(view.cameraPosition - p);
  let n_dot_v = max(dot(n, v), 1e-4);

  // Refraction: the opaque copy, offset by the tilt and how much water there is, and only ever what's
  // under the surface (an offset sample that isn't is rejected).
  let uv = in.clip.xy * view.viewport.zw;
  let d_here = opaque_depth_at(uv);
  let thick_here = thickness(uv, d_here, p);
  var ruv = clamp(uv + n.xz * REFRACTION * clamp(thick_here * 0.5, 0.0, 1.0), vec2f(0.0), vec2f(1.0));
  var d = opaque_depth_at(ruv);
  if (!submerged(ruv, d, in.clip.z, p.y)) {
    ruv = uv;
    d = d_here;
  }
  let thick = thickness(ruv, d, p);
  let roughness = max(optics.scattering.w, 0.02);
  let mips = water.params2.x - 1.0;
  let lod = min(clamp(thick / 6.0, 0.0, 1.0) * roughness * 30.0, mips);
  let refracted = refraction(ruv, lod, in.clip.z, p.y);

  // Light in the water: each sun scattered toward the eye (phase g), and the sky's irradiance.
  let sigma_s = optics.scattering.rgb;
  let sigma_t = optics.absorption.rgb + sigma_s;
  let albedo = sigma_s / max(sigma_t, vec3f(1e-6));
  let view_depth = -(view.view * vec4f(p, 1.0)).z;
  var sun_in = vec3f(0.0);
  var specular = vec3f(0.0);
  let a = max(roughness * roughness, 0.002);
  for (var i = 0u; i < directional.count; i++) {
    let light = directional.lights[i];
    let l = normalize(light.direction);
    var shadow = 1.0;
    if (light.shadowed != 0u) { shadow = directional_shadow(p, n, view_depth, in.clip.xy); }
    let radiance = light.color * view.sunTransmittance[i].rgb * shadow;
    sun_in += radiance * phase_hg(optics.absorption.w, dot(-l, v)) * 0.5 * max(l.y, 0.0);
    let h = normalize(v + l);
    let n_dot_l = max(dot(n, l), 0.0);
    let f = F0 + (1.0 - F0) * pow(1.0 - max(dot(v, h), 0.0), 5.0);
    specular += d_ggx(max(dot(n, h), 0.0), a) * v_smith_ggx_correlated(n_dot_v, n_dot_l, a) * f * n_dot_l * radiance;
  }
  var sky = view.ambient;
  var reflected = view.ambient;
  if (view.envParams.w > 0.5) {
    sky = env_irradiance(vec3f(0.0, 1.0, 0.0)) * view.envParams.x;
    var r = reflect(-v, n);
    r.y = abs(r.y);
    reflected = textureSampleLevel(env_specular, env_sampler, env_rotate(r), roughness * ENV_SPECULAR_MIPS).rgb * view.envParams.x;
  }
  let inscatter = albedo * (sun_in + sky * 0.5);
  let transmittance = exp(-sigma_t * thick);
  let fresnel = F0 + (1.0 - F0) * pow(1.0 - n_dot_v, 5.0);
  let body = refracted * transmittance + inscatter * view.exposure * (vec3f(1.0) - transmittance);
  let color = body * (1.0 - fresnel) + (reflected * fresnel + specular) * view.exposure;
  // Thin water fades into what's under it: no edge where the surface meets the shore.
  let shore = clamp(thick_here / SHORE_FADE, 0.0, 1.0);
  return vec4f(color, shore);
}

/** Depth only (baseline's single-sample depth, 0064): the surface where it's wet. */
@fragment fn fs_depth(in: SurfaceOut) {
  if (here(in.world.xz).wet < 0.5) { discard; }
}`,
}
