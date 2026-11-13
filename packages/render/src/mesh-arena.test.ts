import { Rng } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, type Mesh, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler } from './culling'
import { GpuAssetsResource } from './gpu-assets'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { RangeAllocator } from './mesh-arena'
import { captureView, Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { settle } from './testing'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('RangeAllocator', () => {
  it('allocates first fit and coalesces what is freed', () => {
    const r = new RangeAllocator()
    r.grow(100)
    expect(r.alloc(30)).toBe(0)
    expect(r.alloc(30)).toBe(30)
    expect(r.alloc(30)).toBe(60)
    expect(r.alloc(30)).toBe(-1)
    r.free(30, 30)
    r.free(0, 30)
    expect(r.alloc(50)).toBe(0)
    r.free(0, 50)
    r.free(60, 30)
    expect(r.available).toBe(100)
    expect(r.alloc(100)).toBe(0)
  })
})

/** Many distinct meshes (each its own batch), in an arena or not; returns the app and a shot. */
async function scene(arena: string | undefined, gpuCull: boolean) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(Culler).enabled = gpuCull
  const target = new OffscreenTarget(gpu, { label: 'arena', width: 128, height: 96 })
  const targetRef = world.resource(RenderTargets).add(target, 'arena')
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.7 }))
  const meshes = world.resource(Meshes)
  const rng = new Rng(5)
  const list: Mesh[] = []
  // 600 spheres of ~500 vertices: past the arena's first 16k vertices, so it grows.
  for (let i = 0; i < 600; i++) {
    const mesh =
      i % 3 === 0 ? cube({ size: 0.6 }) : sphere({ radius: 0.35, segments: 12 + (i % 5) })
    mesh.arena = arena
    list.push(mesh)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(mesh) }],
      [MeshMaterial, { material }],
      [Transform, { translation: [rng.range(-12, 12), rng.range(0, 4), rng.range(-24, 2)] }],
    )
  }
  world.spawn(
    [DirectionalLight, { illuminance: 3000, shadows: true }],
    [Transform, { rotation: lookAt([0, 0, 0], [-0.4, -1, -0.3]) }],
  )
  const camera = world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 60 }],
    [Exposure, { ev100: 10 }],
    [Transform, { translation: [0, 5, 8], rotation: lookAt([0, 5, 8], [0, 0, -8]) }],
  )
  const shot = async () => {
    await settle(app)
    const image = captureView(world, `camera:${camera}`)
    app.update(1 / 60)
    return image
  }
  return { app, world, target, list, shot }
}

describe('mesh arenas (0116)', () => {
  for (const gpuCull of [true, false]) {
    it(`draws meshes from an arena exactly as from their own buffers, through growth, updates and moves (${gpuCull ? 'GPU' : 'CPU'})`, async () => {
      const own = await scene(undefined, gpuCull)
      const shared = await scene('test', gpuCull)
      expect((await shared.shot()).data).toEqual((await own.shot()).data)
      expect(shared.world.resource(Gpu).errors).toEqual([])
      const arena = shared.world.resource(GpuAssetsResource).arenas.get('test')!
      expect(arena.version, 'grew past its first size').toBeGreaterThan(0)
      // New data that fits rewrites in place; more than it had room for moves it.
      for (const s of [own, shared]) {
        s.list[1]!.update(sphere({ radius: 0.35, segments: 6 }).data())
        s.list[2]!.update(sphere({ radius: 0.5, segments: 32 }).data())
      }
      expect((await shared.shot()).data).toEqual((await own.shot()).data)
      // Released meshes give their ranges back.
      const free = arena.vertices.available
      shared.world.resource(GpuAssetsResource).releaseMesh(shared.list[4]!)
      expect(arena.vertices.available).toBeGreaterThan(free)
      for (const s of [own, shared]) {
        await s.app.dispose()
        s.target.destroy()
      }
    })
  }
})
