import type { Readable, Writable } from './types'

/** Column-major 3x3: element (row r, column c) at index c * 3 + r. */
export const create = (): Float32Array => identity(new Float32Array(9))

export function identity<T extends Writable>(out: T): T {
  for (let i = 0; i < 9; i++) out[i] = i % 4 === 0 ? 1 : 0
  return out
}

/** Inverse transpose of an affine transform's 3x3 part: transforms normals correctly under scale. */
export function normalFromAffineAt<T extends Writable>(out: T, a: Readable, ao: number): T | null {
  const a00 = a[ao]!
  const a01 = a[ao + 1]!
  const a02 = a[ao + 2]!
  const a10 = a[ao + 4]!
  const a11 = a[ao + 5]!
  const a12 = a[ao + 6]!
  const a20 = a[ao + 8]!
  const a21 = a[ao + 9]!
  const a22 = a[ao + 10]!
  const c00 = a11 * a22 - a12 * a21
  const c01 = a12 * a20 - a10 * a22
  const c02 = a10 * a21 - a11 * a20
  const det = a00 * c00 + a01 * c01 + a02 * c02
  if (!det) return null
  const inv = 1 / det
  // (A^-1)^T = cofactor(A) / det. Column-major: out[c * 3 + r] = cofactor(r, c).
  out[0] = c00 * inv
  out[1] = (a02 * a21 - a01 * a22) * inv
  out[2] = (a01 * a12 - a02 * a11) * inv
  out[3] = c01 * inv
  out[4] = (a00 * a22 - a02 * a20) * inv
  out[5] = (a02 * a10 - a00 * a12) * inv
  out[6] = c02 * inv
  out[7] = (a01 * a20 - a00 * a21) * inv
  out[8] = (a00 * a11 - a01 * a10) * inv
  return out
}
