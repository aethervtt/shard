import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zlib from 'node:zlib'
import { assetServer } from '@aethervtt/shard-assets'
import { World } from '@aethervtt/shard-core'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import jpeg from 'jpeg-js'
import {
  createDefaultContainer,
  KHR_SUPERCOMPRESSION_ZSTD,
  VK_FORMAT_R8G8B8A8_UNORM,
  write,
} from 'ktx-parse'
import { afterEach, describe, expect, it } from 'vitest'
import { transcodeBasis } from './basis'
import { decodeHdr, decodeImage, decodeJpeg, decodePngImage, decodeWebp } from './decode'
import { importImageBytes } from './importer'
import { readKtx2, writeKtx2 } from './ktx2'
import { buildMips } from './mips'
import { setTextureCapabilities, Texture, Textures, textureFromKtx2 } from './texture'
import './index'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = resolve(here, '../fixtures')
const khronos = resolve(here, '../../gltf/fixtures/khronos')
const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
  setTextureCapabilities({ bc: false, astc: false, etc2: false })
})

/** A test pattern: smooth gradients plus alpha. */
function pattern(w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      out[i] = (x * 255) / Math.max(1, w - 1)
      out[i + 1] = (y * 255) / Math.max(1, h - 1)
      out[i + 2] = ((x + y) * 7) % 256
      out[i + 3] = 255
    }
  }
  return out
}

describe('decoding', () => {
  it('decodes every PNG color type and bit depth, interlaced or not', async () => {
    const { expected } = JSON.parse(readFileSync(join(fixtures, 'png-expected.json'), 'utf8')) as {
      expected: Record<string, number[]>
    }
    for (const [name, pixels] of Object.entries(expected)) {
      const image = await decodePngImage(new Uint8Array(readFileSync(join(fixtures, name))))
      expect([image.width, image.height], name).toEqual([13, 9])
      expect(Array.from(image.data), name).toEqual(pixels)
    }
    // Real-world files too.
    const logo = await decodePngImage(
      new Uint8Array(readFileSync(join(khronos, 'BoxTextured/glTF/CesiumLogoFlat.png'))),
    )
    expect(logo.width).toBeGreaterThan(0)
  })

  it('decodes JPEG and lossless WebP to the encoded pixels', async () => {
    const src = pattern(32, 16)
    const jpg = jpeg.encode({ data: src, width: 32, height: 16 }, 100).data
    const decoded = decodeJpeg(new Uint8Array(jpg))
    expect([decoded.width, decoded.height]).toEqual([32, 16])
    let err = 0
    for (let i = 0; i < src.length; i++) err = Math.max(err, Math.abs(src[i]! - decoded.data[i]!))
    expect(err).toBeLessThan(24) // JPEG is lossy; this bounds it

    const enc = await import('@jsquash/webp/encode')
    const wasm = new URL(
      './codec/enc/webp_enc_simd.wasm',
      import.meta.resolve('@jsquash/webp/encode'),
    )
    await enc.init(await WebAssembly.compile(readFileSync(wasm)))
    const webp = new Uint8Array(
      await enc.default(
        {
          data: new Uint8ClampedArray(src),
          width: 32,
          height: 16,
          colorSpace: 'srgb',
        } as ImageData,
        { lossless: 1 },
      ),
    )
    const w = await decodeWebp(webp)
    expect(Array.from(w.data)).toEqual(Array.from(src))
    expect((await decodeImage(webp)).width).toBe(32)
  })

  it('decodes Radiance .hdr, flat and run-length encoded', () => {
    const header = (w: number, h: number) =>
      new TextEncoder().encode(`#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`)
    // Flat: two pixels, 1.0 and 0.5 (e 129 → 2^1 / 256 scale: mantissa 128 → 1.0).
    const flat = new Uint8Array([...header(2, 1), 128, 128, 128, 129, 128, 64, 0, 129])
    const img = decodeHdr(flat)
    expect(Array.from(img.data)).toEqual([1, 1, 1, 1, 1, 0.5, 0, 1])
    // RLE: width 8, every channel one run.
    const run = (v: number) => [128 + 8, v]
    const rle = new Uint8Array([
      ...header(8, 1),
      2,
      2,
      0,
      8,
      ...run(128),
      ...run(128),
      ...run(128),
      ...run(130),
    ])
    const r = decodeHdr(rle)
    expect(r.width).toBe(8)
    expect(r.data[0]).toBe(2) // 128 * 2^(130-136)
  })
})

