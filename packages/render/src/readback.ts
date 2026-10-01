/** Readback helpers: bytes per texel and conversion of any readable format to floats. */

export const BYTES_PER_TEXEL: Partial<Record<GPUTextureFormat, number>> = {
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
  rgba32float: 16,
  r32float: 4,
  r32uint: 4,
  rg16float: 4,
  r16float: 2,
  r8unorm: 1,
  rg11b10ufloat: 4,
  depth32float: 4,
}

export function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

/** Unpacks a readback row of any supported format into 4 floats per pixel. */
export function toFloats(
  src: ArrayBuffer,
  format: GPUTextureFormat,
  count: number,
  out: Float32Array,
  o: number,
) {
  switch (format) {
    case 'rgba16float': {
      const h = new Uint16Array(src, 0, count * 4)
      for (let i = 0; i < count * 4; i++) out[o + i] = halfToFloat(h[i]!)
      return
    }
    case 'rg16float': {
      const h = new Uint16Array(src, 0, count * 2)
      for (let i = 0; i < count; i++) {
        out[o + i * 4] = halfToFloat(h[i * 2]!)
        out[o + i * 4 + 1] = halfToFloat(h[i * 2 + 1]!)
      }
      return
    }
    case 'r16float': {
      const h = new Uint16Array(src, 0, count)
      for (let i = 0; i < count; i++) out[o + i * 4] = halfToFloat(h[i]!)
      return
    }
    case 'rgba32float':
      out.set(new Float32Array(src, 0, count * 4), o)
      return
    case 'r32float':
    case 'depth32float': {
      const f = new Float32Array(src, 0, count)
      for (let i = 0; i < count; i++) out[o + i * 4] = f[i]!
      return
    }
    case 'r32uint': {
      const u = new Uint32Array(src, 0, count)
      for (let i = 0; i < count; i++) out[o + i * 4] = u[i]!
      return
    }
    case 'r8unorm': {
      const b = new Uint8Array(src, 0, count)
      for (let i = 0; i < count; i++) out[o + i * 4] = b[i]! / 255
      return
    }
    case 'rg11b10ufloat': {
      const u = new Uint32Array(src, 0, count)
      for (let i = 0; i < count; i++) {
        const v = u[i]!
        out[o + i * 4] = small(v & 0x7ff, 6)
        out[o + i * 4 + 1] = small((v >>> 11) & 0x7ff, 6)
        out[o + i * 4 + 2] = small((v >>> 22) & 0x3ff, 5)
      }
      return
    }
    default: {
      const b = new Uint8Array(src, 0, count * 4)
      const bgra = format.startsWith('bgra')
      for (let i = 0; i < count; i++) {
        out[o + i * 4] = b[i * 4 + (bgra ? 2 : 0)]! / 255
        out[o + i * 4 + 1] = b[i * 4 + 1]! / 255
        out[o + i * 4 + 2] = b[i * 4 + (bgra ? 0 : 2)]! / 255
        out[o + i * 4 + 3] = b[i * 4 + 3]! / 255
      }
    }
  }
}

/** Unsigned small floats (11 and 10 bit) with a 5-bit exponent. */
function small(v: number, mantissaBits: number): number {
  const e = v >>> mantissaBits
  const m = v & ((1 << mantissaBits) - 1)
  if (e === 0) return 2 ** -14 * (m / (1 << mantissaBits))
  if (e === 31) return m ? Number.NaN : Number.POSITIVE_INFINITY
  return 2 ** (e - 15) * (1 + m / (1 << mantissaBits))
}
