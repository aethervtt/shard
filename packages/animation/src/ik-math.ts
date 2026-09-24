import { ChildOf, type Entity, type World } from '@shard/core'
import { GlobalTransform, Transform } from '@shard/transform'

/**
 * Vector and quaternion helpers for the IK solvers. Everything writes into `out` (which may alias
 * an input) and scalars travel in `arg`: V8 boxes a double passed to or returned from a call it
 * doesn't inline, and these run per joint per frame.
 */

/** Scalar arguments and results: arg[0] is the t / angle / weight a helper reads. */
export const arg = new Float64Array(4)

export const vec = (): Float64Array => new Float64Array(3)
export const quatId = (): Float64Array => Float64Array.of(0, 0, 0, 1)

/**
 * World position and rotation of an entity from its GlobalTransform (rotation from the matrix
 * with its scale divided out). False when it has none.
 */
export function readWorld(world: World, e: Entity, pos: Float64Array, rot: Float64Array): boolean {
  if (e < 0 || !world.isAlive(e)) return false
  const table = world.entityTableUnchecked(e)
  if (!table.has(GlobalTransform)) return false
  const m = table.column(GlobalTransform, 'matrix')
  const o = world.entityRowUnchecked(e) * 12
  pos[0] = m[o + 3]!
  pos[1] = m[o + 7]!
  pos[2] = m[o + 11]!
  matrixRotation(rot, m, o)
  return true
}

/** World position only. */
export function readPosition(world: World, e: Entity, pos: Float64Array): boolean {
  if (e < 0 || !world.isAlive(e)) return false
  const table = world.entityTableUnchecked(e)
  if (!table.has(GlobalTransform)) return false
  const m = table.column(GlobalTransform, 'matrix')
  const o = world.entityRowUnchecked(e) * 12
  pos[0] = m[o + 3]!
  pos[1] = m[o + 7]!
  pos[2] = m[o + 11]!
  return true
}

/** The parent of an entity, or -1. */
export function parentOf(world: World, e: Entity): Entity {
  const table = world.entityTableUnchecked(e)
  if (!table.has(ChildOf)) return -1 as Entity
  return table.column(ChildOf, 'parent')[world.entityRowUnchecked(e)]! as Entity
}

/** World rotation of an entity's parent (identity for roots). */
export function parentRotation(world: World, e: Entity, rot: Float64Array): void {
  const p = parentOf(world, e)
  if (p < 0 || !readWorld(world, p, scratchPos, rot)) {
    rot[0] = 0
    rot[1] = 0
    rot[2] = 0
    rot[3] = 1
  }
}

const scratchPos = new Float64Array(3)

/** Rotation of an affine matrix (rows at offset o) with each column's scale divided out. */
export function matrixRotation(out: Float64Array, m: ArrayLike<number>, o: number): void {
  let m00 = m[o]!
  let m10 = m[o + 4]!
  let m20 = m[o + 8]!
  let m01 = m[o + 1]!
  let m11 = m[o + 5]!
  let m21 = m[o + 9]!
  let m02 = m[o + 2]!
  let m12 = m[o + 6]!
  let m22 = m[o + 10]!
  const sx = Math.sqrt(m00 * m00 + m10 * m10 + m20 * m20) || 1
  const sy = Math.sqrt(m01 * m01 + m11 * m11 + m21 * m21) || 1
  const sz = Math.sqrt(m02 * m02 + m12 * m12 + m22 * m22) || 1
  m00 /= sx
  m10 /= sx
  m20 /= sx
  m01 /= sy
  m11 /= sy
  m21 /= sy
  m02 /= sz
  m12 /= sz
  m22 /= sz
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1)
    out[3] = 0.25 / s
    out[0] = (m21 - m12) * s
    out[1] = (m02 - m20) * s
    out[2] = (m10 - m01) * s
  } else if (m00 > m11 && m00 > m22) {
    const s = 2 * Math.sqrt(1 + m00 - m11 - m22)
    out[3] = (m21 - m12) / s
    out[0] = 0.25 * s
    out[1] = (m01 + m10) / s
    out[2] = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = 2 * Math.sqrt(1 + m11 - m00 - m22)
    out[3] = (m02 - m20) / s
    out[0] = (m01 + m10) / s
    out[1] = 0.25 * s
    out[2] = (m12 + m21) / s
  } else {
    const s = 2 * Math.sqrt(1 + m22 - m00 - m11)
    out[3] = (m10 - m01) / s
    out[0] = (m02 + m20) / s
    out[1] = (m12 + m21) / s
    out[2] = 0.25 * s
  }
  qnormalize(out)
}

/** out = a · b. */
export function qmul(out: Float64Array, a: Float64Array, b: Float64Array): void {
  const ax = a[0]!
  const ay = a[1]!
  const az = a[2]!
  const aw = a[3]!
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  const bw = b[3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
}

/** out = conj(a) · b: the rotation that takes a to b in a's frame (a⁻¹ · b for unit a). */
export function qmulConj(out: Float64Array, a: Float64Array, b: Float64Array): void {
  const ax = -a[0]!
  const ay = -a[1]!
  const az = -a[2]!
  const aw = a[3]!
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  const bw = b[3]!
  out[0] = aw * bx + ax * bw + ay * bz - az * by
  out[1] = aw * by - ax * bz + ay * bw + az * bx
  out[2] = aw * bz + ax * by - ay * bx + az * bw
  out[3] = aw * bw - ax * bx - ay * by - az * bz
}

export function qcopy(out: Float64Array, a: ArrayLike<number>, o: number): void {
  out[0] = a[o]!
  out[1] = a[o + 1]!
  out[2] = a[o + 2]!
  out[3] = a[o + 3]!
}

export function qidentity(out: Float64Array): void {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  out[3] = 1
}

export function qnormalize(q: Float64Array): void {
  const len = Math.sqrt(q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]!)
  if (len > 0) {
    q[0] = q[0]! / len
    q[1] = q[1]! / len
    q[2] = q[2]! / len
    q[3] = q[3]! / len
  } else {
    qidentity(q)
  }
}

