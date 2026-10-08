import { crc32, deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { decodeHeightPng, HeightmapImporter } from './heightmap'
import { parseTerrainSource, terrainLayout } from './source'

const base = () => ({
  size: [4096, 4096],
  spacing: 1,
  heightRange: [-200, 800],
  splines: {
    road: {
      points: [
        [0, 'ground', 0],
        [100, 4, 50],
      ],
      width: 8,
      falloff: 14,
    },
  },
  height: [{ noise: { path: 'noise/hills.noise.json' }, scale: 260 }, { spline: 'road' }],
  layers: [{ name: 'grass' }, { name: 'gravel' }],
  paint: [{ layer: 'grass' }, { layer: 'gravel', spline: 'road', blend: 2 }],
})

function fails(json: unknown): { code: string; path: string | undefined } {
  try {
    parseTerrainSource(json)
  } catch (err) {
    const e = err as { code: string; path?: string }
    return { code: e.code, path: e.path }
  }
  throw new Error('parsed')
}

/** A grayscale PNG of `depth` bits, `w` × `h`, from big-endian samples. */
function png(w: number, h: number, depth: 8 | 16, sample: (x: number, y: number) => number) {
  const bpp = depth / 8
  const raw = new Uint8Array((w * bpp + 1) * h)
  for (let y = 0; y < h; y++) {
    // Sub filter on odd rows, so unfiltering is exercised.
    const filter = y % 2
    raw[y * (w * bpp + 1)] = filter
    const row = new Uint8Array(w * bpp)
    for (let x = 0; x < w; x++) {
      const v = sample(x, y)
      if (depth === 16) {
        row[x * 2] = v >> 8
        row[x * 2 + 1] = v & 0xff
      } else row[x] = v
    }
    for (let i = 0; i < row.length; i++) {
      const left = i >= bpp ? row[i - bpp]! : 0
      raw[y * (w * bpp + 1) + 1 + i] = (row[i]! - (filter === 1 ? left : 0)) & 0xff
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length)
    const v = new DataView(out.buffer)
    v.setUint32(0, data.length)
    out.set(new TextEncoder().encode(type), 4)
    out.set(data, 8)
    v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, w)
  new DataView(ihdr.buffer).setUint32(4, h)
  ihdr[8] = depth
  ihdr[9] = 0
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ]
  return Uint8Array.from(parts.flatMap((p) => [...p]))
}

describe('terrain sources (0071)', () => {
  it('fills defaults and lays out roots', () => {
    const s = parseTerrainSource(base())
    expect(s.paintSpacing).toBe(2)
    expect(s.height[0]).toMatchObject({ kind: 'noise', blend: 'add', scale: 260, region: null })
    expect(s.height[1]).toMatchObject({ kind: 'spline', mode: 'flatten', falloff: 14 })
    expect(s.layers[1]).toMatchObject({ albedo: 1, normal: 1, orm: 1, scale: 4, triplanar: false })
    expect(terrainLayout(s)).toMatchObject({ depth: 3, rootsX: 8, rootSize: 512, blocksX: 4 })
    // 16 km at 1 m and 2 km at 0.5 m: 8 × 8 roots each.
    expect(terrainLayout({ size: [16384, 16384], spacing: 1, paintSpacing: 2 })).toMatchObject({
      depth: 5,
      rootsX: 8,
      blocksX: 16,
    })
    expect(terrainLayout({ size: [2048, 2048], spacing: 0.5, paintSpacing: 0.5 })).toMatchObject({
      depth: 3,
      rootsX: 8,
      cells: 64,
    })
  })

  it('names every problem with a code and a pointer into the file', () => {
    expect(fails({ ...base(), size: [4000, 4096] })).toEqual({
      code: 'terrain/bad-size',
      path: '/size',
    })
    expect(fails({ ...base(), size: [128, 4096] })).toEqual({
      code: 'terrain/bad-size',
      path: '/size/0',
    })
    expect(fails({ ...base(), size: [64 * 3, 64 * 3] }).code).toBe('terrain/bad-size')
    expect(fails({ ...base(), spacing: 8 })).toEqual({
      code: 'terrain/bad-spacing',
      path: '/spacing',
    })
    expect(fails({ ...base(), paintSpacing: 3 })).toEqual({
      code: 'terrain/bad-spacing',
      path: '/paintSpacing',
    })
    expect(fails({ ...base(), height: [{ spline: 'rd' }] })).toEqual({
      code: 'terrain/unknown-spline',
      path: '/height/0/spline',
    })
    expect(fails({ ...base(), paint: [{ layer: 'snow' }] })).toEqual({
      code: 'terrain/unknown-layer',
      path: '/paint/0/layer',
    })
    expect(
      fails({ ...base(), layers: Array.from({ length: 33 }, (_, i) => ({ name: `l${i}` })) }),
    ).toEqual({ code: 'terrain/too-many-layers', path: '/layers' })
    expect(fails({ ...base(), height: [{ noise: { path: 'a' }, image: { path: 'b' } }] })).toEqual({
      code: 'terrain/bad-source',
      path: '/height/0',
    })
    expect(
      fails({ ...base(), height: [{ image: { path: 'a' }, at: [0, 0], size: [1, 1] }] }),
    ).toEqual({
      code: 'terrain/bad-source',
      path: '/height/0/range',
    })
    expect(fails({ ...base(), colour: 1 })).toEqual({ code: 'terrain/bad-source', path: '/colour' })
  })

  it('reads 16-bit grayscale PNGs and refuses 8-bit ones', async () => {
    const decoded = decodeHeightPng(
      'a.png',
      png(5, 3, 16, (x, y) => x * 10000 + y * 7),
    )
    expect([decoded.width, decoded.height]).toEqual([5, 3])
    expect(Array.from(decoded.samples.subarray(5, 10))).toEqual([7, 10007, 20007, 30007, 40007])
    expect(() =>
      decodeHeightPng(
        'b.png',
        png(4, 4, 8, () => 3),
      ),
    ).toThrow(expect.objectContaining({ code: 'terrain/heightmap-format' }))
    const ctx = { settings: { width: 2, height: 2 } } as never
    const raw = new Uint8Array(new Uint16Array([0, 65535, 32768, 1]).buffer)
    const out = await HeightmapImporter.import({ path: 'v.r16', bytes: raw, text: () => '' }, ctx)
    expect(out.assets[0]).toMatchObject({
      type: 'Heightmap',
      json: { width: 2, height: 2, bits: 16 },
    })
    await expect(
      HeightmapImporter.import({ path: 'v.r16', bytes: raw.subarray(0, 6), text: () => '' }, ctx),
    ).rejects.toMatchObject({ code: 'terrain/heightmap-format' })
    await expect(
      HeightmapImporter.import({ path: 'v.r32', bytes: raw, text: () => '' }, {
        settings: {},
      } as never),
    ).rejects.toMatchObject({ code: 'terrain/heightmap-format' })
  })
})
