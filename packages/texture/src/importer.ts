import { defineImporter, type ImportContext, type ImportedAsset } from '@aethervtt/shard-assets'
import { defineSchema, type JsonValue, ShardError, t } from '@aethervtt/shard-core'
import { encodeBasis } from './basis'
import { decodeImage, sniffImage } from './decode'
import type { Image } from './image'
import { readKtx2, tagKtx2, writeKtx2 } from './ktx2'
import { buildMips, type TextureUsage } from './mips'

export const TextureImportSettings = defineSchema(
  'texture/ImportSettings',
  {
    usage: t.enum(['color', 'data', 'normal', 'hdr'], {
      description:
        'color: sRGB albedo/emissive. data: linear masks (roughness, metallic, AO). normal: tangent-space normal map. hdr: linear float (environment maps).',
    }),
    mipmaps: t.bool({ default: true, description: 'Generate a full mip chain.' }),
    compression: t.enum(['none', 'etc1s', 'uastc'], {
      description:
        'Basis Universal. uastc: high quality, larger. etc1s: small, lossy. Encoding takes seconds per texture on first import; the cache keeps the result.',
    }),
    maxSize: t.u32({ default: 4096, min: 1, max: 16384, description: 'Downscale larger images.' }),
    flipY: t.bool({ description: 'Flip vertically on import.' }),
    premultiplyAlpha: t.bool({ description: 'Multiply color by alpha on import.' }),
    normalMap: t.enum(['opengl', 'directx'], {
      description:
        'Normal maps: opengl (+Y up, the engine convention) or directx (+Y down: green is flipped on import).',
    }),
  },
  { description: 'Import settings for images (PNG, JPEG, WebP, .hdr, KTX2).' },
)

export interface TextureSettings {
  usage: TextureUsage
  mipmaps: boolean
  compression: 'none' | 'etc1s' | 'uastc'
  maxSize: number
  flipY: boolean
  premultiplyAlpha: boolean
  normalMap?: 'opengl' | 'directx'
}

/** Flips a normal map's green channel in place (DirectX → OpenGL, or back). */
export function flipGreen(image: Image): Image {
  const d = image.data
  if (image.kind === 'u8') for (let i = 1; i < d.length; i += 4) d[i] = 255 - d[i]!
  else for (let i = 1; i < d.length; i += 4) d[i] = 1 - d[i]!
  return image
}

/** Usage from the file name, for a new `.meta`. */
export function usageFromName(path: string): TextureUsage {
  const name = path.toLowerCase().split('/').pop()!
  if (name.endsWith('.hdr')) return 'hdr'
  if (/normal|_n\.|_nrm/.test(name)) return 'normal'
  if (/rough|metal|_orm|occlusion|_ao[._]|_arm|mask/.test(name)) return 'data'
  return 'color'
}

/** Replicates edge texels so width and height are multiples of 4 (Basis needs whole blocks). */
function padTo4(rgba: Uint8Array, w: number, h: number) {
  const pw = Math.ceil(w / 4) * 4
  const ph = Math.ceil(h / 4) * 4
  if (pw === w && ph === h) return { data: rgba, width: w, height: h }
  const out = new Uint8Array(pw * ph * 4)
  for (let y = 0; y < ph; y++) {
    const sy = Math.min(h - 1, y)
    for (let x = 0; x < pw; x++) {
      const sx = Math.min(w - 1, x)
      out.set(rgba.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * pw + x) * 4)
    }
  }
  return { data: out, width: pw, height: ph }
}

/**
 * GPU bytes of a Basis texture transcoded to a 4x4 block format (BC7, BC5, ASTC 4x4, ETC2, EAC
 * RG11 are all 16 bytes a block). The RGBA8 fallback takes four times as much.
 */
function blockBytes(width: number, height: number, mips: number): number {
  let sum = 0
  for (let level = 0; level < mips; level++) {
    sum += Math.ceil(Math.max(1, width >> level) / 4) * Math.ceil(Math.max(1, height >> level) / 4)
  }
  return sum * 16
}

/** sRGB RGBA8 → linear float (for a color image imported as hdr). */
function toLinearFloat(image: Image): Image {
  if (image.kind === 'f32') return image
  const src = image.data as Uint8Array
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const c = src[i]! / 255
    out[i] = i % 4 === 3 ? c : c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return { width: image.width, height: image.height, kind: 'f32', data: out }
}

/**
 * Imports image bytes into a KTX2 artifact. Shared by the file importer and by glTF (embedded
 * images), so the same bytes become the same artifact wherever they come from.
 */
