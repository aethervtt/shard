import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChildOf, quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure, ExposurePresets, LightPresets, PhysicalCamera } from './camera'
import { forwardPlugin, Mesh3d, MeshMaterial } from './forward'
import { AmbientLight, DirectionalLight } from './lights'
import { captureView, describeRender, renderPlugin } from './plugin'
import { ENGINE_SHADERS } from './shaders'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { Tonemapping } from './view'
import { ComputedVisibility, Visibility } from './visibility'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(size = 64) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'test-target', width: size, height: size })
  const targetRef = app.world.resource(RenderTargets).add(target, 'test-target')
  return { app, world: app.world, target, targetRef }
}

const render = renderView
const here = dirname(fileURLToPath(import.meta.url))

async function referenceScene(tonemap?: { curve: 'aces'; dither: boolean }) {
  const { world, app, targetRef } = await scene(64)
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const red = materials.add(new MaterialAsset({ baseColor: [0.8, 0.1, 0.1, 1], roughness: 0.4 }))
  const metal = materials.add(
    new MaterialAsset({ baseColor: [0.9, 0.9, 0.9, 1], metallic: 1, roughness: 0.25 }),
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 10 })) }],
    [Transform, { translation: [0, -1, 0] }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(cube()) }],
    [MeshMaterial, { material: red }],
    [Transform, { translation: [-1, -0.5, 0], rotation: q(0, 0.5, 0) }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.6 })) }],
    [MeshMaterial, { material: metal }],
    [Transform, { translation: [1, -0.4, 0] }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: LightPresets.daylight }],
    [Transform, { rotation: q(-0.8, 0.6, 0) }],
  )
  world.resource(AmbientLight).brightness = 1500
  const cam = world.spawn(
    [Camera3d, { target: targetRef }],
    ...(tonemap ? [[Tonemapping, tonemap] as const] : []),
    [Transform, { translation: [0, 2, 5], rotation: lookAt([0, 2, 5], [0, -0.5, 0]) }],
  )
  return render(app, `camera:${cam}`)
}

