import type { Readable, Writable } from './types'

/** Quaternions are [x, y, z, w]. */
export const create = (): Float32Array => new Float32Array([0, 0, 0, 1])

export function identity<T extends Writable>(out: T): T {
  out[0] = 0
  out[1] = 0
  out[2] = 0
  out[3] = 1
  return out
}

export function set<T extends Writable>(out: T, x: number, y: number, z: number, w: number): T {
  out[0] = x
  out[1] = y
  out[2] = z
  out[3] = w
  return out
}

export function copy<T extends Writable>(out: T, a: Readable): T {
  out[0] = a[0]!
  out[1] = a[1]!
  out[2] = a[2]!
  out[3] = a[3]!
  return out
}

/** Rotation of `radians` around a unit `axis`. */
export function fromAxisAngle<T extends Writable>(out: T, axis: Readable, radians: number): T {
  const s = Math.sin(radians / 2)
  out[0] = axis[0]! * s
  out[1] = axis[1]! * s
  out[2] = axis[2]! * s
  out[3] = Math.cos(radians / 2)
  return out
}

/** Euler angles in radians, applied X first, then Y, then Z (q = qz · qy · qx). */
export function fromEuler<T extends Writable>(out: T, x: number, y: number, z: number): T {
  const sx = Math.sin(x / 2)
  const cx = Math.cos(x / 2)
  const sy = Math.sin(y / 2)
  const cy = Math.cos(y / 2)
  const sz = Math.sin(z / 2)
  const cz = Math.cos(z / 2)
  // b = qy · qx
  const bx = cy * sx
  const by = sy * cx
  const bz = -sy * sx
  const bw = cy * cx
  out[0] = cz * bx - sz * by
  out[1] = cz * by + sz * bx
  out[2] = sz * bw + cz * bz
  out[3] = cz * bw - sz * bz
  return out
}

/** out = a · b (apply b, then a). */
export function multiply<T extends Writable>(out: T, a: Readable, b: Readable): T {
  const ax = a[0]!
  const ay = a[1]!
  const az = a[2]!
  const aw = a[3]!
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  const bw = b[3]!
  out[0] = ax * bw + aw * bx + ay * bz - az * by
  out[1] = ay * bw + aw * by + az * bx - ax * bz
  out[2] = az * bw + aw * bz + ax * by - ay * bx
  out[3] = aw * bw - ax * bx - ay * by - az * bz
  return out
}

/** Inverse of a unit quaternion. */
export function conjugate<T extends Writable>(out: T, a: Readable): T {
  out[0] = -a[0]!
  out[1] = -a[1]!
  out[2] = -a[2]!
  out[3] = a[3]!
  return out
}

export function normalize<T extends Writable>(out: T, a: Readable): T {
  const x = a[0]!
  const y = a[1]!
  const z = a[2]!
  const w = a[3]!
  const len = Math.sqrt(x * x + y * y + z * z + w * w)
  const inv = len > 0 ? 1 / len : 0
  out[0] = x * inv
  out[1] = y * inv
  out[2] = z * inv
  out[3] = w * inv
  return out
}

export const dot = (a: Readable, b: Readable): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!

/** Spherical interpolation along the shortest arc. */
export function slerp<T extends Writable>(out: T, a: Readable, b: Readable, t: number): T {
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
  let s0: number
  let s1: number
  if (1 - cos > 1e-6) {
    const omega = Math.acos(cos)
    const sin = Math.sin(omega)
    s0 = Math.sin((1 - t) * omega) / sin
    s1 = Math.sin(t * omega) / sin
  } else {
    s0 = 1 - t
    s1 = t
  }
  out[0] = s0 * ax + s1 * bx
  out[1] = s0 * ay + s1 * by
  out[2] = s0 * az + s1 * bz
  out[3] = s0 * aw + s1 * bw
  return out
}

/** Rotation from the columns of an orthonormal basis (x, y, z axes). */
export function fromBasis<T extends Writable>(out: T, x: Readable, y: Readable, z: Readable): T {
  const m00 = x[0]!
  const m10 = x[1]!
  const m20 = x[2]!
  const m01 = y[0]!
  const m11 = y[1]!
  const m21 = y[2]!
  const m02 = z[0]!
  const m12 = z[1]!
  const m22 = z[2]!
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
  return out
}

/** Rotation that points -Z along `forward`, keeping +Y as close to `up` as possible. */
export function lookRotation<T extends Writable>(out: T, forward: Readable, up: Readable): T {
  // z axis = -forward
  let zx = -forward[0]!
  let zy = -forward[1]!
  let zz = -forward[2]!
  let len = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1
  zx /= len
  zy /= len
  zz /= len
  // x = up × z
  let xx = up[1]! * zz - up[2]! * zy
  let xy = up[2]! * zx - up[0]! * zz
  let xz = up[0]! * zy - up[1]! * zx
  len = Math.sqrt(xx * xx + xy * xy + xz * xz)
  if (len < 1e-6) {
    // forward is parallel to up: pick any perpendicular
    xx = 1
    xy = 0
    xz = 0
    len = 1
  }
  xx /= len
  xy /= len
  xz /= len
  // y = z × x
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const m00 = xx
  const m10 = xy
  const m20 = xz
  const m01 = yx
  const m11 = yy
  const m21 = yz
  const m02 = zx
  const m12 = zy
  const m22 = zz
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
  return out
}
