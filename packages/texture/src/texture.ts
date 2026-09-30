import { AssetStore, defineAssetType } from '@aethervtt/shard-assets'
import { defineResource, ShardError } from '@aethervtt/shard-core'
import { type TranscodeTarget, transcodeBasis } from './basis'
import { buildMips, type TextureUsage } from './mips'

/** GPU formats a Texture can hold. */
export type TextureFormat =
  | 'rgba8unorm'
  | 'rgba16float'
  | 'bc7-rgba-unorm'
  | 'bc5-rg-unorm'
  | 'astc-4x4-unorm'
  | 'etc2-rgba8unorm'
  | 'eac-rg11unorm'

/** Bytes per 4x4 block for compressed formats; bytes per texel otherwise (as blockBytes, block 1). */
export const FORMAT_INFO: Record<
  TextureFormat,
  { block: number; bytes: number; srgbView?: string }
> = {
  rgba8unorm: { block: 1, bytes: 4, srgbView: 'rgba8unorm-srgb' },
  rgba16float: { block: 1, bytes: 8 },
  'bc7-rgba-unorm': { block: 4, bytes: 16, srgbView: 'bc7-rgba-unorm-srgb' },
  'bc5-rg-unorm': { block: 4, bytes: 16 },
  'astc-4x4-unorm': { block: 4, bytes: 16, srgbView: 'astc-4x4-unorm-srgb' },
  'etc2-rgba8unorm': { block: 4, bytes: 16, srgbView: 'etc2-rgba8unorm-srgb' },
  'eac-rg11unorm': { block: 4, bytes: 16 },
}

export interface TextureInit {
  width: number
  height: number
  format?: TextureFormat
  usage?: TextureUsage
  /** Level data, level 0 first. With `mipmaps` and one RGBA8 level, the rest are generated. */
  mips: Uint8Array[]
  mipmaps?: boolean
  /** Keep CPU pixels after upload (default true for textures made in code). */
  cpu?: boolean
  /** 6 for a cube map: each level holds the faces +X, -X, +Y, -Y, +Z, -Z one after another. */
  faces?: number
  /**
   * Layers of a 2D texture array (materials bind it as `texture_2d_array`): each level holds the
   * layers one after another. Default 1.
   */
  layers?: number
  /** Color is already multiplied by alpha (sprites blend it as is). */
  premultiplied?: boolean
}

/**
 * A texture on the CPU, ready to upload. The renderer uploads it on first use and whenever
 * `version` changes; imported textures drop their CPU pixels after upload (`levels` becomes
 * undefined) and reload from their artifact if the GPU device is lost.
 */
export class Texture {
  width: number
  height: number
  format: TextureFormat
  usage: TextureUsage
  levels: Uint8Array[] | undefined
  mipCount: number
  keepCpu: boolean
  /** 1, or 6 for a cube map. */
  faces: number
  /** Layers of a texture array (1 for a plain texture). */
  layers: number
  version = 0
  /**
   * Made and written on the GPU (`Texture.gpu`): no CPU pixels, and the GPU copy can be bound as
   * a storage texture so compute passes fill it.
   */
  gpuOnly = false

  /** Color is already multiplied by alpha. */
  premultiplied: boolean

  constructor(
    init: Required<Omit<TextureInit, 'mipmaps' | 'faces' | 'premultiplied' | 'layers'>> & {
      faces?: number
      layers?: number
      premultiplied?: boolean
    },
  ) {
    this.width = init.width
    this.height = init.height
    this.format = init.format
    this.usage = init.usage
    this.levels = init.mips
    this.mipCount = init.mips.length
    this.keepCpu = init.cpu
    this.faces = init.faces ?? 1
    this.layers = init.layers ?? 1
    this.premultiplied = init.premultiplied ?? false
    Texture.validate(this)
  }

  static create(init: TextureInit): Texture {
    const format = init.format ?? 'rgba8unorm'
    const usage = init.usage ?? 'color'
    let mips = init.mips
    if (
      init.mipmaps &&
      mips.length === 1 &&
      format === 'rgba8unorm' &&
      (init.faces ?? 1) === 1 &&
      (init.layers ?? 1) === 1
    ) {
      mips = buildMips(
        { width: init.width, height: init.height, kind: 'u8', data: mips[0]! },
        { usage, mipmaps: true, maxSize: 16384, flipY: false, premultiplyAlpha: false },
      ).levels as Uint8Array[]
    }
    return new Texture({
      width: init.width,
      height: init.height,
      format,
      usage,
      mips,
      cpu: init.cpu ?? true,
      faces: init.faces ?? 1,
      layers: init.layers ?? 1,
      premultiplied: init.premultiplied ?? false,
    })
  }

  /**
   * A texture the GPU writes (a compute pass through a storage binding), with no CPU pixels: one
   * level, `layers` array layers. Its GPU copy is made on first use and kept (see GpuAssets.texture).
   */
  static gpu(init: {
    width: number
    height: number
    layers?: number
    format?: TextureFormat
    usage?: TextureUsage
  }): Texture {
    const t = new Texture({
      width: init.width,
      height: init.height,
      format: init.format ?? 'rgba8unorm',
      usage: init.usage ?? 'data',
      mips: [],
      cpu: false,
      layers: init.layers ?? 1,
    })
    t.levels = undefined
    t.mipCount = 1
    t.gpuOnly = true
    return t
  }