export async function importImageBytes(
  bytes: Uint8Array,
  settings: TextureSettings,
  warn: (message: string) => void = () => {},
): Promise<{ bytes: Uint8Array; info: Record<string, JsonValue> }> {
  const format = sniffImage(bytes)
  if (format === 'ktx2') {
    const ktx = readKtx2(bytes)
    const tagged = tagKtx2(bytes, settings.usage)
    if (ktx.width > settings.maxSize || ktx.height > settings.maxSize) {
      warn(
        `A KTX2 source keeps its size (${ktx.width}x${ktx.height}) and encoding; maxSize and compression don't apply to it.`,
      )
    }
    return {
      bytes: tagged,
      info: {
        width: ktx.width,
        height: ktx.height,
        source: 'ktx2',
        compression: ktx.basis ?? 'none',
        mips: ktx.levels.length,
        usage: settings.usage,
        bytes: tagged.byteLength,
        gpuBytes: ktx.basis
          ? blockBytes(ktx.width, ktx.height, ktx.levels.length)
          : ktx.levels.reduce((sum, level) => sum + level.byteLength, 0),
      },
    }
  }
  let image = await decodeImage(bytes)
  const usage = settings.usage
  if (usage === 'normal' && settings.normalMap === 'directx') image = flipGreen(image)
  if (usage === 'hdr') image = toLinearFloat(image)
  else if (image.kind === 'f32') {
    warn(
      'A float image imported as LDR is clamped to [0, 1]; set usage to "hdr" to keep its range.',
    )
  }
  const info: Record<string, JsonValue> = { source: format ?? 'unknown', usage }
  if (image.width > settings.maxSize || image.height > settings.maxSize) {
    info.sourceWidth = image.width
    info.sourceHeight = image.height
  }
  if (settings.compression !== 'none' && usage !== 'hdr') {
    const base = buildMips(image, { ...settings, mipmaps: false })
    const padded = padTo4(base.levels[0] as Uint8Array, base.width, base.height)
    if (padded.width !== base.width || padded.height !== base.height) {
      warn(
        `Padded ${base.width}x${base.height} to ${padded.width}x${padded.height}: Basis needs multiples of 4.`,
      )
    }
    // Basis transcodes BC5 and EAC RG11 from red and alpha: Y goes in alpha too, so normal maps
    // can take those, while every four-channel target still reads RGB.
    const normal = usage === 'normal'
    if (normal) for (let k = 1; k < padded.data.length; k += 4) padded.data[k + 2] = padded.data[k]!
    const encoded = await encodeBasis(
      padded.data,
      padded.width,
      padded.height,
      usage,
      settings.compression,
      settings.mipmaps,
    )
    const out = tagKtx2(encoded, usage, settings.premultiplyAlpha, normal)
    const ktx = readKtx2(out)
    return {
      bytes: out,
      info: {
        ...info,
        width: ktx.width,
        height: ktx.height,
        mips: ktx.levels.length,
        compression: settings.compression,
        bytes: out.byteLength,
        gpuBytes: blockBytes(ktx.width, ktx.height, ktx.levels.length),
      },
    }
  }
  if (settings.compression !== 'none') warn('HDR textures are stored uncompressed (rgba16float).')
  const chain = buildMips(image, settings)
  const out = writeKtx2(chain, usage, 1, settings.premultiplyAlpha)
  return {
    bytes: out,
    info: {
      ...info,
      width: chain.width,
      height: chain.height,
      mips: chain.levels.length,
      compression: 'none',
      bytes: out.byteLength,
      gpuBytes:
        (chain.levels.reduce((sum, level) => sum + level.length, 0) / 4) *
        (usage === 'hdr' ? 8 : 4),
    },
  }
}

export const TextureImporter = defineImporter({
  name: 'texture',
  version: 1,
  extensions: ['.png', '.jpg', '.jpeg', '.webp', '.hdr', '.ktx2'],
  settings: TextureImportSettings,
  defaults: (path) => ({ usage: usageFromName(path) }),
  async import(source, ctx: ImportContext) {
    const settings = ctx.settings as unknown as TextureSettings
    let result: Awaited<ReturnType<typeof importImageBytes>>
    try {
      result = await importImageBytes(source.bytes, settings, (m) => ctx.warn(m))
    } catch (err) {
      if (err instanceof ShardError) throw err
      throw new ShardError('texture/decode-failed', `${source.path}: ${(err as Error).message}`, {
        cause: err,
      })
    }
    const asset: ImportedAsset = {
      label: '',
      type: 'Texture',
      bytes: result.bytes,
      info: result.info,
    }
    return { assets: [asset] }
  },
})
