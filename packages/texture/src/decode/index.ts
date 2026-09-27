import { ShardError } from '@aethervtt/shard-core'
import type { Image } from '../image'
import { decodeHdr } from './hdr'
import { decodeJpeg } from './jpeg'
import { decodePngImage } from './png'
import { decodeWebp } from './webp'

export type ImageFormat = 'png' | 'jpeg' | 'webp' | 'hdr' | 'ktx2'

/** The file format, from its first bytes. */
export function sniffImage(bytes: Uint8Array): ImageFormat | undefined {
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45
  ) {
    return 'webp'
  }
  if (b[0] === 0x23 && b[1] === 0x3f) return 'hdr'
  if (b[0] === 0xab && b[1] === 0x4b && b[2] === 0x54 && b[3] === 0x58) return 'ktx2'
  return undefined
}

/** Decodes PNG, JPEG, WebP, or Radiance HDR with the engine's own decoders (never the browser's). */
export async function decodeImage(bytes: Uint8Array): Promise<Image> {
  switch (sniffImage(bytes)) {
    case 'png':
      return decodePngImage(bytes)
    case 'jpeg':
      return decodeJpeg(bytes)
    case 'webp':
      return decodeWebp(bytes)
    case 'hdr':
      return decodeHdr(bytes)
    default:
      throw new ShardError('texture/unsupported-format', 'Unrecognized image format', {
        hint: 'Supported: PNG, JPEG, WebP, Radiance .hdr, and KTX2.',
      })
  }
}

export { decodeHdr, decodeJpeg, decodePngImage, decodeWebp }
