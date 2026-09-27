import { FRACTAL, type NoiseProgram, OP, WIDTH } from './compile'
import { SOURCE_KINDS } from './nodes'

/**
 * `shard::noise`: the sources and helpers, mirroring `crates/shard-noise` operation for operation
 * (same constants, same evaluation order) so GPU results match the CPU within the tolerance.
 */
export const NOISE_LIBRARY = /* wgsl */ `
const PX: u32 = 501125321u;
const PY: u32 = 1136930381u;
const PZ: u32 = 1720413743u;
const PW: u32 = 1066037191u;
const SEED_FLIP_3D: u32 = 0x52d547b3u;
const SQRT_2: f32 = 1.4142135623730951;
const LN_2: f32 = 0.6931471805599453;
const G2: f32 = 0.2113248654051871;
const G4: f32 = 0.1381966011250105;
const F2: f32 = 0.3660254037844386;
const F4: f32 = 0.3090169943749474;
const TWO_THIRDS: f32 = 2.0 / 3.0;
const PERLIN2_SCALE: f32 = 1.0;
const PERLIN3_SCALE: f32 = 1.0;
const SIMPLEX2_SCALE: f32 = 70.0;
const SIMPLEX3_SCALE: f32 = 32.0;
const SIMPLEX4_SCALE: f32 = 27.0;

/** One source octave's lattice origin: the integer cell and the fraction (from the CPU, in f64). */
struct NoiseOrigin {
  cell: vec4i,
  frac: vec4f,
}

fn mix32(x: u32) -> u32 {
  var h = x ^ (x >> 16u);
  h = h * 0x7feb352du;
  h = h ^ (h >> 15u);
  h = h * 0x846ca68bu;
  return h ^ (h >> 16u);
}

fn fnv(h: u32, b: u32) -> u32 {
  return (h ^ b) * 0x01000193u;
}

/** hashSeed(seed, label) from @aethervtt/shard-core, for a numeric label. */
fn hash_seed(seed: u32, label: u32) -> u32 {
  var h = 0x811c9dc5u;
  h = fnv(h, label & 0xffu);
  h = fnv(h, (label >> 8u) & 0xffu);
  h = fnv(h, (label >> 16u) & 0xffu);
  h = fnv(h, label >> 24u);
  return ((seed ^ h) * 0x9e3779b1u) ^ fnv(h, 0x23u);
}

fn hash2(seed: u32, x: u32, y: u32) -> u32 { return mix32(seed ^ x ^ y); }
fn hash3(seed: u32, x: u32, y: u32, z: u32) -> u32 { return mix32(seed ^ x ^ y ^ z); }
fn hash4(seed: u32, x: u32, y: u32, z: u32, w: u32) -> u32 { return mix32(seed ^ x ^ y ^ z ^ w); }

fn to_value(h: u32) -> f32 {
  return f32(h >> 8u) * (2.0 / 16777215.0) - 1.0;
}

fn flip(x: f32, s: u32) -> f32 {
  return bitcast<f32>(bitcast<u32>(x) ^ s);
}

fn fade(t: f32) -> f32 {
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn lerp(a: f32, b: f32, t: f32) -> f32 {
  return a + t * (b - a);
}

fn grad_hash2(seed: u32, x: u32, y: u32) -> u32 { return ((seed ^ x ^ y) * 0x27d4eb2du) >> 29u; }
fn grad_hash3(seed: u32, x: u32, y: u32, z: u32) -> u32 { return ((seed ^ x ^ y ^ z) * 0x27d4eb2du) >> 28u; }
fn grad_hash4(seed: u32, x: u32, y: u32, z: u32, w: u32) -> u32 { return ((seed ^ x ^ y ^ z ^ w) * 0x27d4eb2du) >> 27u; }

fn grad2(h: u32, x: f32, y: f32) -> f32 {
  let s0 = h << 31u;
  let s1 = (h & 2u) << 30u;
  let diag = flip(x, s0) + flip(y, s1);
  let axis = flip(select(y, x, (h & 2u) == 0u), s0) * SQRT_2;
  return select(axis, diag, h < 4u);
}

fn grad3(g: u32, x: f32, y: f32, z: f32) -> f32 {
  let drop = g >> 2u;
  let a = select(x, y, drop == 0u);
  let b = select(z, y, drop == 2u);
  return flip(a, g << 31u) + flip(b, (g & 2u) << 30u);
}

fn grad4(h: u32, x: f32, y: f32, z: f32, w: f32) -> f32 {
  let axis = h >> 3u;
  let a = select(x, y, axis == 0u);
  let b = select(y, z, axis < 2u);
  let d = select(z, w, axis < 3u);
  return flip(a, h << 31u) + flip(b, (h & 2u) << 30u) + flip(d, (h & 4u) << 29u);
}

fn unit(v: f32) -> f32 {
  return clamp(v, -1.0, 1.0);
}

fn value2(seed: u32, ix: i32, iy: i32, px: f32, py: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let x0 = bitcast<u32>(ix + i32(fx)) * PX;
  let y0 = bitcast<u32>(iy + i32(fy)) * PY;
  let x1 = x0 + PX;
  let y1 = y0 + PY;
  let u = fade(px - fx);
  let v = fade(py - fy);
  let a = lerp(to_value(hash2(seed, x0, y0)), to_value(hash2(seed, x1, y0)), u);
  let b = lerp(to_value(hash2(seed, x0, y1)), to_value(hash2(seed, x1, y1)), u);
  return lerp(a, b, v);
}

fn value3(seed: u32, ix: i32, iy: i32, iz: i32, px: f32, py: f32, pz: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let fz = floor(pz);
  let x0 = bitcast<u32>(ix + i32(fx)) * PX;
  let y0 = bitcast<u32>(iy + i32(fy)) * PY;
  let z0 = bitcast<u32>(iz + i32(fz)) * PZ;
  let x1 = x0 + PX;
  let y1 = y0 + PY;
  let z1 = z0 + PZ;
  let u = fade(px - fx);
  let v = fade(py - fy);
  let w = fade(pz - fz);
  let a = lerp(to_value(hash3(seed, x0, y0, z0)), to_value(hash3(seed, x1, y0, z0)), u);
  let b = lerp(to_value(hash3(seed, x0, y1, z0)), to_value(hash3(seed, x1, y1, z0)), u);
  let d = lerp(to_value(hash3(seed, x0, y0, z1)), to_value(hash3(seed, x1, y0, z1)), u);
  let e = lerp(to_value(hash3(seed, x0, y1, z1)), to_value(hash3(seed, x1, y1, z1)), u);
  return lerp(lerp(a, b, v), lerp(d, e, v), w);
}

fn perlin2(seed: u32, ix: i32, iy: i32, px: f32, py: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let tx = px - fx;
  let ty = py - fy;
  let x0 = bitcast<u32>(ix + i32(fx)) * PX;
  let y0 = bitcast<u32>(iy + i32(fy)) * PY;
  let x1 = x0 + PX;
  let y1 = y0 + PY;
  let tx1 = tx - 1.0;
  let ty1 = ty - 1.0;
  let u = fade(tx);
  let v = fade(ty);
  let a = lerp(grad2(grad_hash2(seed, x0, y0), tx, ty), grad2(grad_hash2(seed, x1, y0), tx1, ty), u);
  let b = lerp(grad2(grad_hash2(seed, x0, y1), tx, ty1), grad2(grad_hash2(seed, x1, y1), tx1, ty1), u);
  return unit(lerp(a, b, v) * PERLIN2_SCALE);
}

fn perlin3(seed: u32, ix: i32, iy: i32, iz: i32, px: f32, py: f32, pz: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let fz = floor(pz);
  let tx = px - fx;
  let ty = py - fy;
  let tz = pz - fz;
  let x0 = bitcast<u32>(ix + i32(fx)) * PX;
  let y0 = bitcast<u32>(iy + i32(fy)) * PY;
  let z0 = bitcast<u32>(iz + i32(fz)) * PZ;
  let x1 = x0 + PX;
  let y1 = y0 + PY;
  let z1 = z0 + PZ;
  let tx1 = tx - 1.0;
  let ty1 = ty - 1.0;
  let tz1 = tz - 1.0;
  let u = fade(tx);
  let v = fade(ty);
  let w = fade(tz);
  let a = lerp(grad3(grad_hash3(seed, x0, y0, z0), tx, ty, tz), grad3(grad_hash3(seed, x1, y0, z0), tx1, ty, tz), u);
  let b = lerp(grad3(grad_hash3(seed, x0, y1, z0), tx, ty1, tz), grad3(grad_hash3(seed, x1, y1, z0), tx1, ty1, tz), u);
  let d = lerp(grad3(grad_hash3(seed, x0, y0, z1), tx, ty, tz1), grad3(grad_hash3(seed, x1, y0, z1), tx1, ty, tz1), u);
  let e = lerp(grad3(grad_hash3(seed, x0, y1, z1), tx, ty1, tz1), grad3(grad_hash3(seed, x1, y1, z1), tx1, ty1, tz1), u);
  return unit(lerp(lerp(a, b, v), lerp(d, e, v), w) * PERLIN3_SCALE);
}

fn falloff(r2: f32, d2: f32) -> f32 {
  let a = max(r2 - d2, 0.0);
  let a2 = a * a;
  return a2 * a2;
}

fn simplex2(seed: u32, ix: i32, iy: i32, px: f32, py: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let xi = px - fx;
  let yi = py - fy;
  let t = (xi + yi) * G2;
  let x0 = xi - t;
  let y0 = yi - t;
  let xb = bitcast<u32>(ix + i32(fx)) * PX;
  let yb = bitcast<u32>(iy + i32(fy)) * PY;
  let lower = y0 < x0;
  let i1 = select(0.0, 1.0, lower);
  let j1 = 1.0 - i1;
  let x1 = x0 - i1 + G2;
  let y1 = y0 - j1 + G2;
  let x2 = x0 - 1.0 + 2.0 * G2;
  let y2 = y0 - 1.0 + 2.0 * G2;
  let h0 = grad_hash2(seed, xb, yb);
  let h1 = grad_hash2(seed, xb + select(0u, PX, lower), yb + select(PY, 0u, lower));
  let h2 = grad_hash2(seed, xb + PX, yb + PY);
  let n0 = falloff(0.5, x0 * x0 + y0 * y0) * grad2(h0, x0, y0);
  let n1 = falloff(0.5, x1 * x1 + y1 * y1) * grad2(h1, x1, y1);
  let n2 = falloff(0.5, x2 * x2 + y2 * y2) * grad2(h2, x2, y2);
  return unit((n0 + n1 + n2) * SIMPLEX2_SCALE);
}

fn simplex3(seed: u32, ix: i32, iy: i32, iz: i32, px: f32, py: f32, pz: f32) -> f32 {
  let rx = round(px);
  let ry = round(py);
  let rz = round(pz);
  var xb = bitcast<u32>(ix + i32(rx)) * PX;
  var yb = bitcast<u32>(iy + i32(ry)) * PY;
  var zb = bitcast<u32>(iz + i32(rz)) * PZ;
  var xr = px - rx;
  var yr = py - ry;
  var zr = pz - rz;
  var xs = select(-1, 1, xr < 0.0);
  var ys = select(-1, 1, yr < 0.0);
  var zs = select(-1, 1, zr < 0.0);
  var ax = abs(xr);
  var ay = abs(yr);
  var az = abs(zr);
  var a = (0.6 - xr * xr) - (yr * yr + zr * zr);
  var s = seed;
  var value = 0.0;
  for (var l = 0; l < 2; l++) {
    let a0 = max(a, 0.0);
    let a2 = a0 * a0;
    value = value + a2 * a2 * grad3(grad_hash3(s, xb, yb, zb), xr, yr, zr);
    let mx = ax >= ay && ax >= az;
    let my = !mx && ay >= az;
    let mz = !(mx || my);
    let am = select(select(az, ay, my), ax, mx);
    let b0 = max(a + am + am - 1.0, 0.0);
    let b2 = b0 * b0;
    let hx = xb - select(0u, bitcast<u32>(xs) * PX, mx);
    let hy = yb - select(0u, bitcast<u32>(ys) * PY, my);
    let hz = zb - select(0u, bitcast<u32>(zs) * PZ, mz);
    let ox = xr + select(0.0, f32(xs), mx);
    let oy = yr + select(0.0, f32(ys), my);
    let oz = zr + select(0.0, f32(zs), mz);
    value = value + b2 * b2 * grad3(grad_hash3(s, hx, hy, hz), ox, oy, oz);
    if (l == 1) { break; }
    ax = 0.5 - ax;
    ay = 0.5 - ay;
    az = 0.5 - az;
    xr = f32(xs) * ax;
    yr = f32(ys) * ay;
    zr = f32(zs) * az;
    a = a + ((0.75 - ax) - (ay + az));
    xb = xb + select(0u, PX, xs == -1);
    yb = yb + select(0u, PY, ys == -1);
    zb = zb + select(0u, PZ, zs == -1);
    xs = -xs;
    ys = -ys;
    zs = -zs;
    s = s ^ SEED_FLIP_3D;
  }
  return unit(value * SIMPLEX3_SCALE);
}

fn simplex4(seed: u32, ix: i32, iy: i32, iz: i32, iw: i32, px: f32, py: f32, pz: f32, pw: f32) -> f32 {
  let fx = floor(px);
  let fy = floor(py);
  let fz = floor(pz);
  let fw = floor(pw);
  let xi = px - fx;
  let yi = py - fy;
  let zi = pz - fz;
  let wi = pw - fw;
  let t = (xi + yi + zi + wi) * G4;
  let x0 = xi - t;
  let y0 = yi - t;
  let z0 = zi - t;
  let w0 = wi - t;
  var rx = 0;
  var ry = 0;
  var rz = 0;
  var rw = 0;
  if (y0 < x0) { rx += 1; } else { ry += 1; }
  if (z0 < x0) { rx += 1; } else { rz += 1; }
  if (w0 < x0) { rx += 1; } else { rw += 1; }
  if (z0 < y0) { ry += 1; } else { rz += 1; }
  if (w0 < y0) { ry += 1; } else { rw += 1; }
  if (w0 < z0) { rz += 1; } else { rw += 1; }
  let xb = bitcast<u32>(ix + i32(fx)) * PX;
  let yb = bitcast<u32>(iy + i32(fy)) * PY;
  let zb = bitcast<u32>(iz + i32(fz)) * PZ;
  let wb = bitcast<u32>(iw + i32(fw)) * PW;
  var value = 0.0;
  for (var k = 0; k < 5; k++) {
    let at = 4 - k;
    let sx = rx >= at;
    let sy = ry >= at;
    let sz = rz >= at;
    let sw = rw >= at;
    let off = f32(k) * G4;
    let x = x0 - select(0.0, 1.0, sx) + off;
    let y = y0 - select(0.0, 1.0, sy) + off;
    let z = z0 - select(0.0, 1.0, sz) + off;
    let w = w0 - select(0.0, 1.0, sw) + off;
    let h = grad_hash4(seed, xb + select(0u, PX, sx), yb + select(0u, PY, sy), zb + select(0u, PZ, sz), wb + select(0u, PW, sw));
    value = value + falloff(0.6, x * x + y * y + z * z + w * w) * grad4(h, x, y, z, w);
  }
  return unit(value * SIMPLEX4_SCALE);
}

fn jitter_of(h: u32, shift: u32) -> f32 {
  return f32((h >> shift) & 1023u) * (1.0 / 1023.0) - 0.5;
}

fn cell_result(ret: i32, metric: i32, b1: f32, b2: f32, bh: u32) -> f32 {
  var d1 = b1;
  var d2 = b2;
  if (metric == 0) {
    d1 = sqrt(b1);
    d2 = sqrt(b2);
  }
  if (ret == 0) { return d1; }
  if (ret == 1) { return d2; }
  if (ret == 2) { return d2 - d1; }
  return to_value(mix32(bh));
}

fn cell_distance(metric: i32, fx: f32, fy: f32, fz: f32) -> f32 {
  if (metric == 1) { return abs(fx) + abs(fy) + abs(fz); }
  if (metric == 2) { return max(max(abs(fx), abs(fy)), abs(fz)); }
  return fx * fx + fy * fy + fz * fz;
}

fn cellular2(seed: u32, ix: i32, iy: i32, px: f32, py: f32, jitter: f32, metric: i32, ret: i32) -> f32 {
  let fx0 = floor(px);
  let fy0 = floor(py);
  let tx = px - fx0;
  let ty = py - fy0;
  let xb = bitcast<u32>(ix + i32(fx0)) * PX;
  let yb = bitcast<u32>(iy + i32(fy0)) * PY;
  var b1 = 1e10;
  var b2 = 1e10;
  var bh = 0u;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let h = hash2(seed, xb + bitcast<u32>(dx) * PX, yb + bitcast<u32>(dy) * PY);
      let fx = f32(dx) + 0.5 + jitter * jitter_of(h, 0u) - tx;
      let fy = f32(dy) + 0.5 + jitter * jitter_of(h, 10u) - ty;
      var d = fx * fx + fy * fy;
      if (metric == 1) { d = abs(fx) + abs(fy); }
      if (metric == 2) { d = max(abs(fx), abs(fy)); }
      let m = d < b1;
      b2 = select(min(b2, d), b1, m);
      bh = select(bh, h, m);
      b1 = select(b1, d, m);
    }
  }
  return cell_result(ret, metric, b1, b2, bh);
}

fn cellular3(seed: u32, ix: i32, iy: i32, iz: i32, px: f32, py: f32, pz: f32, jitter: f32, metric: i32, ret: i32) -> f32 {
  let fx0 = floor(px);
  let fy0 = floor(py);
  let fz0 = floor(pz);
  let tx = px - fx0;
  let ty = py - fy0;
  let tz = pz - fz0;
  let xb = bitcast<u32>(ix + i32(fx0)) * PX;
  let yb = bitcast<u32>(iy + i32(fy0)) * PY;
  let zb = bitcast<u32>(iz + i32(fz0)) * PZ;
  var b1 = 1e10;
  var b2 = 1e10;
  var bh = 0u;
  for (var dz = -1; dz <= 1; dz++) {
    for (var dy = -1; dy <= 1; dy++) {
      for (var dx = -1; dx <= 1; dx++) {
        let h = hash3(seed, xb + bitcast<u32>(dx) * PX, yb + bitcast<u32>(dy) * PY, zb + bitcast<u32>(dz) * PZ);
        let fx = f32(dx) + 0.5 + jitter * jitter_of(h, 0u) - tx;
        let fy = f32(dy) + 0.5 + jitter * jitter_of(h, 10u) - ty;
        let fz = f32(dz) + 0.5 + jitter * jitter_of(h, 20u) - tz;
        let d = cell_distance(metric, fx, fy, fz);
        let m = d < b1;
        b2 = select(min(b2, d), b1, m);
        bh = select(bh, h, m);
        b1 = select(b1, d, m);
      }
    }
  }
  return cell_result(ret, metric, b1, b2, bh);
}

fn nlog2(x: f32) -> f32 {
  let bits = bitcast<i32>(x);
  let big0 = bitcast<f32>((bits & 0x007fffff) | 0x3f800000);
  let big = big0 > SQRT_2;
  let m = select(big0, big0 * 0.5, big);
  let e = f32(((bits >> 23u) & 0xff) - 127 + select(0, 1, big));
  let s = (m - 1.0) / (m + 1.0);
  let s2 = s * s;
  var p = 1.0 / 9.0;
  p = 1.0 / 7.0 + s2 * p;
  p = 1.0 / 5.0 + s2 * p;
  p = 1.0 / 3.0 + s2 * p;
  p = 1.0 + s2 * p;
  return e + s * p * (2.0 / LN_2);
}

fn nexp2(y0: f32) -> f32 {
  let y = clamp(y0, -126.0, 126.0);
  let n = floor(y + 0.5);
  let t = (y - n) * LN_2;
  var p = 1.0 / 720.0;
  p = 1.0 / 120.0 + t * p;
  p = 1.0 / 24.0 + t * p;
  p = 1.0 / 6.0 + t * p;
  p = 0.5 + t * p;
  p = 1.0 + t * p;
  p = 1.0 + t * p;
  return p * bitcast<f32>((i32(n) + 127) << 23u);
}

/** sign(x) × |x|^e, and 0 for |x| below 1e-30 (the kernel's power). */
fn pow_signed(x: f32, e: f32) -> f32 {
  let a = abs(x);
  let v = select(nexp2(e * nlog2(max(a, 1e-30))), 0.0, a < 1e-30);
  return flip(v, bitcast<u32>(x) & 0x80000000u);
}
`

