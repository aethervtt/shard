import type { GpuContext } from '@aethervtt/shard-gpu'
import { uploadCategory } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, Mesh, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { ForwardStateResource } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight, PointLight } from './lights'
import { describeRender, Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { settle } from './testing'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function scene(shadowUpdate: 'always' | 'on-change' = 'always') {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'uploads', width: 64, height: 48 })
  const ref = world.resource(RenderTargets).add(target, 'uploads')
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.8 }))
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 20 })) }],
    [MeshMaterial, { material }],
    Transform,
  )
  const box = world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(cube()) }],
    [MeshMaterial, { material }],
    [Transform, { translation: [0, 0.5, 0] }],
  )
  const sun = world.spawn(
    [DirectionalLight, { shadows: true, shadowUpdate }],
    [Transform, { rotation: lookAt([3, 6, 2], [0, 0, 0]) }],
  )
  world.spawn(
    [Camera3d, { target: ref }],
    [Exposure, {}],
    [Transform, { translation: [0, 4, 7], rotation: lookAt([0, 4, 7], [0, 0, 0]) }],
  )
  await settle(app)
  for (let i = 0; i < 3; i++) app.update(1 / 60)
  return { app, world, box, sun, target, stats: world.resource(RenderStats) }
}

describe('upload accounting', () => {
  it('categorizes buffers by label', () => {
    expect(uploadCategory('instances', false)).toBe(0)
    expect(uploadCategory('instances/previous', false)).toBe(0)
    expect(uploadCategory('mesh/positions', false)).toBe(1)
    expect(uploadCategory('material/render/StandardMaterial', false)).toBe(2)
    expect(uploadCategory('anything', true)).toBe(3)
    expect(uploadCategory('lights/directional', false)).toBe(4)
    expect(uploadCategory('shadows/views', false)).toBe(5)
    expect(uploadCategory('camera:4/view', false)).toBe(6)
    expect(uploadCategory('cull/views', false)).toBe(6)
    expect(uploadCategory('particles/sim', false)).toBe(7)
  })

  it('a still frame writes no scene bytes; a move writes one slot', async () => {
    const { app, world, box, target, stats } = await scene()
    expect(stats.lastFrame.sceneBytes).toBe(0)
    expect(stats.lastFrame.bytes.view).toBeGreaterThan(0)
    world.set(box, Transform, { translation: [1, 0.5, 0] })
    app.update(1 / 60)
    expect(stats.lastFrame.bytes.instances).toBe(64 + 48)
    expect(stats.lastFrame.sceneBytes).toBe(64 + 48)
    // Next frame, the slot's previous transform catches up (motion vectors go to zero).
    app.update(1 / 60)
    expect(stats.lastFrame.sceneBytes).toBe(48)
    app.update(1 / 60)
    expect(stats.lastFrame.sceneBytes).toBe(0)
    // The last 60 frames: the setup's uploads too, and this move's.
    expect(stats.recent.bytes.instances).toBeGreaterThanOrEqual(64 + 48 + 48)
    const described = describeRender(world).uploads as {
      lastFrame: { sceneBytes: number }
      recent: { bytes: { instances: number } }
      rebuilds: { lastFrame: unknown }
    }
    expect(described.lastFrame.sceneBytes).toBe(0)
    expect(described.recent.bytes.instances).toBe(stats.recent.bytes.instances)
    expect(described.rebuilds.lastFrame).toEqual({
      chunksRebuilt: 0,
      meshesRebuilt: 0,
      shadowMapsRendered: 4,
    })
    await app.dispose()
    target.destroy()
  })

  it("rewrites a mesh's buffers in place while its new data fits", async () => {
    const { app, world, target, stats } = await scene()
    const meshes = world.resource(Meshes)
    const mesh = cube()
    const ref = meshes.add(mesh)
    world.spawn([Mesh3d, { mesh: ref }], [MeshMaterial, { material: null }], Transform)
    await settle(app)
    app.update(1 / 60)
    const owner = world.resource(Gpu).owner
    const before = gpu.stats(owner)
    // Fewer triangles: the same buffers.
    const small = Mesh.create({
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint16Array([0, 1, 2]),
    })
    mesh.update(small.data())
    app.update(1 / 60)
    expect(stats.lastFrame.meshesRebuilt).toBe(1)
    expect(stats.lastFrame.created).toBe(0)
    expect(stats.lastFrame.bytes.meshes).toBeGreaterThan(0)
    expect(gpu.stats(owner)).toEqual(before)
    // More vertices than it had room for: new buffers.
    mesh.update(plane({ size: 1, subdivisions: 16 }).data())
    app.update(1 / 60)
    expect(stats.lastFrame.created).toBeGreaterThan(0)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
    target.destroy()
  })
})

describe('cached shadows', () => {
  it("caches a point light's six faces too, and redraws them when it moves", async () => {
    const { app, world, sun, target, stats } = await scene('on-change')
    world.despawn(sun)
    const torch = world.spawn(
      [PointLight, { shadows: true, shadowUpdate: 'on-change', range: 10 }],
      [Transform, { translation: [0, 3, 0] }],
    )
    await settle(app)
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    world.set(torch, Transform, { translation: [0.5, 3, 0] })
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(6)
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    await app.dispose()
    target.destroy()
  })

  it("'always' draws every cascade every frame", async () => {
    const { app, target, stats } = await scene('always')
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(4)
    await app.dispose()
    target.destroy()
  })

  it("'on-change' draws none on a still frame, and one cascade a frame when the light turns (0116)", async () => {
    const { app, world, sun, box, target, stats } = await scene('on-change')
    const cascades = () =>
      world.resource(ForwardStateResource).views.values().next().value!.cascades
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    world.set(sun, Transform, { rotation: lookAt([-3, 6, 2], [0, 0, 0]) })
    // Every cascade must redraw; at most one full redraw a frame, the others wait their turn.
    for (let i = 0; i < 4; i++) {
      app.update(1 / 60)
      expect(stats.lastFrame.shadowMapsRendered, `frame ${i}`).toBe(1)
      expect(cascades().fullRedraws).toBe(1)
    }
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    // A caster that starts moving leaves the static layers where it was (rect redraws only) and
    // casts from the dynamic layers.
    world.set(box, Transform, { translation: [0.5, 0.5, 0] })
    app.update(1 / 60)
    expect(cascades().fullRedraws).toBe(0)
    expect(cascades().rectRedraws).toBeGreaterThan(0)
    expect(cascades().dynamic.some((v) => v.redraw)).toBe(true)
    // Moving again, or going away while dynamic: no static redraw at all.
    world.set(box, Transform, { translation: [0.6, 0.5, 0] })
    app.update(1 / 60)
    expect(cascades().fullRedraws + cascades().rectRedraws).toBe(0)
    world.remove(box, Mesh3d)
    app.update(1 / 60)
    expect(cascades().fullRedraws + cascades().rectRedraws).toBe(0)
    app.update(1 / 60)
    expect(stats.lastFrame.shadowMapsRendered).toBe(0)
    await app.dispose()
    target.destroy()
  })
})
