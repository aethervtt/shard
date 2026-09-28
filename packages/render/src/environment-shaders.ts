/** WGSL for environments: prefiltering (compute), IBL, and the environment-map background. */
export const ENVIRONMENT_SHADERS: Record<string, string> = {
  'shard::env::common': `
const PI: f32 = 3.14159265359;

/** The direction through texel uv (0..1, top-left origin) of cube face +X, -X, +Y, -Y, +Z, -Z. */
fn cube_dir(face: u32, uv: vec2f) -> vec3f {
  let s = uv.x * 2.0 - 1.0;
  let t = uv.y * 2.0 - 1.0;
  switch face {
    case 0u: { return normalize(vec3f(1.0, -t, -s)); }
    case 1u: { return normalize(vec3f(-1.0, -t, s)); }
    case 2u: { return normalize(vec3f(s, 1.0, t)); }
    case 3u: { return normalize(vec3f(s, -1.0, -t)); }
    case 4u: { return normalize(vec3f(s, -t, 1.0)); }
    default: { return normalize(vec3f(-s, -t, -1.0)); }
  }
}

/** Equirectangular uv of a direction: u = 0.5 looks along +X, v = 0 is straight up. */
fn equirect_uv(d: vec3f) -> vec2f {
  return vec2f(atan2(d.z, d.x) / (2.0 * PI) + 0.5, acos(clamp(d.y, -1.0, 1.0)) / PI);
}

fn hammersley(i: u32, n: u32) -> vec2f {
  return vec2f(f32(i) / f32(n), f32(reverseBits(i)) * 2.3283064365386963e-10);
}

/** A GGX-distributed half vector around n (alpha = roughness²). */
fn importance_ggx(xi: vec2f, n: vec3f, a: f32) -> vec3f {
  let phi = 2.0 * PI * xi.x;
  let cos_theta = sqrt((1.0 - xi.y) / (1.0 + (a * a - 1.0) * xi.y));
  let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
  let h = vec3f(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta);
  let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.z) < 0.999);
  let tx = normalize(cross(up, n));
  let ty = cross(n, tx);
  return normalize(tx * h.x + ty * h.y + n * h.z);
}

/** The nine real spherical harmonics basis functions (bands 0-2) at a unit direction. */
fn sh_basis(d: vec3f) -> array<f32, 9> {
  return array<f32, 9>(
    0.282095,
    0.488603 * d.y,
    0.488603 * d.z,
    0.488603 * d.x,
    1.092548 * d.x * d.y,
    1.092548 * d.y * d.z,
    0.315392 * (3.0 * d.z * d.z - 1.0),
    1.092548 * d.x * d.z,
    0.546274 * (d.x * d.x - d.y * d.y),
  );
}`,
  'shard::env::from_equirect': `
import shard::env::common::{ cube_dir, equirect_uv };

@group(0) @binding(0) var input: texture_2d<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output).x;
  if (id.x >= size || id.y >= size) { return; }
  var c = vec3f(0.0);
  // 2x2 supersampling: a 512² face covers several equirect texels near the poles.
  for (var j = 0u; j < 2u; j++) {
    for (var i = 0u; i < 2u; i++) {
      let uv = (vec2f(id.xy) + (vec2f(f32(i), f32(j)) + 0.5) * 0.5) / f32(size);
      c += textureSampleLevel(input, input_sampler, equirect_uv(cube_dir(id.z, uv)), 0.0).rgb;
    }
  }
  textureStore(output, id.xy, id.z, vec4f(c * 0.25, 1.0));
}`,

  'shard::env::from_cube': `
import shard::env::common::cube_dir;

@group(0) @binding(0) var input: texture_cube<f32>;
@group(0) @binding(1) var input_sampler: sampler;
@group(0) @binding(2) var output: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(output).x;
  if (id.x >= size || id.y >= size) { return; }
  let uv = (vec2f(id.xy) + 0.5) / f32(size);
  let c = textureSampleLevel(input, input_sampler, cube_dir(id.z, uv), 0.0).rgb;
  textureStore(output, id.xy, id.z, vec4f(c, 1.0));
}`,

  'shard::env::downsample': `
@group(0) @binding(0) var src: texture_2d_array<f32>;
@group(0) @binding(1) var dst: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst).x;
  if (id.x >= size || id.y >= size) { return; }
  let p = vec2i(id.xy) * 2;
  let face = i32(id.z);
  let c = textureLoad(src, p, face, 0) + textureLoad(src, p + vec2i(1, 0), face, 0)
    + textureLoad(src, p + vec2i(0, 1), face, 0) + textureLoad(src, p + vec2i(1, 1), face, 0);
  textureStore(dst, id.xy, id.z, vec4f(c.rgb * 0.25, 1.0));
}`,

  'shard::env::sh': `
import shard::env::common::{ PI, cube_dir, sh_basis };

@group(0) @binding(0) var src: texture_2d_array<f32>;
/** Output: SH9 coefficients already convolved with the cosine lobe and divided by π. */
@group(0) @binding(1) var<storage, read_write> sh: array<vec4f, 9>;

var<workgroup> acc: array<array<vec4f, 9>, 64>;

@compute @workgroup_size(64)
fn main(@builtin(local_invocation_index) t: u32) {
  let n = textureDimensions(src).x;
  var c: array<vec4f, 9>;
  for (var k = 0u; k < 9u; k++) { c[k] = vec4f(0.0); }
  let total = 6u * n * n;
  for (var i = t; i < total; i += 64u) {
    let face = i / (n * n);
    let r = i % (n * n);
    let x = r % n;
    let y = r / n;
    let uv = (vec2f(f32(x), f32(y)) + 0.5) / f32(n);
    let st = uv * 2.0 - 1.0;
    // Solid angle of the texel.
    let w = 4.0 / (f32(n * n) * pow(1.0 + dot(st, st), 1.5));
    let radiance = textureLoad(src, vec2u(x, y), face, 0).rgb;
    let b = sh_basis(cube_dir(face, uv));
    for (var k = 0u; k < 9u; k++) { c[k] += vec4f(radiance * b[k] * w, w); }
  }
  acc[t] = c;
  workgroupBarrier();
  for (var stride = 32u; stride > 0u; stride = stride / 2u) {
    if (t < stride) {
      for (var k = 0u; k < 9u; k++) { acc[t][k] += acc[t + stride][k]; }
    }
    workgroupBarrier();
  }
  if (t == 0u) {
    // Normalize the solid angles to exactly 4π, then apply the cosine lobe (Â_l / π).
    let norm = 4.0 * PI / acc[0][0].w;
    let band = array<f32, 9>(1.0, 2.0 / 3.0, 2.0 / 3.0, 2.0 / 3.0, 0.25, 0.25, 0.25, 0.25, 0.25);
    for (var k = 0u; k < 9u; k++) { sh[k] = vec4f(acc[0][k].rgb * norm * band[k], 0.0); }
  }
}`,

  'shard::env::specular': `
import shard::env::common::{ PI, cube_dir, hammersley, importance_ggx };
import shard::pbr::brdf::d_ggx;

struct Params { roughness: f32, source_size: f32, size: f32, _pad: f32 }

@group(0) @binding(0) var src: texture_cube<f32>;
@group(0) @binding(1) var src_sampler: sampler;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba16float, write>;
@group(0) @binding(3) var<uniform> params: Params;

const SAMPLES: u32 = 64u;

/** GGX prefiltering with filtered importance sampling (Křivánek & Colbert): n = v = r. */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = u32(params.size);
  if (id.x >= size || id.y >= size) { return; }
  let n = cube_dir(id.z, (vec2f(id.xy) + 0.5) / f32(size));
  if (params.roughness <= 0.0) {
    let c = textureSampleLevel(src, src_sampler, n, log2(params.source_size / f32(size)));
    textureStore(dst, id.xy, id.z, vec4f(c.rgb, 1.0));
    return;
  }
  let a = params.roughness * params.roughness;
  let omega_p = 4.0 * PI / (6.0 * params.source_size * params.source_size);
  var color = vec3f(0.0);
  var weight = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let h = importance_ggx(hammersley(i, SAMPLES), n, a);
    let l = normalize(2.0 * dot(n, h) * h - n);
    let n_dot_l = dot(n, l);
    if (n_dot_l <= 0.0) { continue; }
    let n_dot_h = max(dot(n, h), 0.0);
    // pdf of l with v = n: D(h) · (n·h) / (4 (v·h)) = D / 4.
    let pdf = d_ggx(n_dot_h, a) * 0.25 + 1e-6;
    let omega_s = 1.0 / (f32(SAMPLES) * pdf);
    let lod = max(0.5 * log2(omega_s / omega_p) + 1.0, 0.0);
    color += textureSampleLevel(src, src_sampler, l, lod).rgb * n_dot_l;
    weight += n_dot_l;
  }
  textureStore(dst, id.xy, id.z, vec4f(color / max(weight, 1e-6), 1.0));
}`,

  'shard::env::brdf_lut': `
import shard::env::common::{ hammersley, importance_ggx };
import shard::pbr::brdf::v_smith_ggx_correlated;

@group(0) @binding(0) var lut: texture_storage_2d<rgba16float, write>;

const SAMPLES: u32 = 256u;

/** Split-sum BRDF scale and bias: x = n·v, y = roughness. Same visibility term as direct light. */
@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let dim = textureDimensions(lut);
  if (id.x >= dim.x || id.y >= dim.y) { return; }
  let n_dot_v = (f32(id.x) + 0.5) / f32(dim.x);
  let roughness = (f32(id.y) + 0.5) / f32(dim.y);
  let a = roughness * roughness;
  let v = vec3f(sqrt(1.0 - n_dot_v * n_dot_v), 0.0, n_dot_v);
  let n = vec3f(0.0, 0.0, 1.0);
  var scale = 0.0;
  var bias = 0.0;
  for (var i = 0u; i < SAMPLES; i++) {
    let h = importance_ggx(hammersley(i, SAMPLES), n, a);
    let l = 2.0 * dot(v, h) * h - v;
    let n_dot_l = max(l.z, 0.0);
    let n_dot_h = max(h.z, 0.0);
    let v_dot_h = max(dot(v, h), 0.0);
    if (n_dot_l <= 0.0) { continue; }
    let g_vis = v_smith_ggx_correlated(n_dot_v, n_dot_l, a) * 4.0 * n_dot_l * v_dot_h / max(n_dot_h, 1e-6);
    let fc = pow(1.0 - v_dot_h, 5.0);
    scale += (1.0 - fc) * g_vis;
    bias += fc * g_vis;
  }
  textureStore(lut, id.xy, vec4f(scale / f32(SAMPLES), bias / f32(SAMPLES), 0.0, 1.0));
}`,

  'shard::sky::background': `
import shard::view::view;
import shard::pbr::environment::environment_background;

struct Background {
  /** brightness, unused ×3. */
  params: vec4f,
}

@group(1) @binding(0) var<uniform> background: Background;

struct BackgroundOutput {
  @builtin(position) clip: vec4f,
  @location(0) ndc: vec2f,
}

/** A fullscreen triangle at depth 0 (reversed-Z infinity): it only draws where nothing else did. */
@vertex fn vs(@builtin(vertex_index) i: u32) -> BackgroundOutput {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u)) * 2.0 - 1.0;
  var out: BackgroundOutput;
  out.clip = vec4f(xy, 0.0, 1.0);
  out.ndc = xy;
  return out;
}

@fragment fn fs(in: BackgroundOutput) -> @location(0) vec4f {
  let near = view.invViewProj * vec4f(in.ndc, 1.0, 1.0);
  let far = view.invViewProj * vec4f(in.ndc, 0.5, 1.0);
  let d = normalize(far.xyz / far.w - near.xyz / near.w);
  let color = environment_background(d) * background.params.x;
  // Pre-exposed, and kept inside what rgba16float holds.
  return vec4f(min(color * view.exposure, vec3f(60000.0)), 1.0);
}`,
}
