// WGSL for the sky (0130) and clouds (0131).

import { SKY_OCCLUSION_BINDING } from '@aethervtt/shard-render'

/** vec4 slots `shard::sky_occlusion` reads from shard::globals: the shadow map, the layer, the cloud map. */
export const OCCLUSION_SLOTS = 3

/** Texels across the cloud shadow map, and the metres it covers around the camera. */
export const SHADOW_SIZE = 512
export const SHADOW_EXTENT = 12000

/** Edge of the shape noise volume (Perlin-Worley and Worley octaves), and of the detail volume. */
export const SHAPE_SIZE = 128
export const DETAIL_SIZE = 32

const COMMON = `
fn sky_pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}
fn sky_hash2(x: u32, y: u32) -> u32 { return sky_pcg(x ^ sky_pcg(y)); }
fn sky_hash3(x: u32, y: u32, z: u32) -> u32 { return sky_pcg(x ^ sky_pcg(y ^ sky_pcg(z))); }
fn sky_u01(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }

/** Smooth value noise in [0, 1] on integer cells. */
fn sky_value2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (3.0 - 2.0 * f);
  let c = vec2i(i);
  let a = sky_u01(sky_hash2(bitcast<u32>(c.x), bitcast<u32>(c.y)));
  let b = sky_u01(sky_hash2(bitcast<u32>(c.x + 1), bitcast<u32>(c.y)));
  let d = sky_u01(sky_hash2(bitcast<u32>(c.x), bitcast<u32>(c.y + 1)));
  let e = sky_u01(sky_hash2(bitcast<u32>(c.x + 1), bitcast<u32>(c.y + 1)));
  return mix(mix(a, b, s.x), mix(d, e, s.x), s.y);
}

fn sky_value3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = p - i;
  let s = f * f * (3.0 - 2.0 * f);
  let c = vec3i(i);
  var v: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    let q = c + o;
    v[k] = sky_u01(sky_hash3(bitcast<u32>(q.x), bitcast<u32>(q.y), bitcast<u32>(q.z)));
  }
  let x0 = mix(mix(v[0], v[1], s.x), mix(v[2], v[3], s.x), s.y);
  let x1 = mix(mix(v[4], v[5], s.x), mix(v[6], v[7], s.x), s.y);
  return mix(x0, x1, s.z);
}

fn sky_remap(v: f32, lo: f32, hi: f32, nlo: f32, nhi: f32) -> f32 {
  return nlo + (v - lo) / max(hi - lo, 1e-5) * (nhi - nlo);
}

/**
 * The cloud map (0131): coverage at a point of the map, p = (world xz − wind offset) × mapScale.
 * Four octaves of value noise around the layer's coverage, so clouds gather in patches and thin
 * out between them. Cloud shadows read the same function, so they fall under the clouds.
 */
fn cloud_map(p: vec2f, coverage: f32) -> f32 {
  var n = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 4; i++) {
    n += amp * sky_value2(q);
    q = q * 2.07 + vec2f(17.3, 9.1);
    amp *= 0.5;
  }
  n = n / 0.9375;
  return clamp(pow(coverage, 0.7) + (n - 0.5) * 1.1 * (1.0 - coverage * 0.5), 0.0, 1.0);
}
`

