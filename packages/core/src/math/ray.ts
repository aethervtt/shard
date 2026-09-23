import type { Readable, Writable } from './types'

/** Ray as 6 floats: `[originX, originY, originZ, dirX, dirY, dirZ]` (direction normalized). */
export const create = (): Float32Array => new Float32Array([0, 0, 0, 0, 0, -1])

/**
 * Ray through a pixel. `x`, `y` in pixels from the top-left; `inverseViewProjection` is the inverse
 * of projection · view. `reversedZ` must match the projection (the engine default is true).
 */
export function fromScreen<T extends Writable>(
  out: T,
  x: number,
  y: number,
  width: number,
  height: number,
  inverseViewProjection: Readable,
  reversedZ = true,
): T {
  const nx = (x / width) * 2 - 1
  const ny = 1 - (y / height) * 2
  const m = inverseViewProjection
  // Unproject a near and a far depth. 0.25/0.75 avoid reversed-Z's infinite plane at depth 0.
  const nearZ = reversedZ ? 0.75 : 0.25
  const farZ = reversedZ ? 0.25 : 0.75
  const wn = m[3]! * nx + m[7]! * ny + m[11]! * nearZ + m[15]!
  const ox = (m[0]! * nx + m[4]! * ny + m[8]! * nearZ + m[12]!) / wn
  const oy = (m[1]! * nx + m[5]! * ny + m[9]! * nearZ + m[13]!) / wn
  const oz = (m[2]! * nx + m[6]! * ny + m[10]! * nearZ + m[14]!) / wn
  const wf = m[3]! * nx + m[7]! * ny + m[11]! * farZ + m[15]!
  const dx = (m[0]! * nx + m[4]! * ny + m[8]! * farZ + m[12]!) / wf - ox
  const dy = (m[1]! * nx + m[5]! * ny + m[9]! * farZ + m[13]!) / wf - oy
  const dz = (m[2]! * nx + m[6]! * ny + m[10]! * farZ + m[14]!) / wf - oz
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
  out[0] = ox
  out[1] = oy
  out[2] = oz
  out[3] = dx / len
  out[4] = dy / len
  out[5] = dz / len
  return out
}

/** Distance along the ray to the box, or -1 on a miss. 0 if the origin is inside. */
export function intersectAabb(ray: Readable, box: Readable): number {
  let tMin = 0
  let tMax = Infinity
  for (let i = 0; i < 3; i++) {
    const o = ray[i]!
    const d = ray[i + 3]!
    const lo = box[i]!
    const hi = box[i + 3]!
    if (Math.abs(d) < 1e-12) {
      if (o < lo || o > hi) return -1
      continue
    }
    let t0 = (lo - o) / d
    let t1 = (hi - o) / d
    if (t0 > t1) {
      const tmp = t0
      t0 = t1
      t1 = tmp
    }
    if (t0 > tMin) tMin = t0
    if (t1 < tMax) tMax = t1
    if (tMin > tMax) return -1
  }
  return tMin
}
