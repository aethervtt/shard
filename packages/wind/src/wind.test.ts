import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { Camera3d, ShaderGlobals, ShaderGlobalsData, Shaders } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ShaderLibrary } from '@aethervtt/shard-shader'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { updateWindField, windPlugin } from './plugin'
import { scheduleWind, syncWind, WindState } from './state'
import { gustNoise, Wind, windAt, windHash, windSample, windTime } from './wind'
import { WindField, WindZone } from './zones'

async function app() {
  const a = new App().addPlugin(TransformPlugin, windPlugin)
  await a.init()
  return a
}

const sample = windSample()

describe('windAt (0096)', () => {
  it('is the Wind resource where there are no zones, with gusts within ±speed × gustiness', async () => {
    const a = await app()
    const wind = a.world.resource(Wind)
    expect(wind).toEqual({ direction: [1, 0, 0.35], speed: 6, gustiness: 0.3, gustScale: 0.05 })
    let lo = Number.POSITIVE_INFINITY
    let hi = Number.NEGATIVE_INFINITY
    for (let i = 0; i < 400; i++) {
      windAt(a.world, [i * 3.7, 2, -i * 1.3], sample, i * 0.25)
      expect(sample.speed).toBeCloseTo(6, 6)
      lo = Math.min(lo, sample.gust)
      hi = Math.max(hi, sample.gust)
    }
    const l = Math.hypot(1, 0.35)
    expect(sample.direction[0]).toBeCloseTo(1 / l, 6)
    expect(sample.direction[2]).toBeCloseTo(0.35 / l, 6)
    expect(lo).toBeGreaterThanOrEqual(-1.8 - 1e-9)
    expect(hi).toBeLessThanOrEqual(1.8 + 1e-9)
    expect(hi - lo).toBeGreaterThan(1.5) // gusts do vary
    // A gale: the same gust pattern, three times the size.
    windAt(a.world, [10, 2, 10], sample, 3)
    const breeze = sample.gust
    wind.speed = 18
    windAt(a.world, [10, 2, 10], sample, 3)
    expect(sample.speed).toBeCloseTo(18, 6)
    expect(sample.gust).toBeCloseTo(breeze * 3, 6)
    // Calm: no gusts either.
    wind.speed = 0
    windAt(a.world, [10, 2, 10], sample, 3)
    expect(sample.speed).toBe(0)
    expect(Math.abs(sample.gust)).toBe(0)
  })

  it('gusts are smooth value noise that drifts downwind with the wind clock', () => {
    for (let i = 0; i < 1000; i++) {
      const h = windHash(i * 7919 - 3000, -i * 104729)
      expect(h).toBeGreaterThanOrEqual(0)
      expect(h).toBeLessThan(1)
    }
    // Continuous across cell edges.
    expect(Math.abs(gustNoise(2 - 1e-9, 0.5) - gustNoise(2 + 1e-9, 0.5))).toBeLessThan(1e-6)
    expect(gustNoise(3, 4)).toBe(windHash(3, 4))
  })

  it('a WindZone with speedScale 0 stills the wind inside, blending over its falloff', async () => {
    const a = await app()
    const w = a.world
    w.resource(Wind).direction = [1, 0, 0]
    w.spawn(
      [WindZone, { shape: 'box', size: [20, 10, 20], falloff: 4, speedScale: 0 }],
      [Transform, { translation: [100, 0, 0] }],
    )
    a.update(1 / 60)
    const at = (x: number) => windAt(w, [x, 0, 0], sample, 0).speed
    expect(at(100)).toBe(0)
    expect(at(110)).toBe(0) // on the edge
    expect(at(112)).toBeCloseTo(3, 5) // halfway through the falloff
    expect(at(114)).toBeCloseTo(6, 5)
    expect(at(130)).toBeCloseTo(6, 5)
    // Gusts scale with the speed, so they're still too.
    expect(Math.abs(windAt(w, [100, 0, 0], sample, 5).gust)).toBe(0)
  })

  it('applies overrides and spheres, lowest priority first', async () => {
    const a = await app()
    const w = a.world
    const storm = w.spawn(
      [
        WindZone,
        {
          shape: 'sphere',
          size: [40, 0, 0],
          falloff: 0,
          override: true,
          direction: [0, 0, 2],
          speed: 25,
          priority: 1,
        },
      ],
      [Transform, { translation: [0, 0, 50] }],
    )
    // A shelter inside the storm, with a lower priority: the storm wins.
    w.spawn(
      [WindZone, { shape: 'box', size: [4, 4, 4], falloff: 0, speedScale: 0 }],
      [Transform, { translation: [0, 0, 50] }],
    )
    a.update(1 / 60)
    expect(w.resource(WindField).entities[1]).toBe(storm)
    windAt(w, [0, 0, 50], sample, 0)
    expect(sample.speed).toBeCloseTo(25, 5)
    expect(sample.direction).toEqual([0, 0, 1])
    expect(windAt(w, [0, 0, 69], sample, 0).speed).toBeCloseTo(25, 5)
    expect(windAt(w, [0, 0, 71], sample, 0).speed).toBeCloseTo(6, 5)
    // Raise the shelter above the storm and it wins.
    w.set(storm, WindZone, { priority: -1 })
    a.update(1 / 60)
    expect(windAt(w, [0, 0, 50], sample, 0).speed).toBe(0)
  })

  it('applies a scheduled WindState at its tick', async () => {
    const a = await app()
    scheduleWind(a.world, { speed: 18 }, 30)
    for (let i = 0; i < 20; i++) a.update(1 / 60)
    expect(a.world.resource(Wind).speed).toBe(6)
    for (let i = 0; i < 20; i++) a.update(1 / 60)
    expect(a.world.resource(Wind).speed).toBe(18)
    expect(a.world.query({ with: [WindState] }).count()).toBe(1)
    expect(windTime(a.world)).toBeGreaterThan(0.6)
  })

  it('allocates nothing per call', async () => {
    const a = await app()
    const w = a.world
    for (let i = 0; i < 8; i++) {
      w.spawn(
        [WindZone, { shape: i % 2 ? 'sphere' : 'box', size: [10, 10, 10], speedScale: 0.5 }],
        [Transform, { translation: [i * 20, 0, 0] }],
      )
    }
    a.update(1 / 60)
    const p = new Float64Array(3)
    let sum = 0
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        p[0] = (i % 200) * 0.8
        p[2] = (i % 37) * 1.3
        sum += windAt(w, p, sample).gust
      }
    }
    run(200_000) // let V8 optimize
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const gcs = gcWindow()
    const t0 = performance.now()
    run(100_000)
    const ms = performance.now() - t0
    const collections = await gcs.end()
    console.log(
      `windAt with 8 zones: ${((ms / 100_000) * 1e6).toFixed(0)} ns; GC events: ${collections}`,
    )
    expect(Number.isFinite(sum)).toBe(true)
    if (allocationChecks) expect(collections).toBe(0)
    expect(ms).toBeLessThan(budget('wind/at', { count: 100_000 }))
  })

  it('packs and uploads zones each frame allocating nothing, the nearest 16 of more', async () => {
    const a = new App().addPlugin(TransformPlugin, windPlugin)
    a.world.insertResource(ShaderGlobals, new ShaderGlobalsData())
    a.world.insertResource(Shaders, new ShaderLibrary())
    await a.init()
    const w = a.world
    const field = w.resource(WindField)
    expect(field.slot).toBe(0)
    for (let i = 0; i < 24; i++) {
      w.spawn(
        [WindZone, { size: [6, 6, 6], speedScale: 0, priority: 24 - i }],
        [Transform, { translation: [i * 10, 0, 0] }],
      )
    }
    w.spawn(Camera3d, [Transform, { translation: [235, 0, 0] }])
    a.update(1 / 60)
    expect(field.count).toBe(24)
    expect(field.uploaded).toBe(16)
    // The 16 nearest the camera (x 80…230), still in priority order (highest x first).
    const v = w.resource(ShaderGlobals).values
    const at = 4 + (3 + 0) * 4
    expect(-v[at + 3]!).toBeCloseTo(230, 3)
    expect(-v[at + 15 * 24 + 3]!).toBeCloseTo(80, 3)
    const field$ = updateWindField.setup!(w)
    const sync = syncWind.setup!(w)
    const frame = () => {
      w.incrementTick()
      syncWind.run(sync, w, undefined as never)
      updateWindField.run(field$, w, undefined as never)
    }
    for (let i = 0; i < 2000; i++) frame()
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const gcs = gcWindow()
    const t0 = performance.now()
    for (let i = 0; i < 2000; i++) frame()
    const ms = performance.now() - t0
    const collections = await gcs.end()
    console.log(
      `wind systems, 24 zones: ${((ms / 2000) * 1e3).toFixed(1)} µs a frame; GC events: ${collections}`,
    )
    if (allocationChecks) expect(collections).toBe(0)
    expect(ms / 2000).toBeLessThan(budget('wind/frame'))
  })
})