describe('forward renderer', () => {
  it('renders a lit cube: faces toward the light are brighter than faces away', async () => {
    const { world, app, targetRef } = await scene()
    const mesh = world.resource(Meshes).add(cube({ size: 2 }))
    world.spawn([Mesh3d, { mesh }], [Transform, { rotation: q(0.4, 0.6, 0) }])
    world.spawn(
      [DirectionalLight, { illuminance: LightPresets.daylight }],
      [Transform, { rotation: q(-0.9, 0.5, 0) }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef }],
      [Transform, { translation: [0, 0, 6] }],
    )
    const image = await render(app, `camera:${cam}`)
    const center = pixel(image, 32, 32)
    const corner = pixel(image, 1, 1)
    expect(center).not.toEqual(corner) // the cube covers the center, background the corner
    const stats = world.resource(RenderStats).get(`camera:${cam}`)!
    expect(stats).toMatchObject({ visible: 1, culled: 0, drawCalls: 1 })
  })

  it('matches the reference scene golden (HDR, AgX)', async () => {
    const image = await referenceScene()
    expect(compareGolden(here, 'reference-scene', image).mean).toBeLessThan(1.5)
  })

  it('with ACES, matches the M2 in-shader tonemap on every surface', async () => {
    const image = await referenceScene({ curve: 'aces', dither: false })

    // The M2 golden tonemapped with ACES inside the material shader, straight into the display
    // target. The HDR path must match it on every surface. The background differs by design: the
    // clear color now goes through the tonemap curve like everything else.
    const old = new Uint8Array(readFileSync(join(here, '__golden__', 'reference-scene-m2.rgba')))
    const bg = [...old.slice(0, 4)]
    let sum = 0
    let n = 0
    for (let i = 0; i < old.length; i += 4) {
      if (old[i] === bg[0] && old[i + 1] === bg[1] && old[i + 2] === bg[2]) continue
      for (let c = 0; c < 3; c++) sum += Math.abs(old[i + c]! - image.data[i + c]!)
      n += 3
    }
    expect(n).toBeGreaterThan(old.length / 3)
    expect(sum / n).toBeLessThan(2)
  })

  it('renders an 18% gray card near mid-gray for every matched light/exposure preset pair', async () => {
    const pairs = [
      ['direct-sun', 'sunny'],
      ['daylight', 'daylight'],
      ['overcast', 'overcast'],
      ['indoor', 'indoor'],
      ['twilight', 'twilight'],
    ] as const
    const values: number[] = []
    for (const [light, exposure] of pairs) {
      const { world, app, targetRef } = await scene(16)
      const gray = world
        .resource(Materials)
        .add(new MaterialAsset({ baseColor: [0.18, 0.18, 0.18, 1], roughness: 1 }))
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 50 })) }],
        [MeshMaterial, { material: gray }],
        Transform,
      )
      // Light straight down, camera straight down: the card faces both.
      world.spawn(
        [DirectionalLight, { illuminance: LightPresets[light] }],
        [Transform, { rotation: q(-Math.PI / 2, 0, 0) }],
      )
      const cam = world.spawn(
        [Camera3d, { target: targetRef }],
        [Exposure, { ev100: ExposurePresets[exposure] }],
        [Transform, { translation: [0, 5, 0], rotation: lookAt([0, 5, 0], [0, 0, 0], [0, 0, -1]) }],
      )
      const image = await render(app, `camera:${cam}`)
      values.push(pixel(image, 8, 8)[0]!)
    }
    // Photographic mid-gray is sRGB ~118. Every pair should land on (nearly) the same value.
    for (const v of values) expect(Math.abs(v - 118)).toBeLessThan(12)
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(2)
  })

  it('instances identical mesh/material pairs: draw calls equal distinct pairs', async () => {
    const { world, app, targetRef } = await scene(32)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const a = meshes.add(cube({ size: 0.2 }))
    const b = meshes.add(sphere({ radius: 0.1, segments: 8 }))
    const red = materials.add(new MaterialAsset({ baseColor: [1, 0, 0, 1] }))
    const blue = materials.add(new MaterialAsset({ baseColor: [0, 0, 1, 1] }))
    for (let i = 0; i < 10_000; i++) {
      world.spawn(
        [Mesh3d, { mesh: i % 2 ? a : b }],
        [MeshMaterial, { material: i % 3 ? red : blue }],
        [Transform, { translation: [((i % 100) - 50) * 0.3, Math.floor(i / 100) * 0.3 - 15, -40] }],
      )
    }
    const cam = world.spawn([Camera3d, { target: targetRef, fovY: 90 }], Transform)
    await render(app, `camera:${cam}`)
    const stats = world.resource(RenderStats).get(`camera:${cam}`)!
    expect(stats.drawCalls).toBe(4)
    expect(stats.visible + stats.culled).toBe(10_000)
    expect(stats.visible).toBeGreaterThan(1000)
  })

  it('culls everything behind the camera', async () => {
    const { world, app, targetRef } = await scene(16)
    const mesh = world.resource(Meshes).add(cube())
    for (let i = 0; i < 10_000; i++)
      world.spawn(
        [Mesh3d, { mesh }],
        [Transform, { translation: [i % 100, 0, 20 + Math.floor(i / 100)] }],
      )
    const cam = world.spawn([Camera3d, { target: targetRef }], Transform) // looks down -Z; cubes are at +Z
    await render(app, `camera:${cam}`)
    expect(world.resource(RenderStats).get(`camera:${cam}`)).toMatchObject({
      visible: 0,
      culled: 10_000,
      drawCalls: 0,
    })
  })

  it('resolves visibility through the hierarchy', async () => {
    const { world, app } = await scene(8)
    const mesh = world.resource(Meshes).add(cube())
    const parent = world.spawn([Mesh3d, { mesh }], [Visibility, { mode: 'hidden' }], Transform)
    const inherits = world.spawn([Mesh3d, { mesh }], [ChildOf, { parent }], Transform)
    const forced = world.spawn(
      [Mesh3d, { mesh }],
      [Visibility, { mode: 'visible' }],
      [ChildOf, { parent }],
      Transform,
    )
    const grandchild = world.spawn([Mesh3d, { mesh }], [ChildOf, { parent: inherits }], Transform)
    app.update(1 / 60)
    const visible = (e: number) => world.get(e, ComputedVisibility).visible
    expect([visible(parent), visible(inherits), visible(forced), visible(grandchild)]).toEqual([
      false,
      false,
      true,
      false,
    ])
  })

  it('renders two cameras with different order and targets in one frame', async () => {
    const { world, app, targetRef } = await scene(16)
    const second = world
      .resource(RenderTargets)
      .add(new OffscreenTarget(gpu, { label: 'second', width: 16, height: 16 }))
    const a = world.spawn(
      [Camera3d, { target: targetRef, clearColor: [1, 0, 0, 1], order: 1 }],
      Transform,
    )
    const b = world.spawn(
      [Camera3d, { target: second, clearColor: [0, 0, 1, 1], order: 0 }],
      Transform,
    )
    await settle(app)
    const shots = [captureView(world, `camera:${a}`), captureView(world, `camera:${b}`)]
    app.update(1 / 60)
    const [ia, ib] = await Promise.all(shots)
    // Clear colors are HDR like everything else: pure red goes through the tonemap curve (AgX
    // desaturates it slightly, as it does any fully saturated color).
    const [r, g, b0] = pixel(ia!, 0, 0)
    expect(r! - Math.max(g!, b0!)).toBeGreaterThan(120)
    const [r1, g1, b1] = pixel(ib!, 0, 0)
    expect(b1! - Math.max(r1!, g1!)).toBeGreaterThan(120)
    expect(describeRender(world).views.map((v) => v.order)).toEqual([1, 0])
  })

  it('derives exposure and field of view from PhysicalCamera', async () => {
    const { world, app, targetRef } = await scene(8)
    const cam = world.spawn(
      [Camera3d, { target: targetRef }],
      [PhysicalCamera, { aperture: 16, shutterSpeed: 1 / 125, iso: 100, focalLength: 50 }],
      Transform,
    )
    app.update(1 / 60)
    expect(world.get(cam, Exposure).ev100).toBeCloseTo(15, 0) // sunny 16 rule
    expect(world.get(cam, Camera3d).fovY).toBeCloseTo(26.99, 1)
  })

  it('keeps materials to the surface stage: only the lighting module evaluates lights', () => {
    const material = ENGINE_SHADERS['shard::pbr::material']!
    expect(material).not.toMatch(/light/i)
    const definers = Object.entries(ENGINE_SHADERS).filter(([, src]) =>
      /fn apply_lighting/.test(src),
    )
    expect(definers.map(([path]) => path)).toEqual(['shard::pbr::lighting'])
  })
})
