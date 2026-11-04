import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { buildShape, gatherWaterBodies, insideShape, WaterBodies } from './bodies'
import { InfoClipmap, placeRings, SurfaceRings } from './clipmap'
import { WaterBody, WaterSpline } from './components'
import { describeWater, waterMethods } from './methods'
import { WATER_OPTICS_PRESETS, waterOptics } from './optics'
import { waterPlugin } from './plugin'
import { waterAt, waterSample } from './query'

async function app() {
  const a = new App().addPlugin(TransformPlugin, waterPlugin())
  await a.init()
  return a
}

type Vec3 = [number, number, number]
const point = (position: Vec3) => ({ position, width: 0, depth: 0, flow: 0 })
const ring = (r: number, n = 12, cx = 0, cz = 0) =>
  Array.from({ length: n }, (_, i) =>
    point([cx + r * Math.cos((i / n) * 2 * Math.PI), 0, cz + r * Math.sin((i / n) * 2 * Math.PI)]),
  )

const logged = (a: App, code: string) =>
  a.world
    .resource(LogResource)
    .tail(500)
    .filter((e) => e.code === code)

describe('waterAt (0097)', () => {
  it('reads an ocean everywhere at its level, and a lake inside its outline on top of it', async () => {
    const a = await app()
    const w = a.world
    const ocean = w.spawn(
      [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
      [Transform, { translation: [0, -2, 0] }],
    )
    const lake = w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake'), priority: 1 }],
      [WaterSpline, { points: ring(40), closed: true }],
      [Transform, { translation: [100, 12, -50] }],
    )
    a.update(1 / 60)
    const s = waterSample()
    waterAt(w, [5000, -10, -3000], s)
    expect(s.body).toBe(ocean)
    expect(s.surfaceHeight).toBe(-2)
    expect(s.depth).toBe(8)
    expect(s.underwater).toBe(true)
    expect(s.groundHeight).toBe(Number.NEGATIVE_INFINITY)
    expect(s.optics).toEqual(WATER_OPTICS_PRESETS.ocean)
    expect(s.normal).toEqual([0, 1, 0])

    waterAt(w, [100, 10, -50], s)
    expect(s.body).toBe(lake)
    expect(s.surfaceHeight).toBe(12)
    expect(s.underwater).toBe(true)
    waterAt(w, [100, 13, -50], s)
    expect(s.underwater).toBe(false)
    expect(s.depth).toBe(-1)
    // Just outside the lake's outline: the ocean.
    waterAt(w, [100 + 45, 10, -50], s)
    expect(s.body).toBe(ocean)
    // Moving the lake moves its water.
    w.set(lake, Transform, { translation: [300, 12, -50] })
    a.update(1 / 60)
    waterAt(w, [100, 10, -50], s)
    expect(s.body).toBe(ocean)
    waterAt(w, [300, 10, -50], s)
    expect(s.body).toBe(lake)
  })

  it('takes the highest priority where bodies overlap, then the later entity', async () => {
    const a = await app()
    const w = a.world
    const low = w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake'), priority: 0 }],
      [WaterSpline, { points: ring(30) }],
      [Transform, { translation: [0, 5, 0] }],
    )
    const high = w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('murky'), priority: 3 }],
      [WaterSpline, { points: ring(10) }],
      [Transform, { translation: [0, 4, 0] }],
    )
    a.update(1 / 60)
    const s = waterSample()
    expect(waterAt(w, [0, 0, 0], s).body).toBe(high)
    expect(s.surfaceHeight).toBe(4)
    expect(waterAt(w, [20, 0, 0], s).body).toBe(low)
    w.set(high, WaterBody, { ...w.get(high, WaterBody), priority: 0 })
    a.update(1 / 60)
    // Same priority: the later entity.
    expect(waterAt(w, [0, 0, 0], s).body).toBe(high)
    w.set(low, WaterBody, { ...w.get(low, WaterBody), priority: 1 })
    a.update(1 / 60)
    expect(waterAt(w, [0, 0, 0], s).body).toBe(low)
    // Gone: no water.
    w.despawn(low)
    w.despawn(high)
    a.update(1 / 60)
    expect(waterAt(w, [0, 0, 0], s).body).toBe(null)
    expect(Number.isNaN(s.surfaceHeight)).toBe(true)
    expect(w.resource(WaterBodies).count).toBe(0)
  })

  it('reports water/bad-spline and leaves the body out', async () => {
    const a = await app()
    const w = a.world
    const two = w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
      [WaterSpline, { points: ring(10, 2) }],
      Transform,
    )
    const eight = w.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
      [
        WaterSpline,
        {
          // A figure eight.
          points: [
            point([0, 0, 0]),
            point([20, 0, 20]),
            point([40, 0, 0]),
            point([20, 0, -20]),
            point([0, 0, 20]),
            point([-20, 0, 0]),
          ],
        },
      ],
      [Transform, { translation: [500, 0, 0] }],
    )
    const bare = w.spawn([WaterBody, { kind: 'lake', optics: waterOptics('lake') }], Transform)
    a.update(1 / 60)
    a.update(1 / 60)
    const errors = logged(a, 'water/bad-spline')
    expect(errors.map((e) => e.message)).toEqual([
      `Water body ${two}: a closed outline needs at least 3 points, it has 2`,
      expect.stringContaining(`Water body ${eight}: its outline crosses itself`),
      `Water body ${bare}: a lake needs a closed water/WaterSpline`,
    ])
    expect(w.resource(WaterBodies).count).toBe(0)
    const d = describeWater(w)
    expect(d.bodies.map((b) => b.problem?.code)).toEqual([
      'water/bad-spline',
      'water/bad-spline',
      'water/bad-spline',
    ])
    // Fixing it brings the body back.
    w.set(two, WaterSpline, { points: ring(10, 6), closed: true })
    a.update(1 / 60)
    expect(w.resource(WaterBodies).count).toBe(1)
    expect(waterAt(w, [0, 0, 0], waterSample()).body).toBe(two)
  })

  it('falls back to clear optics with water/no-optics, and names presets by path', async () => {
    const a = await app()
    const w = a.world
    w.spawn([WaterBody, { kind: 'ocean' }], Transform)
    const pool = w.spawn(
      [
        WaterBody,
        { kind: 'lake', optics: { path: 'water/pool.water.json' } as never, priority: 1 },
      ],
      [WaterSpline, { points: ring(5) }],
      Transform,
    )
    a.update(1 / 60)
    a.update(1 / 60)
    expect(logged(a, 'water/no-optics')).toHaveLength(1)
    const s = waterSample()
    expect(waterAt(w, [100, -1, 0], s).optics).toEqual(WATER_OPTICS_PRESETS.clear)
    expect(waterAt(w, [0, -1, 0], s).body).toBe(pool)
    expect(s.optics).toEqual(WATER_OPTICS_PRESETS.pool)
    const sample = waterMethods.find((m) => m.name === 'water.sample')!
    const out = (await sample.handler({ world: w } as never, point([0, -1, 0]))) as {
      body: number
      surfaceHeight: number
      groundHeight: number | null
      underwater: boolean
    }
    expect(out).toMatchObject({
      body: pool,
      surfaceHeight: 0,
      groundHeight: null,
      underwater: true,
    })
    const d = describeWater(w)
    expect(d.bodies).toHaveLength(2)
    expect(d.bodies[0]!.optics.fallback).toBe('clear (water/no-optics)')
    expect(d.bodies[1]!.optics.asset).toBe('water/pool.water.json')
    // No renderer: no zone.
    expect(d.zone).toBe(null)
  })

  it('tests points against an outline the way a polygon test does', () => {
    const shape = buildShape(1 as never, ring(20, 9), [1, 0, 0, 7, 0, 1, 0, 0, 0, 0, 1, -3])
    let s = 1
    const rand = () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0
      return s / 4294967296
    }
    const p = shape.outline
    const n = shape.count
    for (let k = 0; k < 2000; k++) {
      const x = 7 - 30 + rand() * 60
      const z = -3 - 30 + rand() * 60
      let inside = false
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const zi = p[i * 2 + 1]!
        const zj = p[j * 2 + 1]!
        if (zi > z !== zj > z && x < p[i * 2]! + ((z - zi) / (zj - zi)) * (p[j * 2]! - p[i * 2]!))
          inside = !inside
      }
      expect(insideShape(shape, x, z)).toBe(inside)
    }
    // The triangles cover the outline's area.
    let area = 0
    const t = shape.triangles
    for (let i = 0; i < t.length; i += 6)
      area +=
        Math.abs(
          (t[i + 2]! - t[i]!) * (t[i + 5]! - t[i + 1]!) -
            (t[i + 4]! - t[i]!) * (t[i + 3]! - t[i + 1]!),
        ) / 2
    let polygon = 0
    for (let i = 0, j = n - 1; i < n; j = i++)
      polygon += p[j * 2]! * p[i * 2 + 1]! - p[i * 2]! * p[j * 2 + 1]!
    expect(area).toBeCloseTo(Math.abs(polygon) / 2, 0)
  })

  it('allocates nothing per call, nor per frame for bodies, the clipmap and the rings', async () => {
    const a = await app()
    const w = a.world
    w.spawn([WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }], Transform)
    for (let i = 0; i < 8; i++) {
      w.spawn(
        [WaterBody, { kind: 'lake', optics: waterOptics('lake'), priority: 1 }],
        [WaterSpline, { points: ring(30, 16) }],
        [Transform, { translation: [i * 100, 10, 0] }],
      )
    }
    a.update(1 / 60)
    const state = w.resource(WaterBodies)
    expect(state.count).toBe(9)
    const p = new Float64Array(3)
    const sample = waterSample()
    let sum = 0
    const run = (n: number) => {
      for (let i = 0; i < n; i++) {
        p[0] = (i % 800) * 1.01
        p[1] = 5
        p[2] = (i % 37) * 1.3 - 20
        sum += waterAt(w, p, sample).depth
      }
    }
    run(200_000)
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    let gcs = gcWindow()
    let t0 = performance.now()
    run(100_000)
    let ms = performance.now() - t0
    let collections = await gcs.end()
    console.log(
      `waterAt with 9 bodies: ${((ms / 100_000) * 1e6).toFixed(0)} ns; GC events: ${collections}`,
    )
    expect(Number.isFinite(sum)).toBe(true)
    if (allocationChecks) expect(collections).toBe(0)
    expect(ms).toBeLessThan(budget('water/at', { count: 100_000 }))

    // A frame's CPU work: gather the bodies, move the clipmap and place the rings as the camera moves.
    const gather = gatherWaterBodies.setup!(w)
    const clip = new InfoClipmap()
    const rings = new SurfaceRings()
    let x = 0
    const frame = () => {
      w.incrementTick()
      gatherWaterBodies.run(gather, w, { lastRunTick: w.tick - 1 } as never)
      x += 0.7
      clip.update(state, x, 3)
      placeRings(rings, state, x, 3)
    }
    for (let i = 0; i < 2000; i++) frame()
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    gcs = gcWindow()
    t0 = performance.now()
    for (let i = 0; i < 2000; i++) frame()
    ms = performance.now() - t0
    collections = await gcs.end()
    console.log(
      `water frame (9 bodies, the camera flying): ${((ms / 2000) * 1e3).toFixed(1)} µs; GC events: ${collections}`,
    )
    expect(rings.count).toBe(16)
    if (allocationChecks) expect(collections).toBe(0)
    expect(ms / 2000).toBeLessThan(budget('water/frame'))
  })
})
