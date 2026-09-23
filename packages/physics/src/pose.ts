import { ChildOf, type Entity, type World } from '@shard/core'
import { GlobalTransform, Transform } from '@shard/transform'

/**
 * A rigid pose plus scale: translation (0..2), rotation quaternion (3..6), scale (7..9). Poses are
 * composed from Transforms, not read from GlobalTransform, so bodies spawned before the first
 * propagation get the right place.
 */
export type Pose = Float64Array

export const createPose = (): Pose => {
  const p = new Float64Array(10)
  p[6] = 1
  p[7] = 1
  p[8] = 1
  p[9] = 1
  return p
}

export function identityPose(out: Pose): Pose {
  out.fill(0)
  out[6] = 1
  out[7] = out[8] = out[9] = 1
  return out
}

/** Rotates (x, y, z) by quaternion q (offset qo) into out[oo..oo+2]. */
export function rotate(
  out: ArrayLike<number> & { [i: number]: number },
  oo: number,
  q: ArrayLike<number>,
  qo: number,
  x: number,
  y: number,
  z: number,
): void {
  const qx = q[qo]!
  const qy = q[qo + 1]!
  const qz = q[qo + 2]!
  const qw = q[qo + 3]!
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[oo] = x + qw * tx + (qy * tz - qz * ty)
  out[oo + 1] = y + qw * ty + (qz * tx - qx * tz)
  out[oo + 2] = z + qw * tz + (qx * ty - qy * tx)
}

/** out = a * b (quaternions at offsets). `out` may alias either input. */
export function mulQuat(
  out: { [i: number]: number },
  oo: number,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
): void {
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  const bx = b[bo]!
  const by = b[bo + 1]!
  const bz = b[bo + 2]!
  const bw = b[bo + 3]!
  out[oo] = aw * bx + ax * bw + ay * bz - az * by
  out[oo + 1] = aw * by - ax * bz + ay * bw + az * bx
  out[oo + 2] = aw * bz + ax * by - ay * bx + az * bw
  out[oo + 3] = aw * bw - ax * bx - ay * by - az * bz
}

const chain: Entity[] = []
const tmp = new Float64Array(4)

/** Applies a local TRS (from Transform columns) under `out` in place: out = out ∘ local. */
function composeLocal(
  out: Pose,
  t: ArrayLike<number>,
  to: number,
  r: ArrayLike<number>,
  ro: number,
  s: ArrayLike<number>,
  so: number,
): void {
  // position = parent.pos + parent.rot * (parent.scale ⊙ local.pos)
  rotate(tmp, 0, out, 3, out[7]! * t[to]!, out[8]! * t[to + 1]!, out[9]! * t[to + 2]!)
  out[0] = out[0]! + tmp[0]!
  out[1] = out[1]! + tmp[1]!
  out[2] = out[2]! + tmp[2]!
  mulQuat(out, 3, out, 3, r, ro)
  out[7] = out[7]! * s[so]!
  out[8] = out[8]! * s[so + 1]!
  out[9] = out[9]! * s[so + 2]!
}

/** The entity's parent, read from the ChildOf column (no allocation). */
export function parentOf(world: World, entity: Entity): Entity | undefined {
  const table = world.entityTableUnchecked(entity)
  if (!table.has(ChildOf)) return undefined
  const p = table.column(ChildOf, 'parent')[world.entityRowUnchecked(entity)]!
  return p >= 0 ? (p as Entity) : undefined
}

/**
 * World pose of an entity, from its own and its ancestors' Transforms (up to, not including,
 * `stop` when given: then the pose is relative to `stop`). Ignores shear from non-uniform scale
 * under rotation, like physics shapes do.
 */
export function poseOf(world: World, entity: Entity, out: Pose, stop?: Entity): Pose {
  chain.length = 0
  let e: Entity | undefined = entity
  while (e !== undefined && e !== stop) {
    chain.push(e)
    e = parentOf(world, e)
  }
  identityPose(out)
  for (let i = chain.length - 1; i >= 0; i--) {
    const ent = chain[i]!
    if (!world.has(ent, Transform)) continue
    const table = world.entityTable(ent)
    const row = world.entityRow(ent)
    composeLocal(
      out,
      table.column(Transform, 'translation'),
      row * 3,
      table.column(Transform, 'rotation'),
      row * 4,
      table.column(Transform, 'scale'),
      row * 3,
    )
  }
  return out
}

/**
 * The inverse of a parent's world matrix applied to a world position and rotation, for writing a
 * body's world pose back into its local Transform. Uses the parent's GlobalTransform.
 */
export function worldToLocal(
  world: World,
  parent: Entity,
  pos: ArrayLike<number>,
  rot: ArrayLike<number>,
  outPos: { [i: number]: number },
  po: number,
  outRot: { [i: number]: number },
  ro: number,
): void {
  const table = world.entityTable(parent)
  if (!table.has(GlobalTransform)) {
    outPos[po] = pos[0]!
    outPos[po + 1] = pos[1]!
    outPos[po + 2] = pos[2]!
    outRot[ro] = rot[0]!
    outRot[ro + 1] = rot[1]!
    outRot[ro + 2] = rot[2]!
    outRot[ro + 3] = rot[3]!
    return
  }
  const m = table.column(GlobalTransform, 'matrix')
  const o = world.entityRow(parent) * 12
  // Rows of the 3x4 matrix: [m0 m1 m2 m3; m4 m5 m6 m7; m8 m9 m10 m11]. Columns are scaled axes.
  const dx = pos[0]! - m[o + 3]!
  const dy = pos[1]! - m[o + 7]!
  const dz = pos[2]! - m[o + 11]!
  // Inverse of the 3x3 part (general, handles scale).
  const a = m[o]!
  const b = m[o + 1]!
  const c = m[o + 2]!
  const d = m[o + 4]!
  const e = m[o + 5]!
  const f = m[o + 6]!
  const g = m[o + 8]!
  const h = m[o + 9]!
  const i = m[o + 10]!
  const A = e * i - f * h
  const B = -(d * i - f * g)
  const C = d * h - e * g
  const det = a * A + b * B + c * C || 1
  const inv = 1 / det
  outPos[po] = (A * dx + (c * h - b * i) * dy + (b * f - c * e) * dz) * inv
  outPos[po + 1] = (B * dx + (a * i - c * g) * dy + (c * d - a * f) * dz) * inv
  outPos[po + 2] = (C * dx + (b * g - a * h) * dy + (a * e - b * d) * dz) * inv
  // Parent rotation: normalize the columns and take the quaternion of that basis.
  const sx = Math.sqrt(a * a + d * d + g * g) || 1
  const sy = Math.sqrt(b * b + e * e + h * h) || 1
  const sz = Math.sqrt(c * c + f * f + i * i) || 1
  quatFromBasis(tmp, a / sx, d / sx, g / sx, b / sy, e / sy, h / sy, c / sz, f / sz, i / sz)
  // local = conj(parent) * world
  tmp[0] = -tmp[0]!
  tmp[1] = -tmp[1]!
  tmp[2] = -tmp[2]!
  mulQuat(outRot, ro, tmp, 0, rot, 0)
}

/** Quaternion of a rotation matrix given by its columns (x axis, y axis, z axis). */
function quatFromBasis(
  out: Float64Array,
  m00: number,
  m10: number,
  m20: number,
  m01: number,
  m11: number,
  m21: number,
  m02: number,
  m12: number,
  m22: number,
): void {
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
}
