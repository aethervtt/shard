import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { App, FixedTime, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { describe, expect, it } from 'vitest'
import { WaterBody } from '../components'
import { describeWater } from '../methods'
import { waterOptics } from '../optics'
import { waterPlugin } from '../plugin'
import { waterAt, waterSample } from '../query'
import { waveMethods } from './methods'
import { oceanWavesPlugin } from './plugin'
import { WaveSets } from './sea'
import { buildSea, OceanWaves, REPEAT, type SpectrumParams } from './spectrum'

async function app(speed = 15) {
  const a = new App().addPlugin(TransformPlugin, waterPlugin(), oceanWavesPlugin())
  await a.init()
  a.world.resource(Wind).speed = speed
  return a
}

const params = (o: Partial<SpectrumParams> = {}): SpectrumParams => ({
  seed: 3,
  windSpeed: 15,
  windX: 1,
  windZ: 0,
  fetch: 300_000,
  gamma: 3.3,
  spread: 1,
  swell: false,
  swellHeight: 0,
  swellPeriod: 10,
  swellX: 1,
  swellZ: 0,
  swellSpread: 0.3,
  depth: 0,
  choppiness: 1,
  lengths: [250, 17, 5],
  resolution: 256,
  ...o,
})

describe('ocean waves (0098)', () => {
  it('gives the CPU evaluator JONSWAP’s significant height at 15 m/s and 300 km, within 10%', async () => {
    const a = await app(15)
    const w = a.world
    const ocean = w.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
      [OceanWaves, { seed: 3, fetch: 300 }],
      Transform,
    )
    a.update(1 / 60)
    const sea = w.resource(WaveSets).sets.get(ocean)!.sea
    // 600 s of samples at a point, a tenth of a second apart.
    const fixed = w.resource(FixedTime)
    const s = waterSample()
    let sum = 0
    let sum2 = 0
    let n = 0
    for (let tick = 0; tick < 600 * 60; tick += 6) {
      fixed.tick = tick
      waterAt(w, [13, -2, -7], s)
      sum += s.surfaceHeight
      sum2 += s.surfaceHeight ** 2
      n++
    }
    const hs = 4 * Math.sqrt(sum2 / n - (sum / n) ** 2)
    console.log(
      `JONSWAP Hs ${sea.hs.toFixed(2)} m (Tp ${sea.tp.toFixed(1)} s); the evaluator over 600 s: ${hs.toFixed(2)} m`,
    )
    expect(Math.abs(hs - sea.hs) / sea.hs).toBeLessThan(0.1)
    expect(sea.tp).toBeGreaterThan(9)
    expect(sea.tp).toBeLessThan(12)
  })

  it('is the same sea for the same seed, loops every 8192 s, and differs by seed', () => {
    const a = buildSea(params())
    const b = buildSea(params())
    expect(Array.from(a.components)).toEqual(Array.from(b.components))
    const c = buildSea(params({ seed: 4 }))
    expect(Array.from(c.components)).not.toEqual(Array.from(a.components))
    // Every ω a whole number of turns in REPEAT seconds.
    for (let i = 0; i < a.componentCount; i++) {
      const turns = (a.components[i * 6 + 4]! * REPEAT) / (2 * Math.PI)
      expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-6)
    }
    // A coarser grid keeps the same strong waves (phases come from each wave's own indices); only
    // the roll-off below a texel, which depends on the grid, trims their heights a little.
    const coarse = buildSea(params({ resolution: 128 }))
    for (let i = 0; i < 10; i++) {
      for (const f of [0, 1, 3, 4])
        expect(coarse.components[i * 6 + f]).toBe(a.components[i * 6 + f])
      expect(Math.abs(coarse.components[i * 6 + 2]! / a.components[i * 6 + 2]! - 1)).toBeLessThan(
        0.02,
      )
    }
  })

  it('a swell adds its own height, and shallow water shrinks the sea (TMA)', () => {
    const calm = buildSea(params({ windSpeed: 0, swell: true, swellHeight: 2, swellPeriod: 11 }))
    expect(calm.hs).toBeCloseTo(2, 1)
    expect(calm.tp).toBeCloseTo(11, 5)
    const deep = buildSea(params({ windSpeed: 10, fetch: 50_000 }))
    const shallow = buildSea(params({ windSpeed: 10, fetch: 50_000, depth: 3 }))
    expect(shallow.hs).toBeLessThan(deep.hs * 0.8)
  })

  it('reports water/bad-cascades and draws no waves for that body', async () => {
    const a = await app()
    const w = a.world
    const bad = w.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
      [OceanWaves, { cascades: [{ length: 5 }, { length: 17 }] }],
      Transform,
    )
    a.update(1 / 60)
    const errors = w
      .resource(LogResource)
      .tail(50)
      .filter((e) => e.code === 'water/bad-cascades')
    expect(errors.map((e) => e.message)).toEqual([
      `OceanWaves on ${bad}: cascade lengths must decrease (5, 17)`,
    ])
    expect(w.resource(WaveSets).sets.get(bad)).toBeUndefined()
    const s = waterSample()
    expect(waterAt(w, [3, 0, 4], s).surfaceHeight).toBe(0)
  })

  it('waterAt with waves allocates nothing', async () => {
    const a = await app()
    const w = a.world
    w.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
      [OceanWaves, { seed: 3, fetch: 300 }],
      Transform,
    )
    a.update(1 / 60)
    const p = new Float64Array(3)
    const s = waterSample()
    let sum = 0
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        p[0] = (i % 500) * 1.3
        p[2] = (i % 41) * 2.1
        sum += waterAt(w, p, s).surfaceHeight
      }
    }
    run(20_000)
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const gcs = gcWindow()
    const t0 = performance.now()
    run(10_000)
    const ms = performance.now() - t0
    const collections = await gcs.end()
    console.log(
      `waterAt with waves (128 components): ${((ms / 10_000) * 1e3).toFixed(1)} µs; GC events: ${collections}`,
    )
    expect(Number.isFinite(sum)).toBe(true)
    if (allocationChecks) expect(collections).toBe(0)
    expect(ms).toBeLessThan(budget('water/at-waves', { count: 10_000 }))
  })

  it('water.waves previews a spectrum, and water.describe reports each sea', async () => {
    const a = await app(12)
    const preview = waveMethods.find((m) => m.name === 'water.waves')!
    const out = (await preview.handler({ world: a.world } as never, {
      windSpeed: 15,
      fetch: 300,
      pixels: 32,
    })) as {
      hs: number
      tp: number
      cascades: { band: (number | null)[] }[]
      image: { mimeType: string; data: string }
    }
    expect(out.hs).toBeCloseTo(5.65, 1)
    expect(out.tp).toBeCloseTo(10.3, 0)
    expect(out.cascades).toHaveLength(3)
    expect(out.cascades[0]!.band[0]).toBe(null)
    expect(out.image.mimeType).toBe('image/png')
    expect(out.image.data.length).toBeGreaterThan(100)
    const ocean = a.world.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
      [OceanWaves, { seed: 2, fetch: 40, cascades: [{ length: 120 }, { length: 9 }] }],
      Transform,
    )
    a.update(1 / 60)
    const d = describeWater(a.world) as unknown as {
      waves: {
        seas: { entity: number; hs: number; cascades: unknown[]; wind: { speed: number } }[]
      }
    }
    expect(d.waves.seas).toHaveLength(1)
    expect(d.waves.seas[0]).toMatchObject({ entity: ocean, wind: { speed: 12 } })
    expect(d.waves.seas[0]!.cascades).toHaveLength(2)
  })
})