  /** Replaces the pixels; bumps the version so the GPU copy re-uploads. */
  update(init: Partial<TextureInit> & { mips: Uint8Array[] }): void {
    const next = Texture.create({
      width: init.width ?? this.width,
      height: init.height ?? this.height,
      format: init.format ?? this.format,
      usage: init.usage ?? this.usage,
      mips: init.mips,
      mipmaps: init.mipmaps ?? this.mipCount > 1,
      cpu: this.keepCpu,
      faces: init.faces ?? this.faces,
      layers: init.layers ?? this.layers,
      premultiplied: init.premultiplied ?? this.premultiplied,
    })
    this.width = next.width
    this.height = next.height
    this.format = next.format
    this.usage = next.usage
    this.levels = next.levels
    this.mipCount = next.mipCount
    this.faces = next.faces
    this.layers = next.layers
    this.premultiplied = next.premultiplied
    this.version++
  }

  /** GPU bytes for all levels. */
  get byteSize(): number {
    const info = FORMAT_INFO[this.format]
    let total = 0
    for (let l = 0; l < this.mipCount; l++) {
      const w = Math.max(1, this.width >> l)
      const h = Math.max(1, this.height >> l)
      total += Math.ceil(w / info.block) * Math.ceil(h / info.block) * info.bytes
    }
    return total * this.faces * this.layers
  }

  private static validate(t: Texture): void {
    const info = FORMAT_INFO[t.format]
    if (!info)
      throw new ShardError('texture/unsupported-format', `Unknown texture format "${t.format}"`)
    t.levels?.forEach((level, l) => {
      const w = Math.max(1, t.width >> l)
      const h = Math.max(1, t.height >> l)
      const expected =
        Math.ceil(w / info.block) * Math.ceil(h / info.block) * info.bytes * t.faces * t.layers
      if (level.byteLength < expected) {
        throw new ShardError(
          'texture/invalid',
          `Level ${l} has ${level.byteLength} bytes; ${t.format} ${w}x${h} needs ${expected}`,
        )
      }
    })
  }
}

export const Textures = defineResource<AssetStore<Texture, 'Texture'>>('texture/Textures', {
  description: 'Loaded textures by guid.',
  init: () => new AssetStore('Texture'),
})

/** What the GPU can sample, set by the renderer once it has a device. Decides Basis transcoding. */
export interface TextureCapabilities {
  bc: boolean
  astc: boolean
  etc2: boolean
}

let capabilities: TextureCapabilities = { bc: false, astc: false, etc2: false }

export function setTextureCapabilities(next: TextureCapabilities): void {
  capabilities = { ...next }
}

export function textureCapabilities(): TextureCapabilities {
  return { ...capabilities }
}

/** The best transcode target for a usage on this device. */
export function transcodeTarget(
  usage: TextureUsage,
  caps: TextureCapabilities = capabilities,
): TranscodeTarget {
  if (usage === 'normal')
    return caps.bc ? 'bc5' : caps.astc ? 'astc' : caps.etc2 ? 'eac-rg11' : 'rgba8'
  return caps.bc ? 'bc7' : caps.astc ? 'astc' : caps.etc2 ? 'etc2' : 'rgba8'
}

const TARGET_FORMAT: Record<TranscodeTarget, TextureFormat> = {
  bc7: 'bc7-rgba-unorm',
  bc5: 'bc5-rg-unorm',
  astc: 'astc-4x4-unorm',
  etc2: 'etc2-rgba8unorm',
  'eac-rg11': 'eac-rg11unorm',
  rgba8: 'rgba8unorm',
}

/** Turns a KTX2 artifact into a Texture, transcoding Basis payloads for this device. */
export async function textureFromKtx2(
  bytes: Uint8Array,
  options: { cpu?: boolean } = {},
): Promise<Texture> {
  // Loaded on first use: an app that never loads a texture doesn't download the KTX2 reader.
  const { readKtx2 } = await import('./ktx2')
  const ktx = readKtx2(bytes)
  if (ktx.basis) {
    const out = await transcodeBasis(bytes, transcodeTarget(ktx.usage))
    return new Texture({
      width: out.width,
      height: out.height,
      format: TARGET_FORMAT[out.format],
      usage: ktx.usage,
      mips: out.levels,
      cpu: options.cpu ?? false,
      premultiplied: ktx.premultiplied,
    })
  }
  const format: TextureFormat = ktx.usage === 'hdr' ? 'rgba16float' : 'rgba8unorm'
  return new Texture({
    width: ktx.width,
    height: ktx.height,
    format,
    usage: ktx.usage,
    mips: ktx.levels,
    cpu: options.cpu ?? false,
    faces: ktx.faces,
    layers: ktx.layers,
    premultiplied: ktx.premultiplied,
  })
}

export const TextureAssetType = defineAssetType<Texture>('Texture', {
  store: Textures,
  load: (artifact) => textureFromKtx2(artifact.bytes!),
  update: (existing, next) => {
    existing.width = next.width
    existing.height = next.height
    existing.format = next.format
    existing.usage = next.usage
    existing.levels = next.levels
    existing.mipCount = next.mipCount
    existing.faces = next.faces
    existing.layers = next.layers
    existing.premultiplied = next.premultiplied
    existing.version++
  },
  fallback: ({ dev }) => fallbackTexture(dev),
  cost: (texture) => ({ textures: 1, bytes: texture.byteSize }),
})

/**
 * What a texture that failed to load shows (0061): 50% gray, or in a dev build a magenta and gray
 * checker that can't be mistaken for art. RGBA8, so it binds in any color or data slot.
 */
export function fallbackTexture(dev: boolean): Texture {
  const size = dev ? 8 : 1
  const pixels = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const checker = dev && ((x >> 1) + (y >> 1)) % 2 === 0
      pixels[o] = checker ? 255 : 128
      pixels[o + 1] = checker ? 0 : 128
      pixels[o + 2] = checker ? 255 : 128
      pixels[o + 3] = 255
    }
  }
  return Texture.create({ width: size, height: size, mips: [pixels], usage: 'color', cpu: true })
}
