import type { Readable, Writable } from './types'

/**
 * Six planes as 24 floats `(nx, ny, nz, d)`, inside where `n · p + d >= 0`. Order: left, right,
 * bottom, top, near, far. Works for standard and reversed-Z projections; a degenerate plane (the
 * infinite far plane) always passes.
 */
export const create = (): Float32Array => new Float32Array(24)

export function fromViewProjection<T extends Writable>(out: T, m: Readable): T {
  // Row i of the column-major matrix is (m[i], m[4 + i], m[8 + i], m[12 + i]).
  for (let p = 0; p < 6; p++) {
    const axis = p >> 1 // 0: x, 1: y, 2: z
    const sign = p & 1 ? -1 : 1
    let a: number
    let b: number
    let c: number
    let d: number
    if (axis < 2) {
      // w ± x, w ± y
      a = m[3]! + sign * m[axis]!
      b = m[7]! + sign * m[4 + axis]!
      c = m[11]! + sign * m[8 + axis]!
      d = m[15]! + sign * m[12 + axis]!
    } else if (sign > 0) {
      // z >= 0
      a = m[2]!
      b = m[6]!
      c = m[10]!
      d = m[14]!
    } else {
      // z <= w
      a = m[3]! - m[2]!
      b = m[7]! - m[6]!
      c = m[11]! - m[10]!
      d = m[15]! - m[14]!
    }
    const len = Math.sqrt(a * a + b * b + c * c)
    if (len < 1e-12) {
      out[p * 4] = 0
      out[p * 4 + 1] = 0
      out[p * 4 + 2] = 0
      out[p * 4 + 3] = 1
    } else {
      out[p * 4] = a / len
      out[p * 4 + 1] = b / len
      out[p * 4 + 2] = c / len
      out[p * 4 + 3] = d / len
    }
  }
  return out
}

/** True if the box is at least partly inside (conservative: may keep boxes near corners). */
export function intersectsAabbAt(f: Readable, box: Readable, bo: number): boolean {
  for (let p = 0; p < 24; p += 4) {
    const nx = f[p]!
    const ny = f[p + 1]!
    const nz = f[p + 2]!
    // The box corner furthest along the plane normal.
    const x = nx >= 0 ? box[bo + 3]! : box[bo]!
    const y = ny >= 0 ? box[bo + 4]! : box[bo + 1]!
    const z = nz >= 0 ? box[bo + 5]! : box[bo + 2]!
    if (nx * x + ny * y + nz * z + f[p + 3]! < 0) return false
  }
  return true
}

export const intersectsAabb = (f: Readable, box: Readable): boolean => intersectsAabbAt(f, box, 0)
