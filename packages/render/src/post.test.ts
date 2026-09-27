import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure, PhysicalCamera } from './camera'
import { forwardPlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { captureBuffer, captureView, describeRender, Gpu, renderPlugin, Views } from './plugin'
import {
  Antialiasing,
  AutoExposure,
  Bloom,
  ColorGrading,
  cocRadiusPixels,
  DepthOfField,
  Fog,
  MotionBlur,
  Ssao,
  Vignette,
} from './post'
import { ExposureMeters } from './post-nodes'
import { OffscreenTarget } from './target'
import { compareGolden, renderView, settle } from './testing'
import { cameraOf, RenderPath, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(width = 160, height = 96, msaa: 1 | 4 = 4) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'post-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'post-target')
  return { app, world: app.world, targetRef }
}

type World = Awaited<ReturnType<typeof scene>>['world']

/**
 * The fixture: a floor, a row of spheres and boxes receding from the camera, an emissive panel,
 * a sun, and ambient light. Returns the camera.
 */
function fixture(world: World, targetRef: unknown, extra: unknown[] = []) {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (v: Record<string, unknown>) => materials.add(new MaterialAsset(v))
  world.resource(AmbientLight).brightness = 1500
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 60 })) }],
    [MeshMaterial, { material: mat({ baseColor: [0.45, 0.45, 0.42, 1], roughness: 0.8 }) }],
    Transform,
  )
  const ball = meshes.add(sphere({ radius: 0.5, segments: 32 }))
  const box = meshes.add(cube({ size: 0.9 }))
  const looks = [
    mat({ baseColor: [0.8, 0.2, 0.15, 1], roughness: 0.4 }),
    mat({ baseColor: [0.2, 0.5, 0.8, 1], roughness: 0.6 }),
    mat({ baseColor: [0.9, 0.85, 0.7, 1], metallic: 1, roughness: 0.25 }),
  ]
  for (let i = 0; i < 8; i++) {
    world.spawn(
      [Mesh3d, { mesh: i % 2 ? box : ball }],
      [MeshMaterial, { material: looks[i % 3]! }],
      [
        Transform,
        {
          translation: [(i % 2 ? 1 : -1) * 1.3, 0.5, 2 - i * 2.2],
          rotation: q(0, i * 0.7, 0),
        },
      ],
    )
  }
  // A glowing panel, far brighter than anything lit: bloom and exposure have something to find.
  world.spawn(
    [Mesh3d, { mesh: box }],
    [
      MeshMaterial,
      {
        material: mat({
          baseColor: [0, 0, 0, 1],
          emissive: [1, 0.6, 0.2, 1],
          emissiveLuminance: 60_000,
        }),
      },
    ],
    [Transform, { translation: [0, 1.6, -6], scale: [1.6, 0.25, 0.1] }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 10_000, shadows: true }],
    [Transform, { rotation: q(-0.7, 0.8, 0) }],
  )
  const eye: [number, number, number] = [2.5, 2.4, 6.5]
  return world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 45 }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.4, -4]) }],
    ...(extra as []),
  )
}

async function effect(
  name: string,
  extra: unknown[],
  options: { msaa?: 1 | 4; path?: 'forward' | 'deferred' } = {},
) {
  const { app, world, targetRef } = await scene(160, 96, options.msaa ?? 4)
  const path = options.path ? [[RenderPath, { mode: options.path }]] : []
  const cam = fixture(world, targetRef, [...extra, ...path])
  const image = await renderView(app, `camera:${cam}`)
  await gpu.pipelines.whenIdle()
  expect(world.resource(Gpu).errors, name).toEqual([])
  expect(world.resource(LogResource).errors(), name).toEqual([])
  return { app, world, cam, image }
}

const meanDiff = (a: Uint8Array, b: Uint8Array) => {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / a.length
}

