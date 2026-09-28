import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { forwardCorePlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { Gpu, renderPlugin } from './plugin'
import { Antialiasing, Bloom } from './post'
import { OffscreenTarget } from './target'
import { compareGolden, renderView } from './testing'
import { RenderPath, Tonemapping } from './view'

// The core renderer with no feature plugins (spec 0056): what an app gets from forwardCorePlugin
// alone, and what happens when a camera asks for a feature that isn't installed.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))

async function scene(shadows: boolean) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardCorePlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'core-only', width: 96, height: 64 })
  const targetRef = world.resource(RenderTargets).add(target, 'core-only')
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 8 })) }],
    [MeshMaterial, { material: materials.add(new MaterialAsset({ roughness: 0.9 })) }],
    Transform,
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 1 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.8, 0.2, 0.1, 1] })) },
    ],
    [Transform, { translation: [0, 0.5, 0] }],
  )
  // From behind and to the left, so the cube's shadow falls toward the camera.
  const sun: [number, number, number] = [-2, 4, -3]
  world.spawn(
    [DirectionalLight, { illuminance: 10_000, shadows }],
    [Transform, { translation: sun, rotation: lookAt(sun, [0, 0, 0]) }],
  )
  const eye: [number, number, number] = [3, 3, 4]
  const cam = world.spawn(
    [Camera3d, { target: targetRef, fovY: 45 }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    // Features this app didn't install: each is skipped, and named once.
    [Bloom, {}],
    [Antialiasing, { mode: 'fxaa' }],
    [RenderPath, { mode: 'deferred' }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.5, 0]) }],
  )
  return { app, world, cam, target }
}

describe('forwardCorePlugin alone', () => {
  it('draws a lit, shadowed scene, and names the plugins a camera asks for', async () => {
    const { app, world, cam, target } = await scene(true)
    const image = await renderView(app, `camera:${cam}`)
    expect(world.resource(Gpu).errors).toEqual([])
    expect(compareGolden(here, 'core-only', image).mean).toBeLessThan(1.5)

    const missing = world
      .resource(LogResource)
      .tail(200, 'warn')
      .filter((e) => e.code === 'render/feature-missing')
    const messages = missing.map((e) => e.message).join('\n')
    expect(messages).toContain('Bloom')
    expect(messages).toContain('Fxaa')
    expect(messages).toContain('deferred')
    expect(missing.map((e) => e.hint).join('\n')).toMatch(/postPlugin|fxaaPlugin/)
    // Once each, not every frame.
    expect(missing.length).toBeLessThanOrEqual(3)
    target.destroy()
  })

  it('runs the shadow pass: the same scene without shadows is lighter', async () => {
    const lit = await scene(true)
    const withShadow = await renderView(lit.app, `camera:${lit.cam}`)
    const flat = await scene(false)
    const without = await renderView(flat.app, `camera:${flat.cam}`)
    let shadowed = 0
    for (let i = 0; i < withShadow.data.length; i += 4) {
      if (withShadow.data[i]! + 20 < without.data[i]!) shadowed++
    }
    // A cube's shadow on the floor covers a few hundred of these 6,144 pixels.
    expect(shadowed).toBeGreaterThan(100)
    lit.target.destroy()
    flat.target.destroy()
  })
})
