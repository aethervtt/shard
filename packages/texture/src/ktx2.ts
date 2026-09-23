import { ShardError } from '@shard/core'
import { decompress } from 'fzstd'
import {
  createDefaultContainer,
  KHR_DF_MODEL_UASTC,
  KHR_SUPERCOMPRESSION_BASISLZ,
  KHR_SUPERCOMPRESSION_NONE,
  KHR_SUPERCOMPRESSION_ZSTD,
  read,
  VK_FORMAT_R8G8B8A8_SRGB,
  VK_FORMAT_R8G8B8A8_UNORM,
  VK_FORMAT_R16G16B16A16_SFLOAT,
  write,
} from 'ktx-parse'
import { type MipChain, type TextureUsage, toHalf } from './mips'

const USAGE_KEY = 'shard.usage'
const PREMULTIPLIED_KEY = 'shard.premultiplied'
const KHR_DF_FLAG_ALPHA_PREMULTIPLIED = 1

/**
 * Writes an uncompressed KTX2: RGBA8 (sRGB-tagged for color) or RGBA16F for hdr, every level. With
 * `faces: 6` it's a cube map, and each level holds the six faces one after another.
 */
/**
 * A mip chain as KTX2. `premultiplied` marks color already multiplied by alpha (the DFD flag,
 * plus a key the engine reads back).
 */
export function writeKtx2(
  chain: MipChain,
  usage: TextureUsage,
  faces = 1,
  premultiplied = false,
): Uint8Array {
  const hdr = usage === 'hdr'
  const c = createDefaultContainer()
  c.vkFormat = hdr
    ? VK_FORMAT_R16G16B16A16_SFLOAT
    : usage === 'color'
      ? VK_FORMAT_R8G8B8A8_SRGB
      : VK_FORMAT_R8G8B8A8_UNORM
  c.typeSize = hdr ? 2 : 1
  c.pixelWidth = chain.width
  c.pixelHeight = chain.height
  c.levelCount = chain.levels.length
  c.faceCount = faces
  c.supercompressionScheme = KHR_SUPERCOMPRESSION_NONE
  c.levels = chain.levels.map((level) => {
    const bytes: Uint8Array<ArrayBuffer> = hdr
      ? new Uint8Array(toHalf(level as Float32Array).buffer as ArrayBuffer)
      : new Uint8Array((level as Uint8Array).slice().buffer as ArrayBuffer)
    return { levelData: bytes, uncompressedByteLength: bytes.byteLength }
  })
  const dfd = c.dataFormatDescriptor[0]!
  dfd.colorModel = 1 // RGBSDA
  dfd.colorPrimaries = 1 // BT.709
  dfd.transferFunction = usage === 'color' ? 2 : 1 // sRGB : linear
  dfd.bytesPlane = [hdr ? 8 : 4, 0, 0, 0, 0, 0, 0, 0]
  const bits = hdr ? 16 : 8
  dfd.samples = [0, 1, 2, 15].map((channel, i) => ({
    bitOffset: i * bits,
    bitLength: bits - 1,
    // Float channels are signed floats; sRGB textures keep alpha linear.
    channelType: channel | (hdr ? 0xc0 : 0) | (usage === 'color' && channel === 15 ? 0x10 : 0),
    samplePosition: [0, 0, 0, 0],
    sampleLower: hdr ? 0xbf800000 : 0,
    sampleUpper: hdr ? 0x3f800000 : 255,
  }))
  if (premultiplied) {
    dfd.flags = KHR_DF_FLAG_ALPHA_PREMULTIPLIED
    c.keyValue[PREMULTIPLIED_KEY] = 'true'
  }
  c.keyValue[USAGE_KEY] = usage
  return write(c)
}

export interface Ktx2Data {
  width: number
  height: number
  vkFormat: number
  /** Level data, uncompressed (Zstandard supercompression is undone here). Basis data stays encoded. */
  levels: Uint8Array[]
  /** Basis Universal payloads need transcoding before upload. */
  basis: 'etc1s' | 'uastc' | undefined
  usage: TextureUsage
  srgb: boolean
  /** The original file, for the Basis transcoder. */
  bytes: Uint8Array
  /** 1, or 6 for a cube map (each level holds the faces in order +X, -X, +Y, -Y, +Z, -Z). */
  faces: number
  /** Color is already multiplied by alpha. */
  premultiplied: boolean
}

export function readKtx2(bytes: Uint8Array): Ktx2Data {
  let c: ReturnType<typeof read>
  try {
    c = read(bytes)
  } catch (cause) {
    throw new ShardError(
      'texture/decode-failed',
      `Invalid KTX2 file: ${(cause as Error).message}`,
      { cause },
    )
  }
  if (c.layerCount > 1 || (c.faceCount !== 1 && c.faceCount !== 6) || c.pixelDepth > 1) {
    throw new ShardError('texture/unsupported-format', 'Array and 3D KTX2 textures come later', {
      hint: 'Use a 2D image or a cube map (6 faces).',
    })
  }
  const dfd = c.dataFormatDescriptor[0]
  const basis =
    c.vkFormat === 0
      ? c.supercompressionScheme === KHR_SUPERCOMPRESSION_BASISLZ
        ? 'etc1s'
        : dfd?.colorModel === KHR_DF_MODEL_UASTC
          ? 'uastc'
          : undefined
      : undefined
  if (c.faceCount === 6 && basis) {
    throw new ShardError('texture/unsupported-format', 'Basis-compressed cube maps come later', {
      hint: 'Store cube maps uncompressed (RGBA16F for HDR environments).',
    })
  }
  if (c.vkFormat === 0 && !basis) {
    throw new ShardError(
      'texture/unsupported-format',
      'KTX2 file has an undefined format and no Basis payload',
    )
  }
  const levels = c.levels.map((l) =>
    !basis && c.supercompressionScheme === KHR_SUPERCOMPRESSION_ZSTD
      ? decompress(l.levelData)
      : l.levelData,
  )
  const srgb = dfd?.transferFunction === 2
  const raw = c.keyValue[USAGE_KEY]
  // ktx-parse returns text values as strings, or as bytes when they aren't NUL-terminated.
  const tagged =
    typeof raw === 'string'
      ? raw
      : raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : undefined
  const usage = (
    c.vkFormat === VK_FORMAT_R16G16B16A16_SFLOAT
      ? 'hdr'
      : tagged
        ? tagged.replace(/\0+$/, '')
        : srgb
          ? 'color'
          : 'data'
  ) as TextureUsage
  return {
    width: c.pixelWidth,
    height: Math.max(1, c.pixelHeight),
    vkFormat: c.vkFormat,
    levels,
    basis,
    usage,
    srgb,
    bytes,
    faces: c.faceCount,
    premultiplied:
      c.keyValue[PREMULTIPLIED_KEY] !== undefined ||
      ((dfd?.flags ?? 0) & KHR_DF_FLAG_ALPHA_PREMULTIPLIED) !== 0,
  }
}

/** Re-tags a KTX2 (e.g. one the Basis encoder wrote) with the engine's usage key. */
export function tagKtx2(bytes: Uint8Array, usage: TextureUsage, premultiplied = false): Uint8Array {
  const c = read(bytes)
  c.keyValue[USAGE_KEY] = usage
  if (premultiplied) c.keyValue[PREMULTIPLIED_KEY] = 'true'
  return write(c)
}
