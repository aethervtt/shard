import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Entity } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Cameras,
  Culler,
  ForwardStateResource,
  Gpu,
  type PickHit,
  pick,
  RenderStats,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, renderView, settle } from '@aethervtt/shard-render/testing'
import { type App, animationFrameRunner, Time } from '@aethervtt/shard-runtime'
import { fakeAnimationFrames } from '@aethervtt/shard-runtime/testing'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { DoorLeaf, Floor, Opening, StructureChunk, Wall } from './components'
import { maxScene, type SceneDocs, shadowStress } from './fixtures'
import { chunkKey, chunkX, chunkZ } from './geometry'
import { type Rig, rig } from './harness'

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** Bytes one instance slot writes: its 64-byte record and its 48-byte previous transform. */
const SLOT_BYTES = 64 + 48

const grid = (): SceneDocs['grid'] => ({
  type: 'square',
  hexOrientation: 'pointy',
  size: 70,
  offset: { x: 0, y: 0 },
  distance: 5,
  unit: 'ft',
  diagonal: 'euclidean',
})

function empty(): SceneDocs {
  return { grid: grid(), materials: [], walls: [], openings: [], floors: [], props: [], tokens: [] }
}

/** Frames until nothing is compiling, loading or catching up (a still scene). */
async function still(r: Rig): Promise<void> {
  await settle(r.app)
  for (let i = 0; i < 4; i++) r.frame()
}

/** Separating-axis overlap of a wall's footprint and a chunk square (the reference test). */
function overlaps(
  a: [number, number],
  b: [number, number],
  half: number,
  size: number,
  cx: number,
  cz: number,
): boolean {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1])
  const dx = (b[0] - a[0]) / len
  const dz = (b[1] - a[1]) / len
  const corners: [number, number][] = []
  for (const s of [0, len])
    for (const t of [-half, half]) corners.push([a[0] + dx * s - dz * t, a[1] + dz * s + dx * t])
  const square: [number, number][] = [
    [cx * size, cz * size],
    [(cx + 1) * size, cz * size],
    [(cx + 1) * size, (cz + 1) * size],
    [cx * size, (cz + 1) * size],
  ]
  for (const [ax, az] of [
    [1, 0],
    [0, 1],
    [dx, dz],
    [-dz, dx],
  ] as const) {
    const project = (pts: [number, number][]) => {
      let lo = Infinity
      let hi = -Infinity
      for (const [x, z] of pts) {
        lo = Math.min(lo, x * ax + z * az)
        hi = Math.max(hi, x * ax + z * az)
      }
      return [lo, hi]
    }
    const [a0, a1] = project(corners) as [number, number]
    const [b0, b1] = project(square) as [number, number]
    if (a1 <= b0 + 1e-9 || b1 <= a0 + 1e-9) return false
  }
  return true
}

function referenceChunks(
  a: [number, number],
  b: [number, number],
  half: number,
  size: number,
): Set<number> {
  const out = new Set<number>()
  const x0 = Math.floor((Math.min(a[0], b[0]) - half) / size) - 1
  const x1 = Math.floor((Math.max(a[0], b[0]) + half) / size) + 1
  const z0 = Math.floor((Math.min(a[1], b[1]) - half) / size) - 1
  const z1 = Math.floor((Math.max(a[1], b[1]) + half) / size) + 1
  for (let cx = x0; cx <= x1; cx++)
    for (let cz = z0; cz <= z1; cz++)
      if (overlaps(a, b, half, size, cx, cz)) out.add(chunkKey(cx, cz))
  return out
}

async function resolvePick(
  app: App,
  request: Promise<PickHit | undefined>,
): Promise<PickHit | undefined> {
  let done = false
  const result = request.finally(() => {
    done = true
  })
  for (let i = 0; i < 60 && !done; i++) {
    app.update(1 / 60)
    await app.world.resource(Gpu).pipelines.whenIdle()
    await new Promise((r) => setTimeout(r, 0))
  }
  return result
}

