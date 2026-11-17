import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
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
  Toon,
  worldToScreen,
} from '@aethervtt/shard-render'
import { pixel, renderView, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setTimeOfDay } from './clock'
import { Clouds, Sky } from './components'
import { skyPlugin } from './plugin'

// Cloud shadows (0131) on Toon cameras (0108): overcast dims the light a toon surface gets, as it
// dims a PBR one. Through the band ramp, a surface 90% under cloud kept a whole band of sun, so in
// fog it stayed bright and the fog barely showed on it. Deferred cameras (0021) dim the same.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

type Vec3 = [number, number, number]
const EYE: Vec3 = [0, 1.6, 0]
const BOX: Vec3 = [0, 1, -30]

/** Linear luminance of the box's middle, under thick cloud with or without its shadows. */
async function boxLight(toon: boolean, shadows: boolean, deferred = false): Promise<number> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    skyPlugin,
  )
  await app.init()
  const world = app.world
  setTimeOfDay(world, 11)
  world.spawn([Sky, {}], [Clouds, { coverage: 0.9, shadows }])
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const grey = materials.add(new MaterialAsset({ baseColor: [0.4, 0.4, 0.4, 1], roughness: 1 }))
  const red = materials.add(new MaterialAsset({ baseColor: [0.8, 0.05, 0.05, 1], roughness: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 400 })) }],
    [MeshMaterial, { material: grey }],
    [Transform, {}],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(box({ x: 4, y: 2, z: 2 })) }],
    [MeshMaterial, { material: red }],
    [Transform, { translation: BOX }],
  )
  const target = new OffscreenTarget(gpu, { label: 'toon-clouds', width: 160, height: 120 })
  const ref = world.resource(RenderTargets).add(target, `toon-clouds-${Math.random()}`)
  const cam = world.spawn(
    [Camera3d, { target: ref as never, fovY: 30 }],
    [Exposure, { ev100: 15 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: EYE, rotation: lookAt(EYE, BOX) }],
  )
  if (toon) world.add(cam, Toon, { bands: 3 })
  if (deferred) world.add(cam, RenderPath, { mode: 'deferred' })
  await settle(app, 60)
  const image = await renderView(app, `camera:${cam}`)
  const s = new Float32Array(3)
  worldToScreen(world, cam, BOX, s)
  const [r, g, b] = pixel(image, Math.round(s[0]! - 0.5), Math.round(s[1]! - 0.5))
  await app.dispose()
  const lin = (v: number) => (v / 255) ** 2.2
  return 0.2126 * lin(r!) + 0.7152 * lin(g!) + 0.0722 * lin(b!)
}

describe('cloud shadows on Toon cameras (0108, 0131)', () => {
  it('dim a toon surface as much as a PBR one', async () => {
    const pbr = (await boxLight(false, true)) / (await boxLight(false, false))
    const toon = (await boxLight(true, true)) / (await boxLight(true, false))
    // The clouds shade the box…
    expect(pbr).toBeLessThan(0.7)
    // …and a toon box keeps no more of its light than a PBR one does.
    expect(toon).toBeLessThan(pbr * 1.25)
  }, 120_000)

  it('dim a deferred surface as they dim a forward one', async () => {
    const forward = (await boxLight(false, true)) / (await boxLight(false, false))
    const deferred = (await boxLight(false, true, true)) / (await boxLight(false, false, true))
    const toon = (await boxLight(true, true, true)) / (await boxLight(true, false, true))
    expect(deferred).toBeLessThan(0.7)
    expect(Math.abs(deferred - forward)).toBeLessThan(0.05)
    expect(toon).toBeLessThan(deferred * 1.25)
  }, 120_000)
})