/** A float as a WGSL literal that parses back to the same f32. */
function f(v: number): string {
  const x = Math.fround(v)
  if (Object.is(x, -0)) return '-0.0'
  const s = String(x)
  const lit = /[.e]/.test(s) ? s : `${s}.0`
  return x < 0 ? `(${lit})` : lit
}

const u = (v: number) => `${v >>> 0}u`
const i = (v: number) => (v < 0 ? `(${v | 0})` : `${v | 0}`)

export interface WgslOptions {
  /** Function name: `noise_<name>`. */
  readonly name: string
}

/**
 * Generates the graph's WGSL: straight-line code, one `let` per instruction in program order, with
 * every constant inlined. Exports `noise_<name>(p, seed)` for positions near the origin and
 * `noise_<name>_at(origin, local, seed)`, which reads per-octave origin records
 * (`noiseOrigins(graph, origin)` on the CPU) so precision doesn't depend on where `local` is.
 */
export function generateWgsl(program: NoiseProgram, options: WgslOptions): string {
  const name = options.name
  const records = program.terms.skew.length
  const pos = program.dimensions === 4 ? 'vec4f' : 'vec3f'
  const lines: string[] = [
    'import shard::noise::{ NoiseOrigin, hash_seed, value2, value3, perlin2, perlin3, simplex2, simplex3, simplex4, cellular2, cellular3, pow_signed };',
    '',
    `/** Origin records for noise_${name}_at: one per source octave. */`,
    `alias NoiseOrigins_${name} = array<NoiseOrigin, ${Math.max(records, 1)}>;`,
    `const NOISE_${name.toUpperCase()}_ORIGINS: u32 = ${records}u;`,
    '',
  ]
  const zero = program.zeroOrigins
  const zf = new Float32Array(zero.buffer, zero.byteOffset, zero.length)
  const plain = (k: number, part: 'cell' | 'frac', axis: number) =>
    part === 'cell' ? i(zero[k * 8 + axis]!) : f(zf[k * 8 + 4 + axis]!)
  const at = (k: number, part: 'cell' | 'frac', axis: number) =>
    `(*origin)[${k}].${part}.${'xyzw'[axis]}`

  lines.push(`fn noise_${name}(p: ${pos}, seed: u32) -> f32 {`)
  lines.push(...body(program, plain, 'p'), '}', '')
  lines.push(
    `fn noise_${name}_at(origin: ptr<function, NoiseOrigins_${name}>, local: ${pos}, seed: u32) -> f32 {`,
  )
  lines.push(...body(program, at, 'local'), '}', '')
  return lines.join('\n')
}