describe('structure on the shadow-stress fixture', () => {
  it('a token move writes one instance slot, and no other scene bytes', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu)
    const docs = shadowStress()
    r.host.sync(docs)
    r.look([10, 30, 30], [10, 0, 8])
    await still(r)
    const stats = r.app.world.resource(RenderStats)
    expect(stats.lastFrame.sceneBytes).toBe(0)
    const token = docs.tokens[0]!
    docs.tokens[0] = { ...token, rev: token.rev + 1, x: token.x + 70 }
    expect(r.host.sync(docs)).toMatchObject({ applied: 1, spawned: 0, removed: 0 })
    r.frame()
    expect(stats.lastFrame.bytes.instances).toBe(SLOT_BYTES)
    expect(stats.lastFrame.sceneBytes).toBe(SLOT_BYTES)
    expect(stats.lastFrame.chunksRebuilt).toBe(0)
    await r.dispose()
  })

  it('a door toggle rebuilds no chunk; each frame of its swing writes only the leaf', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu)
    const docs = shadowStress()
    r.host.sync(docs)
    await still(r)
    const world = r.app.world
    const stats = world.resource(RenderStats)
    const rebuiltBefore = world.resource(Structure).chunksRebuilt
    const door = docs.openings[0]!
    docs.openings[0] = { ...door, rev: door.rev + 1, state: 'open' }
    r.host.sync(docs)
    const leaf = world
      .query({ with: [DoorLeaf] })
      .entities()
      .find((e) => world.get(e, DoorLeaf).opening === r.host.openings.entity(door.id))!
    let frames = 0
    for (let i = 0; i < 40 && world.get(leaf, DoorLeaf).angle < 1; i++) {
      r.frame()
      frames++
      expect(stats.lastFrame.chunksRebuilt, `frame ${i}`).toBe(0)
      expect(stats.lastFrame.bytes.instances, `frame ${i}`).toBe(SLOT_BYTES)
      expect(stats.lastFrame.sceneBytes, `frame ${i}`).toBe(SLOT_BYTES)
    }
    // 250 ms at 60 fps.
    expect(frames).toBe(15)
    expect(world.get(leaf, DoorLeaf).angle).toBe(1)
    expect(world.resource(Structure).chunksRebuilt).toBe(rebuiltBefore)
    await r.dispose()
  })

  it('a wall edit rebuilds exactly the chunks its old and new geometry overlap', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const docs = shadowStress()
    r.host.sync(docs)
    r.frame()
    const k = r.host.k
    const state = r.app.world.resource(Structure)
    const times: number[] = []
    for (let i = 0; i < 12; i++) {
      const index = 100 + i * 211
      const old = docs.walls[index]!
      // A typical 3 m wall, somewhere new.
      const ax = old.a.x + 35 + i * 3
      const ay = old.a.y + 20
      const angle = i * 0.61
      const bx = ax + (Math.cos(angle) * 3) / k
      const by = ay + (Math.sin(angle) * 3) / k
      docs.walls[index] = { ...old, rev: old.rev + 1, a: { x: ax, y: ay }, b: { x: bx, y: by } }
      r.host.sync(docs)
      r.frame()
      const half = (old.thickness * k) / 2
      const expected = referenceChunks(
        [old.a.x * k, old.a.y * k],
        [old.b.x * k, old.b.y * k],
        half,
        8,
      )
      for (const key of referenceChunks([ax * k, ay * k], [bx * k, by * k], half, 8))
        expected.add(key)
      const rebuilt = new Set(state.last.dirtyChunks.map(([x, z]) => chunkKey(x, z)))
      expect([...rebuilt].sort(), `edit ${i}`).toEqual([...expected].sort())
      times.push(state.last.ms)
    }
    times.sort((a, b) => a - b)
    expect(times[times.length >> 1]!).toBeLessThan(budget(4))
    await r.dispose()
  })

  it('an unrelated host update writes no scene bytes and renders no frame on demand', {
    timeout: timeout(60_000),
  }, async () => {
    const fake = fakeAnimationFrames()
    try {
      const r = await rig(gpu)
      const docs = shadowStress()
      r.host.sync(docs)
      await still(r)
      const world = r.app.world
      r.app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
      const running = r.app.run()
      for (let i = 0; i < 100 && fake.pending === 0; i++) await Promise.resolve()
      fake.runUntilIdle()
      // A Chat message: the host re-syncs every list, and nothing in them changed.
      const counts = r.host.sync(docs)
      expect(counts).toEqual({ spawned: 0, applied: 0, removed: 0, resized: 0 })
      const before = world.resource(Time).frame
      expect(fake.runUntilIdle()).toBe(0)
      expect(world.resource(Time).frame).toBe(before)
      await r.app.dispose()
      await running
      r.target.destroy()
    } finally {
      fake.restore()
    }
  })

  it('with on-change shadows, a still frame draws no shadow map; a token move only its cascades', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadowUpdate: 'on-change' })
    const docs = shadowStress()
    r.host.sync(docs)
    r.look([10, 20, 24], [10, 0, 8])
    const world = r.app.world
    await still(r)
    const stats = world.resource(RenderStats)
    r.frame()
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    // The cascades whose cull volume holds the token, before or after the move.
    const token = docs.tokens[5]!
    const root = r.host.tokens.entity(token.id)!
    const disc = r.host.discs.get(root)!
    const before = world.get(disc, GlobalTransform).matrix.slice()
    docs.tokens[5] = { ...token, rev: token.rev + 1, y: token.y + 35 }
    r.host.sync(docs)
    r.frame()
    const after = world.get(disc, GlobalTransform).matrix
    const { views } = forwardCascades(world, r.view)
    let containing = 0
    for (const v of views) {
      if (inPlanes(v.cullPlanes, before) || inPlanes(v.cullPlanes, after)) containing++
    }
    expect(containing).toBeGreaterThan(0)
    expect(containing).toBeLessThan(views.length)
    expect(stats.lastFrame.shadowMapsRendered).toBe(containing)
    r.frame()
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    await r.dispose()
  })
})

