import { AssetStore, defineAssetType, defineImporter } from '@aethervtt/shard-assets'
import { defineResource, defineSchema, ShardError, t } from '@aethervtt/shard-core'
import { inflate } from './kernel'

/** A heightmap image (spec 0071): samples 0–1, row by row, top row first. */
export interface Heightmap {
  readonly width: number
  readonly height: number
  readonly data: Float32Array
  /** Bumps on hot reload. */
  version: number
}

export const Heightmaps = defineResource<AssetStore<Heightmap, 'Heightmap'>>('terrain/Heightmaps', {
  description: 'Loaded heightmaps (16-bit PNG, .r16, .r32) by guid.',
  init: () => new AssetStore('Heightmap'),
})

/** What the importer stores: a small header and the samples (u16 or f32, little-endian). */
interface HeightmapArtifact {
  width: number
  height: number
  bits: 16 | 32
}

export const HeightmapAssetType = defineAssetType<Heightmap>('Heightmap', {
  store: Heightmaps,
  load: (artifact) => {
    const info = artifact.json as unknown as HeightmapArtifact
    const bytes = artifact.bytes ?? new Uint8Array(0)
    const n = info.width * info.height
    const data = new Float32Array(n)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (info.bits === 16) for (let i = 0; i < n; i++) data[i] = view.getUint16(i * 2, true) / 65535
    else for (let i = 0; i < n; i++) data[i] = view.getFloat32(i * 4, true)
    return { width: info.width, height: info.height, data, version: 0 }
  },
  update: (existing, next) => {
    const e = existing as { -readonly [K in keyof Heightmap]: Heightmap[K] }
    e.width = next.width
    e.height = next.height
    e.data = next.data
    e.version++
  },
})

const HeightmapSettings = defineSchema(
  'terrain/HeightmapSettings',
  {
    width: t.u32({ description: 'Raw files (.r16, .r32): samples per row.' }),
    height: t.u32({ description: 'Raw files (.r16, .r32): rows.' }),
  },
  {
    description:
      'A heightmap: a 16-bit grayscale PNG (dimensions from the file), or raw little-endian samples (.r16 unsigned 16-bit, .r32 float, 0–1) with width and height here.',
  },
)

function format(path: string, message: string): ShardError {
  return new ShardError('terrain/heightmap-format', `${path}: ${message}`, {
    path,
    hint: 'Heightmaps are 16-bit grayscale PNGs, or .r16/.r32 raw files with "width" and "height" in their .meta settings. An 8-bit PNG is a texture, not a heightmap.',
  })
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

/** Decodes a 16-bit grayscale, non-interlaced PNG to samples 0–65535 (row by row). */
export function decodeHeightPng(
  path: string,
  png: Uint8Array,
): HeightmapArtifact & { samples: Uint16Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  if (png.length < 8 || view.getUint32(0) !== 0x89504e47) throw format(path, 'not a PNG file')
  let offset = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = -1
  let interlace = 0
  const idat: Uint8Array[] = []
  while (offset + 8 <= png.length) {
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8))
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = view.getUint32(offset + 8)
      height = view.getUint32(offset + 12)
      depth = data[8]!
      colorType = data[9]!
      interlace = data[12]!
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += 12 + length
  }
  if (colorType !== 0 || depth !== 16) {
    throw format(
      path,
      `a ${depth}-bit ${colorType === 0 ? 'grayscale' : 'color'} PNG isn't 16-bit grayscale`,
    )
  }
  if (interlace !== 0)
    throw format(path, 'interlaced PNGs aren’t read; save it without interlacing')
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of idat) {
    joined.set(p, o)
    o += p.length
  }
  const rowBytes = width * 2
  // The zlib stream: a two-byte header, raw DEFLATE, an Adler-32 trailer.
  const raw = inflate(joined.subarray(2), (rowBytes + 1) * height)
  const samples = new Uint16Array(width * height)
  const prev = new Uint8Array(rowBytes)
  const row = new Uint8Array(rowBytes)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (rowBytes + 1)]!
    const src = y * (rowBytes + 1) + 1
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[src + x]!
      const a = x >= 2 ? row[x - 2]! : 0
      const b = prev[x]!
      const c = x >= 2 ? prev[x - 2]! : 0
      const r =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : filter === 4
                  ? v + paeth(a, b, c)
                  : -1
      if (r < 0) throw format(path, `row ${y} has an invalid filter (${filter})`)
      row[x] = r & 0xff
    }
    for (let x = 0; x < width; x++) samples[y * width + x] = (row[x * 2]! << 8) | row[x * 2 + 1]!
    prev.set(row)
  }
  return { width, height, bits: 16, samples }
}

/**
 * `*.r16`, `*.r32` and `*.height.png` (or any 16-bit grayscale PNG whose `.meta` names this
 * importer): a Heightmap for terrain image layers and paint masks (spec 0071).
 */
export const HeightmapImporter = defineImporter({
  name: 'heightmap',
  version: 1,
  extensions: ['.r16', '.r32', '.height.png'],
  settings: HeightmapSettings,
  async import(source, ctx) {
    const path = source.path
    let info: HeightmapArtifact
    let bytes: Uint8Array
    if (path.endsWith('.r16') || path.endsWith('.r32')) {
      const bits = path.endsWith('.r16') ? 16 : 32
      const width = Number(ctx.settings.width ?? 0)
      const height = Number(ctx.settings.height ?? 0)
      if (!(width > 0 && height > 0))
        throw format(path, 'a raw heightmap needs width and height in its .meta settings')
      const expected = width * height * (bits / 8)
      if (source.bytes.length !== expected) {
        throw format(
          path,
          `${source.bytes.length} bytes, but ${width} × ${height} ${bits}-bit samples are ${expected}`,
        )
      }
      info = { width, height, bits }
      bytes = source.bytes.slice()
    } else {
      const png = decodeHeightPng(path, source.bytes)
      info = { width: png.width, height: png.height, bits: 16 }
      bytes = new Uint8Array(png.samples.length * 2)
      const view = new DataView(bytes.buffer)
      for (let i = 0; i < png.samples.length; i++) view.setUint16(i * 2, png.samples[i]!, true)
    }
    return {
      assets: [
        {
          label: '',
          type: 'Heightmap',
          bytes,
          json: { ...info },
          info: { width: info.width, height: info.height, bits: info.bits },
        },
      ],
    }
  },
})
