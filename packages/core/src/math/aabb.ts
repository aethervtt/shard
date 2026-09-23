import type { Readable, Writable } from './types'

/** Axis-aligned box as 6 floats: `[minX, minY, minZ, maxX, maxY, maxZ]`. */
export const create = (): Float32Array => empty(new Float32Array(6))

/** An inverted box that any point expands. */
export function empty<T extends Writable>(out: T): T {
  out[0] = out[1] = out[2] = Infinity
  out[3] = out[4] = out[5] = -Infinity
  return out
}

export function set<T extends Writable>(out: T, min: Readable, max: Readable): T {
  out[0] = min[0]!
  out[1] = min[1]!
  out[2] = min[2]!
  out[3] = max[0]!
  out[4] = max[1]!
  out[5] = max[2]!
  return out
}

/** Bounds of packed xyz positions. */
export function fromPoints<T extends Writable>(out: T, positions: Readable, stride = 3): T {
  empty(out)
  for (let i = 0; i + 2 < positions.length; i += stride) {
    const x = positions[i]!
    const y = positions[i + 1]!
    const z = positions[i + 2]!
    if (x < out[0]!) out[0] = x
    if (y < out[1]!) out[1] = y
    if (z < out[2]!) out[2] = z
    if (x > out[3]!) out[3] = x
    if (y > out[4]!) out[4] = y
    if (z > out[5]!) out[5] = z
  }
  return out
}

/** Bounds of `box` after an affine transform (Arvo's method: exact for the transformed box). */
export function transformAffineAt<T extends Writable>(
  out: T,
  box: Readable,
  m: Readable,
  mo: number,
): T {
  const minX = box[0]!
  const minY = box[1]!
  const minZ = box[2]!
  const maxX = box[3]!
  const maxY = box[4]!
  const maxZ = box[5]!
  for (let r = 0; r < 3; r++) {
    let lo = m[mo + r * 4 + 3]!
    let hi = lo
    const ex = m[mo + r * 4]!
    const ey = m[mo + r * 4 + 1]!
    const ez = m[mo + r * 4 + 2]!
    const ax = ex * minX
    const bx = ex * maxX
    const ay = ey * minY
    const by = ey * maxY
    const az = ez * minZ
    const bz = ez * maxZ
    lo += Math.min(ax, bx) + Math.min(ay, by) + Math.min(az, bz)
    hi += Math.max(ax, bx) + Math.max(ay, by) + Math.max(az, bz)
    out[r] = lo
    out[r + 3] = hi
  }
  return out
}

export function center<T extends Writable>(out: T, box: Readable): T {
  out[0] = (box[0]! + box[3]!) / 2
  out[1] = (box[1]! + box[4]!) / 2
  out[2] = (box[2]! + box[5]!) / 2
  return out
}

export function intersects(a: Readable, b: Readable): boolean {
  return (
    a[0]! <= b[3]! &&
    a[3]! >= b[0]! &&
    a[1]! <= b[4]! &&
    a[4]! >= b[1]! &&
    a[2]! <= b[5]! &&
    a[5]! >= b[2]!
  )
}

export function containsPoint(box: Readable, p: Readable): boolean {
  return (
    p[0]! >= box[0]! &&
    p[0]! <= box[3]! &&
    p[1]! >= box[1]! &&
    p[1]! <= box[4]! &&
    p[2]! >= box[2]! &&
    p[2]! <= box[5]!
  )
}
