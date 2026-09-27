import { ShardError } from '@aethervtt/shard-core'
import type { Image } from '../image'

async function inflate(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }

/** Adam7 passes: start x, start y, step x, step y. */
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Reverses PNG row filters in place. `bpp` is bytes per complete pixel (at least 1). */
function unfilter(
  raw: Uint8Array,
  offset: number,
  rowBytes: number,
  rows: number,
  bpp: number,
): Uint8Array {
  const out = new Uint8Array(rowBytes * rows)
  for (let y = 0; y < rows; y++) {
    const filter = raw[offset + y * (rowBytes + 1)]!
    const src = offset + y * (rowBytes + 1) + 1
    const row = y * rowBytes
    const prev = row - rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x]!
      const a = x >= bpp ? out[row + x - bpp]! : 0
      const b = y > 0 ? out[prev + x]! : 0
      const c = x >= bpp && y > 0 ? out[prev + x - bpp]! : 0
      let r: number
      switch (filter) {
        case 0:
          r = v
          break
        case 1:
          r = v + a
          break
        case 2:
          r = v + b
          break
        case 3:
          r = v + ((a + b) >> 1)
          break
        case 4:
          r = v + paeth(a, b, c)
          break
        default:
          throw new ShardError('texture/decode-failed', `PNG row filter ${filter} is invalid`)
      }
      out[row + x] = r & 0xff
    }
  }
  return out
}

export interface PngInfo {
  /** The file declares sRGB (sRGB chunk or an ICC profile), linear (gAMA 1.0), or says nothing. */
  colorSpace: 'srgb' | 'linear' | 'unspecified'
}

/**
 * Decodes any standard PNG: gray, RGB, palette (with tRNS), gray+alpha, RGBA; bit depths 1–16;
 * interlaced or not. Output is RGBA8 (16-bit samples round to 8 bits).
 */
export async function decodePngImage(png: Uint8Array): Promise<Image & PngInfo> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 8 || view.getUint32(0) !== 0x89504e47) {
    throw new ShardError('texture/decode-failed', 'Not a PNG file')
  }
  let offset = 8
  let width = 0
  let height = 0
  let depth = 8
  let colorType = 6
  let interlace = 0
  let palette: Uint8Array | undefined
  let trns: Uint8Array | undefined
  let colorSpace: PngInfo['colorSpace'] = 'unspecified'
  const idat: Uint8Array[] = []
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(
      png[offset + 4]!,
      png[offset + 5]!,
      png[offset + 6]!,
      png[offset + 7]!,
    )
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      const d = new DataView(data.buffer, data.byteOffset)
      width = d.getUint32(0)
      height = d.getUint32(4)
      depth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'sRGB' || type === 'iCCP') colorSpace = 'srgb'
    else if (type === 'gAMA' && colorSpace === 'unspecified') {
      const gamma = new DataView(data.buffer, data.byteOffset).getUint32(0)
      colorSpace = gamma === 100000 ? 'linear' : 'srgb'
    } else if (type === 'IEND') break
    offset += 12 + length
  }
  const channels = CHANNELS[colorType]
  if (!width || !height || !channels) {
    throw new ShardError('texture/decode-failed', 'PNG header is missing or invalid')
  }
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of idat) {
    joined.set(p, o)
    o += p.length
  }
  const raw = await inflate(joined)
  const bitsPerPixel = channels * depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const out = new Uint8Array(width * height * 4)
  const maxValue = (1 << depth) - 1

  const sample = (row: Uint8Array, rowStart: number, x: number, c: number): number => {
    if (depth === 8) return row[rowStart + x * channels + c]!
    if (depth === 16) {
      const i = rowStart + (x * channels + c) * 2
      return row[i]! * 256 + row[i + 1]!
    }
    const bit = (x * channels + c) * depth
    const byte = row[rowStart + (bit >> 3)]!
    return (byte >> (8 - depth - (bit & 7))) & maxValue
  }
  const to8 = (v: number) =>
    depth === 8 ? v : depth === 16 ? Math.round(v / 257) : Math.round((v * 255) / maxValue)

  const put = (row: Uint8Array, rowStart: number, x: number, px: number, py: number) => {
    const i = (py * width + px) * 4
    if (colorType === 3) {
      const index = sample(row, rowStart, x, 0)
      out[i] = palette?.[index * 3] ?? 0
      out[i + 1] = palette?.[index * 3 + 1] ?? 0
      out[i + 2] = palette?.[index * 3 + 2] ?? 0
      out[i + 3] = trns && index < trns.length ? trns[index]! : 255
      return
    }
    if (colorType === 0 || colorType === 4) {
      const g = sample(row, rowStart, x, 0)
      out[i] = out[i + 1] = out[i + 2] = to8(g)
      if (colorType === 4) out[i + 3] = to8(sample(row, rowStart, x, 1))
      else {
        const key = trns ? new DataView(trns.buffer, trns.byteOffset).getUint16(0) : -1
        out[i + 3] = g === key ? 0 : 255
      }
      return
    }
    const r = sample(row, rowStart, x, 0)
    const g = sample(row, rowStart, x, 1)
    const b = sample(row, rowStart, x, 2)
    out[i] = to8(r)
    out[i + 1] = to8(g)
    out[i + 2] = to8(b)
    if (colorType === 6) out[i + 3] = to8(sample(row, rowStart, x, 3))
    else {
      const t = trns ? new DataView(trns.buffer, trns.byteOffset) : undefined
      out[i + 3] =
        t && r === t.getUint16(0) && g === t.getUint16(2) && b === t.getUint16(4) ? 0 : 255
    }
  }

  if (interlace === 0) {
    const rowBytes = Math.ceil((width * bitsPerPixel) / 8)
    const pixels = unfilter(raw, 0, rowBytes, height, bpp)
    if (depth === 8 && colorType === 6)
      return { width, height, kind: 'u8', data: pixels, colorSpace }
    if (depth === 8 && colorType === 2 && !trns) {
      // The common opaque RGB case, without the general per-sample path.
      for (let i = 0, o = 0; i < pixels.length; i += 3, o += 4) {
        out[o] = pixels[i]!
        out[o + 1] = pixels[i + 1]!
        out[o + 2] = pixels[i + 2]!
        out[o + 3] = 255
      }
      return { width, height, kind: 'u8', data: out, colorSpace }
    }
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) put(pixels, y * rowBytes, x, x, y)
  } else {
    let at = 0
    for (const [sx, sy, dx, dy] of ADAM7) {
      const w = Math.ceil((width - sx) / dx)
      const h = Math.ceil((height - sy) / dy)
      if (w <= 0 || h <= 0) continue
      const rowBytes = Math.ceil((w * bitsPerPixel) / 8)
      const pixels = unfilter(raw, at, rowBytes, h, bpp)
      at += (rowBytes + 1) * h
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) put(pixels, y * rowBytes, x, sx + x * dx, sy + y * dy)
      }
    }
  }
  return { width, height, kind: 'u8', data: out, colorSpace }
}
