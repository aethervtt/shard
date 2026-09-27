import { defineImporter, type ImportContext } from '@aethervtt/shard-assets'
import { defineSchema, ShardError } from '@aethervtt/shard-core'
import { decodeImage } from './decode'
import type { Image } from './image'
import { flipGreen, usageFromName } from './importer'
import { writeKtx2 } from './ktx2'
import { buildMips, type TextureUsage } from './mips'

/** What a `*.texarray.json` file holds. */
export interface TextureArrayFile {
  /** Image files (relative to the file), one per layer, in layer order. */
  layers: string[]
  /** Side of every layer in pixels (default: the first image's width, as a power of two). */
  size?: number
  /** color (sRGB albedo), data (linear masks such as ORM), or normal. Default: from the file name. */
  usage?: TextureUsage
  /** Normal maps: opengl (+Y up, the default) or directx (green flipped on import). */
  normalMap?: 'opengl' | 'directx'
}

/** Bilinear resample to `width` × `height` (RGBA). */
export function resizeImage(image: Image, width: number, height: number): Image {
  if (image.width === width && image.height === height) return image
  const src = image.data
  const out =
    image.kind === 'u8' ? new Uint8Array(width * height * 4) : new Float32Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    const fy = Math.min(image.height - 1, Math.max(0, ((y + 0.5) * image.height) / height - 0.5))
    const y0 = Math.floor(fy)
    const y1 = Math.min(image.height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < width; x++) {
      const fx = Math.min(image.width - 1, Math.max(0, ((x + 0.5) * image.width) / width - 0.5))
      const x0 = Math.floor(fx)
      const x1 = Math.min(image.width - 1, x0 + 1)
      const tx = fx - x0
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * image.width + x0) * 4 + c]!
        const b = src[(y0 * image.width + x1) * 4 + c]!
        const d = src[(y1 * image.width + x0) * 4 + c]!
        const e = src[(y1 * image.width + x1) * 4 + c]!
        const v = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty
        out[(y * width + x) * 4 + c] = image.kind === 'u8' ? Math.round(v) : v
      }
    }
  }
  return { width, height, kind: image.kind, data: out }
}

const NoSettings = defineSchema(
  'texture/TextureArraySettings',
  {},
  { description: 'None: the file lists the layers.' },
)

function fail(path: string, message: string, hint: string): never {
  throw new ShardError('texture/invalid-array', `${path}: ${message}`, { path, hint })
}

/**
 * `*.texarray.json`: a 2D texture array from a list of images, all resized to one size, each with
 * its own mip chain, stored as one uncompressed KTX2 (spec 0043). Materials bind it as
 * `texture_2d_array`; terrain biomes index its layers. Editing any listed image re-imports it.
 */
export const TextureArrayImporter = defineImporter({
  name: 'texture-array',
  version: 1,
  extensions: ['.texarray.json'],
  settings: NoSettings,
  async import(source, ctx: ImportContext) {
    let file: TextureArrayFile
    try {
      file = JSON.parse(source.text()) as TextureArrayFile
    } catch (cause) {
      throw new ShardError('assets/import-failed', `${source.path} isn't valid JSON`, {
        path: source.path,
        cause,
      })
    }
    const hint =
      'A texture array file is { "layers": ["grass.png", "rock.png"], "size": 512, "usage": "color" }.'
    if (!Array.isArray(file.layers) || file.layers.length === 0)
      fail(source.path, '"layers" must list at least one image', hint)
    if (file.layers.length > 256) fail(source.path, 'at most 256 layers', hint)
    const usage: TextureUsage =
      file.usage ?? usageFromName(source.path.replace('.texarray.json', ''))
    if (usage === 'hdr') fail(source.path, 'HDR arrays come later', 'Use color, data, or normal.')
    const images: Image[] = []
    for (const layer of file.layers) {
      let image = await decodeImage(await ctx.read(layer))
      if (usage === 'normal' && file.normalMap === 'directx') image = flipGreen(image)
      images.push(image)
    }
    const first = images[0]!
    let size = file.size ?? 2 ** Math.round(Math.log2(Math.max(1, first.width)))
    size = Math.max(1, Math.min(4096, Math.floor(size)))
    const chains = images.map((image, i) => {
      if (image.width !== size || image.height !== size) {
        ctx.warn(
          `Layer ${i} (${file.layers[i]}) is ${image.width}×${image.height}; resized to ${size}×${size}.`,
        )
      }
      return buildMips(resizeImage(image, size, size), {
        usage,
        mipmaps: true,
        maxSize: 16384,
        flipY: false,
        premultiplyAlpha: false,
      })
    })
    // Each level holds every layer, one after another.
    const levels = chains[0]!.levels.map((_, level) => {
      const parts = chains.map((c) => c.levels[level] as Uint8Array)
      const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
      let o = 0
      for (const p of parts) {
        out.set(p, o)
        o += p.byteLength
      }
      return out
    })
    const bytes = writeKtx2({ width: size, height: size, levels }, usage, 1, false, images.length)
    return {
      assets: [
        {
          label: '',
          type: 'Texture',
          bytes,
          info: { width: size, height: size, layers: images.length, usage, mips: levels.length },
        },
      ],
    }
  },
})
