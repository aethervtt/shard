import { MAX_WATER_BODIES } from '../bodies'

// The sea on the GPU (0098), as image kernels: each writes one storage texture at its invocation
// id, so the full tier dispatches them as written and the baseline tier runs the same WGSL as
// fragment passes (0064's fragmentKernel). Per frame, for every cascade layer at once:
//
// 1. evolve: h(k, t) from h0 (and the old h0 during a crossfade), packed into four complex fields
//    two to an rgba32float layer: (Dx + iDz, h + iDxz) and (∂h/∂x + i∂h/∂z, Dxx + iDzz);
// 2. fft: a Stockham radix-2 stage of the inverse FFT, log₂N along x, then log₂N along z;
// 3. resolve: the real fields, signs and choppiness applied, into rgba16float: displacement and
//    foam (accumulated from the Jacobian), then derivatives for normals.

/** Cascade layers on the GPU at most, across every body's sea. */
export const MAX_WAVE_LAYERS = 8
/** Floats of the evolve and resolve uniforms: a header, then a vec4 per layer. */
export const KERNEL_FLOATS = 4 + MAX_WAVE_LAYERS * 4
/** Floats of the water pass's waves uniform: a vec4 per layer, two per body. */
export const SURFACE_WAVES_FLOATS = (MAX_WAVE_LAYERS + MAX_WATER_BODIES * 2) * 4