type OriginRef = (k: number, part: 'cell' | 'frac', axis: number) => string

function body(program: NoiseProgram, origin: OriginRef, p: string): string[] {
  const out: string[] = []
  const r = (n: number) => `r${n}`
  const w4 = program.dimensions === 4
  out.push(`  let r0 = ${p}.x;`, `  let r1 = ${p}.y;`)
  out.push(program.dimensions === 2 ? '  let r2 = 0.0;' : `  let r2 = ${p}.z;`)
  out.push(w4 ? `  let r3 = ${p}.w;` : '  let r3 = 0.0;')
  const code = program.code
  const k = program.consts
  for (let n = 0; n < program.instructions; n++) {
    const b = n * WIDTH
    const op = code[b]!
    const dst = code[b + 1]!
    const a = code[b + 2]!
    const c0 = code[b + 3]!
    const c1 = code[b + 4]!
    const kb = code[b + 8]!
    const count = code[b + 9]!
    const d = r(dst)
    switch (op) {
      case OP.CONST:
        out.push(`  let ${d} = ${f(k[kb]!)};`)
        break
      case OP.SOURCE:
        out.push(...source(program, b, origin))
        break
      case OP.ADD:
        out.push(`  let ${d} = ${r(a)} + ${r(c0)};`)
        break
      case OP.MUL:
        out.push(`  let ${d} = ${r(a)} * ${r(c0)};`)
        break
      case OP.MIN:
        out.push(`  let ${d} = min(${r(a)}, ${r(c0)});`)
        break
      case OP.MAX:
        out.push(`  let ${d} = max(${r(a)}, ${r(c0)});`)
        break
      case OP.LERP:
        out.push(`  let ${d} = ${r(a)} + ${r(c1)} * (${r(c0)} - ${r(a)});`)
        break
      case OP.SELECT: {
        const [th, fo, lo, inv] = [k[kb]!, k[kb + 1]!, k[kb + 2]!, k[kb + 3]!]
        if (fo > 0) {
          out.push(`  let ${d}_t0 = clamp((${r(c1)} - ${f(lo)}) * ${f(inv)}, 0.0, 1.0);`)
          out.push(`  let ${d}_t = ${d}_t0 * ${d}_t0 * (3.0 - 2.0 * ${d}_t0);`)
        } else out.push(`  let ${d}_t = select(0.0, 1.0, ${r(c1)} >= ${f(th)});`)
        out.push(`  let ${d} = ${r(a)} + ${d}_t * (${r(c0)} - ${r(a)});`)
        break
      }
      case OP.REMAP: {
        const v = `${f(k[kb + 1]!)} + (${r(a)} - ${f(k[kb]!)}) * ${f(k[kb + 2]!)}`
        out.push(
          count
            ? `  let ${d} = clamp(${v}, ${f(k[kb + 3]!)}, ${f(k[kb + 4]!)});`
            : `  let ${d} = ${v};`,
        )
        break
      }
      case OP.CLAMP:
        out.push(`  let ${d} = clamp(${r(a)}, ${f(k[kb]!)}, ${f(k[kb + 1]!)});`)
        break
      case OP.CURVE: {
        out.push(`  var ${d}_v = ${f(k[kb + 1]!)};`)
        for (let s = 0; s + 1 < count; s++) {
          const o = kb + s * 4
          const [x0, y0, inv, dy] = [f(k[o]!), f(k[o + 1]!), f(k[o + 2]!), f(k[o + 3]!)]
          out.push(
            `  ${d}_v = select(${d}_v, ${y0} + clamp((${r(a)} - ${x0}) * ${inv}, 0.0, 1.0) * ${dy}, ${r(a)} >= ${x0});`,
          )
        }
        out.push(`  let ${d} = ${d}_v;`)
        break
      }
      case OP.TERRACE: {
        const [min, scale, sharp, back] = [f(k[kb]!), f(k[kb + 1]!), f(k[kb + 2]!), f(k[kb + 3]!)]
        out.push(`  let ${d}_u = (${r(a)} - ${min}) * ${scale};`)
        out.push(`  let ${d}_s = floor(${d}_u);`)
        out.push(`  let ${d}_f = clamp((${d}_u - ${d}_s - 0.5) * ${sharp} + 0.5, 0.0, 1.0);`)
        out.push(`  let ${d} = (${d}_s + ${d}_f) * ${back} + ${min};`)
        break
      }
      case OP.ABS:
        out.push(`  let ${d} = abs(${r(a)});`)
        break
      case OP.POWER:
        out.push(`  let ${d} = pow_signed(${r(a)}, ${f(k[kb]!)});`)
        break
      case OP.WARP: {
        const amount = f(k[kb]!)
        for (let axis = 0; axis < 4; axis++) {
          const ch = code[b + 3 + axis]!
          const dst4 = r(dst + axis)
          if (ch < 0) out.push(`  let ${dst4} = ${a >= 0 ? r(a + axis) : '0.0'};`)
          else if (a >= 0) out.push(`  let ${dst4} = ${r(a + axis)} + ${amount} * ${r(ch)};`)
          else out.push(`  let ${dst4} = ${amount} * ${r(ch)};`)
        }
        break
      }
      case OP.SCALE_DISP:
        for (let axis = 0; axis < 4; axis++) {
          out.push(`  let ${r(dst + axis)} = ${r(a + axis)} * ${f(k[kb + axis]!)};`)
        }
        break
    }
  }
  out.push(`  return ${r(program.result)};`)
  return out
}

