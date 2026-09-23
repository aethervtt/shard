import type { Image } from './image'

export type TextureUsage = 'color' | 'data' | 'normal' | 'hdr'

const SRGB_TO_LINEAR = new Float32Array(256)
for (let i = 0; i < 256; i++) {
  const c = i / 255
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Linear [0, 1] → sRGB byte through a 16k-entry table (exact to within one step of rounding). */
const LUT_SIZE = 16384
const LINEAR_TO_SRGB = new Uint8Array(LUT_SIZE + 1)
for (let i = 0; i <= LUT_SIZE; i++) {
  const v = i / LUT_SIZE
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055
  LINEAR_TO_SRGB[i] = Math.round(c * 255)
}

function linearToSrgb8(v: number): number {
  return LINEAR_TO_SRGB[v <= 0 ? 0 : v >= 1 ? LUT_SIZE : Math.round(v * LUT_SIZE)]!
}

/** Unpacks an image into linear-ish floats for filtering, per usage. */
function toFloats(image: Image, usage: TextureUsage): Float32Array {
  if (image.kind === 'f32') return Float32Array.from(image.data)
  const src = image.data as Uint8Array
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = src[i + c]!
      out[i + c] =
        usage === 'color' ? SRGB_TO_LINEAR[v]! : usage === 'normal' ? (v / 255) * 2 - 1 : v / 255
    }
    out[i + 3] = src[i + 3]! / 255
  }
  return out
}

function fromFloats(data: Float32Array, usage: TextureUsage): Uint8Array | Float32Array {
  if (usage === 'hdr') return data
  const out = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!
      out[i + c] =
        usage === 'color'
          ? linearToSrgb8(v)
          : usage === 'normal'
            ? Math.round(Math.min(1, Math.max(0, v * 0.5 + 0.5)) * 255)
            : Math.round(Math.min(1, Math.max(0, v)) * 255)
    }
    out[i + 3] = Math.round(Math.min(1, Math.max(0, data[i + 3]!)) * 255)
  }
  return out
}

/** Halves an RGBA float image with a 2x2 box filter (edges clamp for odd sizes). */
function downsample(src: Float32Array, w: number, h: number, usage: TextureUsage) {
  const nw = Math.max(1, w >> 1)
  const nh = Math.max(1, h >> 1)
  const out = new Float32Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, y * 2)
    const y1 = Math.min(h - 1, y * 2 + 1)
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2)
      const x1 = Math.min(w - 1, x * 2 + 1)
      const a = (y0 * w + x0) * 4
      const b = (y0 * w + x1) * 4
      const c = (y1 * w + x0) * 4
      const d = (y1 * w + x1) * 4
      const o = (y * nw + x) * 4
      for (let k = 0; k < 4; k++)
        out[o + k] = (src[a + k]! + src[b + k]! + src[c + k]! + src[d + k]!) * 0.25
      if (usage === 'normal') {
        const len = Math.sqrt(out[o]! ** 2 + out[o + 1]! ** 2 + out[o + 2]! ** 2) || 1
        out[o] = out[o]! / len
        out[o + 1] = out[o + 1]! / len
        out[o + 2] = out[o + 2]! / len
      }
    }
  }
  return { data: out, width: nw, height: nh }
}

export interface MipChain {
  width: number
  height: number
  /** Level 0 first; RGBA8 (sRGB-encoded for color) or RGBA float for hdr. */
  levels: (Uint8Array | Float32Array)[]
}

export interface MipOptions {
  usage: TextureUsage
  mipmaps: boolean
  maxSize: number
  flipY: boolean
  premultiplyAlpha: boolean
}

/**
 * Prepares an image for upload: flip, premultiply, then a full mip chain filtered in linear light
 * (normal maps renormalized per level). Levels larger than `maxSize` are dropped.
 */
export function buildMips(image: Image, options: MipOptions): MipChain {
  const { usage } = options
  let data = toFloats(image, usage)
  let w = image.width
  let h = image.height
  if (options.flipY) {
    const flipped = new Float32Array(data.length)
    for (let y = 0; y < h; y++)
      flipped.set(data.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4)
    data = flipped
  }
  if (options.premultiplyAlpha) {
    for (let i = 0; i < data.length; i += 4) {
      data[i] = data[i]! * data[i + 3]!
      data[i + 1] = data[i + 1]! * data[i + 3]!
      data[i + 2] = data[i + 2]! * data[i + 3]!
    }
  }
  const chain: { data: Float32Array; width: number; height: number }[] = [
    { data, width: w, height: h },
  ]
  while ((options.mipmaps || w > options.maxSize || h > options.maxSize) && (w > 1 || h > 1)) {
    const next = downsample(data, w, h, usage)
    chain.push(next)
    data = next.data
    w = next.width
    h = next.height
    if (!options.mipmaps && w <= options.maxSize && h <= options.maxSize) break
  }
  let first = chain.findIndex((l) => l.width <= options.maxSize && l.height <= options.maxSize)
  if (first === -1) first = chain.length - 1
  const kept = options.mipmaps ? chain.slice(first) : [chain[first]!]
  return {
    width: kept[0]!.width,
    height: kept[0]!.height,
    levels: kept.map((l) => fromFloats(l.data, usage)),
  }
}

/** Float32 → IEEE half floats (for rgba16float). */
export function toHalf(data: Float32Array): Uint16Array {
  const out = new Uint16Array(data.length)
  const f = new Float32Array(1)
  const u = new Uint32Array(f.buffer)
  for (let i = 0; i < data.length; i++) {
    f[0] = data[i]!
    const x = u[0]!
    const sign = (x >>> 16) & 0x8000
    const exp = ((x >>> 23) & 0xff) - 127 + 15
    const mant = x & 0x7fffff
    if (exp <= 0) out[i] = sign
    else if (exp >= 31) out[i] = sign | 0x7c00
    else out[i] = sign | (exp << 10) | (mant >>> 13)
  }
  return out
}
