import { ShardError } from '@aethervtt/shard-core'
import { nodeCodecs, readCodecDependency } from '@aethervtt/shard-platform-node/codecs'
import type { Image } from '../image'

let ready: Promise<(bytes: ArrayBuffer) => Promise<ImageData>> | undefined

/** Loads the WASM WebP decoder once, from the package's own file in Node or by URL in browsers. */
function decoder() {
  ready ??= (async () => {
    const mod = await import('@jsquash/webp/decode.js')
    if (nodeCodecs) {
      // Node cannot fetch file URLs. Browsers let the decoder resolve its emitted WASM URL.
      const bytes = await readCodecDependency(
        '@jsquash/webp/decode.js',
        './codec/dec/webp_dec.wasm',
        import.meta.url,
      )
      await mod.init(await WebAssembly.compile(bytes))
    }
    return mod.default
  })()
  return ready
}

export async function decodeWebp(bytes: Uint8Array): Promise<Image> {
  try {
    const decode = await decoder()
    const copy = bytes.slice()
    const img = await decode(copy.buffer)
    return {
      width: img.width,
      height: img.height,
      kind: 'u8',
      data: new Uint8Array(img.data.buffer),
    }
  } catch (cause) {
    throw new ShardError(
      'texture/decode-failed',
      `WebP decode failed: ${(cause as Error).message}`,
      { cause },
    )
  }
}
