import type { Readable, Writable } from './types'

export const create = (x = 0, y = 0): Float32Array => new Float32Array([x, y])

export function set<T extends Writable>(out: T, x: number, y: number): T {
  out[0] = x
  out[1] = y
  return out
}

export function copy<T extends Writable>(out: T, a: Readable): T {
  out[0] = a[0]!
  out[1] = a[1]!
  return out
}

export function add<T extends Writable>(out: T, a: Readable, b: Readable): T {
  out[0] = a[0]! + b[0]!
  out[1] = a[1]! + b[1]!
  return out
}

export function sub<T extends Writable>(out: T, a: Readable, b: Readable): T {
  out[0] = a[0]! - b[0]!
  out[1] = a[1]! - b[1]!
  return out
}

export function scale<T extends Writable>(out: T, a: Readable, s: number): T {
  out[0] = a[0]! * s
  out[1] = a[1]! * s
  return out
}

export const dot = (a: Readable, b: Readable): number => a[0]! * b[0]! + a[1]! * b[1]!
export const length = (a: Readable): number => Math.sqrt(a[0]! * a[0]! + a[1]! * a[1]!)

export function normalize<T extends Writable>(out: T, a: Readable): T {
  const len = Math.sqrt(a[0]! * a[0]! + a[1]! * a[1]!)
  const inv = len > 0 ? 1 / len : 0
  out[0] = a[0]! * inv
  out[1] = a[1]! * inv
  return out
}

export function lerp<T extends Writable>(out: T, a: Readable, b: Readable, t: number): T {
  out[0] = a[0]! + (b[0]! - a[0]!) * t
  out[1] = a[1]! + (b[1]! - a[1]!) * t
  return out
}
