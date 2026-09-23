import type { Readable, Writable } from './types'

/** Column-major 4x4: element (row r, column c) is at index c * 4 + r. */
export const create = (): Float32Array => identity(new Float32Array(16))

export function identity<T extends Writable>(out: T): T {
  for (let i = 0; i < 16; i++) out[i] = i % 5 === 0 ? 1 : 0
  return out
}

export function copy<T extends Writable>(out: T, a: Readable): T {
  for (let i = 0; i < 16; i++) out[i] = a[i]!
  return out
}

/** out = a · b */
export function multiply<T extends Writable>(out: T, a: Readable, b: Readable): T {
  const a00 = a[0]!
  const a01 = a[1]!
  const a02 = a[2]!
  const a03 = a[3]!
  const a10 = a[4]!
  const a11 = a[5]!
  const a12 = a[6]!
  const a13 = a[7]!
  const a20 = a[8]!
  const a21 = a[9]!
  const a22 = a[10]!
  const a23 = a[11]!
  const a30 = a[12]!
  const a31 = a[13]!
  const a32 = a[14]!
  const a33 = a[15]!
  for (let c = 0; c < 4; c++) {
    const b0 = b[c * 4]!
    const b1 = b[c * 4 + 1]!
    const b2 = b[c * 4 + 2]!
    const b3 = b[c * 4 + 3]!
    out[c * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
    out[c * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
    out[c * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
    out[c * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
  }
  return out
}

export function transpose<T extends Writable>(out: T, a: Readable): T {
  if ((out as unknown) === a) {
    for (let r = 0; r < 4; r++) {
      for (let c = r + 1; c < 4; c++) {
        const tmp = out[c * 4 + r]!
        out[c * 4 + r] = out[r * 4 + c]!
        out[r * 4 + c] = tmp
      }
    }
    return out
  }
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) out[c * 4 + r] = a[r * 4 + c]!
  return out
}

/** General inverse. Returns null (and leaves `out` untouched) for singular matrices. */
export function invert<T extends Writable>(out: T, a: Readable): T | null {
  const a00 = a[0]!
  const a01 = a[1]!
  const a02 = a[2]!
  const a03 = a[3]!
  const a10 = a[4]!
  const a11 = a[5]!
  const a12 = a[6]!
  const a13 = a[7]!
  const a20 = a[8]!
  const a21 = a[9]!
  const a22 = a[10]!
  const a23 = a[11]!
  const a30 = a[12]!
  const a31 = a[13]!
  const a32 = a[14]!
  const a33 = a[15]!
  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (!det) return null
  det = 1 / det
  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
  return out
}

/** Translation · rotation · scale. */
export function fromTRS<T extends Writable>(out: T, t: Readable, q: Readable, s: Readable): T {
  const x = q[0]!
  const y = q[1]!
  const z = q[2]!
  const w = q[3]!
  const sx = s[0]!
  const sy = s[1]!
  const sz = s[2]!
  out[0] = (1 - 2 * (y * y + z * z)) * sx
  out[1] = 2 * (x * y + w * z) * sx
  out[2] = 2 * (x * z - w * y) * sx
  out[3] = 0
  out[4] = 2 * (x * y - w * z) * sy
  out[5] = (1 - 2 * (x * x + z * z)) * sy
  out[6] = 2 * (y * z + w * x) * sy
  out[7] = 0
  out[8] = 2 * (x * z + w * y) * sz
  out[9] = 2 * (y * z - w * x) * sz
  out[10] = (1 - 2 * (x * x + y * y)) * sz
  out[11] = 0
  out[12] = t[0]!
  out[13] = t[1]!
  out[14] = t[2]!
  out[15] = 1
  return out
}

export function getTranslation<T extends Writable>(out: T, m: Readable): T {
  out[0] = m[12]!
  out[1] = m[13]!
  out[2] = m[14]!
  return out
}

function clear(out: Writable): void {
  for (let i = 0; i < 16; i++) out[i] = 0
}

/** Perspective projection with WebGPU 0..1 depth (near → 0, far → 1). */
export function perspective<T extends Writable>(
  out: T,
  fovY: number,
  aspect: number,
  near: number,
  far: number,
): T {
  const f = 1 / Math.tan(fovY / 2)
  clear(out)
  out[0] = f / aspect
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (far * near) / (near - far)
  return out
}

/** Reversed-Z perspective with an infinite far plane: near → 1, infinity → 0. */
export function perspectiveReversedZ<T extends Writable>(
  out: T,
  fovY: number,
  aspect: number,
  near: number,
): T {
  const f = 1 / Math.tan(fovY / 2)
  clear(out)
  out[0] = f / aspect
  out[5] = f
  out[11] = -1
  out[14] = near
  return out
}

/** Orthographic projection with WebGPU 0..1 depth (near → 0, far → 1). */
export function orthographic<T extends Writable>(
  out: T,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): T {
  clear(out)
  out[0] = 2 / (right - left)
  out[5] = 2 / (top - bottom)
  out[10] = 1 / (near - far)
  out[12] = (left + right) / (left - right)
  out[13] = (top + bottom) / (bottom - top)
  out[14] = near / (near - far)
  out[15] = 1
  return out
}

/** Reversed-Z orthographic: near → 1, far → 0. */
export function orthographicReversedZ<T extends Writable>(
  out: T,
  left: number,
  right: number,
  bottom: number,
  top: number,
  near: number,
  far: number,
): T {
  orthographic(out, left, right, bottom, top, near, far)
  out[10] = 1 / (far - near)
  out[14] = far / (far - near)
  return out
}

/** View matrix for a camera at `eye` looking at `target`. */
export function lookAt<T extends Writable>(
  out: T,
  eye: Readable,
  target: Readable,
  up: Readable,
): T {
  let zx = eye[0]! - target[0]!
  let zy = eye[1]! - target[1]!
  let zz = eye[2]! - target[2]!
  let len = Math.sqrt(zx * zx + zy * zy + zz * zz) || 1
  zx /= len
  zy /= len
  zz /= len
  let xx = up[1]! * zz - up[2]! * zy
  let xy = up[2]! * zx - up[0]! * zz
  let xz = up[0]! * zy - up[1]! * zx
  len = Math.sqrt(xx * xx + xy * xy + xz * xz) || 1
  xx /= len
  xy /= len
  xz /= len
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  out[0] = xx
  out[1] = yx
  out[2] = zx
  out[3] = 0
  out[4] = xy
  out[5] = yy
  out[6] = zy
  out[7] = 0
  out[8] = xz
  out[9] = yz
  out[10] = zz
  out[11] = 0
  out[12] = -(xx * eye[0]! + xy * eye[1]! + xz * eye[2]!)
  out[13] = -(yx * eye[0]! + yy * eye[1]! + yz * eye[2]!)
  out[14] = -(zx * eye[0]! + zy * eye[1]! + zz * eye[2]!)
  out[15] = 1
  return out
}