function source(program: NoiseProgram, b: number, origin: OriginRef): string[] {
  const code = program.code
  const k = program.consts
  const out: string[] = []
  const dst = code[b + 1]!
  const disp = code[b + 2]!
  const base = code[b + 3]!
  const kind = SOURCE_KINDS[code[b + 4]!]!
  const dims = code[b + 5]!
  const fractal = code[b + 6]!
  const metric = code[b + 7]! & 15
  const ret = code[b + 7]! >> 4
  const kb = code[b + 8]!
  const octaves = code[b + 9]!
  const label = code[b + 10]!
  const salt = code[b + 11]!
  const d = `r${dst}`
  const seed = salt !== 0 ? `hash_seed(seed, ${u(salt)})` : 'seed'
  out.push(`  let ${d}_s = hash_seed(${seed}, ${u(label)});`)
  const jitter = f(k[kb]!)
  const norm = f(k[kb + 1]!)
  let sum = '0.0'
  for (let o = 0; o < octaves; o++) {
    const c = kb + 2 + o * 6
    const v = `${d}_${o}`
    const q = (axis: number) => {
      const lx = `r${axis}`
      const a = f(k[c + axis]!)
      return disp >= 0 ? `${a} * ${lx} + ${f(k[c + 4]!)} * r${disp + axis}` : `${a} * ${lx}`
    }
    out.push(`  let ${v}_qx = ${q(0)};`, `  let ${v}_qy = ${q(1)};`)
    if (dims >= 3) out.push(`  let ${v}_qz = ${q(2)};`)
    if (dims >= 4) out.push(`  let ${v}_qw = ${q(3)};`)
    const rec = base + o
    const cell = (axis: number) => origin(rec, 'cell', axis)
    const frac = (axis: number) => origin(rec, 'frac', axis)
    const s = fractal === FRACTAL.NONE ? `${d}_s` : `hash_seed(${d}_s, ${u(o)})`
    let call: string
    if (kind === 'simplex' && dims === 2) {
      out.push(`  let ${v}_t = (${v}_qx + ${v}_qy) * ${f(0.3660254037844386)};`)
      call = `simplex2(${s}, ${cell(0)}, ${cell(1)}, ${frac(0)} + (${v}_qx + ${v}_t), ${frac(1)} + (${v}_qy + ${v}_t))`
    } else if (kind === 'simplex' && dims === 4) {
      out.push(`  let ${v}_t = (${v}_qx + ${v}_qy + ${v}_qz + ${v}_qw) * ${f(0.3090169943749474)};`)
      call = `simplex4(${s}, ${cell(0)}, ${cell(1)}, ${cell(2)}, ${cell(3)}, ${frac(0)} + (${v}_qx + ${v}_t), ${frac(1)} + (${v}_qy + ${v}_t), ${frac(2)} + (${v}_qz + ${v}_t), ${frac(3)} + (${v}_qw + ${v}_t))`
    } else if (kind === 'simplex') {
      out.push(`  let ${v}_t = (${v}_qx + ${v}_qy + ${v}_qz) * ${f(2 / 3)};`)
      call = `simplex3(${s}, ${cell(0)}, ${cell(1)}, ${cell(2)}, ${frac(0)} + (${v}_t - ${v}_qx), ${frac(1)} + (${v}_t - ${v}_qy), ${frac(2)} + (${v}_t - ${v}_qz))`
    } else if (dims === 2) {
      const args = `${s}, ${cell(0)}, ${cell(1)}, ${frac(0)} + ${v}_qx, ${frac(1)} + ${v}_qy`
      call =
        kind === 'cellular'
          ? `cellular2(${args}, ${jitter}, ${metric}, ${ret})`
          : `${kind}2(${args})`
    } else {
      const args = `${s}, ${cell(0)}, ${cell(1)}, ${cell(2)}, ${frac(0)} + ${v}_qx, ${frac(1)} + ${v}_qy, ${frac(2)} + ${v}_qz`
      call =
        kind === 'cellular'
          ? `cellular3(${args}, ${jitter}, ${metric}, ${ret})`
          : `${kind}3(${args})`
    }
    out.push(`  let ${v} = ${call};`)
    const amp = f(k[c + 5]!)
    const term =
      fractal === FRACTAL.RIDGED
        ? `${amp} * ((1.0 - abs(${v})) * (1.0 - abs(${v})))`
        : fractal === FRACTAL.BILLOW
          ? `${amp} * (2.0 * abs(${v}) - 1.0)`
          : `${amp} * ${v}`
    out.push(`  let ${v}_sum = ${sum} + ${term};`)
    sum = `${v}_sum`
  }
  out.push(
    fractal === FRACTAL.RIDGED
      ? `  let ${d} = ${sum} * ${norm} * 2.0 - 1.0;`
      : `  let ${d} = ${sum} * ${norm};`,
  )
  return out
}
