import { ShardError } from '@aethervtt/shard-core'
import type { TextureUsage } from './mips'

/**
 * Basis Universal, from the official WASM builds vendored in `vendor/basis` (Apache-2.0). The
 * emscripten wrappers are classic scripts, so they're evaluated with a small shim that works in
 * Node and browsers alike; each module loads once, only when a compressed texture needs it.
 */

interface EmbindEnum {
  value: number
}

interface BasisModule {
  initializeBasis(): void
  BasisEncoder: new () => BasisEncoder
  KTX2File: new (bytes: Uint8Array) => Ktx2File
  basis_tex_format: Record<string, EmbindEnum>
  transcoder_texture_format: Record<string, EmbindEnum>
}

interface BasisEncoder {
  setCreateKTX2File(on: boolean): void
  setFormatModeAndQualityEffort(
    format: number,
    quality: number,
    effort: number,
    defaults: boolean,
  ): void
  setSliceSourceImage(
    slice: number,
    rgba: Uint8Array,
    width: number,
    height: number,
    type: number,
  ): boolean
  setMipGen(on: boolean): void
  setMipSRGB(on: boolean): void
  setMipRenormalize(on: boolean): void
  setPerceptual(on: boolean): void
  setKTX2AndBasisSRGBTransferFunc(on: boolean): void
  setKTX2UASTCSupercompression(on: boolean): void
  setCheckForAlpha(on: boolean): void
  encode(out: Uint8Array): number
  delete(): void
}

interface Ktx2File {
  isValid(): boolean
  getLevels(): number
  getWidth(): number
  getHeight(): number
  startTranscoding(): boolean
  getImageTranscodedSizeInBytes(level: number, layer: number, face: number, format: number): number
  transcodeImage(
    dst: Uint8Array,
    level: number,
    layer: number,
    face: number,
    format: number,
    alphaForOpaque: number,
    channel0: number,
    channel1: number,
  ): number
  close(): void
  delete(): void
}

const modules = new Map<string, Promise<BasisModule>>()

async function readVendor(file: string): Promise<{ text?: string; bytes?: Uint8Array }> {
  const url = new URL(`../vendor/basis/${file}`, import.meta.url)
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises')
    const data = await readFile(url)
    return file.endsWith('.js') ? { text: data.toString('utf8') } : { bytes: new Uint8Array(data) }
  }
  const res = await fetch(url)
  if (!res.ok) throw new ShardError('texture/transcoder-unavailable', `Couldn't fetch ${url}`)
  return file.endsWith('.js')
    ? { text: await res.text() }
    : { bytes: new Uint8Array(await res.arrayBuffer()) }
}

function load(name: 'basis_encoder' | 'basis_transcoder'): Promise<BasisModule> {
  let pending = modules.get(name)
  if (!pending) {
    pending = (async () => {
      try {
        const [{ text }, { bytes }] = await Promise.all([
          readVendor(`${name}.js`),
          readVendor(`${name}.wasm`),
        ])
        let require: unknown
        let dirname = ''
        if (typeof process !== 'undefined' && process.versions?.node) {
          const { createRequire } = await import('node:module')
          const { fileURLToPath } = await import('node:url')
          require = createRequire(import.meta.url)
          dirname = fileURLToPath(new URL('../vendor/basis/', import.meta.url))
        }
        // The emscripten wrapper expects CommonJS globals in Node.
        const factory = new Function(
          'module',
          'exports',
          'require',
          '__dirname',
          '__filename',
          `${text}\nreturn BASIS`,
        )(undefined, undefined, require, dirname, `${dirname}${name}.js`) as (options: {
          wasmBinary: Uint8Array
        }) => Promise<BasisModule>
        const quiet = () => {}
        const mod = await factory({ wasmBinary: bytes!, print: quiet, printErr: quiet } as never)
        mod.initializeBasis()
        return mod
      } catch (cause) {
        throw new ShardError(
          'texture/transcoder-unavailable',
          `Couldn't load ${name}: ${(cause as Error).message}`,
          {
            cause,
            hint: 'Basis Universal ships in @aethervtt/shard-texture/vendor/basis; check the files are present.',
          },
        )
      }
    })()
    modules.set(name, pending)
  }
  return pending
}

