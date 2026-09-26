/**
 * Test-only f64 reference evaluators for the gradient sources: the kernel's algorithms with every
 * position in f64 and cells as exact integers. They show what the true value at a far-away point
 * is, so tests can check that origin-offset sampling finds it (and plain f32 sampling doesn't).
 */

const PX = 501125321
const PY = 1136930381
const PZ = 1720413743
const SEED_FLIP_3D = 0x52d547b3
const R3 = Math.fround(0.6)
const TWO_THIRDS = Math.fround(2 / 3)

const gradHash3 = (s: number, x: number, y: number, z: number) =>
  Math.imul(s ^ x ^ y ^ z, 0x27d4eb2d) >>> 28

function grad3(g: number, x: number, y: number, z: number): number {
  const drop = g >> 2
  const a = drop === 0 ? y : x
  const b = drop === 2 ? y : z
  return (g & 1 ? -a : a) + (g & 2 ? -b : b)
}

const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10)
const lerp = (a: number, b: number, t: number) => a + t * (b - a)

/** Perlin 3D at an f64 lattice position. */
export function perlin3Reference(seed: number, x: number, y: number, z: number): number {
  const fx = Math.floor(x)
  const fy = Math.floor(y)
  const fz = Math.floor(z)
  const tx = x - fx
  const ty = y - fy
  const tz = z - fz
  const x0 = Math.imul(fx, PX)
  const y0 = Math.imul(fy, PY)
  const z0 = Math.imul(fz, PZ)
  const x1 = (x0 + PX) | 0
  const y1 = (y0 + PY) | 0
  const z1 = (z0 + PZ) | 0
  const g = (a: number, b: number, c: number, dx: number, dy: number, dz: number) =>
    grad3(gradHash3(seed, a, b, c), dx, dy, dz)
  const u = fade(tx)
  const v = fade(ty)
  const w = fade(tz)
  const a = lerp(g(x0, y0, z0, tx, ty, tz), g(x1, y0, z0, tx - 1, ty, tz), u)
  const b = lerp(g(x0, y1, z0, tx, ty - 1, tz), g(x1, y1, z0, tx - 1, ty - 1, tz), u)
  const d = lerp(g(x0, y0, z1, tx, ty, tz - 1), g(x1, y0, z1, tx - 1, ty, tz - 1), u)
  const e = lerp(g(x0, y1, z1, tx, ty - 1, tz - 1), g(x1, y1, z1, tx - 1, ty - 1, tz - 1), u)
  return Math.max(-1, Math.min(1, lerp(lerp(a, b, v), lerp(d, e, v), w)))
}

/** OpenSimplex2 3D at an f64 position in lattice units (before the rotation). */
export function simplex3Reference(seed: number, x: number, y: number, z: number): number {
  const r = (x + y + z) * TWO_THIRDS
  const px = r - x
  const py = r - y
  const pz = r - z
  const rx = Math.round(px)
  const ry = Math.round(py)
  const rz = Math.round(pz)
  let xb = Math.imul(rx, PX)
  let yb = Math.imul(ry, PY)
  let zb = Math.imul(rz, PZ)
  let xr = px - rx
  let yr = py - ry
  let zr = pz - rz
  let xs = xr < 0 ? 1 : -1
  let ys = yr < 0 ? 1 : -1
  let zs = zr < 0 ? 1 : -1
  let ax = Math.abs(xr)
  let ay = Math.abs(yr)
  let az = Math.abs(zr)
  let a = R3 - xr * xr - (yr * yr + zr * zr)
  let s = seed
  let value = 0
  for (let l = 0; ; l++) {
    const a0 = Math.max(a, 0)
    value += a0 * a0 * a0 * a0 * grad3(gradHash3(s, xb, yb, zb), xr, yr, zr)
    const mx = ax >= ay && ax >= az
    const my = !mx && ay >= az
    const am = Math.max(ax, ay, az)
    const b0 = Math.max(a + am + am - 1, 0)
    const hx = mx ? (xb - Math.imul(xs, PX)) | 0 : xb
    const hy = my ? (yb - Math.imul(ys, PY)) | 0 : yb
    const hz = !mx && !my ? (zb - Math.imul(zs, PZ)) | 0 : zb
    const ox = xr + (mx ? xs : 0)
    const oy = yr + (my ? ys : 0)
    const oz = zr + (!mx && !my ? zs : 0)
    value += b0 * b0 * b0 * b0 * grad3(gradHash3(s, hx, hy, hz), ox, oy, oz)
    if (l === 1) break
    ax = 0.5 - ax
    ay = 0.5 - ay
    az = 0.5 - az
    xr = xs * ax
    yr = ys * ay
    zr = zs * az
    a += 0.75 - ax - (ay + az)
    if (xs === -1) xb = (xb + PX) | 0
    if (ys === -1) yb = (yb + PY) | 0
    if (zs === -1) zb = (zb + PZ) | 0
    xs = -xs
    ys = -ys
    zs = -zs
    s ^= SEED_FLIP_3D
  }
  return Math.max(-1, Math.min(1, value * 32))
}
