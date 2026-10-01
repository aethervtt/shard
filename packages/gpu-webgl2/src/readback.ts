import type { GlFormat } from './formats'
import { GL } from './gl'

// Reading texels back. WebGL2's readPixels only promises a few format/type pairs: RGBA bytes for
// normalized targets, RGBA floats for float ones (EXT_color_buffer_float), RGBA 32-bit integers for
// integer ones. Formats whose WebGPU bytes are exactly that read straight into the destination
// buffer; the rest read in the promised layout and are repacked into WebGPU's texel bytes.

/** A readPixels format/type pair, the bytes a texel takes in it, and whether that's WebGPU's layout. */
export interface ReadFormat {
  format: number
  type: number
  bytes: number
  direct: boolean
}

const READ_BYTES: ReadFormat = { format: GL.RGBA, type: GL.UNSIGNED_BYTE, bytes: 4, direct: false }
const READ_BYTES_DIRECT: ReadFormat = { ...READ_BYTES, direct: true }
const READ_FLOAT: ReadFormat = { format: GL.RGBA, type: GL.FLOAT, bytes: 16, direct: false }
const READ_FLOAT_DIRECT: ReadFormat = { ...READ_FLOAT, direct: true }
const READ_UINT: ReadFormat = {
  format: GL.RGBA_INTEGER,
  type: GL.UNSIGNED_INT,
  bytes: 16,
  direct: false,
}
const READ_UINT_DIRECT: ReadFormat = { ...READ_UINT, direct: true }
const READ_SINT: ReadFormat = { format: GL.RGBA_INTEGER, type: GL.INT, bytes: 16, direct: false }

/** How a format reads back. Depth reads as floats: it's drawn into an R32F target first. */
export function readFormatOf(info: GlFormat): ReadFormat {
  if (info.kind === 'uint') return info.internal === GL.RGBA32UI ? READ_UINT_DIRECT : READ_UINT
  if (info.kind === 'sint') return READ_SINT
  if (info.kind === 'depth') return READ_FLOAT
  if (info.type === GL.UNSIGNED_BYTE || info.type === GL.UNSIGNED_INT_2_10_10_10_REV) {
    return info.internal === GL.RGBA8 || info.internal === GL.SRGB8_ALPHA8
      ? READ_BYTES_DIRECT
      : READ_BYTES
  }
  return info.internal === GL.RGBA32F ? READ_FLOAT_DIRECT : READ_FLOAT
}

const scratch = new DataView(new ArrayBuffer(4))

/** A float32 as float16 bits (round to nearest; exact for values a half target stored). */
export function floatToHalf(value: number): number {
  scratch.setFloat32(0, value, true)
  const x = scratch.getUint32(0, true)
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  let mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0)
  let e = exp - 112
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    if (e < -10) return sign
    mant = (mant | 0x800000) >>> (1 - e)
    return sign | ((mant + 0x1000) >>> 13)
  }
  mant += 0x1000
  if (mant & 0x800000) {
    mant = 0
    e++
    if (e >= 0x1f) return sign | 0x7c00
  }
  return sign | (e << 10) | (mant >>> 13)
}

/** A non-negative float as an unsigned float of 5 exponent bits and `bits` mantissa bits. */
function toUfloat(value: number, bits: number): number {
  if (!(value > 0)) return 0
  scratch.setFloat32(0, value, true)
  const x = scratch.getUint32(0, true)
  const e = ((x >>> 23) & 0xff) - 112
  const mant = x & 0x7fffff
  if (e >= 0x1f) return 0x1f << bits
  if (e <= 0) return ((mant | 0x800000) >>> (1 - e)) >>> (23 - bits)
  return (e << bits) | (mant >>> (23 - bits))
}

/**
 * Rewrites `rows` rows of `width` texels read as `read` (tight rows, `src`) into WebGPU's bytes for
 * `info`, `bytesPerRow` apart from `outOffset` in `out`.
 */
export function repack(
  src: Uint8Array,
  read: ReadFormat,
  info: GlFormat,
  width: number,
  rows: number,
  out: Uint8Array,
  outOffset: number,
  bytesPerRow: number,
): void {
  const input = new DataView(src.buffer, src.byteOffset, src.byteLength)
  const output = new DataView(out.buffer, out.byteOffset, out.byteLength)
  const components = info.components
  const size = info.bytes / components
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * read.bytes
      const o = outOffset + y * bytesPerRow + x * info.bytes
      if (info.internal === GL.RGB10_A2) {
        const r = Math.round((src[i]! * 1023) / 255)
        const g = Math.round((src[i + 1]! * 1023) / 255)
        const b = Math.round((src[i + 2]! * 1023) / 255)
        const a = Math.round((src[i + 3]! * 3) / 255)
        output.setUint32(o, (r | (g << 10) | (b << 20) | (a << 30)) >>> 0, true)
        continue
      }
      if (info.internal === GL.R11F_G11F_B10F) {
        const r = toUfloat(input.getFloat32(i, true), 6)
        const g = toUfloat(input.getFloat32(i + 4, true), 6)
        const b = toUfloat(input.getFloat32(i + 8, true), 5)
        output.setUint32(o, (r | (g << 11) | (b << 22)) >>> 0, true)
        continue
      }
      for (let c = 0; c < components; c++) {
        const p = o + c * size
        if (read.type === GL.UNSIGNED_BYTE) {
          out[p] = src[i + c]!
        } else if (read.type === GL.FLOAT) {
          const v = input.getFloat32(i + c * 4, true)
          if (size === 4) output.setFloat32(p, v, true)
          else if (info.depth)
            output.setUint16(p, Math.round(Math.min(1, Math.max(0, v)) * 65535), true)
          else output.setUint16(p, floatToHalf(v), true)
        } else {
          const v = input.getUint32(i + c * 4, true)
          if (size === 4) output.setUint32(p, v, true)
          else if (size === 2) output.setUint16(p, v & 0xffff, true)
          else out[p] = v & 0xff
        }
      }
    }
  }
}