describe('mipmaps', () => {
  it('averages color in linear light and keeps normals unit length', () => {
    // A 2x2 black/white checker: the 1x1 mip is 50% linear gray, which is 188 in sRGB (not 128).
    const checker = new Uint8Array([
      0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 0, 0, 0, 255,
    ])
    const mips = buildMips(
      { width: 2, height: 2, kind: 'u8', data: checker },
      {
        usage: 'color',
        mipmaps: true,
        maxSize: 4096,
        flipY: false,
        premultiplyAlpha: false,
      },
    )
    expect(mips.levels.length).toBe(2)
    expect(mips.levels[1]![0]).toBe(188)
    // Normal map: tilted normals in a pattern; every mip texel has unit length within 1%.
    const n = 16
    const normals = new Uint8Array(n * n * 4)
    for (let i = 0; i < n * n; i++) {
      const a = (i * 0.7) % (Math.PI * 2)
      const v = [Math.cos(a) * 0.6, Math.sin(a) * 0.6, 0.8]
      normals.set([...v.map((c) => Math.round((c * 0.5 + 0.5) * 255)), 255], i * 4)
    }
    const nm = buildMips(
      { width: n, height: n, kind: 'u8', data: normals },
      {
        usage: 'normal',
        mipmaps: true,
        maxSize: 4096,
        flipY: false,
        premultiplyAlpha: false,
      },
    )
    expect(nm.levels.length).toBe(5)
    for (const level of nm.levels.slice(1)) {
      for (let i = 0; i < level.length; i += 4) {
        const v = [0, 1, 2].map((c) => (level[i + c]! / 255) * 2 - 1)
        expect(Math.abs(Math.hypot(...v) - 1)).toBeLessThan(0.02) // 8-bit quantization included
      }
    }
  })

  it('maxSize drops the larger levels', () => {
    const mips = buildMips(
      { width: 64, height: 32, kind: 'u8', data: pattern(64, 32) },
      {
        usage: 'data',
        mipmaps: false,
        maxSize: 16,
        flipY: false,
        premultiplyAlpha: false,
      },
    )
    expect([mips.width, mips.height, mips.levels.length]).toEqual([16, 8, 1])
  })
})