describe('post-processing', () => {
  it('renders each effect on the fixture (golden images)', {
    timeout: timeout(120_000),
  }, async () => {
    const base = await effect('none', [])
    expect(compareGolden(here, 'post-none', base.image).mean).toBeLessThan(1.5)
    const cases: [string, unknown[], { msaa?: 1 | 4; path?: 'forward' | 'deferred' }?][] = [
      ['bloom', [[Bloom, { intensity: 0.3 }]]],
      ['fog', [[Fog, { density: 0.08, heightFalloff: 0.3 }]]],
      ['dof', [[DepthOfField, { focusDistance: 4, maxBlur: 0.03 }]]],
      ['ssao', [[Ssao, { radius: 0.8, intensity: 1.5 }]]],
      ['ssao-deferred', [[Ssao, { radius: 0.8, intensity: 1.5 }]], { path: 'deferred' }],
      ['grading', [[ColorGrading, { temperature: 0.25, saturation: 1.3, contrast: 1.15 }]]],
      ['vignette', [[Vignette, { intensity: 0.8 }]]],
      ['fxaa', [[Antialiasing, { mode: 'fxaa' }]]],
      ['taa', [[Antialiasing, { mode: 'taa' }]]],
      ['motion-blur', [[MotionBlur, {}]]],
      ['auto-exposure', [[AutoExposure, { compensation: 2 }]]],
    ]
    for (const [name, extra, options] of cases) {
      const { image } = await effect(name, extra, options)
      expect(compareGolden(here, `post-${name}`, image).mean, name).toBeLessThan(1.5)
      // Every effect changes the picture, except those with nothing to act on in a still frame.
      if (name !== 'motion-blur')
        expect(meanDiff(image.data, base.image.data), name).toBeGreaterThan(0.2)
    }
  })

  it('lists active effects in order, and removing a component removes its node', async () => {
    const { app, world, cam } = await effect('all', [
      [Fog, {}],
      [Bloom, {}],
      [DepthOfField, {}],
      [MotionBlur, {}],
      [Antialiasing, { mode: 'taa' }],
      [AutoExposure, {}],
      [Ssao, {}],
    ])
    const order = () =>
      (describeRender(world).perView as Record<string, { order: string[] }>)[`camera:${cam}`]!.order
    const chain = order().filter((n) => n.startsWith('post/'))
    expect(chain).toEqual([
      'post/fog',
      'post/taa',
      'post/motion-blur',
      'post/dof',
      'post/bloom',
      'post/exposure',
    ])
    expect(order()).toContain('prepass')
    expect(order()).toContain('ssao')
    const post = describeRender(world).post as {
      views: Record<string, { effects: { name: string }[]; ev100: number }>
    }
    expect(post.views[`camera:${cam}`]!.effects.map((e) => e.name)).toEqual([
      'ssao',
      'fog',
      'taa',
      'motion-blur',
      'dof',
      'bloom',
      'auto-exposure',
    ])
    world.remove(cam, Bloom)
    world.remove(cam, Ssao)
    world.remove(cam, MotionBlur)
    world.remove(cam, Antialiasing)
    app.update(1 / 60)
    expect(order()).not.toContain('post/bloom')
    expect(order()).not.toContain('ssao')
    expect(order()).not.toContain('post/motion-blur')
    expect(order()).not.toContain('post/taa')
    expect(order()).not.toContain('prepass')
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('adapts from an interior to daylight within 0.25 EV of the metered target in its adaptation time', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, targetRef } = await scene(96, 64, 1)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 200 })) }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({ baseColor: [0.18, 0.18, 0.18, 1], roughness: 1 }),
          ),
        },
      ],
      Transform,
    )
    // Straight down: the floor gets the full illuminance.
    const sun = world.spawn(
      [DirectionalLight, { illuminance: 100 }],
      [Transform, { rotation: q(-Math.PI / 2, 0, 0) }],
    )
    const eye: [number, number, number] = [0, 5, 0]
    const cam = world.spawn(
      [Camera3d, { target: targetRef as never, fovY: 40 }],
      [Exposure, { ev100: 5 }],
      [AutoExposure, { speedUp: 3, speedDown: 3 }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, -0.01]) }],
    )
    const step = async () => {
      app.update(1 / 60)
      await gpu.pipelines.whenIdle()
      await new Promise((r) => setTimeout(r, 0))
    }
    const ev = () => world.get(cam, Exposure)!.ev100
    // The interior first: settled at its own exposure.
    for (let i = 0; i < 90; i++) await step()
    const interior = ev()
    world.set(sun, DirectionalLight, { illuminance: 10_000 })
    // Metered target: EV100 of the floor's luminance (reflected-light meter, K = 12.5).
    const luminance = (10_000 * 0.18) / Math.PI
    const expected = Math.log2((luminance * 100) / 12.5)
    const meter = () => world.resource(ExposureMeters).get(cam)!
    // Every readback issued so far metered a frame drawn before the change; the first reading of a
    // frame drawn after it must show it. How many frames that takes depends on how fast the GPU maps
    // readbacks (a frame or two in a browser, dozens on a software GPU), so the test waits for that
    // reading rather than counting frames.
    const before = meter().submitted
    let frames = 0
    while (meter().reading <= before && frames < 600) {
      await step()
      frames++
    }
    expect(meter().reading).toBeGreaterThan(before)
    expect(meter().metered!).toBeGreaterThanOrEqual(interior + 1)
    frames = 0
    const target = meter().metered!
    expect(Math.abs(target - expected)).toBeLessThan(0.25)
    // The configured adaptation time: the EV distance at speedUp (3 EV/s).
    const budget = (target - interior) / 3
    while (Math.abs(ev() - target) > 0.25 && frames < 400) {
      await step()
      frames++
    }
    expect(interior).toBeCloseTo(Math.log2(((100 * 0.18) / Math.PI) * 8), 0)
    expect(Math.abs(ev() - target)).toBeLessThan(0.25)
    expect(frames / 60).toBeLessThanOrEqual(budget)
    // It stays there.
    for (let i = 0; i < 30; i++) await step()
    expect(Math.abs(ev() - expected)).toBeLessThan(0.25)
    const post = describeRender(world).post as { views: Record<string, { meteredEv100: number }> }
    expect(post.views[`camera:${cam}`]!.meteredEv100).toBeCloseTo(expected, 0)
  })

  it('blurs by the thin-lens circle of confusion, within 10%', {
    timeout: timeout(60_000),
  }, async () => {
    const size = 400
    const { app, world, targetRef } = await scene(size, size, 1)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const glow = (l: number) =>
      materials.add(
        new MaterialAsset({
          baseColor: [0, 0, 0, 1],
          emissive: [1, 1, 1, 1],
          emissiveLuminance: l,
        }),
      )
    const quad = meshes.add(plane({ size: 1 }))
    const facing = q(Math.PI / 2, 0, 0)
    const distance = 20
    // White on the left half, black on the right, as a wall 20 m away.
    world.spawn(
      [Mesh3d, { mesh: quad }],
      [MeshMaterial, { material: glow(0) }],
      [Transform, { translation: [0, 0, -distance - 0.01], rotation: facing, scale: [40, 1, 40] }],
    )
    world.spawn(
      [Mesh3d, { mesh: quad }],
      [MeshMaterial, { material: glow(1000) }],
      [Transform, { translation: [-10, 0, -distance], rotation: facing, scale: [20, 1, 40] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef as never }],
      // 1/8000 s keeps the white wall below display white, so bokeh doesn't boost it.
      [
        PhysicalCamera,
        { aperture: 0.5, shutterSpeed: 1 / 8000, focalLength: 50, sensorHeight: 24 },
      ],
      [DepthOfField, { mode: 'bokeh', focusDistance: 1.5, maxBlur: 0.1 }],
      [Tonemapping, { curve: 'none', dither: false }],
      Transform,
    )
    await settle(app)
    const shot = captureBuffer(world, `camera:${cam}`, 'post-hdr')
    const half = captureBuffer(world, `camera:${cam}`, 'dof-half')
    app.update(1 / 60)
    const [image, coc] = await Promise.all([shot, half])
    const data = cameraOf(world.resource(Views).list.find((v) => v.name === `camera:${cam}`)!)!
    // Thin lens: diameter A · |d − s| / d · f / (s − f), A = f / N; radius in pixels of the height.
    const f = 0.05
    const s = 1.5
    const n = 0.5
    const expected =
      (((((f / n) * (distance - s)) / distance) * (f / (s - f))) / 0.024) * size * 0.5
    expect(cocRadiusPixels(data, distance)).toBeCloseTo(expected, 3)
    // The CoC buffer at the wall.
    const c = coc.data[((coc.height / 2) * coc.width + coc.width / 4) * 4 + 3]!
    expect(Math.abs(c - expected) / expected).toBeLessThan(0.1)
    // The blur itself: a flat disc of radius R turns a step into a ramp whose 10–90% width is
    // known. Solve for the R that fits the measured width.
    const row = size / 2
    const lum = (x: number) => image.data[(row * size + x) * 4]!
    const white = lum(20)
    let x10 = 0
    let x90 = 0
    for (let x = 0; x < size; x++) {
      const v = lum(x) / white
      if (v > 0.9) x90 = x
      if (v > 0.1) x10 = x
    }
    const width = x10 - x90
    // Fraction of a unit disc left of a vertical line at t: (acos(-t) + t·sqrt(1 - t²)) / π.
    const cover = (t: number) => (Math.acos(-t) + t * Math.sqrt(1 - t * t)) / Math.PI
    let t90 = 0
    for (let t = 0; t <= 1; t += 1e-4) if (cover(t) <= 0.9) t90 = t
    const measured = width / (2 * t90)
    expect(Math.abs(measured - expected) / expected).toBeLessThan(0.1)
  })

  it('TAA lowers edge aliasing and does not ghost behind a moving object', {
    timeout: timeout(60_000),
  }, async () => {
    const size = 96
    const make = async (mode: 'none' | 'taa', scale = 1) => {
      const { app, world, targetRef } = await scene(size * scale, size * scale, 1)
      const quad = world.resource(Meshes).add(plane({ size: 1 }))
      const white = world.resource(Materials).add(
        new MaterialAsset({
          baseColor: [0, 0, 0, 1],
          emissive: [1, 1, 1, 1],
          emissiveLuminance: 500,
        }),
      )
      const bar = world.spawn(
        [Mesh3d, { mesh: quad }],
        [MeshMaterial, { material: white }],
        [
          Transform,
          {
            translation: [0, 0, -5],
            rotation: quat.multiply([0, 0, 0, 1], q(0, 0, 0.35), q(Math.PI / 2, 0, 0)) as never,
            scale: [2.2, 1, 0.9],
          },
        ],
      )
      const cam = world.spawn(
        [Camera3d, { target: targetRef as never, fovY: 40, clearColor: [0, 0, 0, 1] }],
        [Exposure, { ev100: 8 }],
        [Tonemapping, { curve: 'none', dither: false }],
        [Antialiasing, { mode }],
        Transform,
      )
      await settle(app)
      for (let i = 0; i < 24; i++) app.update(1 / 60)
      return { app, world, cam, bar }
    }
    const capture = async (s: Awaited<ReturnType<typeof make>>) => {
      const shot = captureView(s.world, `camera:${s.cam}`)
      s.app.update(1 / 60)
      return shot
    }
    // Ground truth: 4× the resolution, box-filtered down.
    const big = await capture(await make('none', 4))
    const truth = new Float32Array(size * size)
    for (let y = 0; y < size * 4; y++)
      for (let x = 0; x < size * 4; x++)
        truth[Math.floor(y / 4) * size + Math.floor(x / 4)]! +=
          big.data[(y * size * 4 + x) * 4]! / 16
    const error = (image: { data: Uint8Array }) => {
      let sum = 0
      let n = 0
      for (let i = 0; i < size * size; i++) {
        const t = truth[i]!
        if (t < 8 || t > 247) continue // only pixels on an edge
        sum += Math.abs(image.data[i * 4]! - t)
        n++
      }
      return sum / n
    }
    const none = error(await capture(await make('none')))
    const taaScene = await make('taa')
    const taa = error(await capture(taaScene))
    expect(taa).toBeLessThan(none * 0.7)

    // Now move the bar right, 2 px a frame, and look behind it.
    const { app, world, bar, cam } = taaScene
    const frames: Uint8Array[] = []
    const perPixel = (2 * Math.tan((40 * Math.PI) / 360) * 5) / size
    for (let i = 1; i <= 16; i++) {
      world.set(bar, Transform, { translation: [i * 2 * perPixel, 0, -5] })
      if (i % 4 === 0) {
        const shot = captureView(world, `camera:${cam}`)
        const v = captureBuffer(world, `camera:${cam}`, 'velocity')
        app.update(1 / 60)
        frames.push((await shot).data)
        if (i === 16) {
          // Velocity at the bar's center: 2 px right a frame, in uv units.
          const vel = await v
          const o = ((size / 2) * size + size / 2 + 32) * 4
          expect(vel.data[o]! * size).toBeCloseTo(2, 0)
        } else {
          await v
        }
      } else {
        app.update(1 / 60)
      }
    }
    // Where the bar was 16 frames ago (its left end, now 32 px behind) is background again.
    const last = frames.at(-1)!
    let ghost = 0
    for (let y = size / 2 - 2; y <= size / 2 + 2; y++) {
      for (let x = 8; x < 20; x++) ghost = Math.max(ghost, last[(y * size + x) * 4]!)
    }
    expect(ghost).toBeLessThan(20)
    const strip = new Uint8Array(size * size * 4 * frames.length)
    for (let y = 0; y < size; y++)
      for (let k = 0; k < frames.length; k++)
        strip.set(
          frames[k]!.subarray(y * size * 4, (y + 1) * size * 4),
          (y * frames.length + k) * size * 4,
        )
    expect(
      compareGolden(here, 'post-taa-motion', {
        width: size * frames.length,
        height: size,
        data: strip,
      }).mean,
    ).toBeLessThan(1.5)
  })
})
