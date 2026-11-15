import { quat, type World } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import { Camera3d } from '@aethervtt/shard-render'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { bodyBounds, MAX_WATER_BODIES, WaterBodies } from './bodies'
import { WaterBody, WaterSpline } from './components'
import { waterOptics } from './optics'
import { waterPlugin } from './plugin'
import { waterAt, waterSample } from './query'

async function app(): Promise<{ app: App; world: World }> {
  const a = new App().addPlugin(TransformPlugin, waterPlugin())
  await a.init()
  return { app: a, world: a.world }
}

const point = (x: number, y: number, z: number, width: number, flow: number, depth = 2) => ({
  position: [x, y, z] as [number, number, number],
  width,
  depth,
  flow,
})

const circle = (r: number, n = 16) =>
  Array.from({ length: n }, (_, i) =>
    point(r * Math.cos((i / n) * 2 * Math.PI), 0, r * Math.sin((i / n) * 2 * Math.PI), 0, 0),
  )

describe('rivers (0123)', () => {
  it('reports a river’s surface, flow and bed inside its banks, and dry outside', async () => {
    const { app: a, world } = await app()
    // Straight, evenly spaced, its surface falling 1 m per 100 m: Catmull-Rom is linear inside.
    world.spawn(
      [WaterBody, { kind: 'river', optics: waterOptics('river') }],
      [
        WaterSpline,
        {
          closed: false,
          points: [0, 1, 2, 3, 4].map((i) => point(i * 100, 12 - i, 0, 20, 1.5)),
        },
      ],
      Transform,
    )
    a.update(1 / 60)
    const s = waterSample()
    let seed = 5
    const rand = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed / 4294967296
    }
    for (let k = 0; k < 1000; k++) {
      const x = 100 + rand() * 200
      const z = (rand() * 2 - 1) * 9.9
      waterAt(world, [x, 11 - x / 100, z], s)
      expect(s.body).not.toBeNull()
      expect(Math.abs(s.surfaceHeight - (12 - x / 100))).toBeLessThan(0.01)
      expect(Math.abs(s.flow[0] - 1.5)).toBeLessThan(0.01)
      expect(Math.abs(s.flow[2])).toBeLessThan(0.01)
      // No terrain: the bed is the surface less the depth.
      expect(s.groundHeight).toBeCloseTo(s.surfaceHeight - 2, 6)
      expect(s.underwater).toBe(true)
      waterAt(world, [x, 0, 10.5 + rand() * 20], s)
      expect(s.body).toBeNull()
    }
    expect(world.resource(LogResource).tail(50, 'warn')).toEqual([])
    await a.dispose()
  })

  it('meets the lake it runs into at the lake’s level, with no step, its flow fading out', async () => {
    const { app: a, world } = await app()
    world.spawn(
      [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
      [WaterSpline, { points: circle(60) }],
      [Transform, { translation: [0, 4, 0] }],
    )
    world.spawn(
      [WaterBody, { kind: 'river', optics: waterOptics('river'), priority: 1 }],
      [
        WaterSpline,
        {
          closed: false,
          points: [
            point(-300, 9, 0, 16, 1.2),
            point(-150, 7, 0, 16, 1.2),
            point(-30, 5, 0, 16, 1.2),
          ],
        },
      ],
      Transform,
    )
    a.update(1 / 60)
    const s = waterSample()
    let last = Number.NaN
    let lastBody = s.body
    let handovers = 0
    for (let x = -200; x <= 0; x += 0.5) {
      waterAt(world, [x, 0, 0], s)
      expect(s.body).not.toBeNull()
      if (!Number.isNaN(last)) {
        const step = Math.abs(s.surfaceHeight - last)
        // Smooth along the river (the 16 m blend is the steepest part), and no step at the handover.
        expect(step).toBeLessThan(0.08)
        if (s.body !== lastBody) {
          handovers++
          expect(step).toBeLessThan(0.01)
        }
      }
      last = s.surfaceHeight
      lastBody = s.body
    }
    expect(handovers).toBe(1)
    // At the river's end: the lake's level and no flow.
    waterAt(world, [-30.01, 0, 0], s)
    expect(s.surfaceHeight).toBeCloseTo(4, 3)
    expect(Math.abs(s.flow[0])).toBeLessThan(1e-3)
    // Upstream of the blend: the river's own.
    waterAt(world, [-150, 0, 0], s)
    expect(s.surfaceHeight).toBeCloseTo(7, 3)
    expect(s.flow[0]).toBeCloseTo(1.2, 3)
    await a.dispose()
  })

  it('draws the 64 lakes nearest the camera, and waterAt finds all 300 without one', async () => {
    const { app: a, world } = await app()
    const lakes: [number, number][] = []
    for (let i = 0; i < 300; i++) {
      const x = (i % 20) * 1000 + 300
      const z = Math.floor(i / 20) * 1000 + 300
      lakes.push([x, z])
      world.spawn(
        [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
        [WaterSpline, { points: circle(20, 8) }],
        [Transform, { translation: [x, 2, z] }],
      )
    }
    a.update(1 / 60)
    const state = world.resource(WaterBodies)
    expect(state.all.length).toBe(300)
    expect(state.count).toBe(MAX_WATER_BODIES)
    const s = waterSample()
    // Without a camera: every lake, found where it is.
    for (const [x, z] of lakes) {
      waterAt(world, [x, 0, z], s)
      expect(s.surfaceHeight).toBe(2)
    }
    const chosen = (cx: number, cz: number) => {
      const distance = (r: (typeof state.all)[number]) => {
        const b = bodyBounds(r)!
        const dx = Math.max(b[0]! - cx, 0, cx - b[2]!)
        const dz = Math.max(b[1]! - cz, 0, cz - b[3]!)
        return Math.sqrt(dx * dx + dz * dz)
      }
      const drawn = new Set(state.sorted.slice(0, state.count))
      let far = 0
      let near = Infinity
      for (const r of state.all) {
        if (drawn.has(r)) far = Math.max(far, distance(r))
        else near = Math.min(near, distance(r))
      }
      // Every drawn lake is at least as near as every one left out, and still in priority order.
      expect(far).toBeLessThanOrEqual(near)
      for (let i = 1; i < state.count; i++)
        expect(state.all.indexOf(state.sorted[i]!)).toBeGreaterThan(
          state.all.indexOf(state.sorted[i - 1]!),
        )
      return drawn
    }
    const camera = world.spawn(
      [Camera3d, {}],
      [
        Transform,
        { translation: [0, 50, 0], rotation: quat.fromEuler([0, 0, 0, 1], -0.5, 0, 0) as never },
      ],
    )
    a.update(1 / 60)
    const first = chosen(0, 0)
    world.set(camera, Transform, {
      ...world.get(camera, Transform),
      translation: [10_000, 50, 10_000],
    })
    a.update(1 / 60)
    const second = chosen(10_000, 10_000)
    expect([...first].filter((r) => second.has(r)).length).toBeLessThan(10)
    // And it costs the same with 300 bodies: a lookup in their grid.
    const t0 = performance.now()
    let n = 0
    for (let k = 0; k < 20_000; k++) {
      const [x, z] = lakes[k % 300]!
      waterAt(world, [x + (k % 7), 0, z - (k % 5)], s)
      n++
    }
    expect((performance.now() - t0) / n).toBeLessThan(budget('water/at'))
    await a.dispose()
  })

  it('reports a closed or short river spline as water/bad-spline', async () => {
    const { app: a, world } = await app()
    world.spawn(
      [WaterBody, { kind: 'river' }],
      [WaterSpline, { closed: true, points: circle(30) }],
      Transform,
    )
    world.spawn(
      [WaterBody, { kind: 'river' }],
      [WaterSpline, { closed: false, points: [point(0, 0, 0, 10, 1)] }],
      Transform,
    )
    a.update(1 / 60)
    const codes = world
      .resource(LogResource)
      .tail(50, 'error')
      .map((e) => e.code)
    expect(codes.filter((c) => c === 'water/bad-spline')).toHaveLength(2)
    expect(world.resource(WaterBodies).all).toHaveLength(0)
    await a.dispose()
  })
})
