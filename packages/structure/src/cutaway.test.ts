import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type AssetRef, Children, type Entity } from '@aethervtt/shard-core'
import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Cutaway,
  CutawayView,
  captureShadowMap,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  pick,
  RenderStats,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, renderView, settle } from '@aethervtt/shard-render/testing'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { Cutout, DoorLeaf, Floor, Opening, Roof, StructureSettings, Wall } from './components'
import { maxScene } from './fixtures'
import { type Rig, rig } from './harness'

// Cutaway roofs and walls (0070).

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

type World = Rig['app']['world']

const square = (x: number, z: number, w: number, d = w): [number, number][] => [
  [x, z],
  [x + w, z],
  [x + w, z + d],
  [x, z + d],
]

/** Four walls and a floor, `size` metres from (x, z); the first wall has a door, the second a window. */
function room(world: World, x: number, z: number, size: number, material?: AssetRef<'Material'>) {
  const c = square(x, z, size)
  const walls = c.map((a, i) =>
    world.spawn([
      Wall,
      { a, b: c[(i + 1) % 4]!, height: 2.8, thickness: 0.2, ...(material ? { material } : {}) },
    ]),
  )
  const door = world.spawn([
    Opening,
    { wall: walls[0]!, kind: 'door', offset: 1, width: 1, height: 2.1 },
  ])
  const window = world.spawn([
    Opening,
    { wall: walls[1]!, kind: 'window', offset: 2, width: 1.2, height: 1, sill: 1 },
  ])
  const floor = world.spawn([Floor, { points: c, thickness: 0, ...(material ? { material } : {}) }])
  return { walls, door, window, floor }
}

/** The meshes structure keeps under a group or piece: chunk meshes, leaves and panes. */
function meshesUnder(world: World, group: Entity): Entity[] {
  return (world.tryGet(group, Children)?.entities ?? []).filter(
    (e): e is Entity => e !== null && world.has(e, Mesh3d),
  )
}

function color(world: World, c: [number, number, number]): AssetRef<'Material'> {
  return world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [...c, 1], roughness: 1 })) as never
}

const leafOf = (world: World, opening: Entity) =>
  world
    .query({ with: [DoorLeaf] })
    .entities()
    .find((e) => world.get(e, DoorLeaf).opening === opening)