/** The camera's cascade views (fitted this frame). */
function forwardCascades(world: App['world'], view: string) {
  const cascades = world.resource(ForwardStateResource).views.get(view)!.cascades
  return { views: cascades.views.slice(0, cascades.count) }
}

/** Whether a token disc (unit cylinder through its world matrix) touches six half-spaces. */
function inPlanes(planes: Float32Array, m: ArrayLike<number>): boolean {
  // Row-major affine rows: translation in 3, 7, 11; the disc's radius is its x scale / 2.
  const x = m[3]!
  const y = m[7]!
  const z = m[11]!
  const r = Math.hypot(m[0]!, m[4]!, m[8]!) * 0.75
  for (let p = 0; p < 24; p += 4)
    if (planes[p]! * x + planes[p + 1]! * y + planes[p + 2]! * z + planes[p + 3]! < -r) return false
  return true
}

describe('chunk clipping on screen', () => {
  it('draws the endpoint of a wall spanning 10 chunks whose midpoint is off screen', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { width: 96, height: 64, shadows: false })
    const world = r.app.world
    world.resource(Culler).enabled = false
    world.spawn([Wall, { a: [0.5, 4], b: [79.5, 4], height: 3, thickness: 0.4 }])
    r.frame()
    const state = world.resource(Structure)
    expect(state.chunks.size).toBe(10)
    // Looking at the far end from just past it: the midpoint (x = 40) is behind the camera's view.
    r.look([84, 6, 12], [78, 1.5, 4])
    const image = await renderView(r.app, r.view)
    r.frame()
    const stats = world.resource(RenderStats).get(r.view)!
    expect(stats.drawCalls).toBeGreaterThan(0)
    expect(stats.visible).toBeLessThan(10)
    let wall = 0
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) if (pixel(image, x, y)[0]! > 20) wall++
    expect(wall).toBeGreaterThan(200)
    expect(compareGolden(here, 'long-wall-endpoint', image).mean).toBeLessThan(1.5)
    await r.dispose()
  })

  it('a 60 m concave floor shows no gap at chunk seams, top-down and at 30°', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { width: 160, height: 96, shadows: false, orthoHeight: 48 })
    const world = r.app.world
    // A comb: a 60 m bar with deep notches that cross chunk boundaries.
    const points: [number, number][] = [
      [0, 0],
      [60, 0],
      [60, 40],
    ]
    for (let i = 12; i > 0; i--) {
      const x = i * 5
      const top = i % 2 === 0 ? 40 : 6
      points.push([x, top], [x - 5, top])
    }
    world.spawn([Floor, { points, elevation: 0 }])
    r.frame()
    expect(world.resource(Structure).chunks.size).toBeGreaterThan(20)
    r.look([30, 50, 20.001], [30, 0, 20])
    const top = await renderView(r.app, r.view)
    // Every pixel whose centre is well inside the comb is floor: no seam shows the clear colour.
    const cam = world.resource(Cameras).get(r.camera)!
    const scale = cam.orthoHeight / top.height
    let checked = 0
    for (let py = 0; py < top.height; py++) {
      for (let px = 0; px < top.width; px++) {
        const x = 30 + (px + 0.5 - top.width / 2) * scale
        const z = 20 + (py + 0.5 - top.height / 2) * scale
        if (!insideComb(points, x, z, scale * 1.5)) continue
        checked++
        expect(pixel(top, px, py)[0], `pixel ${px},${py}`).toBeGreaterThan(20)
      }
    }
    expect(checked).toBeGreaterThan(3000)
    expect(compareGolden(here, 'comb-floor-top', top).mean).toBeLessThan(1.5)
    r.look([30, 22, 58], [30, 0, 20])
    const oblique = await renderView(r.app, r.view)
    expect(compareGolden(here, 'comb-floor-30', oblique).mean).toBeLessThan(1.5)
    await r.dispose()
  })
})