/**
 * Encodes RGBA8 into a Basis Universal KTX2 with a full mip chain. Dimensions must be multiples of
 * 4 (the importer pads first). `mode`: 'uastc' (high quality) or 'etc1s' (small).
 */
export async function encodeBasis(
  rgba: Uint8Array,
  width: number,
  height: number,
  usage: TextureUsage,
  mode: 'uastc' | 'etc1s',
  mipmaps: boolean,
): Promise<Uint8Array> {
  const basis = await load('basis_encoder')
  const enc = new basis.BasisEncoder()
  try {
    enc.setCreateKTX2File(true)
    const format =
      mode === 'uastc' ? basis.basis_tex_format.cUASTC_LDR_4x4! : basis.basis_tex_format.cETC1S!
    enc.setFormatModeAndQualityEffort(format.value, -1, -1, true)
    enc.setKTX2UASTCSupercompression(mode === 'uastc')
    const color = usage === 'color'
    enc.setPerceptual(color)
    enc.setKTX2AndBasisSRGBTransferFunc(color)
    enc.setMipGen(mipmaps)
    enc.setMipSRGB(color)
    enc.setMipRenormalize(usage === 'normal')
    enc.setCheckForAlpha(true)
    if (!enc.setSliceSourceImage(0, rgba, width, height, 0)) {
      throw new ShardError('texture/decode-failed', 'Basis encoder rejected the image')
    }
    const out = new Uint8Array(width * height * 4 * 2 + 1024 * 1024)
    const size = enc.encode(out)
    if (!size) throw new ShardError('texture/decode-failed', 'Basis encoding failed')
    return out.slice(0, size)
  } finally {
    enc.delete()
  }
}

/** GPU formats a Basis texture can become, by device feature, best first. */
export type TranscodeTarget = 'bc7' | 'bc5' | 'astc' | 'etc2' | 'eac-rg11' | 'rgba8'

export interface TranscodedTexture {
  width: number
  height: number
  format: TranscodeTarget
  levels: Uint8Array[]
}

const TARGET_FORMATS: Record<TranscodeTarget, string> = {
  bc7: 'cTFBC7_RGBA',
  bc5: 'cTFBC5_RG',
  astc: 'cTFASTC_4x4_RGBA',
  etc2: 'cTFETC2_RGBA',
  'eac-rg11': 'cTFETC2_EAC_RG11',
  rgba8: 'cTFRGBA32',
}

/** Transcodes every level of a Basis KTX2 to `target`. */
export async function transcodeBasis(
  bytes: Uint8Array,
  target: TranscodeTarget,
): Promise<TranscodedTexture> {
  const basis = await load('basis_transcoder')
  const file = new basis.KTX2File(bytes)
  try {
    if (!file.isValid() || !file.startTranscoding()) {
      throw new ShardError('texture/decode-failed', 'Invalid Basis KTX2 payload')
    }
    const format = basis.transcoder_texture_format[TARGET_FORMATS[target]]!.value
    const levels: Uint8Array[] = []
    for (let level = 0; level < file.getLevels(); level++) {
      const dst = new Uint8Array(file.getImageTranscodedSizeInBytes(level, 0, 0, format))
      if (!file.transcodeImage(dst, level, 0, 0, format, 0, -1, -1)) {
        throw new ShardError(
          'texture/decode-failed',
          `Couldn't transcode level ${level} to ${target}`,
        )
      }
      levels.push(dst)
    }
    return { width: file.getWidth(), height: file.getHeight(), format: target, levels }
  } finally {
    file.close()
    file.delete()
  }
}
