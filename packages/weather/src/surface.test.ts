import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  captureView,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderPath,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Sky, setTimeOfDay, skyPlugin } from '@aethervtt/shard-sky'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Weather, WeatherState } from './components'
import { weatherPlugin } from './plugin'

// Surface weather (0134) on deferred cameras (0021): the G-buffer keeps the weathered surface, so
// wet ground darkens there as it does in forward views.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

type Vec3 = [number, number, number]
const EYE: Vec3 = [0, 3, 0]
const GROUND: Vec3 = [0, 0, -6]

/** Linear luminance of rough ground in the middle of the view, dry or soaked. */
async function groundLight(wet: boolean, deferred: boolean): Promise<number> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    skyPlugin,
    weatherPlugin,
  )
  await app.init()
  const world = app.world
  setTimeOfDay(world, 11)
  world.spawn([Sky, {}], [Weather, { source: 'preset', preset: 'clear' }])
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const grey = materials.add(new MaterialAsset({ baseColor: [0.5, 0.5, 0.5, 1], roughness: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 200 })) }],
    [MeshMaterial, { material: grey }],
    [Transform, {}],
  )
  const target = new OffscreenTarget(gpu, { label: 'surface-weather', width: 96, height: 64 })
  const ref = world.resource(RenderTargets).add(target, `surface-weather-${Math.random()}`)
  const cam = world.spawn(
    [Camera3d, { target: ref as never, fovY: 30 }],
    [Exposure, { ev100: 15 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: EYE, rotation: lookAt(EYE, GROUND) }],
  )
  if (deferred) world.add(cam, RenderPath, { mode: 'deferred' })
  await settle(app, 60)
  // Soaked for the captured frame, without the rain that would wet it falling through the view.
  if (wet) world.resource(WeatherState).wetness = 1
  const shot = captureView(world, `camera:${cam}`)
  app.update(1 / 60)
  const image = await shot
  const [r, g, b] = pixel(image, 48, 32)
  await app.dispose()
  const lin = (v: number) => (v / 255) ** 2.2
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
}

describe('surface weather on deferred cameras (0021, 0134)', () => {
  it('darkens wet ground as forward views do', async () => {
    const forward = (await groundLight(true, false)) / (await groundLight(false, false))
    const deferred = (await groundLight(true, true)) / (await groundLight(false, true))
    expect(forward).toBeLessThan(0.75)
    expect(Math.abs(deferred - forward)).toBeLessThan(0.05)
  }, 120_000)
})