/** Point-in-polygon, `margin` away from every edge. */
function insideComb(points: [number, number][], x: number, z: number, margin: number): boolean {
  let inside = false
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, zi] = points[i]!
    const [xj, zj] = points[j]!
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside
    const ex = xj - xi
    const ez = zj - zi
    const t = Math.max(0, Math.min(1, ((x - xi) * ex + (z - zi) * ez) / (ex * ex + ez * ez)))
    if (Math.hypot(x - (xi + ex * t), z - (zi + ez * t)) < margin) return false
  }
  return inside
}

describe('the grid and the host', () => {
  it("changing the grid's distance, unit or diagonal changes nothing drawn", {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const docs = shadowStress()
    r.host.sync(docs)
    r.look([6, 12, 14], [6, 0, 4])
    const world = r.app.world
    await still(r)
    const image = await renderView(r.app, r.view)
    const transforms = world
      .query({ with: [Transform] })
      .entities()
      .map((e) => world.get(e, Transform))
    const versions = world
      .query({ with: [StructureChunk] })
      .entities()
      .map((e) => world.get(e, StructureChunk))
    const rebuilt = world.resource(Structure).chunksRebuilt
    const relabelled = {
      ...docs,
      grid: { ...docs.grid, distance: 1.5, unit: 'm', diagonal: 'alternating' as const },
    }
    expect(r.host.sync(relabelled)).toEqual({ spawned: 0, applied: 0, removed: 0, resized: 0 })
    r.frame()
    expect(world.resource(Structure).chunksRebuilt).toBe(rebuilt)
    expect(
      world
        .query({ with: [Transform] })
        .entities()
        .map((e) => world.get(e, Transform)),
    ).toEqual(transforms)
    expect(
      world
        .query({ with: [StructureChunk] })
        .entities()
        .map((e) => world.get(e, StructureChunk)),
    ).toEqual(versions)
    const again = await renderView(r.app, r.view)
    expect(Buffer.from(again.data).equals(Buffer.from(image.data))).toBe(true)
    await r.dispose()
  })

  it("doubling the grid's size doubles cell-sized footprints and moves nothing", {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const docs = shadowStress()
    r.host.sync(docs)
    r.frame()
    const world = r.app.world
    const snapshot = () => ({
      walls: world
        .query({ with: [Wall] })
        .entities()
        .map((e) => world.get(e, Wall)),
      openings: world
        .query({ with: [Opening] })
        .entities()
        .map((e) => world.get(e, Opening)),
      floors: world
        .query({ with: [Floor] })
        .entities()
        .map((e) => world.get(e, Floor)),
      tokens: docs.tokens.map((t) => {
        const root = r.host.tokens.entity(t.id)!
        return {
          at: world.get(root, Transform).translation,
          footprint: world.get(r.host.discs.get(root)!, Transform).scale[0],
        }
      }),
      props: docs.props.map((p) => world.get(r.host.props.entity(p.id)!, Transform)),
    })
    const before = snapshot()
    const counts = r.host.sync({ ...docs, grid: { ...docs.grid, size: 140 } })
    expect(counts.resized).toBe(docs.tokens.length + docs.props.length)
    r.frame()
    const after = snapshot()
    expect(after.walls).toEqual(before.walls)
    expect(after.openings).toEqual(before.openings)
    expect(after.floors).toEqual(before.floors)
    for (let i = 0; i < docs.tokens.length; i++) {
      expect(after.tokens[i]!.at).toEqual(before.tokens[i]!.at)
      expect(after.tokens[i]!.footprint).toBeCloseTo(before.tokens[i]!.footprint! * 2, 5)
    }
    for (let i = 0; i < docs.props.length; i++) {
      const a = after.props[i]!
      const b = before.props[i]!
      // Props are centred on their document's position; a per-cell prop doubles in size (and sits
      // on the floor, so its centre rises with it).
      expect([a.translation[0], a.translation[2]]).toEqual([b.translation[0], b.translation[2]])
      expect(a.scale[0]).toBeCloseTo(b.scale[0]! * 2, 5)
    }
    await r.dispose()
  })

  it("resolves a pick on a token's visual child to the token's host id", {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { width: 64, height: 64, shadows: false, orthoHeight: 6 })
    const docs = empty()
    docs.tokens.push({ id: 'token-gm-7', rev: 0, name: 'Hero', x: 700, y: 350, size: 1 })
    r.host.sync(docs)
    const k = r.host.k
    r.look([700 * k, 10, 350 * k + 0.001], [700 * k, 0, 350 * k])
    await settle(r.app)
    const hit = await resolvePick(r.app, pick(r.app.world, r.camera, 32, 32))
    expect(hit).toBeDefined()
    const root = r.host.tokens.entity('token-gm-7')!
    expect(hit!.entity).toBe(r.host.discs.get(root))
    expect(hit!.entity).not.toBe(root)
    expect(r.host.tokens.keyOf(hit!.entity as Entity)).toBe('token-gm-7')
    await r.dispose()
  })
})

