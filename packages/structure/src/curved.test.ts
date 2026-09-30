import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef, Entity, World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { AmbientLight, Gpu, MaterialAsset, Materials } from '@aethervtt/shard-render'
import { compareGolden, renderView, settle } from '@aethervtt/shard-render/testing'
import { LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { Floor, Opening, StructureSettings, Wall } from './components'
import { sampleWall } from './curve'
import { brickMaterial, shadowStress } from './fixtures'
import { chunkKey } from './geometry'
import { rig } from './harness'

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** The bow of a quarter circle of radius r bulging outward, walked anticlockwise. */
const QUARTER = (r: number) => -r * (1 - Math.SQRT1_2)

/** A round brick tower: four quarter arcs, a door and a window, on a floor. */
function tower(w: World, brick: AssetRef<'Material'>, r = 4): Entity[] {
  w.spawn([
    Floor,
    {
      points: [
        [-8, -8],
        [8, -8],
        [8, 8],
        [-8, 8],
      ],
    },
  ])
  const corners: [number, number][] = [
    [r, 0],
    [0, r],
    [-r, 0],
    [0, -r],
  ]
  const walls = corners.map((a, i) =>
    w.spawn([
      Wall,
      {
        a,
        b: corners[(i + 1) % 4]!,
        shape: 'arc',
        bow: QUARTER(r),
        height: 3,
        thickness: 0.35,
        material: brick,
      },
    ]),
  )
  w.spawn([Opening, { wall: walls[0]!, kind: 'door', offset: 2.2, width: 1.2, state: 'open' }])
  w.spawn([
    Opening,
    { wall: walls[2]!, kind: 'window', offset: 2.4, width: 1.3, sill: 1, height: 1 },
  ])
  return walls
}

async function brickScene(width = 160, height = 120) {
  const r = await rig(gpu, { width, height })
  const world = r.app.world
  world.resource(AmbientLight).brightness = 2000
  const brick = brickMaterial(world)
  return { r, world, brick }
}

describe('curved walls, textured', () => {
  it('draw a round brick tower without seams, top-down and at 30°', {
    timeout: timeout(60_000),
  }, async () => {
    const { r, world, brick } = await brickScene()
    tower(world, brick)
    r.frame()
    // Every quarter arc is sampled, and all four meet the circle.
    const d = world.resource(Structure).describe()
    expect(d.curves).toHaveLength(4)
    for (const [name, eye, at] of [
      ['tower-top', [0, 14, 0.001], [0, 0, 0]],
      ['tower-30', [0, 6.5, 11], [0, 1, 0]],
    ] as const) {
      r.look([...eye], [...at])
      await settle(r.app)
      const image = await renderView(r.app, r.view)
      expect(compareGolden(here, name, image).mean, name).toBeLessThan(1.5)
    }
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('tile bricks the same on straight and curved walls', {
    timeout: timeout(60_000),
  }, async () => {
    const { r, world, brick } = await brickScene()
    world.spawn([
      Floor,
      {
        points: [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ],
      },
    ])
    world.spawn([Wall, { a: [-8, 2], b: [-2, 2], material: brick, height: 2.6, thickness: 0.3 }])
    const arc = world.spawn([
      Wall,
      { a: [0, 2], b: [6, 2], shape: 'arc', bow: -3, material: brick, height: 2.6, thickness: 0.3 },
    ])
    world.spawn([Opening, { wall: arc, kind: 'door', offset: 3.9, width: 1.2 }])
    world.spawn([
      Wall,
      {
        a: [-8, -3],
        b: [6, -3],
        shape: 'bezier',
        c0: [-4, -8],
        c1: [2, 2],
        material: brick,
        height: 2,
        thickness: 0.3,
      },
    ])
    r.look([-1, 5, 13], [-1, 1, 0])
    await settle(r.app)
    expect(compareGolden(here, 'bricks-30', await renderView(r.app, r.view)).mean).toBeLessThan(1.5)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  it('light a normal-mapped wall differently from the same wall without its normal map', {
    timeout: timeout(60_000),
  }, async () => {
    const { r, world, brick } = await brickScene(200, 130)
    world.set(r.sun, Transform, { rotation: lookAt([-8, 2, 3], [0, 1, 0]) })
    const materials = world.resource(Materials)
    const flat = materials.add(
      new MaterialAsset({ ...materials.get(brick)!.value, normalTexture: null }),
    ) as AssetRef<'Material'>
    for (const shape of ['straight', 'arc'] as const) {
      const wall = world.spawn([
        Wall,
        {
          a: [-3, 0],
          b: [3, 0],
          shape,
          bow: shape === 'arc' ? -1 : 0,
          material: brick,
          height: 3,
          thickness: 0.3,
        },
      ])
      // Close: a mortar bevel is a few pixels wide here (farther away, mips average it flat).
      r.look([0.3, 1.5, 1.1], [0, 1.5, 0])
      await settle(r.app)
      const mapped = await renderView(r.app, r.view)
      world.set(wall, Wall, { material: flat })
      await settle(r.app)
      const plain = await renderView(r.app, r.view)
      // Over the wall's pixels: the relief of the mortar lights differently from a flat face.
      // Flat brick faces barely change; the bevels into the mortar do.
      let changed = 0
      let wallPixels = 0
      for (let i = 0; i < mapped.data.length; i += 4) {
        if (plain.data[i]! < 12) continue
        wallPixels++
        if (Math.abs(mapped.data[i]! - plain.data[i]!) > 8) changed++
      }
      expect(wallPixels, shape).toBeGreaterThan(500)
      expect(changed / wallPixels, shape).toBeGreaterThan(0.03)
      world.despawn(wall)
    }
    await r.dispose()
  })
})

describe('curves too tight for their wall', () => {
  it('skip an arc under half its thickness, and draw a folding Bézier, each reported once', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const log = world.resource(LogResource)
    const tight = world.spawn([
      Wall,
      { a: [0, 0], b: [0.2, 0], shape: 'arc', bow: 0.1, thickness: 0.3 },
    ])
    r.frame()
    const state = world.resource(Structure)
    expect(state.walls.has(tight)).toBe(false)
    const err = log.errors().find((e) => e.code === 'structure/wall-too-tight')!
    expect(err.path).toBe(`/entities/${tight}/structure/Wall/bow`)
    world.set(tight, Wall, { height: 2.5 })
    r.frame()
    expect(log.errors().filter((e) => e.code === 'structure/wall-too-tight')).toHaveLength(1)
    const fold = world.spawn([
      Wall,
      { a: [4, 0], b: [4.5, 0], shape: 'bezier', c0: [8, 3], c1: [0, 3], thickness: 1.6 },
    ])
    r.frame()
    world.set(fold, Wall, { height: 2 })
    r.frame()
    expect(state.walls.has(fold)).toBe(true)
    expect(log.tail(50, 'warn').filter((e) => e.code === 'structure/wall-folds')).toHaveLength(1)
    await r.dispose()
  })
})

describe('editing a curved wall', () => {
  it('rebuilds exactly the chunks its old and new arcs overlap, in under 4 ms for a 6 m arc', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    r.host.sync(shadowStress())
    r.frame()
    const state = world.resource(Structure)
    const tolerance = world.resource(StructureSettings).curveTolerance
    const size = state.chunkSize
    const chunksOf = (a: [number, number], b: [number, number], bow: number, half: number) => {
      const l = sampleWall({ a, b, shape: 'arc', bow }, tolerance)
      const out = new Set<number>()
      for (let i = 0; i + 1 < l.count; i++) {
        const q: [number, number][] = [
          [l.x[i]! + l.nx[i]! * half, l.z[i]! + l.nz[i]! * half],
          [l.x[i + 1]! + l.nx[i + 1]! * half, l.z[i + 1]! + l.nz[i + 1]! * half],
          [l.x[i + 1]! - l.nx[i + 1]! * half, l.z[i + 1]! - l.nz[i + 1]! * half],
          [l.x[i]! - l.nx[i]! * half, l.z[i]! - l.nz[i]! * half],
        ]
        const xs = q.map((p) => p[0])
        const zs = q.map((p) => p[1])
        for (
          let cx = Math.floor(Math.min(...xs) / size);
          cx <= Math.floor(Math.max(...xs) / size);
          cx++
        )
          for (
            let cz = Math.floor(Math.min(...zs) / size);
            cz <= Math.floor(Math.max(...zs) / size);
            cz++
          )
            if (quadOverlaps(q, size, cx, cz)) out.add(chunkKey(cx, cz))
      }
      return out
    }
    const wall = world.spawn([
      Wall,
      { a: [20, 20], b: [26, 20], shape: 'arc', bow: 1.5, thickness: 0.3 },
    ])
    r.frame()
    const times: number[] = []
    let a: [number, number] = [20, 20]
    let b: [number, number] = [26, 20]
    let bow = 1.5
    for (let i = 0; i < 10; i++) {
      const next: [number, number] = [a[0] + 1.3, a[1] + 0.7]
      const nextB: [number, number] = [
        next[0] + 6 * Math.cos(i * 0.4),
        next[1] + 6 * Math.sin(i * 0.4),
      ]
      const nextBow = i % 2 === 0 ? -2 : 2.4
      world.set(wall, Wall, { a: next, b: nextB, bow: nextBow })
      r.frame()
      const expected = chunksOf(a, b, bow, 0.15)
      for (const k of chunksOf(next, nextB, nextBow, 0.15)) expected.add(k)
      // Other walls in those chunks rebuild with them; the chunks are exactly the overlap.
      expect(state.last.dirtyChunks.map(([x, z]) => chunkKey(x, z)).sort()).toEqual(
        [...expected].sort(),
      )
      times.push(state.last.ms)
      a = next
      b = nextB
      bow = nextBow
    }
    times.sort((x, y) => x - y)
    expect(times[times.length >> 1]!).toBeLessThan(budget(4))
    await r.dispose()
  })
})

/** Separating-axis overlap of a convex quad and a chunk square. */
function quadOverlaps(q: [number, number][], size: number, cx: number, cz: number): boolean {
  const square: [number, number][] = [
    [cx * size, cz * size],
    [(cx + 1) * size, cz * size],
    [(cx + 1) * size, (cz + 1) * size],
    [cx * size, (cz + 1) * size],
  ]
  const axes: [number, number][] = [
    [1, 0],
    [0, 1],
  ]
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = q[i]!
    const [x1, z1] = q[(i + 1) % 4]!
    axes.push([z0 - z1, x1 - x0])
  }
  for (const [ax, az] of axes) {
    let a0 = Infinity
    let a1 = -Infinity
    let b0 = Infinity
    let b1 = -Infinity
    for (const [x, z] of q) {
      a0 = Math.min(a0, x * ax + z * az)
      a1 = Math.max(a1, x * ax + z * az)
    }
    for (const [x, z] of square) {
      b0 = Math.min(b0, x * ax + z * az)
      b1 = Math.max(b1, x * ax + z * az)
    }
    const eps = 1e-9 * Math.hypot(ax, az)
    if (a1 <= b0 + eps || b1 <= a0 + eps) return false
  }
  return true
}
