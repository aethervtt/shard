import type { Readable, Writable } from './types'

/**
 * Affine transforms stored as the top three rows of a 4x4 matrix, row by row (12 floats):
 * `[m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz]`. The implied fourth row is `0 0 0 1`.
 * In WGSL this is `array<vec4f, 3>`, and a point transforms with three dot products.
 *
 * `*At` variants read and write at offsets, for strided ECS columns.
 */
export const create = (): Float32Array => identity(new Float32Array(12))

export function identityAt<T extends Writable>(out: T, o: number): T {
  for (let i = 0; i < 12; i++) out[o + i] = 0
  out[o] = 1
  out[o + 5] = 1
  out[o + 10] = 1
  return out
}

export const identity = <T extends Writable>(out: T): T => identityAt(out, 0)

export function copyAt<T extends Writable>(out: T, o: number, a: Readable, ao: number): T {
  for (let i = 0; i < 12; i++) out[o + i] = a[ao + i]!
  return out
}

/** Translation · rotation · scale, from values at offsets (t: vec3, q: quat, s: vec3). */
export function fromTRSAt<T extends Writable>(
  out: T,
  o: number,
  t: Readable,
  to: number,
  q: Readable,
  qo: number,
  s: Readable,
  so: number,
): T {
  const x = q[qo]!
  const y = q[qo + 1]!
  const z = q[qo + 2]!
  const w = q[qo + 3]!
  const sx = s[so]!
  const sy = s[so + 1]!
  const sz = s[so + 2]!
  const xx = x * x
  const yy = y * y
  const zz = z * z
  const xy = x * y
  const xz = x * z
  const yz = y * z
  const wx = w * x
  const wy = w * y
  const wz = w * z
  out[o] = (1 - 2 * (yy + zz)) * sx
  out[o + 1] = 2 * (xy - wz) * sy
  out[o + 2] = 2 * (xz + wy) * sz
  out[o + 3] = t[to]!
  out[o + 4] = 2 * (xy + wz) * sx
  out[o + 5] = (1 - 2 * (xx + zz)) * sy
  out[o + 6] = 2 * (yz - wx) * sz
  out[o + 7] = t[to + 1]!
  out[o + 8] = 2 * (xz - wy) * sx
  out[o + 9] = 2 * (yz + wx) * sy
  out[o + 10] = (1 - 2 * (xx + yy)) * sz
  out[o + 11] = t[to + 2]!
  return out
}

export const fromTRS = <T extends Writable>(out: T, t: Readable, q: Readable, s: Readable): T =>
  fromTRSAt(out, 0, t, 0, q, 0, s, 0)

/** out = a · b, at offsets. `out` may alias `b` but not `a`. */
export function multiplyAt<T extends Writable>(
  out: T,
  o: number,
  a: Readable,
  ao: number,
  b: Readable,
  bo: number,
): T {
  const b00 = b[bo]!
  const b01 = b[bo + 1]!
  const b02 = b[bo + 2]!
  const b03 = b[bo + 3]!
  const b10 = b[bo + 4]!
  const b11 = b[bo + 5]!
  const b12 = b[bo + 6]!
  const b13 = b[bo + 7]!
  const b20 = b[bo + 8]!
  const b21 = b[bo + 9]!
  const b22 = b[bo + 10]!
  const b23 = b[bo + 11]!
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!
    const a1 = a[ao + r * 4 + 1]!
    const a2 = a[ao + r * 4 + 2]!
    const a3 = a[ao + r * 4 + 3]!
    out[o + r * 4] = a0 * b00 + a1 * b10 + a2 * b20
    out[o + r * 4 + 1] = a0 * b01 + a1 * b11 + a2 * b21
    out[o + r * 4 + 2] = a0 * b02 + a1 * b12 + a2 * b22
    out[o + r * 4 + 3] = a0 * b03 + a1 * b13 + a2 * b23 + a3
  }
  return out
}

export const multiply = <T extends Writable>(out: T, a: Readable, b: Readable): T =>
  multiplyAt(out, 0, a, 0, b, 0)

/** Inverse of an affine transform. Returns null for singular transforms. */
export function invert<T extends Writable>(out: T, a: Readable): T | null {
  const a00 = a[0]!
  const a01 = a[1]!
  const a02 = a[2]!
  const a10 = a[4]!
  const a11 = a[5]!
  const a12 = a[6]!
  const a20 = a[8]!
  const a21 = a[9]!
  const a22 = a[10]!
  const tx = a[3]!
  const ty = a[7]!
  const tz = a[11]!
  const c00 = a11 * a22 - a12 * a21
  const c01 = a02 * a21 - a01 * a22
  const c02 = a01 * a12 - a02 * a11
  const det = a00 * c00 + a10 * c01 + a20 * c02
  if (!det) return null
  const inv = 1 / det
  const i00 = c00 * inv
  const i01 = c01 * inv
  const i02 = c02 * inv
  const i10 = (a12 * a20 - a10 * a22) * inv
  const i11 = (a00 * a22 - a02 * a20) * inv
  const i12 = (a02 * a10 - a00 * a12) * inv
  const i20 = (a10 * a21 - a11 * a20) * inv
  const i21 = (a01 * a20 - a00 * a21) * inv
  const i22 = (a00 * a11 - a01 * a10) * inv
  out[0] = i00
  out[1] = i01
  out[2] = i02
  out[3] = -(i00 * tx + i01 * ty + i02 * tz)
  out[4] = i10
  out[5] = i11
  out[6] = i12
  out[7] = -(i10 * tx + i11 * ty + i12 * tz)
  out[8] = i20
  out[9] = i21
  out[10] = i22
  out[11] = -(i20 * tx + i21 * ty + i22 * tz)
  return out
}

export function transformPointAt<T extends Writable>(
  out: T,
  a: Readable,
  ao: number,
  p: Readable,
): T {
  const x = p[0]!
  const y = p[1]!
  const z = p[2]!
  out[0] = a[ao]! * x + a[ao + 1]! * y + a[ao + 2]! * z + a[ao + 3]!
  out[1] = a[ao + 4]! * x + a[ao + 5]! * y + a[ao + 6]! * z + a[ao + 7]!
  out[2] = a[ao + 8]! * x + a[ao + 9]! * y + a[ao + 10]! * z + a[ao + 11]!
  return out
}

export const transformPoint = <T extends Writable>(out: T, a: Readable, p: Readable): T =>
  transformPointAt(out, a, 0, p)

export function getTranslationAt<T extends Writable>(out: T, a: Readable, ao: number): T {
  out[0] = a[ao + 3]!
  out[1] = a[ao + 7]!
  out[2] = a[ao + 11]!
  return out
}

/** Expands to a column-major mat4. */
export function toMat4At<T extends Writable>(out: T, a: Readable, ao: number): T {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[ao + r * 4 + c]!
  out[3] = 0
  out[7] = 0
  out[11] = 0
  out[15] = 1
  return out
}

export const toMat4 = <T extends Writable>(out: T, a: Readable): T => toMat4At(out, a, 0)

/** Takes the top three rows of a column-major mat4 (drops any projective part). */
export function fromMat4<T extends Writable>(out: T, m: Readable): T {
  for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) out[r * 4 + c] = m[c * 4 + r]!
  return out
}
