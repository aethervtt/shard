import { ShardError } from '@aethervtt/shard-core'
import jpeg from 'jpeg-js'
import type { Image } from '../image'

/** Baseline and progressive JPEG, in pure JS (the same pixels on every host). */
export function decodeJpeg(bytes: Uint8Array): Image {
  try {
    const out = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxMemoryUsageInMB: 1024,
    })
    return { width: out.width, height: out.height, kind: 'u8', data: out.data }
  } catch (cause) {
    throw new ShardError(
      'texture/decode-failed',
      `JPEG decode failed: ${(cause as Error).message}`,
      { cause },
    )
  }
}