describe('Roof.cutaway', () => {
  it('tags its chunk meshes, hatches and skylights; a toggle rebuilds nothing', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    room(world, 0, 0, 10)
    const roof = world.spawn([Roof, { points: square(-0.5, -0.5, 11), height: 2.8 }])
    const skylight = world.spawn([
      Cutout,
      { host: roof, points: square(4, 4, 2), kind: 'skylight', frameWidth: 0.06 },
    ])
    r.frame()
    const meshes = meshesUnder(world, roof)
    expect(meshes.length).toBeGreaterThan(2)
    expect(meshes.some((e) => world.has(e, Cutaway))).toBe(false)
    const state = world.resource(Structure)
    const rebuilt = state.chunksRebuilt
    world.set(roof, Roof, { cutaway: true })
    r.frame()
    expect(meshesUnder(world, roof).every((e) => world.has(e, Cutaway))).toBe(true)
    expect(world.has(leafOf(world, skylight)!, Cutaway)).toBe(true)
    expect(state.chunksRebuilt).toBe(rebuilt)
    // Walls and floors under it are untouched.
    for (const e of world.query({ with: [Mesh3d, Cutaway] }).entities())
      expect(meshes.includes(e) || e === leafOf(world, skylight)).toBe(true)
    // A roof edit rebuilds its chunks: they come back tagged.
    world.set(roof, Roof, { height: 2.9 })
    r.frame()
    expect(state.chunksRebuilt).toBeGreaterThan(rebuilt)
    expect(meshesUnder(world, roof).every((e) => world.has(e, Cutaway))).toBe(true)
    world.set(roof, Roof, { cutaway: false })
    r.frame()
    expect(world.query({ with: [Cutaway] }).count()).toBe(0)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})

describe('StructureSettings.cutawayWalls', () => {
  it('splits wall pieces from floors of the same material and tags them, doors and windows too; off merges them back', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await rig(gpu, { shadows: false })
    const world = r.app.world
    const stone = color(world, [0.6, 0.6, 0.6])
    const { door, window, floor } = room(world, 1, 1, 6, stone)
    r.frame()
    const state = world.resource(Structure)
    const chunkMeshes = () => {
      let n = 0
      for (const c of state.chunks.values()) n += c.meshes.size
      return n
    }
    const merged = chunkMeshes()
    const floorArea = () =>
      world
        .query({ with: [Mesh3d] })
        .entities()
        .filter((e) => !world.has(e, Cutaway) && !world.has(e, DoorLeaf)).length
    world.patchResource(StructureSettings, { cutawayWalls: true } as never)
    r.frame()
    expect(state.last.chunksRebuilt).toBeGreaterThan(0)
    // Every chunk with walls gains a wall mesh per material, apart from the floor's.
    expect(chunkMeshes()).toBeGreaterThan(merged)
    const tagged = world.query({ with: [Mesh3d, Cutaway] }).entities()
    expect(tagged.length).toBeGreaterThan(2)
    expect(world.has(leafOf(world, door)!, Cutaway)).toBe(true)
    expect(world.has(leafOf(world, window)!, Cutaway)).toBe(true)
    // The floor draws in meshes of its own, never cut.
    expect(floorArea()).toBeGreaterThan(0)
    for (const c of state.chunks.values())
      for (const [key, cm] of c.meshes)
        expect(world.has(cm.entity, Cutaway)).toBe(key.startsWith('#wall/'))
    // A wall edit keeps them apart.
    world.set(state.walls.keys().next().value!, Wall, { height: 3 })
    r.frame()
    expect(world.query({ with: [Mesh3d, Cutaway] }).count()).toBe(tagged.length)
    world.patchResource(StructureSettings, { cutawayWalls: false } as never)
    r.frame()
    expect(chunkMeshes()).toBe(merged)
    expect(world.query({ with: [Cutaway] }).count()).toBe(0)
    expect(world.isAlive(floor)).toBe(true)
    expect(world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})

describe('a cutaway roof over a token', () => {
  /** A 10 m room, a cutaway roof over it, and a token in it; the camera reveals the token. */
  async function scene(view: 'top' | '30') {
    const r = await rig(gpu, {
      width: 96,
      height: 96,
      ...(view === 'top' ? { orthoHeight: 14 } : {}),
    })
    const world = r.app.world
    Object.assign(world.resource(AmbientLight), { brightness: 1500 })
    room(world, 0, 0, 10, color(world, [0.75, 0.7, 0.6]))
    const roof = world.spawn([
      Roof,
      {
        points: square(-0.5, -0.5, 11),
        height: 2.8,
        cutaway: true,
        material: color(world, [0.8, 0.15, 0.1]),
      },
    ])
    const token = world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 0.6, y: 1.2, z: 0.6 })) }],
      [MeshMaterial, { material: color(world, [0.1, 0.2, 0.9]) }],
      [Transform, { translation: [5, 0.6, 5] }],
    )
    if (view === 'top') r.look([5, 30, 5.001], [5, 0, 5])
    else r.look([5, 0.5 + 18 * Math.sin(Math.PI / 6), 5 + 18 * Math.cos(Math.PI / 6)], [5, 0.6, 5])
    world.add(r.camera, CutawayView, { points: [[5, 0.6, 5]], radius: 2, margin: 0.6, edge: 0.3 })
    await settle(r.app)
    for (let i = 0; i < 4; i++) r.frame()
    return { r, world, roof, token }
  }

  const screen = (world: World, camera: Entity, p: [number, number, number]) => {
    const out = [0, 0]
    worldToScreen(world, camera, p, out)
    return out as [number, number]
  }
  const isRed = (p: ArrayLike<number>) => p[0]! > p[1]! * 1.3 && p[0]! > p[2]! * 1.3
  const isBlue = (p: ArrayLike<number>) => p[2]! > p[0]! * 1.3 && p[2]! > p[1]! * 1.1

  for (const view of ['top', '30'] as const) {
    it(`shows the token through the roof (${view === 'top' ? 'from above' : 'at 30°'}), keeps the floor, and casts as before`, {
      timeout: timeout(60_000),
    }, async () => {
      const { r, world, roof, token } = await scene(view)
      const image = await renderView(r.app, r.view)
      expect(world.resource(Gpu).errors).toEqual([])
      // The token's top from above, its front face at 30°.
      const [tx, ty] = screen(world, r.camera, view === 'top' ? [5, 1.2, 5] : [5, 0.6, 5.3])
      expect(isBlue(pixel(image, Math.floor(tx), Math.floor(ty)))).toBe(true)
      // The roof stays away from the token.
      const [rx, ry] = screen(world, r.camera, [0.5, 2.8, 5])
      expect(isRed(pixel(image, Math.floor(rx), Math.floor(ry)))).toBe(true)
      // The floor in the hole draws (floors aren't Cutaway).
      const [fx, fy] = screen(world, r.camera, [6.2, 0, 5])
      const f = pixel(image, Math.floor(fx), Math.floor(fy))
      expect(f[0]! + f[1]! + f[2]!).toBeGreaterThan(30)
      expect(isRed(f)).toBe(false)
      expect(compareGolden(here, `cutaway-roof-${view}`, image).mean).toBeLessThan(1.5)
      // The shadow map is the same as with the roof whole: the room stays as dark.
      const cut = await captureShadowMap(world, r.sun, 0, r.camera)
      world.set(r.camera, CutawayView, { points: [] })
      await settle(r.app, 4)
      const whole = await captureShadowMap(world, r.sun, 0, r.camera)
      expect(Buffer.from(cut.data).equals(Buffer.from(whole.data))).toBe(true)
      // A pick through the hole reaches the token.
      world.set(r.camera, CutawayView, { points: [[5, 0.6, 5]] })
      await settle(r.app, 4)
      const hit = pick(world, r.camera, tx, ty)
      for (let i = 0; i < 30; i++) {
        r.frame()
        await world.resource(Gpu).pipelines.whenIdle()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect((await hit)?.entity).toBe(token)
      expect(world.isAlive(roof)).toBe(true)
      await r.dispose()
    })
  }
})