export const SKY_SHADERS: Record<string, string> = {
  'shard::sky::common': COMMON,

  // Shape: R Perlin-Worley, GBA Worley fBm at 4, 8 and 16 cells. Detail: RGB Worley fBm at 2, 4, 8.
  'shard::sky::noise': `
import shard::sky::common::{ sky_pcg, sky_hash3, sky_u01 };

@group(0) @binding(0) var out_shape: texture_storage_3d<rgba8unorm, write>;
@group(0) @binding(1) var out_detail: texture_storage_3d<rgba8unorm, write>;

fn wrap3(c: vec3i, period: i32) -> vec3u {
  return vec3u(((c % period) + period) % period);
}

/** 1 − distance to the nearest feature point, tiling every \`period\` cells. */
fn worley(p: vec3f, period: i32) -> f32 {
  let cell = vec3i(floor(p));
  let f = p - floor(p);
  var best = 1e9;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let o = vec3i(x, y, z);
        let w = wrap3(cell + o, period);
        let h = sky_hash3(w.x + 101u, w.y, w.z);
        let fp = vec3f(sky_u01(h), sky_u01(sky_pcg(h)), sky_u01(sky_pcg(h ^ 0x68bc21ebu)));
        let d = vec3f(o) + fp - f;
        best = min(best, dot(d, d));
      }
    }
  }
  return clamp(1.0 - sqrt(best), 0.0, 1.0);
}

fn grad3(c: vec3u) -> vec3f {
  let h = sky_hash3(c.x, c.y + 7u, c.z);
  let a = sky_u01(h) * 6.2831853;
  let z = sky_u01(sky_pcg(h)) * 2.0 - 1.0;
  let r = sqrt(max(0.0, 1.0 - z * z));
  return vec3f(r * cos(a), r * sin(a), z);
}

/** Tiling gradient noise in about [-1, 1]. */
fn perlin(p: vec3f, period: i32) -> f32 {
  let i = vec3i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  var v: array<f32, 8>;
  for (var k = 0; k < 8; k++) {
    let o = vec3i(k & 1, (k >> 1) & 1, (k >> 2) & 1);
    v[k] = dot(grad3(wrap3(i + o, period)), f - vec3f(o));
  }
  let x0 = mix(mix(v[0], v[1], u.x), mix(v[2], v[3], u.x), u.y);
  let x1 = mix(mix(v[4], v[5], u.x), mix(v[6], v[7], u.x), u.y);
  return mix(x0, x1, u.z) * 1.5;
}

fn worley_fbm(p: vec3f, cells: i32) -> f32 {
  return worley(p * f32(cells), cells) * 0.625 +
    worley(p * f32(cells * 2), cells * 2) * 0.25 +
    worley(p * f32(cells * 4), cells * 4) * 0.125;
}

@compute @workgroup_size(4, 4, 4)
fn shape(@builtin(global_invocation_id) id: vec3u) {
  let size = ${SHAPE_SIZE}u;
  if (any(id >= vec3u(size))) { return; }
  let p = (vec3f(id) + 0.5) / f32(size);
  var n = 0.0;
  var amp = 1.0;
  var total = 0.0;
  var cells = 4;
  for (var o = 0; o < 5; o++) {
    n += perlin(p * f32(cells), cells) * amp;
    total += amp;
    amp *= 0.5;
    cells *= 2;
  }
  let pn = clamp(n / total * 0.5 + 0.5, 0.0, 1.0);
  let w = worley_fbm(p, 4);
  // Perlin-Worley: billowy Perlin, its gaps cut by Worley.
  let pw = clamp((pn - (1.0 - w)) / max(w, 1e-3) * 0.5 + pn * 0.5, 0.0, 1.0);
  textureStore(out_shape, id, vec4f(pw, w, worley_fbm(p, 8), worley_fbm(p, 16)));
}

@compute @workgroup_size(4, 4, 4)
fn detail(@builtin(global_invocation_id) id: vec3u) {
  let size = ${DETAIL_SIZE}u;
  if (any(id >= vec3u(size))) { return; }
  let p = (vec3f(id) + 0.5) / f32(size);
  textureStore(out_detail, id, vec4f(worley_fbm(p, 2), worley_fbm(p, 4), worley_fbm(p, 8), 1.0));
}`,

  // The raymarch (0131): quarter resolution, jittered, lit by the sun and moon through the
  // atmosphere's transmittance, with sky-view ambient and aerial perspective to the cloud.
  'shard::sky::march': `
import shard::atmosphere::{ AtmosphereView, AtmosphereParams, KCD, sample_transmittance, sky_view_uv, ray_at };
import shard::sky::common::{ sky_remap, cloud_map, sky_u01, sky_pcg };

struct CloudParams {
  /** bottom (m), top (m), planet radius (m), extinction (1/m) */
  layer: vec4f,
  /** coverage, type, shape scale, detail scale (1/m) */
  shape: vec4f,
  /** wind offset x, z (m), evolution offset (m), map scale (1/m) */
  wind: vec4f,
  /** camera world xyz (m), frame */
  camera: vec4f,
  /** output width, height, 1/width, 1/height */
  size: vec4f,
  /** albedo, max steps, sky-view w, sky-view h */
  light: vec4f,
  /** exposure, has atmosphere, bands, mode (0 volumetric, 1 2d) */
  misc: vec4f,
  /** shadow map center x, z (m), extent (m), texels */
  shadow: vec4f,
  /** toward the light that casts cloud shadows; w: 1 when there is one */
  shadow_light: vec4f,
  /** toon bands (0: smooth), softness */
  toon: vec4f,
  /** a lightning flash inside the clouds: camera-relative position (m), strength (0: none) */
  flash: vec4f,
}

/**
 * Toon (0108) for clouds: the lit fraction (direct light over what an unshadowed cloud would get)
 * falls into the camera's bands, with Toon's edge softness.
 */
fn toon_level(ratio: f32) -> f32 {
  let n = max(cp.toon.x - 1.0, 1.0);
  let x = clamp(ratio, 0.0, 1.0) * n;
  let s = max(cp.toon.y, 0.001) * 0.5;
  return (floor(x) + smoothstep(0.5 - s, 0.5 + s, fract(x))) / n;
}

@group(0) @binding(0) var<uniform> cp: CloudParams;
@group(0) @binding(1) var<uniform> atmo: AtmosphereView;
@group(0) @binding(2) var tlut: texture_2d_array<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var sky_view: texture_2d<f32>;
@group(0) @binding(5) var sky_sampler: sampler;
@group(0) @binding(6) var shape_tex: texture_3d<f32>;
@group(0) @binding(7) var detail_tex: texture_3d<f32>;
@group(0) @binding(8) var noise_sampler: sampler;
@group(0) @binding(9) var out_tex: texture_storage_2d<rgba16float, write>;
@group(0) @binding(10) var shadow_out: texture_storage_2d<rgba8unorm, write>;

const PI: f32 = 3.14159265;

/** Distances to the sphere of radius R + h from radius r = R + alt along cos-zenith mu; (-1,-1) miss. */
fn shell(alt: f32, mu: f32, h: f32) -> vec2f {
  let R = cp.layer.z;
  let r = R + alt;
  let rs = R + h;
  let b = r * mu;
  let c = (alt - h) * (r + rs);
  let disc = b * b - c;
  if (disc < 0.0) { return vec2f(-1.0); }
  let s = sqrt(disc);
  let q = -(b + select(-s, s, b >= 0.0));
  if (abs(q) < 1e-6) { return vec2f(-1.0); }
  let t0 = q;
  let t1 = c / q;
  return vec2f(min(t0, t1), max(t0, t1));
}

/** Altitude of a camera-relative point, precise with a planet's radius in f32. */
fn altitude(q: vec3f) -> f32 {
  let R = cp.layer.z;
  let alt = cp.camera.y;
  let r = R + alt;
  let n = dot(q, q) + 2.0 * r * q.y + alt * (r + R);
  return n / (sqrt(max(r * r + 2.0 * r * q.y + dot(q, q), 0.0)) + R);
}

fn hg(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

/** Height profile by cloud type: stratus thin and low, cumulus rounded, cumulonimbus tall. */
fn profile(h: f32, kind: f32) -> f32 {
  let stratus = smoothstep(0.0, 0.08, h) * (1.0 - smoothstep(0.15, 0.3, h));
  let cumulus = smoothstep(0.0, 0.12, h) * (1.0 - smoothstep(0.35, 0.75, h));
  let cb = smoothstep(0.0, 0.1, h) * (1.0 - smoothstep(0.75, 1.0, h));
  let a = mix(stratus, cumulus, clamp(kind * 2.0, 0.0, 1.0));
  return mix(a, cb, clamp(kind * 2.0 - 1.0, 0.0, 1.0));
}

/** Density at a camera-relative point; cheap leaves out the detail erosion (light marches). */
fn density(q: vec3f, alt: f32, cheap: bool) -> f32 {
  let h = (alt - cp.layer.x) / (cp.layer.y - cp.layer.x);
  if (h <= 0.0 || h >= 1.0) { return 0.0; }
  let world = cp.camera.xz + q.xz;
  let cov = cloud_map((world - cp.wind.xy) * cp.wind.w, cp.shape.x);
  if (cov <= 0.01) { return 0.0; }
  let p = vec3f(world.x - cp.wind.x, alt + cp.wind.z * 0.2, world.y - cp.wind.y);
  let s = textureSampleLevel(shape_tex, noise_sampler, p * cp.shape.z, 0.0);
  let fbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  var base = sky_remap(s.r, -(1.0 - fbm), 1.0, 0.0, 1.0);
  base *= profile(h, cp.shape.y);
  base = clamp(sky_remap(base, 1.0 - cov, 1.0, 0.0, 1.0), 0.0, 1.0) * mix(cov, 1.0, 0.5);
  if (base <= 0.0) { return 0.0; }
  if (!cheap) {
    let dp = p * cp.shape.w + vec3f(0.0, cp.wind.z * cp.shape.w * 0.5, 0.0);
    let d = textureSampleLevel(detail_tex, noise_sampler, dp, 0.0);
    let dfbm = d.r * 0.625 + d.g * 0.25 + d.b * 0.125;
    // Wispy at the base, billowy at the top.
    let m = mix(dfbm, 1.0 - dfbm, clamp(h * 4.0, 0.0, 1.0));
    base = clamp(sky_remap(base, m * 0.35, 1.0, 0.0, 1.0), 0.0, 1.0);
  }
  return base * cp.layer.w;
}

/** Optical depth toward a light: six cheap samples at growing steps. */
fn light_depth(q: vec3f, l: vec3f) -> f32 {
  var od = 0.0;
  var t = 0.0;
  var step = (cp.layer.y - cp.layer.x) * 0.025;
  for (var i = 0; i < 6; i++) {
    let s = q + l * (t + step * 0.5);
    od += density(s, altitude(s), true) * step;
    t += step;
    step *= 1.6;
  }
  return od;
}

fn sky_lum(d: vec3f) -> vec3f {
  if (cp.misc.y < 0.5) { return vec3f(0.0); }
  let a = atmo.atmospheres[i32(atmo.info.y)];
  let uv = sky_view_uv(a, atmo.frame_up.xyz, atmo.frame_x.xyz, atmo.frame_y.xyz, d, cp.light.zw);
  return textureSampleLevel(sky_view, sky_sampler, uv, 0.0).rgb * KCD;
}

/**
 * How much of a light toward cos-zenith mu the planet leaves visible from altitude alt (m): zero
 * below the horizon, with a couple of degrees of twilight glow past it.
 */
fn planet_shadow(alt: f32, mu: f32) -> f32 {
  let R = cp.layer.z;
  let r = R + alt;
  let mu_h = -sqrt(max(0.0, alt * (2.0 * R + alt)) ) / r;
  return smoothstep(mu_h - 0.035, mu_h + 0.01, mu);
}

/** Transmittance through the atmosphere from altitude alt (m) along cos-zenith mu. */
fn atmo_t(alt: f32, mu: f32) -> vec3f {
  if (cp.misc.y < 0.5) { return vec3f(1.0); }
  let a = atmo.atmospheres[i32(atmo.info.y)];
  return sample_transmittance(tlut, lut_sampler, a, a.radii.x + alt / 1000.0, mu);
}

/**
 * The 2d mode (0131): two thin layers on the shell, at the base and halfway up, from the same
 * cloud map and shape noise, self-shadowed by two samples toward the light. Cheap and flat.
 */
fn planar(d: vec3f, alt0: f32) -> vec4f {
  var L = vec3f(0.0);
  var T = 1.0;
  let suns = u32(atmo.info.z);
  let zenith = sky_lum(vec3f(0.0, 1.0, 0.0));
  for (var k = 1; k >= 0; k--) {
    let h = cp.layer.x + (cp.layer.y - cp.layer.x) * (0.15 + 0.35 * f32(k));
    let hit = shell(alt0, d.y, h);
    let t = select(hit.y, hit.x, alt0 > h);
    if (t <= 0.0 || t > 90000.0) { continue; }
    let q = d * t;
    let world = cp.camera.xz + q.xz - cp.wind.xy;
    let cov = cloud_map(world * cp.wind.w, cp.shape.x) * (1.0 - 0.35 * f32(k));
    let layer_d = fn_planar_density(world, h, cov, f32(k));
    if (layer_d <= 0.001) { continue; }
    var S = vec3f(0.0);
    for (var i = 0u; i < suns; i++) {
      let sun = atmo.suns[i];
      let l = sun.direction.xyz;
      let toward = fn_planar_density(world + l.xz / max(l.y, 0.15) * 350.0, h, cov, f32(k)) +
        fn_planar_density(world + l.xz / max(l.y, 0.15) * 900.0, h, cov, f32(k)) * 0.6;
      let E = sun.illuminance.rgb * atmo_t(h, l.y) * planet_shadow(h, l.y);
      let c = dot(d, l);
      let ph = mix(hg(c, 0.6), hg(c, -0.2), 0.3);
      // Thin layers scatter light nearly every way: a phase lifted toward isotropic.
      var lit = exp(-toward * 3.0);
      if (cp.toon.x > 0.5) { lit = toon_level(lit); }
      S += E * (ph + 0.12) * (lit * 0.8 + 0.2);
    }
    S += zenith * 0.8;
    var a = 1.0 - exp(-layer_d * 6.0);
    if (cp.toon.x > 0.5) { a = smoothstep(0.3, 0.3 + max(cp.toon.y, 0.02) * 2.0, a); }
    // Far layers fade into the horizon haze.
    let fade = 1.0 - smoothstep(30000.0, 80000.0, t);
    let lit = S * cp.light.x;
    let air = clamp(atmo_t(alt0, d.y) / max(atmo_t(h, d.y), vec3f(1e-4)), vec3f(0.0), vec3f(1.0));
    let col = lit * air + sky_lum(d) * (1.0 - air);
    L = L * (1.0 - a * fade) + col * a * fade;
    T *= 1.0 - a * fade;
  }
  return vec4f(L, T);
}

fn fn_planar_density(world: vec2f, h: f32, cov: f32, layer: f32) -> f32 {
  let p = vec3f(world.x, 500.0 + layer * 4000.0, world.y) * cp.shape.z * 1.3;
  let s = textureSampleLevel(shape_tex, noise_sampler, p, 0.0);
  let fbm = s.g * 0.625 + s.b * 0.25 + s.a * 0.125;
  let base = sky_remap(s.r, -(1.0 - fbm), 1.0, 0.0, 1.0);
  let d = textureSampleLevel(detail_tex, noise_sampler, p * 6.0, 0.0);
  let shaped = sky_remap(base, 1.0 - cov, 1.0, 0.0, 1.0) - d.r * 0.25;
  return clamp(shaped, 0.0, 1.0);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (f32(id.x) >= cp.size.x || f32(id.y) >= cp.size.y) { return; }
  let uv = (vec2f(id.xy) + 0.5) * cp.size.zw;
  let d = ray_at(atmo, uv);
  if (cp.misc.w > 0.5) {
    if (d.y < -0.02) {
      textureStore(out_tex, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
      return;
    }
    let r = planar(d, max(cp.camera.y, 1.0));
    textureStore(out_tex, id.xy, vec4f(min(r.rgb * cp.misc.x, vec3f(60000.0)), r.a));
    return;
  }
  let alt0 = max(cp.camera.y, 1.0);
  let bottom = cp.layer.x;
  let top = cp.layer.y;
  var t0 = 0.0;
  var t1 = 0.0;
  let ib = shell(alt0, d.y, bottom);
  let it = shell(alt0, d.y, top);
  if (alt0 < bottom) {
    // From below: from the base to the top, unless the ground is in the way.
    let ig = shell(alt0, d.y, 0.0);
    if (ig.x > 0.0 || ib.y <= 0.0) {
      textureStore(out_tex, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
      return;
    }
    t0 = ib.y;
    t1 = it.y;
  } else if (alt0 < top) {
    t0 = 0.0;
    t1 = select(it.y, ib.x, ib.x > 0.0);
  } else {
    if (it.x <= 0.0) {
      textureStore(out_tex, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
      return;
    }
    t0 = it.x;
    t1 = select(it.y, ib.x, ib.x > 0.0);
  }
  // Far clouds are haze anyway: stop at 90 km, and march at most 60 km of layer.
  if (t0 > 90000.0) {
    textureStore(out_tex, id.xy, vec4f(0.0, 0.0, 0.0, 1.0));
    return;
  }
  t1 = min(t1, t0 + 60000.0);
  let len = t1 - t0;
  let steps = u32(clamp(len / 90.0, 24.0, cp.light.y));
  let dt = len / f32(steps);
  // Interleaved gradient noise, shifted every frame: the history averages it out.
  let frame = cp.camera.w;
  let px = vec2f(id.xy) + vec2f(5.588238 * frame, 5.588238 * frame * 0.618);
  let jitter = fract(52.9829189 * fract(dot(px, vec2f(0.06711056, 0.00583715))));

  // Light from the sun and moon (the atmosphere's two suns), and ambient from the sky.
  let suns = u32(atmo.info.z);
  let zenith = sky_lum(vec3f(0.0, 1.0, 0.0));
  let horizon = (sky_lum(normalize(vec3f(1.0, 0.15, 0.0))) + sky_lum(normalize(vec3f(-1.0, 0.15, 0.0))) +
    sky_lum(normalize(vec3f(0.0, 0.15, 1.0))) + sky_lum(normalize(vec3f(0.0, 0.15, -1.0)))) * 0.25;
  let amb_top = (zenith + horizon) * 0.5;
  var ground = vec3f(0.0);
  for (var i = 0u; i < suns; i++) {
    let sun = atmo.suns[i];
    ground += sun.illuminance.rgb * max(sun.direction.y, 0.0) * atmo_t(0.0, sun.direction.y) * (0.25 / PI);
  }
  let amb_bottom = ground + horizon * 0.3;

  var L = vec3f(0.0);
  // Toon: direct light, and what it would be with no self-shadowing, kept apart.
  var L_sun = vec3f(0.0);
  var L_ref = vec3f(0.0);
  var T = 1.0;
  var weighted = 0.0;
  var weight = 0.0;
  let albedo = cp.light.x;
  var t = t0 + dt * jitter;
  for (var k = 0u; k < steps; k++) {
    let q = d * t;
    let alt = altitude(q);
    let sigma = density(q, alt, false);
    if (sigma > 0.0) {
      let h = clamp((alt - bottom) / (top - bottom), 0.0, 1.0);
      var S = vec3f(0.0);
      var S_ref = vec3f(0.0);
      for (var i = 0u; i < suns; i++) {
        let sun = atmo.suns[i];
        let l = sun.direction.xyz;
        if (max(sun.illuminance.r, sun.illuminance.g) <= 0.0) { continue; }
        let od = light_depth(q, l);
        let up = normalize(vec3f(q.x / cp.layer.z, 1.0, q.z / cp.layer.z));
        let mu_l = dot(up, l);
        let E = sun.illuminance.rgb * atmo_t(alt, mu_l) * planet_shadow(alt, mu_l);
        let c = dot(d, l);
        // Multiple scattering as octaves (Wrenninge): each lets more light through, less forward.
        var ms = 0.0;
        var ms_ref = 0.0;
        var ext = 1.0;
        var contrib = 1.0;
        var g = 1.0;
        for (var o = 0; o < 4; o++) {
          let ph = mix(hg(c, 0.8 * g), hg(c, -0.3 * g), 0.3);
          ms += contrib * exp(-od * ext) * ph;
          ms_ref += contrib * ph;
          ext *= 0.3;
          contrib *= 0.65;
          g *= 0.5;
        }
        // Beer-powder: darker where little cloud is in front of the light-facing side.
        let powder = 1.0 - exp(-sigma * 160.0);
        S += E * ms * mix(1.0, powder * 2.0, 0.4);
        S_ref += E * ms_ref;
      }
      var amb = mix(amb_bottom, amb_top, h) * mix(0.55, 1.0, h);
      // Lightning lights the cloud around it from inside (0133).
      if (cp.flash.w > 0.0) {
        let fd = length(q - cp.flash.xyz);
        amb += vec3f(0.75, 0.82, 1.0) * cp.flash.w * exp(-fd / 1800.0);
      }
      let e = exp(-sigma * dt);
      // ∫ over the step of scattering × transmittance, for a unit source: (1 − e) × albedo.
      let w = T * (1.0 - e) * albedo;
      L += (S + amb) * w;
      L_sun += S * w;
      L_ref += S_ref * w;
      weighted += T * (1.0 - e) * t;
      weight += T * (1.0 - e);
      T *= e;
      if (T < 0.01) { break; }
    }
    t += dt;
  }
  if (T < 0.01) { T = 0.0; }
  if (cp.toon.x > 0.5 && T < 1.0) {
    // Banded light, and a hard edge: toon clouds are shapes, not haze.
    let lum = vec3f(0.2126, 0.7152, 0.0722);
    let ratio = dot(L_sun, lum) / max(dot(L_ref, lum), 1e-6);
    L = L - L_sun + L_ref * toon_level(ratio);
    let a = 1.0 - T;
    let crisp = smoothstep(0.25, 0.25 + max(cp.toon.y, 0.02) * 2.0, a);
    L *= crisp / max(a, 1e-3);
    T = 1.0 - crisp;
  }
  // Aerial perspective to the clouds' weighted distance: dimmed, and hazed toward the sky.
  if (weight > 0.0 && cp.misc.y > 0.5) {
    let dist = weighted / weight;
    let q = d * dist;
    let alt = altitude(q);
    let up = normalize(vec3f(q.x / cp.layer.z, 1.0, q.z / cp.layer.z));
    let t_cam = atmo_t(alt0, d.y);
    let t_pt = atmo_t(alt, dot(up, d));
    let air = clamp(t_cam / max(t_pt, vec3f(1e-4)), vec3f(0.0), vec3f(1.0));
    L = L * air + sky_lum(d) * (1.0 - air) * (1.0 - T);
  }
  // Clouds near the horizon fade into it.
  let fade = 1.0 - smoothstep(55000.0, 90000.0, t0);
  L *= fade;
  T = mix(1.0, T, fade);
  textureStore(out_tex, id.xy, vec4f(min(L * cp.misc.x, vec3f(60000.0)), T));
}

/**
 * The cloud shadow map: for each ground point around the camera, the transmittance toward the
 * shadow-casting light through the layer, from the same density the march draws (no detail).
 */
@compute @workgroup_size(8, 8)
fn shadow(@builtin(global_invocation_id) id: vec3u) {
  let n = u32(cp.shadow.w);
  if (id.x >= n || id.y >= n) { return; }
  let l = cp.shadow_light.xyz;
  if (cp.shadow_light.w < 0.5 || l.y < 0.02) {
    textureStore(shadow_out, id.xy, vec4f(1.0));
    return;
  }
  let uv = (vec2f(id.xy) + 0.5) / f32(n) - 0.5;
  let ground = cp.shadow.xy + uv * cp.shadow.z;
  // Camera-relative ground point, then up the light through the layer.
  let g = vec3f(ground.x - cp.camera.x, -cp.camera.y, ground.y - cp.camera.z);
  // The lower half of the layer: where clouds are densest, and their shadows' edges come from.
  let t0 = cp.layer.x / l.y;
  let t1 = (cp.layer.x + (cp.layer.y - cp.layer.x) * 0.55) / l.y;
  let steps = 10;
  let dt = (t1 - t0) / f32(steps);
  var od = 0.0;
  for (var i = 0; i < steps; i++) {
    let q = g + l * (t0 + (f32(i) + 0.5) * dt);
    od += density(q, altitude(q), true) * dt;
  }
  textureStore(shadow_out, id.xy, vec4f(exp(-od * 0.3), 0.0, 0.0, 1.0));
}`,

  // Temporal resolve: last frame's clouds reprojected by direction (they're far), clamped to this
  // frame's neighborhood, blended in.
  'shard::sky::resolve': `
struct ResolveParams {
  /** Last frame's view-projection without translation. */
  prev_view_proj: mat4x4f,
  /** This frame's inverse, without translation. */
  inv_view_proj: mat4x4f,
  /** width, height, 1/width, 1/height */
  size: vec4f,
  /** history weight, history valid */
  blend: vec4f,
}

@group(0) @binding(0) var<uniform> rp: ResolveParams;
@group(0) @binding(1) var current: texture_2d<f32>;
@group(0) @binding(2) var history: texture_2d<f32>;
@group(0) @binding(3) var lin: sampler;
@group(0) @binding(4) var out_tex: texture_storage_2d<rgba16float, write>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(rp.size.xy);
  let p = vec2i(id.xy);
  if (p.x >= size.x || p.y >= size.y) { return; }
  let c = textureLoad(current, p, 0);
  var lo = c;
  var hi = c;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let s = textureLoad(current, clamp(p + vec2i(x, y), vec2i(0), size - 1), 0);
      lo = min(lo, s);
      hi = max(hi, s);
    }
  }
  var result = c;
  if (rp.blend.y > 0.5) {
    let uv = (vec2f(p) + 0.5) * rp.size.zw;
    let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    let near = rp.inv_view_proj * vec4f(ndc, 1.0, 1.0);
    let far = rp.inv_view_proj * vec4f(ndc, 0.5, 1.0);
    let d = normalize(far.xyz / far.w - near.xyz / near.w);
    let clip = rp.prev_view_proj * vec4f(d, 0.0);
    if (clip.w > 1e-5) {
      let prev_ndc = clip.xy / clip.w;
      let prev_uv = vec2f(prev_ndc.x * 0.5 + 0.5, 0.5 - prev_ndc.y * 0.5);
      if (all(prev_uv >= vec2f(0.0)) && all(prev_uv <= vec2f(1.0))) {
        let h = textureSampleLevel(history, lin, prev_uv, 0.0);
        // Widen the box a little: one jittered sample is noisy, and the history is the average.
        let pad = (hi - lo) * 0.25;
        let hc = clamp(h, lo - pad, hi + pad);
        result = mix(c, hc, rp.blend.x);
      }
    }
  }
  textureStore(out_tex, p, result);
}`,

  // The clouds over the sky: drawn only where nothing else was (depth 0), premultiplied.
  'shard::sky::composite': `
@group(0) @binding(0) var clouds: texture_2d<f32>;
@group(0) @binding(1) var lin: sampler;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Out;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  return textureSampleLevel(clouds, lin, in.uv, 0.0);
}`,

  // Stars, the Milky Way, the moon and 2D aurora (0130): behind the clouds, dimmed by the
  // atmosphere's transmittance, added over the sky.
  'shard::sky::celestial': `
import shard::atmosphere::{ AtmosphereView, sample_transmittance, ray_sphere, ray_at };
import shard::sky::common::{ sky_pcg, sky_hash3, sky_u01, sky_value2, sky_value3 };

struct CelestialParams {
  /** World → equatorial rows. */
  row0: vec4f,
  row1: vec4f,
  row2: vec4f,
  /** Toward the moon, angular radius (rad). */
  moon: vec4f,
  /** Toward the sun, illuminated fraction. */
  sun: vec4f,
  /** night brightness, stars, Milky Way, aurora */
  a: vec4f,
  /** time (s), twinkle, moon disk brightness, pixel angle (rad) */
  b: vec4f,
}

@group(0) @binding(0) var<uniform> atmo: AtmosphereView;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var lut_sampler: sampler;
@group(0) @binding(3) var<uniform> cel: CelestialParams;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  var out: Out;
  out.clip = vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
  out.uv = vec2f(xy.x, 1.0 - xy.y);
  return out;
}

const STAR_CELLS: f32 = 360.0;

fn star_color(t: f32) -> vec3f {
  let blue = vec3f(0.66, 0.76, 1.0);
  let white = vec3f(1.0, 0.97, 0.92);
  let red = vec3f(1.0, 0.72, 0.48);
  return select(mix(white, red, (t - 0.5) * 2.0), mix(blue, white, t * 2.0), t < 0.5);
}

/** Stars as Gaussians a pixel wide: one candidate per cell of a cube map of the celestial sphere. */
fn stars(dc: vec3f, px: f32, elevation: f32) -> vec3f {
  let a = abs(dc);
  var face = 0u;
  var uv = vec2f(0.0);
  if (a.x >= a.y && a.x >= a.z) {
    face = select(1u, 0u, dc.x > 0.0);
    uv = dc.yz / a.x;
  } else if (a.y >= a.z) {
    face = select(3u, 2u, dc.y > 0.0);
    uv = dc.xz / a.y;
  } else {
    face = select(5u, 4u, dc.z > 0.0);
    uv = dc.xy / a.z;
  }
  let g = (uv * 0.5 + 0.5) * STAR_CELLS;
  let cell = floor(g);
  // Cells shrink toward a face's edges; the gnomonic stretch converts them to angles.
  let stretch = 1.0 / (1.0 + dot(uv, uv));
  let cell_angle = (2.0 / STAR_CELLS) * stretch;
  let sigma = max(px * 0.6, 1e-5);
  var sum = vec3f(0.0);
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      let c = cell + vec2f(f32(x), f32(y));
      if (any(c < vec2f(0.0)) || any(c >= vec2f(STAR_CELLS))) { continue; }
      let h = sky_hash3(face, u32(c.x), u32(c.y));
      if (sky_u01(h) > 0.075) { continue; }
      let h1 = sky_pcg(h);
      let h2 = sky_pcg(h1);
      let pos = c + vec2f(sky_u01(h1), sky_u01(h2));
      let dist = length(g - pos) * cell_angle;
      let mag = max(7.0 + 2.2 * log(max(sky_u01(sky_pcg(h2)), 1e-6)) / log(10.0), -1.4);
      let lux = pow(10.0, -0.4 * (mag + 14.18));
      let w = exp(-0.5 * (dist / sigma) * (dist / sigma)) / (6.2831853 * sigma * sigma);
      let tw = 1.0 + cel.b.y * (0.25 + 0.6 * (1.0 - elevation)) *
        sin(cel.b.x * (7.0 + 9.0 * sky_u01(h1)) + 6.2831853 * sky_u01(h2));
      sum += star_color(sky_u01(sky_pcg(h1 ^ 0x5bd1e995u))) * lux * w * max(tw, 0.0);
    }
  }
  return sum;
}

fn fbm3(p: vec3f) -> f32 {
  var n = 0.0;
  var amp = 0.5;
  var q = p;
  for (var i = 0; i < 5; i++) {
    n += amp * sky_value3(q);
    q = q * 2.03 + vec3f(5.1, 1.7, 9.3);
    amp *= 0.5;
  }
  return n / 0.96875;
}

/** The Milky Way in equatorial coordinates: a band with a bright core and dark lanes. */
fn milky_way(dc: vec3f) -> vec3f {
  let ngp = vec3f(-0.8676, -0.1981, 0.4560);
  let gc = vec3f(-0.0549, -0.8734, -0.4838);
  let b = dot(dc, ngp);
  let toward = dot(dc, gc) * 0.5 + 0.5;
  let clumps = fbm3(dc * 7.0);
  let band = exp(-b * b / (2.0 * 0.16 * 0.16)) * (0.35 + 0.65 * clumps) * (0.4 + 1.6 * toward * toward * toward);
  let lanes = 1.0 - 0.8 * exp(-b * b / (2.0 * 0.035 * 0.035)) * smoothstep(0.35, 0.75, fbm3(dc * 11.0 + 3.0)) * toward;
  let glow = band * lanes;
  return mix(vec3f(0.75, 0.82, 1.0), vec3f(1.0, 0.88, 0.72), toward) * glow * 2.5e-3;
}

/** The moon: lit by the true sun direction (Lommel-Seeliger), with maria and craters. */
fn moon(d: vec3f, px: f32) -> vec3f {
  let m = cel.moon.xyz;
  let r = cel.moon.w;
  let cd = dot(d, m);
  if (cd < cos(r * 1.3)) { return vec3f(0.0); }
  var right = cross(m, vec3f(0.0, 1.0, 0.0));
  if (dot(right, right) < 1e-6) { right = vec3f(1.0, 0.0, 0.0); }
  right = normalize(right);
  let up = cross(right, m);
  let v = d - m * cd;
  let sr = sin(r);
  let x = dot(v, right) / sr;
  let y = dot(v, up) / sr;
  let rr = x * x + y * y;
  let edge = 1.0 - smoothstep(1.0 - px / r, 1.0 + px / r, sqrt(rr));
  if (edge <= 0.0) { return vec3f(0.0); }
  let z = sqrt(max(0.0, 1.0 - rr));
  let n = right * x + up * y - m * z;
  let local = vec3f(x, y, z);
  let maria = smoothstep(0.45, 0.62, fbm3(local * 2.2 + 11.0));
  let craters = fbm3(local * 14.0);
  let albedo = mix(0.15, 0.075, maria) * (0.8 + 0.4 * craters);
  let mu0 = dot(n, normalize(cel.sun.xyz));
  let lit = select(0.0, mu0 / (mu0 + z + 1e-4), mu0 > 0.0);
  // Full moon is about 2 500 cd/m² (a 0.12 albedo); earthshine fills the dark side faintly.
  // Full moon is about 2 500 cd/m²; drawn at a twentieth by default, so its maria survive a night
  // exposure (moonDisk scales it).
  let lum = albedo / 0.12 * (lit * 2.0 * 2500.0 * 0.012 + 0.08);
  return vec3f(1.0, 0.97, 0.92) * lum * edge * cel.b.z;
}

/** Aurora curtains toward the celestial pole, on a plane high above. */
fn aurora(d: vec3f) -> vec3f {
  if (d.y < 0.03) { return vec3f(0.0); }
  var pole = vec3f(cel.row2.x, 0.0, cel.row2.z);
  if (dot(pole, pole) < 1e-6) { pole = vec3f(0.0, 0.0, -1.0); }
  pole = normalize(pole);
  let side = vec3f(-pole.z, 0.0, pole.x);
  let p = d.xz / d.y;
  let toward = dot(p, pole.xz);
  let along = dot(p, side.xz);
  var sum = vec3f(0.0);
  for (var k = 0; k < 3; k++) {
    let fk = f32(k);
    let wave = sky_value2(vec2f(along * 0.35 + cel.b.x * 0.015 * (1.0 + fk), fk * 13.0)) * 1.4;
    let lane = toward - (1.6 + fk * 0.9) - wave;
    let curtain = exp(-lane * lane * 6.0);
    let rays = 0.55 + 0.45 * sky_value2(vec2f(along * 6.0 + cel.b.x * 0.2, fk * 7.0));
    sum += curtain * rays * (1.0 - fk * 0.25);
  }
  let elev = d.y;
  let color = mix(vec3f(0.15, 1.0, 0.45), vec3f(0.65, 0.25, 0.9), smoothstep(0.25, 0.6, elev));
  return color * sum * smoothstep(0.03, 0.12, elev) * 2e-2;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  let d = ray_at(atmo, in.uv);
  var color = vec3f(0.0);
  let night = cel.a.x;
  let dc = vec3f(dot(cel.row0.xyz, d), dot(cel.row1.xyz, d), dot(cel.row2.xyz, d));
  let elevation = clamp(d.y, 0.0, 1.0);
  color += stars(dc, cel.b.w, elevation) * cel.a.y * night;
  color += milky_way(dc) * cel.a.z * night;
  if (cel.a.w > 0.0) { color += aurora(d) * cel.a.w * night; }
  color += moon(d, cel.b.w);
  // Through the atmosphere: reddened near the horizon, gone below it.
  let primary = i32(atmo.info.y);
  if (primary >= 0) {
    let a = atmo.atmospheres[primary];
    let o = a.origin.xyz;
    let r = length(o);
    if (ray_sphere(o, d, a.radii.z).x > 0.0) { return vec4f(0.0); }
    color *= sample_transmittance(tlut, lut_sampler, a, r, dot(o, d) / r);
  }
  return vec4f(min(color * atmo.camera.w, vec3f(60000.0)), 0.0);
}`,
}

