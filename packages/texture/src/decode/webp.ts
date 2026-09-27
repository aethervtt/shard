import { ShardError } from '@aethervtt/shard-core'
import type { Image } from '../image'

let ready: Promise<(bytes: ArrayBuffer) => Promise<ImageData>> | undefined

/** Loads the WASM WebP decoder once, from the package's own file in Node or by URL in browsers. */
function decoder() {
  ready ??= (async () => {
    const mod = await import('@jsquash/webp/decode')
    if (typeof process !== 'undefined' && process.versions?.node) {
      // Node can't fetch file URLs, so hand the decoder its WASM directly. Browsers find it by URL.
      const wasmUrl = new URL(
        './codec/dec/webp_dec.wasm',
        import.meta.resolve('@jsquash/webp/decode'),
      )
      const { readFile } = await import('node:fs/promises')
      await mod.init(await WebAssembly.compile(await readFile(wasmUrl)))
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