describe('the max fixture', () => {
  it('with 16 reveal points and cutaway walls, a frame costs at most 5% more GPU time than with none', {
    timeout: timeout(300_000),
  }, async () => {
    const r = await rig(gpu, { width: 1280, height: 720, shadows: true })
    const world = r.app.world
    r.host.sync(maxScene())
    world.patchResource(StructureSettings, { cutawayWalls: true } as never)
    // A tilted map view over a block of rooms, as a VTT shows it.
    r.look([30, 28, 48], [30, 0, 22])
    const points: [number, number, number][] = []
    for (let i = 0; i < 16; i++) points.push([18 + (i % 4) * 8, 0.8, 12 + Math.floor(i / 4) * 7])
    world.add(r.camera, CutawayView, { points: [], radius: 2.5, margin: 0.6, edge: 0.3 })
    await settle(r.app)
    // GPU time: from the frame's submit to the queue going idle (its CPU work is done by then).
    const frameMs = async (n: number) => {
      const times: number[] = []
      for (let i = 0; i < n; i++) {
        r.frame()
        const t0 = performance.now()
        await gpu.device.queue.onSubmittedWorkDone()
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      return times[times.length >> 1]!
    }
    // Interleaved rounds, compared within each: a laptop's clocks drift more than 5% over a run.
    // Only the bench checks the ratio, so elsewhere one round covers the rest (it's 40 minutes of
    // WARP on CI's Windows runners at eight).
    const rounds = timingMode === 'bench' ? 8 : 1
    const ratios: number[] = []
    for (let round = 0; round < rounds; round++) {
      world.set(r.camera, CutawayView, { points: [] })
      await settle(r.app, 3)
      const none = await frameMs(9)
      world.set(r.camera, CutawayView, { points })
      await settle(r.app, 3)
      ratios.push((await frameMs(9)) / none)
    }
    ratios.sort((a, b) => a - b)
    const mid = ratios.length >> 1
    const ratio = ratios.length % 2 ? ratios[mid]! : (ratios[mid - 1]! + ratios[mid]!) / 2
    console.log(
      `max fixture, 1280×720: 16 reveal points cost ${((ratio - 1) * 100).toFixed(1)}% GPU time`,
    )
    expect(world.resource(Gpu).errors).toEqual([])
    expect(world.resource(RenderStats).lastFrame.chunksRebuilt).toBe(0)
    if (timingMode === 'bench') expect(ratio).toBeLessThan(1.05)
    await r.dispose()
  })
})