/** out = slerp(a, b, arg[0]) along the shortest arc. */
export function qslerp(out: Float64Array, a: Float64Array, b: Float64Array): void {
  const t = arg[0]!
  const ax = a[0]!
  const ay = a[1]!
  const az = a[2]!
  const aw = a[3]!
  let bx = b[0]!
  let by = b[1]!
  let bz = b[2]!
  let bw = b[3]!
  let cos = ax * bx + ay * by + az * bz + aw * bw
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let s0 = 1 - t
  let s1 = t
  if (1 - cos > 1e-6) {
    const omega = Math.acos(Math.min(1, cos))
    const sin = Math.sin(omega)
    s0 = Math.sin((1 - t) * omega) / sin
    s1 = Math.sin(t * omega) / sin
  }
  out[0] = s0 * ax + s1 * bx
  out[1] = s0 * ay + s1 * by
  out[2] = s0 * az + s1 * bz
  out[3] = s0 * aw + s1 * bw
  qnormalize(out)
}

/** Rotation of arg[0] radians about a unit axis. */
export function qaxisAngle(out: Float64Array, axis: Float64Array): void {
  const half = arg[0]! * 0.5
  const s = Math.sin(half)
  out[0] = axis[0]! * s
  out[1] = axis[1]! * s
  out[2] = axis[2]! * s
  out[3] = Math.cos(half)
}

/** The smallest rotation taking unit vector a to unit vector b. */
export function qfromTo(out: Float64Array, a: Float64Array, b: Float64Array): void {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  if (d < -0.999999) {
    // Opposite: half a turn about any axis perpendicular to a.
    let x = 0
    let y = -a[2]!
    let z = a[1]!
    if (y * y + z * z < 1e-12) {
      x = a[2]!
      y = 0
      z = -a[0]!
    }
    const len = Math.sqrt(x * x + y * y + z * z)
    out[0] = x / len
    out[1] = y / len
    out[2] = z / len
    out[3] = 0
    return
  }
  out[0] = a[1]! * b[2]! - a[2]! * b[1]!
  out[1] = a[2]! * b[0]! - a[0]! * b[2]!
  out[2] = a[0]! * b[1]! - a[1]! * b[0]!
  out[3] = 1 + d
  qnormalize(out)
}

/** out = q · v · q⁻¹. */
export function vrotate(out: Float64Array, q: Float64Array, v: Float64Array): void {
  const x = q[0]!
  const y = q[1]!
  const z = q[2]!
  const w = q[3]!
  const vx = v[0]!
  const vy = v[1]!
  const vz = v[2]!
  const ix = w * vx + y * vz - z * vy
  const iy = w * vy + z * vx - x * vz
  const iz = w * vz + x * vy - y * vx
  const iw = -x * vx - y * vy - z * vz
  out[0] = ix * w - iw * x - iy * z + iz * y
  out[1] = iy * w - iw * y - iz * x + ix * z
  out[2] = iz * w - iw * z - ix * y + iy * x
}

export function vsub(out: Float64Array, a: Float64Array, b: Float64Array): void {
  out[0] = a[0]! - b[0]!
  out[1] = a[1]! - b[1]!
  out[2] = a[2]! - b[2]!
}

export function vcopy(out: Float64Array, a: ArrayLike<number>): void {
  out[0] = a[0]!
  out[1] = a[1]!
  out[2] = a[2]!
}

/** Normalizes v in place; arg[1] gets its length before. Zero stays zero. */
export function vnormalize(v: Float64Array): void {
  const len = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!)
  arg[1] = len
  if (len > 1e-12) {
    v[0] = v[0]! / len
    v[1] = v[1]! / len
    v[2] = v[2]! / len
  }
}

/** Writes a local rotation into an entity's Transform, marked changed at `tick`. */
export function writeRotation(world: World, e: Entity, q: Float64Array, tick: number): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(Transform)) return
  const row = world.entityRowUnchecked(e)
  const r = table.column(Transform, 'rotation')
  r[row * 4] = q[0]!
  r[row * 4 + 1] = q[1]!
  r[row * 4 + 2] = q[2]!
  r[row * 4 + 3] = q[3]!
  table.changedTicks(Transform)[row] = tick
  table.touch(Transform)
}

/** Reads an entity's local rotation. */
export function readRotation(world: World, e: Entity, out: Float64Array): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(Transform)) {
    qidentity(out)
    return
  }
  qcopy(out, table.column(Transform, 'rotation'), world.entityRowUnchecked(e) * 4)
}

/** Whether `ancestor` is `e` or one of its ancestors. */
export function isAncestor(world: World, ancestor: Entity, e: Entity): boolean {
  let cur = e
  for (let guard = 0; cur >= 0 && guard < 128; guard++) {
    if (cur === ancestor) return true
    if (!world.isAlive(cur)) return false
    cur = parentOf(world, cur)
  }
  return false
}