export const WAVE_KERNELS: Record<string, string> = {
  'water::waves::evolve': `
struct Evolve {
  /** Sea time (s, looped), and the number of layers. */
  head: vec4f,
  /** Per cascade: the crossfade weight (x: 1 the new sea). */
  layers: array<vec4f, ${MAX_WAVE_LAYERS}>,
}

@group(0) @binding(0) var<uniform> params: Evolve;
/** Per cascade c: layer 3c the new h0 pair, 3c + 1 the old, 3c + 2 (ω new, ω old, kx, kz). */
@group(0) @binding(1) var spectrum: texture_2d_array<f32>;
@group(0) @binding(2) var out_fft: texture_storage_2d_array<rgba32float, write>;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/** h(k, t) = h0(k) e^(−iωt) + conj(h0(−k)) e^(iωt): waves travel along k. */
fn evolve(h0: vec4f, omega: f32, t: f32) -> vec2f {
  // ω is a multiple of 2π / 8192 s and t is below 8192 s: the phase in turns, wrapped first.
  let turns = fract(omega * (t / 6.283185307179586));
  let a = turns * 6.283185307179586;
  let e = vec2f(cos(a), sin(a));
  return cmul(h0.xy, vec2f(e.x, -e.y)) + cmul(h0.zw, e);
}

@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_fft);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let c = id.z / 2u;
  let t = params.head.x;
  let w = params.layers[c].x;
  let at = vec2i(id.xy);
  let spec = textureLoad(spectrum, at, i32(c * 3u + 2u), 0);
  var h = evolve(textureLoad(spectrum, at, i32(c * 3u), 0), spec.x, t) * w;
  if (w < 1.0) {
    h += evolve(textureLoad(spectrum, at, i32(c * 3u + 1u), 0), spec.y, t) * (1.0 - w);
  }
  let kx = spec.z;
  let kz = spec.w;
  let k = max(sqrt(kx * kx + kz * kz), 1e-6);
  // i·h, −i·h: the derivatives and the horizontal displacement in frequency space.
  let ih = vec2f(-h.y, h.x);
  var value: vec4f;
  if (id.z % 2u == 0u) {
    // Dx + iDz, with Dx = −i kx/k h and Dz = −i kz/k h; then h + iDxz, Dxz = kx kz / k h.
    let dx = -ih * (kx / k);
    let dz = -ih * (kz / k);
    let dxz = h * (kx * kz / k);
    value = vec4f(dx + vec2f(-dz.y, dz.x), h + vec2f(-dxz.y, dxz.x));
  } else {
    // ∂h/∂x + i∂h/∂z (i kx h, i kz h); then Dxx + iDzz (kx²/k h, kz²/k h).
    let hx = ih * kx;
    let hz = ih * kz;
    let dxx = h * (kx * kx / k);
    let dzz = h * (kz * kz / k);
    value = vec4f(hx + vec2f(-hz.y, hz.x), dxx + vec2f(-dzz.y, dzz.x));
  }
  textureStore(out_fft, at, id.z, value);
}`,

  'water::waves::fft': `
struct Stage {
  /** x: the stage (Ns = 2^x), y: 1 along z, z: N. */
  stage: vec4u,
}

@group(0) @binding(0) var<uniform> stage: Stage;
@group(0) @binding(1) var src: texture_2d_array<f32>;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba32float, write>;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/**
 * One radix-2 Stockham stage of an inverse FFT (Govindaraju et al.'s FftIteration, one output a
 * texel): output o takes inputs j and j + N/2, where j comes back from o's place in the
 * autosorted order. Two complex numbers a texel, transformed alike.
 */
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(dst);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let n = stage.stage.z;
  let ns = 1u << stage.stage.x;
  let along_z = stage.stage.y == 1u;
  let o = select(id.x, id.y, along_z);
  let r = (o % (2u * ns)) / ns;
  let jm = o % ns;
  let j = (o / (2u * ns)) * ns + jm;
  var p0 = vec2i(id.xy);
  var p1 = vec2i(id.xy);
  if (along_z) {
    p0.y = i32(j);
    p1.y = i32(j + n / 2u);
  } else {
    p0.x = i32(j);
    p1.x = i32(j + n / 2u);
  }
  let v0 = textureLoad(src, p0, i32(id.z), 0);
  let v1 = textureLoad(src, p1, i32(id.z), 0);
  let angle = 6.283185307179586 * f32(jm) / f32(2u * ns);
  let w = vec2f(cos(angle), sin(angle));
  let t = vec4f(cmul(w, v1.xy), cmul(w, v1.zw));
  textureStore(dst, vec2i(id.xy), id.z, select(v0 + t, v0 - t, r == 1u));
}`,

  'water::waves::fft_line': `
struct Stage {
  /** y: 1 along z, z: N. */
  stage: vec4u,
}

@group(0) @binding(0) var<uniform> stage: Stage;
@group(0) @binding(1) var src: texture_2d_array<f32>;
@group(0) @binding(2) var dst: texture_storage_2d_array<rgba32float, write>;

/** A line of the field, twice (ping-pong): 512 texels of two complex numbers, 16 KiB. */
var<workgroup> line: array<array<vec4f, 512>, 2>;

fn cmul(a: vec2f, b: vec2f) -> vec2f {
  return vec2f(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

/**
 * The full tier's inverse FFT of one line (a row, or a column along z) in workgroup memory: every
 * Stockham stage of water::waves::fft, the same butterflies in the same order, without a trip
 * through memory between them. Workgroup (line, layer).
 */
@compute @workgroup_size(256, 1, 1) fn main(
  @builtin(local_invocation_id) local: vec3u,
  @builtin(workgroup_id) group: vec3u,
) {
  let n = stage.stage.z;
  let half = n / 2u;
  let along_z = stage.stage.y == 1u;
  let t = local.x;
  let layer = i32(group.y);
  var stages = 0u;
  for (var m = n; m > 1u; m = m / 2u) { stages++; }
  if (t < half) {
    for (var e = 0u; e < 2u; e++) {
      let i = t + e * half;
      let p = select(vec2i(i32(i), i32(group.x)), vec2i(i32(group.x), i32(i)), along_z);
      line[0][i] = textureLoad(src, p, layer, 0);
    }
  }
  workgroupBarrier();
  var current = 0u;
  for (var s = 0u; s < stages; s++) {
    let ns = 1u << s;
    if (t < half) {
      let jm = t % ns;
      let v0 = line[current][t];
      let v1 = line[current][t + half];
      let angle = 6.283185307179586 * f32(jm) / f32(2u * ns);
      let w = vec2f(cos(angle), sin(angle));
      let d = vec4f(cmul(w, v1.xy), cmul(w, v1.zw));
      let o = (t / ns) * 2u * ns + jm;
      line[1u - current][o] = v0 + d;
      line[1u - current][o + ns] = v0 - d;
    }
    workgroupBarrier();
    current = 1u - current;
  }
  if (t < half) {
    for (var e = 0u; e < 2u; e++) {
      let i = t + e * half;
      let p = select(vec2i(i32(i), i32(group.x)), vec2i(i32(group.x), i32(i)), along_z);
      textureStore(dst, p, layer, line[current][i]);
    }
  }
}`,

  'water::waves::resolve': `
struct Resolve {
  /** Seconds since the last frame (foam), the number of layers. */
  head: vec4f,
  /** Per cascade: choppiness λ, foam threshold, growth, decay. */
  layers: array<vec4f, ${MAX_WAVE_LAYERS}>,
}

@group(0) @binding(0) var<uniform> params: Resolve;
/** The inverse FFT's result, two layers a cascade. */
@group(0) @binding(1) var fields: texture_2d_array<f32>;
/** Last frame's resolved waves: its foam carries on. */
@group(0) @binding(2) var previous: texture_2d_array<f32>;
@group(0) @binding(3) var out_waves: texture_storage_2d_array<rgba16float, write>;

/**
 * Per cascade c: layer 2c is the displacement (x, height, z) and foam; layer 2c + 1 the derivatives
 * (∂h/∂x, ∂h/∂z, ∂Dx/∂x, ∂Dz/∂z), choppiness applied.
 */
@compute @workgroup_size(8, 8, 1) fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = textureDimensions(out_waves);
  if (id.x >= size.x || id.y >= size.y) { return; }
  let c = id.z / 2u;
  let at = vec2i(id.xy);
  // The spectrum was centred at N/2: the inverse FFT's output alternates sign by texel.
  let sign = select(1.0, -1.0, ((id.x + id.y) & 1u) == 1u);
  let a = textureLoad(fields, at, i32(c * 2u), 0) * sign;
  let b = textureLoad(fields, at, i32(c * 2u + 1u), 0) * sign;
  let p = params.layers[c];
  let lambda = p.x;
  var value: vec4f;
  if (id.z % 2u == 0u) {
    let dxx = lambda * b.z;
    let dzz = lambda * b.w;
    let dxz = lambda * a.w;
    let jacobian = (1.0 + dxx) * (1.0 + dzz) - dxz * dxz;
    let dt = params.head.x;
    let before = textureLoad(previous, at, i32(id.z), 0).w;
    let fold = max((1.0 - jacobian) - p.y, 0.0);
    let foam = clamp(before * exp(-p.w * dt) + p.z * dt * fold * 4.0, 0.0, 1.0);
    value = vec4f(lambda * a.x, a.z, lambda * a.y, foam);
  } else {
    value = vec4f(b.x, b.y, lambda * b.z, lambda * b.w);
  }
  textureStore(out_waves, at, id.z, value);
}`,
}
