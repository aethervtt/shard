import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView } from './testing'

it('keeps drawing earlier instances after the instance buffer grows', async () => {
  const gpu = await createNodeGpuContext()
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'growth', width: 64, height: 64 })
  const ref = world.resource(RenderTargets).add(target, 'growth')
  const eye: [number, number, number] = [0, 10, 20]
  const cam = world.spawn(
    [Camera3d, { target: ref as never }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 5000 }],
    [Transform, { rotation: lookAt([0, 0, 0], [0.3, -1, 0.2]) }],
  )
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 80 })) }],
    [MeshMaterial, { material: materials.add(new MaterialAsset({ baseColor: [1, 0, 0, 1] })) }],
    Transform,
  )
  const before = pixel(await renderView(app, `camera:${cam}`), 32, 60)
  expect(before[0]).toBeGreaterThan(100) // the red plane, near the camera
  // Far-off boxes past the store's first 256 slots: the GPU buffer is replaced.
  const box = world.resource(Meshes).add(cube({ size: 0.2 }))
  const green = materials.add(new MaterialAsset({ baseColor: [0, 1, 0, 1] }))
  for (let i = 0; i < 600; i++) {
    world.spawn(
      [Mesh3d, { mesh: box }],
      [MeshMaterial, { material: green }],
      [Transform, { translation: [-30 + (i % 60), 5, -30 - Math.floor(i / 60)] }],
    )
  }
  const after = pixel(await renderView(app, `camera:${cam}`), 32, 60)
  expect(after).toEqual(before)
  gpu.destroy()
})