describe('KTX2 and Basis', () => {
  it('round-trips uncompressed KTX2 and reads Zstandard-supercompressed files', async () => {
    const chain = buildMips(
      { width: 8, height: 8, kind: 'u8', data: pattern(8, 8) },
      {
        usage: 'color',
        mipmaps: true,
        maxSize: 4096,
        flipY: false,
        premultiplyAlpha: false,
      },
    )
    const back = readKtx2(writeKtx2(chain, 'color'))
    expect(back).toMatchObject({
      width: 8,
      height: 8,
      usage: 'color',
      srgb: true,
      basis: undefined,
    })
    expect(back.levels.map((l) => l.length)).toEqual([256, 64, 16, 4])
    expect(Array.from(back.levels[0]!)).toEqual(Array.from(chain.levels[0]!))

    const zstd = (zlib as unknown as { zstdCompressSync?: (b: Uint8Array) => Buffer })
      .zstdCompressSync
    if (zstd) {
      const c = createDefaultContainer()
      c.vkFormat = VK_FORMAT_R8G8B8A8_UNORM
      c.pixelWidth = 4
      c.pixelHeight = 4
      c.levelCount = 1
      c.supercompressionScheme = KHR_SUPERCOMPRESSION_ZSTD
      const raw = pattern(4, 4)
      const packed = new Uint8Array(zstd(raw))
      c.levels = [{ levelData: packed, uncompressedByteLength: raw.length }]
      const read = readKtx2(write(c))
      expect(Array.from(read.levels[0]!)).toEqual(Array.from(raw))
    }
  })

  it('encodes UASTC and transcodes to BC7 or RGBA8 depending on the device', async () => {
    const src = pattern(64, 64)
    const { bytes } = await importImageBytes(src.length ? await pngOf(src, 64, 64) : src, {
      usage: 'color',
      mipmaps: true,
      compression: 'uastc',
      maxSize: 4096,
      flipY: false,
      premultiplyAlpha: false,
    })
    const ktx = readKtx2(bytes)
    expect(ktx).toMatchObject({ basis: 'uastc', usage: 'color', width: 64 })
    expect(ktx.levels.length).toBe(7)
    const rgba = await transcodeBasis(bytes, 'rgba8')
    let err = 0
    for (let i = 0; i < src.length; i++) err += Math.abs(src[i]! - rgba.levels[0]![i]!)
    expect(err / src.length).toBeLessThan(3)
    setTextureCapabilities({ bc: true, astc: false, etc2: false })
    const bc = await textureFromKtx2(bytes)
    expect(bc.format).toBe('bc7-rgba-unorm')
    expect(bc.levels![0]!.length).toBe((64 / 4) * (64 / 4) * 16)
    setTextureCapabilities({ bc: false, astc: false, etc2: false })
    expect((await textureFromKtx2(bytes)).format).toBe('rgba8unorm')
  }, 60_000)
})

/** A PNG from RGBA8 pixels, via the protocol encoder's approach (deflate stored as zlib). */
async function pngOf(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const raw = new Uint8Array((w * 4 + 1) * h)
  for (let y = 0; y < h; y++)
    raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
  const crc = (b: Uint8Array) => zlib.crc32(b)
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const view = new DataView(out.buffer)
    view.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, w)
  new DataView(ihdr.buffer).setUint32(4, h)
  ihdr[8] = 8
  ihdr[9] = 6
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', new Uint8Array()),
  ]
  return new Uint8Array(Buffer.concat(parts))
}

