import { identity } from './affine'
import type { Readable, Writable } from './types'

/**
 * The `affine` functions on `Float64Array`, for the few places that need positions beyond f32
 * precision (large-world grids, spec 0040). Same layout: the top three rows of a 4x4, row by row.
 */
export {
  copyAt,
  fromMat4,
  fromTRS,
  fromTRSAt,
  getTranslationAt,
  identity,
  identityAt,
  invert,
  multiply,
  multiplyAt,
  toMat4,
  toMat4At,
  transformPoint,
  transformPointAt,
} from './affine'

export const create = (): Float64Array => identity(new Float64Array(12))

/** out = a · translation(x, y, z). `out` may alias `a`. */
export function translateAt<T extends Writable>(
  out: T,
  o: number,
  a: Readable,
  ao: number,
  x: number,
  y: number,
  z: number,
): T {
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!
    const a1 = a[ao + r * 4 + 1]!
    const a2 = a[ao + r * 4 + 2]!
    out[o + r * 4] = a0
    out[o + r * 4 + 1] = a1
    out[o + r * 4 + 2] = a2
    out[o + r * 4 + 3] = a0 * x + a1 * y + a2 * z + a[ao + r * 4 + 3]!
  }
  return out
}

/** Rotates and scales a direction (no translation). */
export function transformVectorAt<T extends Writable>(
  out: T,
  a: Readable,
  ao: number,
  v: Readable,
): T {
  const x = v[0]!
  const y = v[1]!
  const z = v[2]!
  out[0] = a[ao]! * x + a[ao + 1]! * y + a[ao + 2]! * z
  out[1] = a[ao + 4]! * x + a[ao + 5]! * y + a[ao + 6]! * z
  out[2] = a[ao + 8]! * x + a[ao + 9]! * y + a[ao + 10]! * z
  return out
}
