import { EPSILON, type Readable, type Writable } from './types'

export const create = (x = 0, y = 0, z = 0): Float32Array => new Float32Array([x, y, z])

export function set<T extends Writable>(out: T, x: number, y: number, z: number): T {
  out[0] = x
  out[1] = y
  out[2] = z
  return out
}

export function copy<T extends Writable>(out: T, a: Readable): T {
  out[0] = a[0]!
  out[1] = a[1]!
  out[2] = a[2]!
  return out
}

export function add<T extends Writable>(out: T, a: Readable, b: Readable): T {
  out[0] = a[0]! + b[0]!
  out[1] = a[1]! + b[1]!
  out[2] = a[2]! + b[2]!
  return out
}

export function sub<T extends Writable>(out: T, a: Readable, b: Readable): T {
  out[0] = a[0]! - b[0]!
  out[1] = a[1]! - b[1]!
  out[2] = a[2]! - b[2]!
  return out
}

export function mul<T extends Writable>(out: T, a: Readable, b: Readable): T {
  out[0] = a[0]! * b[0]!
  out[1] = a[1]! * b[1]!
  out[2] = a[2]! * b[2]!
  return out
}

export function scale<T extends Writable>(out: T, a: Readable, s: number): T {
  out[0] = a[0]! * s
  out[1] = a[1]! * s
  out[2] = a[2]! * s
  return out
}

/** out = a + b * s */
export function scaleAndAdd<T extends Writable>(out: T, a: Readable, b: Readable, s: number): T {
  out[0] = a[0]! + b[0]! * s
  out[1] = a[1]! + b[1]! * s
  out[2] = a[2]! + b[2]! * s
  return out
}

export function negate<T extends Writable>(out: T, a: Readable): T {
  out[0] = -a[0]!
  out[1] = -a[1]!
  out[2] = -a[2]!
  return out
}

export const dot = (a: Readable, b: Readable): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!

export function cross<T extends Writable>(out: T, a: Readable, b: Readable): T {
  const ax = a[0]!
  const ay = a[1]!
  const az = a[2]!
  const bx = b[0]!
  const by = b[1]!
  const bz = b[2]!
  out[0] = ay * bz - az * by
  out[1] = az * bx - ax * bz
  out[2] = ax * by - ay * bx
  return out
}

export const lengthSq = (a: Readable): number => a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!
export const length = (a: Readable): number => Math.sqrt(lengthSq(a))

export function distance(a: Readable, b: Readable): number {
  const x = a[0]! - b[0]!
  const y = a[1]! - b[1]!
  const z = a[2]! - b[2]!
  return Math.sqrt(x * x + y * y + z * z)
}

export function normalize<T extends Writable>(out: T, a: Readable): T {
  const len = length(a)
  const inv = len > 0 ? 1 / len : 0
  out[0] = a[0]! * inv
  out[1] = a[1]! * inv
  out[2] = a[2]! * inv
  return out
}

export function lerp<T extends Writable>(out: T, a: Readable, b: Readable, t: number): T {
  out[0] = a[0]! + (b[0]! - a[0]!) * t
  out[1] = a[1]! + (b[1]! - a[1]!) * t
  out[2] = a[2]! + (b[2]! - a[2]!) * t
  return out
}

/** Rotates `a` by unit quaternion `q`. */
export function transformQuat<T extends Writable>(out: T, a: Readable, q: Readable): T {
  const qx = q[0]!
  const qy = q[1]!
  const qz = q[2]!
  const qw = q[3]!
  const x = a[0]!
  const y = a[1]!
  const z = a[2]!
  // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  out[0] = x + qw * tx + (qy * tz - qz * ty)
  out[1] = y + qw * ty + (qz * tx - qx * tz)
  out[2] = z + qw * tz + (qx * ty - qy * tx)
  return out
}

/** Transforms a point by a column-major mat4, with perspective divide. */
export function transformMat4<T extends Writable>(out: T, a: Readable, m: Readable): T {
  const x = a[0]!
  const y = a[1]!
  const z = a[2]!
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! || 1
  out[0] = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w
  out[1] = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w
  out[2] = (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w
  return out
}

export function equals(a: Readable, b: Readable, epsilon = EPSILON): boolean {
  return (
    Math.abs(a[0]! - b[0]!) <= epsilon &&
    Math.abs(a[1]! - b[1]!) <= epsilon &&
    Math.abs(a[2]! - b[2]!) <= epsilon
  )
}
