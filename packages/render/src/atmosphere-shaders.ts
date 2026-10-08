/**
 * WGSL for atmospheres (spec 0044, Hillaire 2020): the shared model (`shard::atmosphere`), the
 * transmittance and multiple-scattering LUTs, the per-camera sky-view LUT and aerial-perspective
 * froxels, the sky pass, the aerial-perspective composite, and the environment bake. Mirrors
 * `atmosphere-model.ts`; everything runs in km relative to the atmosphere's center.
 */
export const ATMOSPHERE_SHADERS: Record<string, string> = {
  'shard::atmosphere': `
const ATMO_PI: f32 = 3.14159265359;
/** LUTs store luminance in kcd/m², so rgba16float holds a noon sky. */
const KCD: f32 = 1000.0;
const TRANSMITTANCE_SIZE: vec2f = vec2f(256.0, 64.0);
const MULTISCATTER_SIZE: vec2f = vec2f(32.0, 32.0);

struct AtmosphereParams {
  /** bottom, top, LUT floor (bottom − deck) in km; intensity. */
  radii: vec4f,
  /** Rayleigh scattering (1/km) rgb, 1 / scale height (1/km). */
  rayleigh: vec4f,
  /** Mie scattering, Mie absorption (1/km), 1 / scale height, LUT layer. */
  mie: vec4f,
  /** Mie asymmetry per channel. */
  mie_g: vec4f,
  /** Ozone-like absorption (1/km) rgb, tent center (km). */
  absorption: vec4f,
  /** Tent width (km). */
  absorption_width: vec4f,
  albedo: vec4f,
  /** The camera relative to the center (km); w = 1 when the camera is inside. */
  origin: vec4f,
}

struct Sun {
  /** Toward the sun; w: angular radius (rad), 0 without a disk. */
  direction: vec4f,
  /** Illuminance (lux) per channel at the top of the atmosphere. */
  illuminance: vec4f,
}

struct AtmosphereView {
  /** Composite order, far to near. */
  atmospheres: array<AtmosphereParams, 4>,
  suns: array<Sun, 2>,
  /** count, primary index (-1: none), sun count, aerial perspective on (1). */
  info: vec4f,
  /** Sky-view frame of the primary: up (radial), azimuth 0, azimuth 90°. */
  frame_up: vec4f,
  frame_x: vec4f,
  frame_y: vec4f,
  /** Froxels: max distance (km), first-slice scale D0 (km), slices, 1 / ln(1 + max / D0). */
  froxels: vec4f,
  /** Clip space to camera-relative positions (m): the inverse view-projection without translation. */
  inv_view_proj: mat4x4f,
  /** Camera position in world space (m); w: exposure. */
  camera: vec4f,
}

/** Near and far distances along unit d to the sphere of radius r at the origin; (-1, -1): miss. */
fn ray_sphere(o: vec3f, d: vec3f, r: f32) -> vec2f {
  let b = dot(o, d);
  let c = dot(o, o) - r * r;
  let disc = b * b - c;
  if (disc < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(disc);
  return vec2f(-b - s, -b + s);
}

struct Medium {
  rayleigh: vec3f,
  mie: f32,
  scattering: vec3f,
  extinction: vec3f,
}

/** The medium at altitude h km above the bottom (negative in a gas giant's deck). */
fn medium_at(a: AtmosphereParams, h: f32) -> Medium {
  let hc = max(h, a.radii.z - a.radii.x);
  let dr = exp(-hc * a.rayleigh.w);
  let dm = exp(-hc * a.mie.z);
  let da = max(0.0, 1.0 - abs(hc - a.absorption.w) / (0.5 * a.absorption_width.x));
  var m: Medium;
  m.rayleigh = a.rayleigh.xyz * dr;
  m.mie = a.mie.x * dm;
  m.scattering = m.rayleigh + vec3f(m.mie);
  m.extinction = m.scattering + vec3f(a.mie.y * dm) + a.absorption.xyz * da;
  return m;
}

fn rayleigh_phase(mu: f32) -> f32 {
  return 3.0 / (16.0 * ATMO_PI) * (1.0 + mu * mu);
}

/** Cornette-Shanks, per channel. */
fn mie_phase(mu: f32, g: vec3f) -> vec3f {
  let g2 = g * g;
  let denom = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, vec3f(1.5));
  return 3.0 / (8.0 * ATMO_PI) * ((1.0 - g2) * (1.0 + mu * mu)) / denom;
}

/** Texel-center remapping: unit 0 and 1 land on the first and last texel centers. */
fn unit_to_uv(x: vec2f, size: vec2f) -> vec2f { return (0.5 + x * (size - 1.0)) / size; }
fn uv_to_unit(uv: vec2f, size: vec2f) -> vec2f { return (uv * size - 0.5) / (size - 1.0); }

/** Transmittance LUT unit coordinates of radius r and zenith cosine mu (Bruneton). */
fn transmittance_unit(a: AtmosphereParams, r: f32, mu: f32) -> vec2f {
  let rb = a.radii.z;
  let rt = a.radii.y;
  let H = sqrt(max(0.0, rt * rt - rb * rb));
  let rho = sqrt(max(0.0, r * r - rb * rb));
  let disc = r * r * (mu * mu - 1.0) + rt * rt;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let d_min = rt - r;
  let d_max = rho + H;
  return vec2f(select(0.0, (d - d_min) / (d_max - d_min), d_max > d_min), select(0.0, rho / H, H > 0.0));
}

fn transmittance_r_mu(a: AtmosphereParams, x: vec2f) -> vec2f {
  let rb = a.radii.z;
  let rt = a.radii.y;
  let H = sqrt(max(0.0, rt * rt - rb * rb));
  let rho = H * x.y;
  let r = sqrt(rho * rho + rb * rb);
  let d_min = rt - r;
  let d_max = rho + H;
  let d = d_min + x.x * (d_max - d_min);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

fn sample_transmittance(lut: texture_2d_array<f32>, s: sampler, a: AtmosphereParams, r: f32, mu: f32) -> vec3f {
  let uv = unit_to_uv(clamp(transmittance_unit(a, r, mu), vec2f(0.0), vec2f(1.0)), TRANSMITTANCE_SIZE);
  return textureSampleLevel(lut, s, uv, i32(a.mie.w), 0.0).rgb;
}

/** Transmittance from p toward a sun; zero in the planet's shadow. */
fn sun_transmittance(lut: texture_2d_array<f32>, s: sampler, a: AtmosphereParams, p: vec3f, l: vec3f) -> vec3f {
  if (ray_sphere(p, l, a.radii.z).x > 0.0) { return vec3f(0.0); }
  let r = length(p);
  return sample_transmittance(lut, s, a, r, dot(p, l) / r);
}

fn sample_multiscatter(lut: texture_2d_array<f32>, s: sampler, a: AtmosphereParams, r: f32, cos_sun: f32) -> vec3f {
  let x = vec2f(cos_sun * 0.5 + 0.5, (r - a.radii.z) / (a.radii.y - a.radii.z));
  let uv = unit_to_uv(clamp(x, vec2f(0.0), vec2f(1.0)), MULTISCATTER_SIZE);
  return textureSampleLevel(lut, s, uv, i32(a.mie.w), 0.0).rgb;
}

/** Sample placement along a segment: quadratic toward the start, or toward the end. */
fn bunch(s: f32, toward_end: bool) -> f32 {
  if (toward_end) { return 1.0 - (1.0 - s) * (1.0 - s); }
  return s * s;
}

struct Segment {
  /** In-scattered radiance (cd/m²), before exposure. */
  luminance: vec3f,
  transmittance: vec3f,
  /** The ray ended on the ground. */
  ground: bool,
}

/**
 * Radiance along a ray from o (km, relative to the center) in unit direction d, clipped to the
 * atmosphere and to max_t km: single scattering of up to two suns, multiple scattering from the
 * LUT, and (with ground) the lit surface where it ends on it. Samples bunch up near the start.
 */
fn integrate(tlut: texture_2d_array<f32>, mlut: texture_2d_array<f32>, s: sampler, a: AtmosphereParams,
             sun0: Sun, sun1: Sun, suns: u32, o: vec3f, d: vec3f, max_t: f32, steps: u32, with_ground: bool) -> Segment {
  var out: Segment;
  out.luminance = vec3f(0.0);
  out.transmittance = vec3f(1.0);
  out.ground = false;
  let top = ray_sphere(o, d, a.radii.y);
  if (top.y <= 0.0) { return out; }
  let t0 = max(0.0, top.x);
  var t1 = top.y;
  var hits = false;
  let g = ray_sphere(o, d, a.radii.z);
  if (g.x > 0.0 && g.x < t1) {
    t1 = g.x;
    hits = true;
  }
  if (max_t < t1) {
    t1 = max_t;
    hits = false;
  }
  if (t1 <= t0) { return out; }
  let span = t1 - t0;
  let n = f32(steps);
  // Samples bunch up where the air is densest: near the start from inside, near the end (the
  // ground) for a ray that enters from space.
  let from_space = t0 > 0.0;
  var T = vec3f(1.0);
  var L = vec3f(0.0);
  for (var k = 0u; k < steps; k++) {
    let s0 = bunch(f32(k) / n, from_space);
    let s1 = bunch((f32(k) + 1.0) / n, from_space);
    let sm = bunch((f32(k) + 0.5) / n, from_space);
    let dt = span * (s1 - s0);
    let p = o + d * (t0 + span * sm);
    let r = length(p);
    let m = medium_at(a, r - a.radii.x);
    var S = vec3f(0.0);
    for (var i = 0u; i < suns; i++) {
      var sun = sun0;
      if (i == 1u) { sun = sun1; }
      let l = sun.direction.xyz;
      let mu = dot(d, l);
      let st = sun_transmittance(tlut, s, a, p, l);
      let ms = sample_multiscatter(mlut, s, a, r, dot(p, l) / r);
      S += ((m.rayleigh * rayleigh_phase(mu) + m.mie * mie_phase(mu, a.mie_g.xyz)) * st + ms * m.scattering) * sun.illuminance.rgb;
    }
    let ext = max(m.extinction, vec3f(1e-9));
    let step_t = exp(-ext * dt);
    L += T * S * (1.0 - step_t) / ext;
    T *= step_t;
  }
  if (hits && with_ground) {
    let p = o + d * t1;
    let n_up = normalize(p);
    for (var i = 0u; i < suns; i++) {
      var sun = sun0;
      if (i == 1u) { sun = sun1; }
      let l = sun.direction.xyz;
      let ndl = max(dot(n_up, l), 0.0);
      if (ndl <= 0.0) { continue; }
      let st = sun_transmittance(tlut, s, a, p * 1.00001, l);
      L += T * sun.illuminance.rgb * st * ndl * a.albedo.rgb / ATMO_PI;
    }
    out.ground = true;
  }
  out.luminance = L * a.radii.w;
  // Behind a background ray that ends on the ground there's nothing; geometry sits on it.
  out.transmittance = select(T, vec3f(0.0), hits && with_ground);
  return out;
}

/** Sky-view LUT uv of a direction in the primary's frame (full azimuth, horizon-dense latitude). */
fn sky_view_uv(a: AtmosphereParams, up: vec3f, fx: vec3f, fy: vec3f, d: vec3f, size: vec2f) -> vec2f {
  let r = max(length(a.origin.xyz), a.radii.z + 1e-4);
  let v_horizon = sqrt(max(r * r - a.radii.z * a.radii.z, 0.0));
  let beta = acos(clamp(v_horizon / r, -1.0, 1.0));
  let zenith_horizon = ATMO_PI - beta;
  let zenith = acos(clamp(dot(d, up), -1.0, 1.0));
  var v = 0.0;
  if (zenith < zenith_horizon) {
    v = (1.0 - sqrt(max(1.0 - zenith / zenith_horizon, 0.0))) * 0.5;
  } else {
    v = sqrt(max((zenith - zenith_horizon) / max(beta, 1e-6), 0.0)) * 0.5 + 0.5;
  }
  var az = atan2(dot(d, fy), dot(d, fx));
  if (az < 0.0) { az += 2.0 * ATMO_PI; }
  let u = az / (2.0 * ATMO_PI);
  // v on texel centers; u wraps (the sampler repeats).
  return vec2f(u, (0.5 + clamp(v, 0.0, 1.0) * (size.y - 1.0)) / size.y);
}

/** The direction of a sky-view texel (uv in 0..1). */
fn sky_view_dir(a: AtmosphereParams, up: vec3f, fx: vec3f, fy: vec3f, uv: vec2f, size: vec2f) -> vec3f {
  let r = max(length(a.origin.xyz), a.radii.z + 1e-4);
  let v_horizon = sqrt(max(r * r - a.radii.z * a.radii.z, 0.0));
  let beta = acos(clamp(v_horizon / r, -1.0, 1.0));
  let zenith_horizon = ATMO_PI - beta;
  let v = clamp((uv.y * size.y - 0.5) / (size.y - 1.0), 0.0, 1.0);
  var zenith = 0.0;
  if (v < 0.5) {
    let c = 1.0 - 2.0 * v;
    zenith = zenith_horizon * (1.0 - c * c);
  } else {
    let c = v * 2.0 - 1.0;
    zenith = zenith_horizon + beta * c * c;
  }
  let az = uv.x * 2.0 * ATMO_PI;
  return normalize(up * cos(zenith) + (fx * cos(az) + fy * sin(az)) * sin(zenith));
}

/** Distance (km) of froxel slice coordinate s in 0..1 (exponential slices). */
fn froxel_distance(f: vec4f, s: f32) -> f32 {
  return f.y * (exp(s / f.w) - 1.0);
}

fn froxel_slice(f: vec4f, t: f32) -> f32 {
  return log(1.0 + t / f.y) * f.w;
}

/** Camera-relative position (m) at a uv and (reversed-Z) depth. */
fn relative_at(atmo: AtmosphereView, uv: vec2f, depth: f32) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let p = atmo.inv_view_proj * vec4f(ndc, depth, 1.0);
  return p.xyz / p.w;
}

/** The view ray through a uv. */
fn ray_at(atmo: AtmosphereView, uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let near = atmo.inv_view_proj * vec4f(ndc, 1.0, 1.0);
  let far = atmo.inv_view_proj * vec4f(ndc, 0.5, 1.0);
  return normalize(far.xyz / far.w - near.xyz / near.w);
}`,

  'shard::atmosphere::transmittance_lut': `
import shard::atmosphere::{ AtmosphereParams, transmittance_r_mu, medium_at, ray_sphere };

@group(0) @binding(0) var<uniform> params: AtmosphereParams;
@group(0) @binding(1) var lut: texture_storage_2d<rgba16float, write>;

const STEPS: u32 = 40u;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(lut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let x = vec2f(f32(id.x), f32(id.y)) / (vec2f(size) - 1.0);
  let rm = transmittance_r_mu(params, x);
  let o = vec3f(0.0, rm.x, 0.0);
  let d = vec3f(sqrt(max(0.0, 1.0 - rm.y * rm.y)), rm.y, 0.0);
  let top = ray_sphere(o, d, params.radii.y).y;
  let dt = max(top, 0.0) / f32(STEPS);
  var depth = vec3f(0.0);
  for (var i = 0u; i < STEPS; i++) {
    let p = o + d * ((f32(i) + 0.5) * dt);
    depth += medium_at(params, length(p) - params.radii.x).extinction * dt;
  }
  textureStore(lut, id.xy, vec4f(exp(-depth), 1.0));
}`,

  'shard::atmosphere::multiscatter_lut': `
import shard::atmosphere::{ ATMO_PI, AtmosphereParams, medium_at, ray_sphere, sun_transmittance };

@group(0) @binding(0) var<uniform> params: AtmosphereParams;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var lut_sampler: sampler;
@group(0) @binding(3) var lut: texture_storage_2d<rgba16float, write>;

const STEPS: u32 = 20u;
const DIRS: u32 = 8u;

/** L2 / (1 − f_ms) per unit illuminance: Hillaire's isotropic second-order approximation. */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(lut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let a = params;
  let x = vec2f(f32(id.x), f32(id.y)) / (vec2f(size) - 1.0);
  let r = max(a.radii.z + x.y * (a.radii.y - a.radii.z), a.radii.z + 1e-3);
  let cs = x.x * 2.0 - 1.0;
  let l = vec3f(0.0, cs, sqrt(max(0.0, 1.0 - cs * cs)));
  let o = vec3f(0.0, r, 0.0);
  let isotropic = 1.0 / (4.0 * ATMO_PI);
  var lum = vec3f(0.0);
  var fms = vec3f(0.0);
  for (var i = 0u; i < DIRS; i++) {
    for (var j = 0u; j < DIRS; j++) {
      let ct = 1.0 - 2.0 * (f32(i) + 0.5) / f32(DIRS);
      let st = sqrt(max(0.0, 1.0 - ct * ct));
      let phi = 2.0 * ATMO_PI * (f32(j) + 0.5) / f32(DIRS);
      let d = vec3f(st * cos(phi), ct, st * sin(phi));
      let g = ray_sphere(o, d, a.radii.z);
      let hits = g.x > 0.0;
      let t_max = select(ray_sphere(o, d, a.radii.y).y, g.x, hits);
      let dt = t_max / f32(STEPS);
      var th = vec3f(1.0);
      for (var k = 0u; k < STEPS; k++) {
        let p = o + d * ((f32(k) + 0.5) * dt);
        let m = medium_at(a, length(p) - a.radii.x);
        let sun_t = sun_transmittance(tlut, lut_sampler, a, p, l);
        let ext = max(m.extinction, vec3f(1e-9));
        let step_t = exp(-ext * dt);
        lum += th * sun_t * m.scattering * isotropic * (1.0 - step_t) / ext;
        fms += th * m.scattering * (1.0 - step_t) / ext;
        th *= step_t;
      }
      if (hits) {
        let p = o + d * t_max;
        let ndl = max(dot(normalize(p), l), 0.0);
        let sun_t = sun_transmittance(tlut, lut_sampler, a, p * 1.00001, l);
        lum += th * sun_t * ndl * a.albedo.rgb / ATMO_PI;
      }
    }
  }
  let count = f32(DIRS * DIRS);
  let psi = (lum / count) / max(vec3f(1.0) - fms / count, vec3f(1e-4));
  textureStore(lut, id.xy, vec4f(psi, 1.0));
}`,

  'shard::atmosphere::sky_view': `
import shard::atmosphere::{ AtmosphereView, KCD, integrate, sky_view_dir };

@group(0) @binding(0) var<uniform> atmo: AtmosphereView;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var mlut: texture_2d_array<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var out_lut: texture_storage_2d<rgba16float, write>;

/** The primary's sky around the camera, every azimuth, with the lit ground below the horizon. */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_lut);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let a = atmo.atmospheres[u32(atmo.info.y)];
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size);
  let d = sky_view_dir(a, atmo.frame_up.xyz, atmo.frame_x.xyz, atmo.frame_y.xyz, uv, vec2f(size));
  let o = a.origin.xyz * (max(length(a.origin.xyz), a.radii.z + 1e-4) / max(length(a.origin.xyz), 1e-6));
  let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], u32(atmo.info.z), o, d, 1e9, 32u, true);
  textureStore(out_lut, id.xy, vec4f(seg.luminance / KCD, 1.0));
}`,

  'shard::atmosphere::aerial': `
import shard::atmosphere::{ AtmosphereView, KCD, integrate, froxel_distance, ray_at };

@group(0) @binding(0) var<uniform> atmo: AtmosphereView;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var mlut: texture_2d_array<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var out_scatter: texture_storage_3d<rgba16float, write>;
@group(0) @binding(5) var out_transmittance: texture_storage_3d<rgba16float, write>;

/**
 * Aerial perspective froxels: along each froxel column's ray, in-scattering (kcd/m²) and
 * transmittance from the camera to each exponential slice's far end.
 */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_scatter);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let a = atmo.atmospheres[u32(atmo.info.y)];
  let uv = (vec2f(id.xy) + 0.5) / vec2f(size.xy);
  let d = ray_at(atmo, uv);
  let o = a.origin.xyz;
  var L = vec3f(0.0);
  var T = vec3f(1.0);
  var t_prev = 0.0;
  for (var k = 0u; k < size.z; k++) {
    let t = froxel_distance(atmo.froxels, (f32(k) + 1.0) / f32(size.z));
    // Two steps per slice, from where the last one ended.
    let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], u32(atmo.info.z), o + d * t_prev, d, t - t_prev, 2u, false);
    L += T * seg.luminance;
    T *= seg.transmittance;
    t_prev = t;
    textureStore(out_scatter, vec3u(id.xy, k), vec4f(L / KCD, 1.0));
    textureStore(out_transmittance, vec3u(id.xy, k), vec4f(T, 1.0));
  }
}`,

  'shard::atmosphere::sky': `
import shard::view::view;
import shard::atmosphere::{ AtmosphereView, ATMO_PI, KCD, integrate, sample_transmittance, sky_view_uv, ray_sphere, ray_at };

@group(1) @binding(0) var<uniform> atmo: AtmosphereView;
@group(1) @binding(1) var tlut: texture_2d_array<f32>;
@group(1) @binding(2) var mlut: texture_2d_array<f32>;
@group(1) @binding(3) var lut_sampler: sampler;
@group(1) @binding(4) var sky_view: texture_2d<f32>;
@group(1) @binding(5) var sky_view_sampler: sampler;
@group(1) @binding(6) var background: texture_cube<f32>;

struct BackgroundParams {
  /** intensity (cd/m² per unit) × brightness, cos and sin of the rotation, enabled. */
  env: vec4f,
  /** Sky-view LUT size. */
  size: vec4f,
}
@group(1) @binding(7) var<uniform> bg: BackgroundParams;

struct SkyOutput {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
}

/** A fullscreen triangle at depth 0 (reversed-Z infinity): it only draws where nothing else did. */
@vertex fn vs(@builtin(vertex_index) i: u32) -> SkyOutput {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var out: SkyOutput;
  out.clip = vec4f(xy, 0.0, 1.0);
  out.ndc = xy;
  return out;
}

@fragment fn fs(in: SkyOutput) -> @location(0) vec4f {
  let d = ray_at(atmo, vec2f(in.ndc.x * 0.5 + 0.5, 0.5 - in.ndc.y * 0.5));
  // What lies beyond every atmosphere: the environment (a star field), and the sun disks.
  var color = vec3f(0.0);
  if (bg.env.w > 0.5) {
    let c = bg.env.y;
    let s = bg.env.z;
    let e = vec3f(c * d.x - s * d.z, d.y, s * d.x + c * d.z);
    color = textureSampleLevel(background, lut_sampler, e, 0.0).rgb * bg.env.x;
  }
  let suns = u32(atmo.info.z);
  for (var i = 0u; i < suns; i++) {
    let sun = atmo.suns[i];
    let radius = sun.direction.w;
    if (radius <= 0.0) { continue; }
    let cd = dot(d, sun.direction.xyz);
    if (cd < cos(radius * 1.2)) { continue; }
    let angle = acos(clamp(cd, -1.0, 1.0));
    {
      // E / solid angle, a soft edge, and a little limb darkening.
      let x = clamp(angle / radius, 0.0, 1.0);
      let edge = 1.0 - smoothstep(0.9, 1.2, angle / radius);
      let limb = 1.0 - 0.6 * (1.0 - sqrt(max(0.0, 1.0 - x * x)));
      color += sun.illuminance.rgb / (ATMO_PI * radius * radius) * edge * limb;
    }
  }
  // Then through each atmosphere, far to near.
  let count = u32(atmo.info.x);
  let primary = i32(atmo.info.y);
  for (var i = 0u; i < count; i++) {
    let a = atmo.atmospheres[i];
    if (i32(i) == primary && a.origin.w > 0.5) {
      // Inside: the sky-view LUT, and transmittance to space unless the ground is in the way.
      let o = a.origin.xyz;
      let r = length(o);
      let uv = sky_view_uv(a, atmo.frame_up.xyz, atmo.frame_x.xyz, atmo.frame_y.xyz, d, bg.size.xy);
      let lum = textureSampleLevel(sky_view, sky_view_sampler, uv, 0.0).rgb * KCD;
      // Transmittance matters only for what's behind (a star field, a sun disk, a farther limb).
      var t = vec3f(0.0);
      if (any(color > vec3f(0.0)) && ray_sphere(o, d, a.radii.z).x <= 0.0) { t = sample_transmittance(tlut, lut_sampler, a, r, dot(o, d) / r); }
      color = color * t + lum;
    } else {
      let steps = select(8u, 16u, i32(i) == primary);
      let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], suns, a.origin.xyz, d, 1e9, steps, true);
      color = color * seg.transmittance + seg.luminance;
    }
  }
  // Pre-exposed, and kept inside what rgba16float holds.
  return vec4f(min(color * view.exposure, vec3f(60000.0)), 1.0);
}`,

  'shard::atmosphere::composite': `
import shard::view::view;
import shard::post::common::{ uv_of, post_out };
import shard::atmosphere::{ AtmosphereView, KCD, integrate, froxel_slice, relative_at };
@if(FOG) import shard::post::fog::common::{ FogParams, fog_apply };

@group(1) @binding(0) var input: texture_2d<f32>;
@group(1) @binding(1) var depth_texture: texture_depth_2d;
@group(1) @binding(2) var<uniform> atmo: AtmosphereView;
@group(1) @binding(3) var tlut: texture_2d_array<f32>;
@group(1) @binding(4) var mlut: texture_2d_array<f32>;
@group(1) @binding(5) var lut_sampler: sampler;
@group(1) @binding(6) var ap_scatter: texture_3d<f32>;
@group(1) @binding(7) var ap_transmittance: texture_3d<f32>;
/** A view with fog too: fog follows in the same pass (\`fs_fog\`). */
@if(FOG) @group(1) @binding(8) var<uniform> fog: FogParams;

/**
 * Aerial perspective on geometry: color × transmittance + in-scattering for every atmosphere the
 * view ray crosses before the surface, far to near. The primary reads its froxels within their
 * range; beyond it (terrain seen from orbit), and for the others, the ray is marched.
 */
fn haze(frag: vec4f, c: vec4f, depth: f32) -> vec4f {
  let count = u32(atmo.info.x);
  if (depth <= 0.0 || count == 0u) { return c; }
  let uv = uv_of(frag.xy);
  let to = relative_at(atmo, uv, depth);
  let dist = length(to) / 1000.0;
  let d = to / max(length(to), 1e-6);
  var color = c.rgb;
  let primary = i32(atmo.info.y);
  let suns = u32(atmo.info.z);
  let froxels = atmo.froxels.x > 0.0 && atmo.info.w > 0.5;
  for (var i = 0u; i < count; i++) {
    let a = atmo.atmospheres[i];
    if (i32(i) == primary && a.origin.w > 0.5 && froxels && dist < atmo.froxels.x) {
      let s = froxel_slice(atmo.froxels, dist);
      let n = atmo.froxels.z;
      let coord = vec3f(uv, max(s - 0.5 / n, 0.0));
      // The first slice fades in from the camera.
      let near = clamp(s * n, 0.0, 1.0);
      let lum = textureSampleLevel(ap_scatter, lut_sampler, coord, 0.0).rgb * KCD * near;
      let t = mix(vec3f(1.0), textureSampleLevel(ap_transmittance, lut_sampler, coord, 0.0).rgb, near);
      color = color * t + lum * view.exposure;
    } else {
      // Marched: the primary finely from inside, coarser from space; the others coarsest.
      let steps = select(8u, select(12u, 24u, a.origin.w > 0.5), i32(i) == primary);
      let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], suns, a.origin.xyz, d, dist, steps, false);
      color = color * seg.transmittance + seg.luminance * view.exposure;
    }
  }
  return vec4f(min(color, vec3f(60000.0)), c.a);
}

@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  return post_out(haze(frag, textureLoad(input, px, 0), textureLoad(depth_texture, px, 0)));
}

/** Aerial perspective, then height fog: the view's fog pass folded into this one. */
@if(FOG) @fragment fn fs_fog(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let px = vec2i(frag.xy);
  let depth = textureLoad(depth_texture, px, 0);
  return post_out(fog_apply(haze(frag, textureLoad(input, px, 0), depth), uv_of(frag.xy), depth, fog));
}`,

  'shard::atmosphere::bake': `
import shard::env::common::cube_dir;
import shard::atmosphere::{ AtmosphereView, integrate };

@group(0) @binding(0) var<uniform> atmo: AtmosphereView;
@group(0) @binding(1) var tlut: texture_2d_array<f32>;
@group(0) @binding(2) var mlut: texture_2d_array<f32>;
@group(0) @binding(3) var lut_sampler: sampler;
@group(0) @binding(4) var dst: texture_storage_2d_array<rgba16float, write>;

/** The primary's sky from the camera into a cube face (no sun disk: the DirectionalLight is the sun). */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  let d = cube_dir(id.z, (vec2f(id.xy) + 0.5) / f32(size));
  let a = atmo.atmospheres[u32(atmo.info.y)];
  let seg = integrate(tlut, mlut, lut_sampler, a, atmo.suns[0], atmo.suns[1], u32(atmo.info.z), a.origin.xyz, d, 1e9, 32u, true);
  textureStore(dst, id.xy, id.z, vec4f(min(seg.luminance, vec3f(60000.0)), 1.0));
}`,
}
