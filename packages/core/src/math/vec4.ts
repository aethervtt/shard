import type { Readable, Writable } from './types'

export const create = (x = 0, y = 0, z = 0, w = 0): Float32Array => new Float32Array([x, y, z, w])

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

export function scale<T extends Writable>(out: T, a: Readable, s: number): T {
  out[0] = a[0]! * s
  out[1] = a[1]! * s
  out[2] = a[2]! * s
  out[3] = a[3]! * s
  return out
}

export const dot = (a: Readable, b: Readable): number =>
  a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!

export function lerp<T extends Writable>(out: T, a: Readable, b: Readable, t: number): T {
  for (let i = 0; i < 4; i++) out[i] = a[i]! + (b[i]! - a[i]!) * t
  return out
}

export function transformMat4<T extends Writable>(out: T, a: Readable, m: Readable): T {
  const x = a[0]!
  const y = a[1]!
  const z = a[2]!
  const w = a[3]!
  out[0] = m[0]! * x + m[4]! * y + m[8]! * z + m[12]! * w
  out[1] = m[1]! * x + m[5]! * y + m[9]! * z + m[13]! * w
  out[2] = m[2]! * x + m[6]! * y + m[10]! * z + m[14]! * w
  out[3] = m[3]! * x + m[7]! * y + m[11]! * z + m[15]! * w
  return out
}