describe('the max fixture', () => {
  it('builds from nothing in under 300 ms', { timeout: timeout(120_000) }, async () => {
    const r = await rig(gpu, { shadows: false })
    const docs = maxScene()
    const times: number[] = []
    for (let i = 0; i < 4; i++) {
      const t0 = performance.now()
      r.host.sync(docs)
      r.frame()
      times.push(performance.now() - t0)
      r.host.sync(empty())
      r.frame()
    }
    const state = r.app.world.resource(Structure)
    expect(state.walls.size + state.slabs.size).toBe(0)
    // The first build warms V8 and the pipeline caches; the rest are what a scene load costs.
    times.shift()
    times.sort((a, b) => a - b)
    expect(times[0]!).toBeLessThan(budget(300))
    await r.dispose()
  })

  it('spawning and despawning it 20 times leaves gpu.stats at its baseline', {
    timeout: timeout(300_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const owner = world.resource(Gpu).owner
    const docs = maxScene()
    const cycle = async () => {
      r.host.sync(docs)
      await settle(r.app, 3)
      r.host.sync(empty())
      for (let i = 0; i < 3; i++) r.frame()
    }
    // One cycle warms the pools that stay (instance and cull buffers, the leaf and prop meshes).
    await cycle()
    const baseline = gpu.stats(owner)
    for (let i = 0; i < 20; i++) await cycle()
    expect(gpu.stats(owner)).toEqual(baseline)
    expect(world.query({ with: [StructureChunk] }).count()).toBe(0)
    await r.dispose()
  })

  it('compiles nothing and allocates nothing on a frame where nothing changed', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    r.host.sync(maxScene())
    r.frame()
    const world = r.app.world
    const state = world.resource(Structure)
    const compiles = state.compiles
    const system = (await import('./compile')).compileStructure
    const local = system.setup!(world)
    for (let i = 0; i < 200; i++) {
      world.incrementTick()
      system.run(local, world, { lastRunTick: world.tick - 1, thisRunTick: world.tick } as never)
    }
    if (allocationChecks) {
      globalThis.gc?.()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const window = gcWindow()
      for (let i = 0; i < 2000; i++) {
        world.incrementTick()
        system.run(local, world, { lastRunTick: world.tick - 1, thisRunTick: world.tick } as never)
      }
      expect(await window.end()).toBe(0)
    }
    expect(state.compiles).toBe(compiles)
    await r.dispose()
  })
})

// Chunk key helpers stay consistent with what describe reports.
it('chunk keys round-trip', () => {
  for (const [x, z] of [
    [0, 0],
    [-3, 7],
    [120, -45],
  ] as const) {
    expect([chunkX(chunkKey(x, z)), chunkZ(chunkKey(x, z))]).toEqual([x, z])
  }
})