/**
 * \`shard::sky_occlusion\` (0131): the cloud shadow the lighting stage multiplies each directional
 * light by, from the cloud map at the layer's middle along the light, reading \`slot\` of
 * shard::globals.
 */
export function occlusionShaders(slot: number): Record<string, string> {
  return {
    'shard::sky_occlusion': `
import shard::globals::globals;
import shard::pbr::environment::env_sampler;
import shard::sky::common::cloud_map;

const SKY_OCCLUSION_BLOCK: u32 = ${slot}u;

@group(0) @binding(${SKY_OCCLUSION_BINDING}) var sky_occlusion_map: texture_2d<f32>;

/**
 * How much of a directional light toward l reaches world point p through the clouds: the shadow
 * map near the camera, the cloud map's coverage beyond it.
 */
fn sky_occlusion(p: vec3f, l: vec3f) -> f32 {
  let a = globals.data[SKY_OCCLUSION_BLOCK];
  let b = globals.data[SKY_OCCLUSION_BLOCK + 1u];
  let c = globals.data[SKY_OCCLUSION_BLOCK + 2u];
  if (b.z < 0.5 || l.y < 0.02) { return 1.0; }
  // Down the light to the ground the map was made for.
  let ground = p.xz - l.xz * (p.y / l.y);
  let uv = (ground - a.xy) * a.z + 0.5;
  let t = max(b.x - p.y, 0.0) / l.y;
  let far = 1.0 - smoothstep(0.3, 0.8, cloud_map((p.xz + l.xz * t - c.xy) * c.z, a.w)) * b.w * 0.6;
  let edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  let near = smoothstep(0.04, 0.85, textureSampleLevel(sky_occlusion_map, env_sampler, uv, 0.0).r);
  let shade = mix(near, far, smoothstep(0.42, 0.5, edge));
  return 1.0 - b.y * (1.0 - shade);
}`,
  }
}