describe('textures in code and in projects', () => {
  it('Texture.create generates mips; update bumps the version', () => {
    const t = Texture.create({ width: 8, height: 8, mips: [pattern(8, 8)], mipmaps: true })
    expect(t.mipCount).toBe(4)
    expect(t.byteSize).toBe(256 + 64 + 16 + 4)
    t.update({ mips: [pattern(8, 8)] })
    expect(t.version).toBe(1)
  })

  it('imports a PNG as a texture with usage from its name, and hot reloads it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-texture-'))
    roots.push(root)
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets/rock_normal.png'), await pngOf(pattern(16, 16), 16, 16))
    writeFileSync(join(root, 'assets/rock_albedo.png'), await pngOf(pattern(32, 16), 32, 16))
    const assets = assetServer(new World()).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await assets.scan()
    expect(report.failed).toEqual([])
    expect(
      JSON.parse(readFileSync(join(root, 'assets/rock_normal.png.meta'), 'utf8')).settings.usage,
    ).toBe('normal')
    await assets.load('assets/rock_albedo.png')
    const tex = assets.world.resource(Textures).get(assets.resolve('assets/rock_albedo.png'))!
    expect(tex).toMatchObject({
      width: 32,
      height: 16,
      format: 'rgba8unorm',
      usage: 'color',
      mipCount: 6,
    })
    expect(assets.info('assets/rock_albedo.png').info).toMatchObject({
      width: 32,
      height: 16,
      mips: 6,
    })
    await new Promise((r) => setTimeout(r, 10))
    writeFileSync(join(root, 'assets/rock_albedo.png'), await pngOf(pattern(8, 8), 8, 8))
    await assets.scan()
    expect(tex).toMatchObject({ width: 8, height: 8, version: 1 })
  })

  it('imports a *.texarray.json as a texture array, resizing layers and re-importing on edits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-texture-'))
    roots.push(root)
    mkdirSync(join(root, 'assets'))
    writeFileSync(join(root, 'assets/grass.png'), await pngOf(pattern(16, 16), 16, 16))
    writeFileSync(join(root, 'assets/rock.png'), await pngOf(pattern(32, 32), 32, 32))
    writeFileSync(
      join(root, 'assets/ground.texarray.json'),
      JSON.stringify({ layers: ['grass.png', 'rock.png'], usage: 'color' }),
    )
    writeFileSync(join(root, 'assets/bad.texarray.json'), JSON.stringify({ layers: [] }))
    const assets = assetServer(new World()).configure({
      platform: createNodePlatform({ root, logTo: () => {} }),
    })
    const report = await assets.scan()
    expect(report.failed.map((f) => f.error.code)).toEqual(['texture/invalid-array'])
    expect(assets.info('assets/ground.texarray.json').info).toMatchObject({
      width: 16,
      height: 16,
      layers: 2,
      mips: 5,
    })
    // The 32² layer was resized to the first one's size (with a warning).
    expect(JSON.stringify(assets.info('assets/ground.texarray.json').warnings)).toContain(
      'resized to 16×16',
    )
    await assets.load('assets/ground.texarray.json')
    const tex = assets.world.resource(Textures).get(assets.resolve('assets/ground.texarray.json'))!
    expect(tex).toMatchObject({ width: 16, height: 16, layers: 2, usage: 'color', mipCount: 5 })
    // Level 0 holds both layers: the first one's pixels, then the (resized) second one's.
    expect(tex.levels?.[0]?.byteLength).toBe(16 * 16 * 4 * 2)
    await new Promise((r) => setTimeout(r, 10))
    writeFileSync(
      join(root, 'assets/ground.texarray.json'),
      JSON.stringify({ layers: ['grass.png', 'rock.png', 'grass.png'], size: 8 }),
    )
    await assets.scan()
    expect(tex).toMatchObject({ width: 8, height: 8, layers: 3, version: 1 })
  })

  it('imports a 2048² PNG in under 1.5 s', async () => {
    const png = await pngOf(pattern(2048, 2048), 2048, 2048)
    const start = performance.now()
    const out = await importImageBytes(png, {
      usage: 'color',
      mipmaps: true,
      compression: 'none',
      maxSize: 4096,
      flipY: false,
      premultiplyAlpha: false,
    })
    const ms = performance.now() - start
    expect(out.info.mips).toBe(12)
    expect(ms).toBeLessThan(budget(1500))
  }, 30_000)
})

describe('the same pixels on every host', () => {
  it('decodes the cross-host fixtures to their recorded hashes', async () => {
    const { createHash } = await import('node:crypto')
    const hashes = JSON.parse(
      readFileSync(join(fixtures, 'crosshost-hashes.json'), 'utf8'),
    ) as Record<string, string>
    const sha = (b: ArrayBufferView) =>
      createHash('sha256')
        .update(new Uint8Array(b.buffer, b.byteOffset, b.byteLength))
        .digest('hex')
    for (const [file, hash] of Object.entries(hashes)) {
      const bytes = new Uint8Array(readFileSync(join(fixtures, file)))
      const data = file.endsWith('-zstd.ktx2')
        ? readKtx2(bytes).levels[0]!
        : file.endsWith('-uastc.ktx2')
          ? (await transcodeBasis(bytes, 'rgba8')).levels[0]!
          : (await decodeImage(bytes)).data
      expect(sha(data), file).toBe(hash)
    }
  }, 30_000)
})
