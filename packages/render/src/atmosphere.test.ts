import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Entity, ProfilerResource, quat } from '@shard/core'
import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { box, plane } from '@shard/mesh'
import { App, LogResource } from '@shard/runtime'
import { Texture, Textures } from '@shard/texture'
import { lookAt, Transform, TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import {
  Atmosphere,
  AtmospherePresets,
  Atmospheres,
  atmosphereMethods,
  sampleAtmosphere,
  sunTransmittanceAt,
} from './atmosphere'
import { transmittanceUnit } from './atmosphere-model'
import { AtmosphereGpuResource } from './atmosphere-nodes'
import { Camera3d, Exposure } from './camera'
import { readTextureLayer } from './debug-views'
import { EnvironmentMap, Skybox } from './environment'
import { forwardPlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { captureBuffer, describeRender, Gpu, renderPlugin } from './plugin'
import { Fog, PostEffect } from './post'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { Cameras, RenderPath } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)
const rad = (d: number) => (d * Math.PI) / 180
const R = 6_360_000
const lum = (c: ArrayLike<number>) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!

async function scene(width: number, height: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'atmosphere', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'atmosphere')
  return { app, world: app.world, targetRef }
}

/** A sun at an elevation, toward azimuth +X (yaw 90°) by default. */
function sun(world: App['world'], elevation: number, yaw = 90, illuminance = 100_000) {
  return world.spawn(
    [DirectionalLight, { illuminance }],
    [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -rad(elevation), rad(yaw), 0) as never }],
  )
}

/** A unit direction at an azimuth from +X toward -Z and an elevation, in degrees. */
function dir(azimuth: number, elevation: number): [number, number, number] {
  const a = rad(azimuth)
  const e = rad(elevation)
  return [Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a)]
}

function camera(
  world: App['world'],
  target: unknown,
  eye: [number, number, number],
  look: [number, number, number],
  ev100: number,
  extra: unknown[] = [],
  fovY = 60,
) {
  const at: [number, number, number] = [eye[0] + look[0], eye[1] + look[1], eye[2] + look[2]]
  return world.spawn(
    [Camera3d, { target, fovY, near: 0.5 }],
    [Exposure, { ev100 }],
    ...(extra as never[]),
    [Transform, { translation: eye, rotation: lookAt(eye, at) }],
  )
}

/**
 * HDR radiance (cd/m²; the capture divides out pre-exposure) of a camera's frame, settled, after
 * the post chain's aerial perspective.
 */
async function hdr(app: App, cam: Entity) {
  await settle(app)
  const shot = captureBuffer(app.world, `camera:${cam}`, 'post-hdr')
  app.update(1 / 60)
  const image = await shot
  const k = 1
  return {
    image,
    at: (x: number, y: number) =>
      pixel(image, x, y)
        .slice(0, 3)
        .map((v) => v * k),
    mean: () => {
      let s = 0
      const d = image.data
      for (let i = 0; i < d.length; i += 4) s += lum([d[i]!, d[i + 1]!, d[i + 2]!])
      return (s / (d.length / 4)) * k
    },
  }
}

const EV = { 60: 13.5, 10: 12, 0: 10, [-4]: 6 } as Record<number, number>

describe('atmosphere (spec 0044)', () => {
  it('renders Earth at sun elevations 60°, 10°, 0°, −4° from 2 m, 10 km, and 400 km (goldens)', async () => {
    for (const altitude of [2, 10_000, 400_000]) {
      for (const elevation of [60, 10, 0, -4]) {
        const { app, world, targetRef } = await scene(96, 54)
        world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
        sun(world, elevation)
        // Forty degrees off the sun; from orbit, down past the limb.
        const look = altitude > 100_000 ? dir(40, -12) : dir(40, 8)
        // From orbit the lit day side fills the frame whatever the local sun: one exposure.
        const ev = altitude > 100_000 ? 14 : EV[elevation]!
        const cam = camera(world, targetRef, [0, altitude, 0], look, ev)
        const image = await renderView(app, `camera:${cam}`)
        const name = `atmosphere-earth-${altitude >= 1000 ? `${altitude / 1000}km` : `${altitude}m`}-${elevation < 0 ? 'm' : ''}${Math.abs(elevation)}`
        expect(compareGolden(here, name, image).mean).toBeLessThan(1.5)
        expect(world.resource(Gpu).errors).toEqual([])
      }
    }
  }, 120_000)

  it('zenith luminance at a 60° sun from 2 m matches the model (GPU and CPU agree)', async () => {
    const { app, world, targetRef } = await scene(32, 32)
    const planet = world.spawn(
      [Atmosphere, AtmospherePresets.earth],
      [Transform, { translation: [0, -R, 0] }],
    )
    sun(world, 60)
    const cam = camera(world, targetRef, [0, 2, 0], dir(180, 89.5), 13.5, [], 10)
    const gpuZenith = lum((await hdr(app, cam)).at(16, 16))
    const cpu = sampleAtmosphere(world, planet, [0, 2, 0], [0, 1, 0])
    // Hillaire's Earth coefficients with a 100 klux sun: ~1.55 kcd/m². Rayleigh single scattering
    // alone is E·τ·P = 100 000 × 0.108 × 0.105 ≈ 1.1 kcd/m² (green); multiple scattering adds the rest.
    expect(Math.abs(cpu.luminance - 1550) / 1550).toBeLessThan(0.15)
    expect(Math.abs(gpuZenith - cpu.luminance) / cpu.luminance).toBeLessThan(0.03)
    // Blue overhead.
    expect(cpu.radiance[2]).toBeGreaterThan(cpu.radiance[0] * 3)
  })

  it('Mars at sunset: bluish near the sun, butterscotch overhead', async () => {
    const { app, world, targetRef } = await scene(96, 54)
    const mars = world.spawn(
      [Atmosphere, { ...AtmospherePresets.mars, bottomRadius: 3_389_500 }],
      [Transform, { translation: [0, -3_389_500, 0] }],
    )
    sun(world, 2, 90, 43_000)
    app.update(1 / 60)
    const hue = (c: number[]) => {
      const [r, g, b] = c as [number, number, number]
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      if (max === min) return 0
      const h =
        max === r
          ? (g - b) / (max - min)
          : max === g
            ? 2 + (b - r) / (max - min)
            : 4 + (r - g) / (max - min)
      return (h * 60 + 360) % 360
    }
    const near = sampleAtmosphere(world, mars, [0, 2, 0], dir(2, 5)).radiance
    const overhead = sampleAtmosphere(world, mars, [0, 2, 0], [0, 1, 0]).radiance
    // Near the sun: blue dominates (hue 180°–260°). Overhead: a warm yellow-orange (25°–60°).
    expect(near[2]).toBeGreaterThan(near[0])
    expect(hue(near)).toBeGreaterThan(180)
    expect(hue(near)).toBeLessThan(260)
    expect(overhead[0]).toBeGreaterThan(overhead[2])
    expect(hue(overhead)).toBeGreaterThan(25)
    expect(hue(overhead)).toBeLessThan(60)
    const cam = camera(world, targetRef, [0, 2, 0], dir(20, 12), 7, [], 70)
    const image = await renderView(app, `camera:${cam}`)
    expect(compareGolden(here, 'atmosphere-mars-sunset', image).mean).toBeLessThan(1.5)
  })

  it('flies from 2 m to 400 km and back in 20 s without a jump in luminance', async () => {
    // Big enough that the horizon crossing a pixel row isn't itself a 3% step.
    const { app, world, targetRef } = await scene(64, 36)
    world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
    sun(world, 30)
    const ev = 13
    const cam = camera(world, targetRef, [0, 2, 0], dir(40, 0), ev)
    await settle(app)
    const FRAMES = 1200
    const means: number[] = []
    for (let f = 0; f <= FRAMES; f++) {
      const t = f / FRAMES
      const up = t < 0.5 ? t * 2 : (1 - t) * 2
      const altitude = 2 * 200_000 ** up
      const eye: [number, number, number] = [0, altitude, 0]
      const look = dir(40, 0)
      world.set(cam, Transform, {
        translation: eye,
        rotation: lookAt(eye, [eye[0] + look[0], eye[1] + look[1], eye[2] + look[2]]) as never,
      })
      const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
      app.update(1 / 60)
      const image = await shot
      let s = 0
      for (let i = 0; i < image.data.length; i += 4)
        s += lum([image.data[i]!, image.data[i + 1]!, image.data[i + 2]!])
      means.push(s)
    }
    let worst = 0
    for (let i = 1; i < means.length; i++) {
      worst = Math.max(worst, Math.abs(means[i]! - means[i - 1]!) / Math.max(means[i - 1]!, 1e-6))
    }
    expect(worst).toBeLessThan(0.03)
    expect(world.resource(Gpu).errors).toEqual([])
  }, 120_000)

  it('hazes terrain 20 km away more than terrain 1 km away, the same in forward and deferred', async () => {
    const images = []
    const measured = []
    for (const deferred of [false, true]) {
      const { app, world, targetRef } = await scene(160, 90)
      world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
      sun(world, 35, 60)
      const materials = world.resource(Materials)
      const grass = materials.add(
        new MaterialAsset({ baseColor: [0.1, 0.25, 0.08, 1], roughness: 1 }),
      )
      const rock = materials.add(
        new MaterialAsset({ baseColor: [0.05, 0.05, 0.05, 1], roughness: 1 }),
      )
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 200_000 })) }],
        [MeshMaterial, { material: grass }],
        Transform,
      )
      const slab = world.resource(Meshes).add(box())
      // Two hills the same size on screen: 60 m at 1 km, 1 200 m at 20 km.
      for (const [x, d, s] of [
        [-1, 1000, 60],
        [1, 20_000, 1200],
      ] as const) {
        world.spawn(
          [Mesh3d, { mesh: slab }],
          [MeshMaterial, { material: rock }],
          [Transform, { translation: [x * d * 0.15, s * 0.5, -d], scale: [s, s, s] }],
        )
      }
      const eye: [number, number, number] = [0, 20, 0]
      const cam = world.spawn(
        [Camera3d, { target: targetRef, fovY: 40, near: 0.5 }],
        [Exposure, { ev100: 14 }],
        ...(deferred ? [[RenderPath, { mode: 'deferred' }] as never] : []),
        [Transform, { translation: eye, rotation: lookAt(eye, [0, 150, -2000]) }],
      )
      const h = await hdr(app, cam)
      // Hill centers, and the sky just above the horizon between them.
      const near = h.at(59, 42)
      const far = h.at(101, 42)
      const sky = h.at(80, 30)
      measured.push({ near, far, sky })
      images.push(await renderView(app, `camera:${cam}`))
    }
    for (const { near, far, sky } of measured) {
      // Haze moves a dark hill toward the horizon sky, and turns it blue.
      const toSky = (c: number[]) => Math.abs(lum(sky) - lum(c)) / lum(sky)
      expect(toSky(far)).toBeLessThan(toSky(near) * 0.8)
      expect(far[2]! / far[0]!).toBeGreaterThan(near[2]! / near[0]!)
    }
    // Forward and deferred: within 1% (2.55 levels on average).
    const [a, b] = images as unknown as [{ data: Uint8Array }, { data: Uint8Array }]
    let sum = 0
    for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!)
    expect(sum / a.data.length).toBeLessThan(2.55)
  })

  it('shows a moon’s atmosphere as a limb, from the planet’s surface and from orbit', async () => {
    for (const altitude of [2, 800_000]) {
      const { app, world, targetRef } = await scene(128, 128)
      world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
      const center: [number, number, number] = [0, 30_000_000, -40_000_000]
      world.spawn(
        // Titan-like: tall enough to see from far away.
        [
          Atmosphere,
          {
            ...AtmospherePresets.earth,
            bottomRadius: 1_000_000,
            thickness: 150_000,
            rayleighScale: 20_000,
          },
        ],
        [Transform, { translation: center }],
      )
      // Night on the planet (its sky would drown a thin limb), the moon lit from below the horizon.
      sun(world, -20)
      const eye: [number, number, number] = [0, altitude, 0]
      const to = center.map((v, i) => v - eye[i]!) as [number, number, number]
      const cam = camera(world, targetRef, eye, to, 12, [], 3.2)
      const h = await hdr(app, cam)
      const d = describeRender(world).atmosphere as {
        views: Record<string, { secondaries: { pixels: number }[] }>
      }
      expect(d.views[`camera:${cam}`]!.secondaries).toHaveLength(1)
      // Screen radii of the surface and the top, from the camera's focal length in pixels.
      const dist = Math.hypot(...to)
      const focal = 64 / Math.tan(rad(1.6))
      const rb = (1_000_000 / dist) * focal
      const rt = (1_150_000 / dist) * focal
      // Along the lit (+X) side: the disk, then the glowing shell, then the sky behind.
      const disk = lum(h.at(Math.round(64 + rb * 0.8), 64))
      const shell = lum(h.at(Math.round(64 + rb + 1.5), 64))
      const behind = lum(h.at(Math.min(127, Math.round(64 + rt + 4)), 64))
      expect(disk).toBeGreaterThan(shell)
      expect(shell).toBeGreaterThan(behind + Math.max(behind * 0.01, 0.5))
    }
  })

  it('dims sunlight near the horizon and sunTransmittanceAt matches the GPU LUT within 1%', async () => {
    const { app, world, targetRef } = await scene(16, 16)
    const planet = world.spawn(
      [Atmosphere, AtmospherePresets.earth],
      [Transform, { translation: [0, -R, 0] }],
    )
    const light = sun(world, 90)
    const cam = camera(world, targetRef, [0, 2, 0], dir(0, 0), 13)
    await settle(app)
    type Sun = { illuminanceAtCamera: number; transmittance: number[] }
    const atCamera = () =>
      (describeRender(world).atmosphere as { views: Record<string, { suns: Sun[] }> }).views[
        `camera:${cam}`
      ]!.suns[0]!
    const noon = atCamera().illuminanceAtCamera
    world.set(light, Transform, {
      rotation: quat.fromEuler([0, 0, 0, 1], -rad(2), rad(90), 0) as never,
    })
    app.update(1 / 60)
    const dusk = atCamera().illuminanceAtCamera
    expect(dusk).toBeLessThan(noon * 0.15)
    expect(dusk).toBeGreaterThan(0)
    // The renderer's value is the gameplay value.
    const T = sunTransmittanceAt(world, planet, [0, 2, 0])
    expect(atCamera().transmittance[0]).toBeCloseTo(T[0], 3)
    // The shader's transmittance LUT, read back and sampled like the shader does.
    const store = world.resource(Atmospheres)
    const rec = store.records.get(planet)!
    const lut = await readTextureLayer(
      gpu,
      world.resource(AtmosphereGpuResource).transmittance,
      rec.layer,
    )
    const m = rec.model
    const unit = new Float64Array(2)
    const sampleLut = (r: number, mu: number) => {
      transmittanceUnit(m, r, mu, unit)
      const fx = unit[0]! * (lut.width - 1)
      const fy = unit[1]! * (lut.height - 1)
      const x0 = Math.min(lut.width - 2, Math.floor(fx))
      const y0 = Math.min(lut.height - 2, Math.floor(fy))
      const ax = fx - x0
      const ay = fy - y0
      const at = (x: number, y: number, c: number) => lut.data[(y * lut.width + x) * 4 + c]!
      return [0, 1, 2].map(
        (c) =>
          (at(x0, y0, c) * (1 - ax) + at(x0 + 1, y0, c) * ax) * (1 - ay) +
          (at(x0, y0 + 1, c) * (1 - ax) + at(x0 + 1, y0 + 1, c) * ax) * ay,
      )
    }
    for (const elevation of [2, 10, 30, 60, 90]) {
      world.set(light, Transform, {
        rotation: quat.fromEuler([0, 0, 0, 1], -rad(elevation), rad(90), 0) as never,
      })
      app.update(1 / 60)
      const cpu = sunTransmittanceAt(world, planet, [0, 2, 0])
      const shader = sampleLut(R / 1000 + 0.002, Math.sin(rad(elevation)))
      expect(Math.abs(lum(shader) - lum(cpu)) / lum(cpu)).toBeLessThan(0.01)
    }
  })

  it('costs little per frame over a skybox: one primary with aerial perspective, and four atmospheres', async () => {
    /** GPU time of one frame: submit to done, the queue idle when it starts. */
    async function frameMs(app: App) {
      await gpu.device.queue.onSubmittedWorkDone()
      app.update(1 / 60)
      const t = performance.now()
      await gpu.device.queue.onSubmittedWorkDone()
      return performance.now() - t
    }
    /** The 25th percentile: steady-state cost, past the odd frame the machine stalls. */
    const quartile = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 2]!
    /**
     * 1080p, MSAA 4x, ground to the horizon. Without atmospheres, the camera draws a Skybox: every
     * sky has a background pass, so the atmosphere's cost is what it adds over one.
     */
    async function build(atmospheres: number) {
      const { app, world, targetRef } = await scene(1920, 1080)
      const ground = world
        .resource(Materials)
        .add(new MaterialAsset({ baseColor: [0.2, 0.3, 0.1, 1] }))
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 100_000 })) }],
        [MeshMaterial, { material: ground }],
        Transform,
      )
      sun(world, 30)
      const moons = [
        [-2e7, 3e7, -4e7],
        [0, 3.2e7, -4e7],
        [2e7, 3e7, -4e7],
      ] as const
      const extra: unknown[] = []
      if (atmospheres === 0) {
        const map = Texture.create({
          width: 4,
          height: 2,
          format: 'rgba16float',
          usage: 'hdr',
          mips: [new Uint8Array(64)],
        })
        extra.push([EnvironmentMap, { texture: world.resource(Textures).add(map) }], Skybox)
      } else {
        world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
      }
      for (let i = 0; i < atmospheres - 1; i++) {
        world.spawn(
          [Atmosphere, { ...AtmospherePresets.thin, bottomRadius: 3_000_000, thickness: 200_000 }],
          [Transform, { translation: moons[i] as never }],
        )
      }
      const cam = camera(world, targetRef, [0, 30, 0], dir(90, 25), 13, extra, 90)
      await settle(app)
      return { app, world, cam }
    }
    const skybox = await build(0)
    const one = await build(1)
    const four = await build(4)
    // Frame by frame in turn, so the machine's load (other tests share the GPU) hits all three.
    const times: [number[], number[], number[]] = [[], [], []]
    for (let f = 0; f < 90; f++) {
      times[0].push(await frameMs(skybox.app))
      times[1].push(await frameMs(one.app))
      times[2].push(await frameMs(four.app))
    }
    const base = quartile(times[0])
    const primary = quartile(times[1])
    const all = quartile(times[2])
    const d = describeRender(four.world).atmosphere as {
      views: Record<string, { secondaries: unknown[] }>
    }
    expect(d.views[`camera:${four.cam}`]!.secondaries).toHaveLength(3)
    expect(primary - base).toBeLessThan(budget(0.6))
    expect(all - base).toBeLessThan(budget(1.2))
    // Nothing recomputes per frame: the LUTs stay as they are, and selection is cheap.
    const s = one.world.resource(AtmosphereGpuResource)
    const computes = s.lutComputes
    for (let i = 0; i < 30; i++) one.app.update(1 / 60)
    expect(s.lutComputes).toBe(computes)
    const select = one.world.resource(ProfilerResource).timing('render/atmosphere-select')!
    expect(select.avg).toBeLessThan(budget(0.1))
  }, 120_000)

  it('keeps the same image far from the origin (camera-relative math)', async () => {
    const images = []
    for (const offset of [0, 3_000_000]) {
      const { app, world, targetRef } = await scene(64, 36)
      world.spawn(
        [Atmosphere, AtmospherePresets.earth],
        [Transform, { translation: [offset, -R, 0] }],
      )
      sun(world, 20)
      const cam = camera(world, targetRef, [offset, 10_000, 0], dir(40, 5), 12)
      images.push(await renderView(app, `camera:${cam}`))
    }
    const [a, b] = images as unknown as [{ data: Uint8Array }, { data: Uint8Array }]
    let sum = 0
    for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!)
    expect(sum / a.data.length).toBeLessThan(1)
  })

  it('draws both disks of a binary star and lights the sky with both', async () => {
    const { app, world, targetRef } = await scene(64, 64)
    world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
    sun(world, 20, 85)
    sun(world, 20, 95, 40_000)
    const cam = camera(world, targetRef, [0, 2, 0], dir(0, 20), 14, [], 20)
    const h = await hdr(app, cam)
    // The suns are ±5° of azimuth from the view axis: one disk in each half of the frame.
    const brightest = (x0: number, x1: number) => {
      let best = 0
      for (let y = 0; y < 64; y++)
        for (let x = x0; x < x1; x++) best = Math.max(best, lum(h.at(x, y)))
      return best
    }
    const sky = lum(h.at(32, 5))
    expect(brightest(0, 30)).toBeGreaterThan(sky * 100)
    expect(brightest(34, 64)).toBeGreaterThan(sky * 100)
  })

  it('thickens a gas giant’s deck to opaque cloud as the camera dives', async () => {
    const app = new App().addPlugin(TransformPlugin)
    await app.init()
    const world = app.world
    world.initResource(Atmospheres)
    const giant = world.spawn(
      [Atmosphere, AtmospherePresets['gas-giant']],
      [Transform, { translation: [0, -69_911_000, 0] }],
    )
    app.update(1 / 60)
    const up = (depth: number) => sampleAtmosphere(world, giant, [0, -depth, 0], [0, 1, 0])
    const t = [0, 50_000, 120_000, 199_000].map((depth) => lum(up(depth).transmittance))
    for (let i = 1; i < t.length; i++) expect(t[i]!).toBeLessThan(t[i - 1]!)
    expect(t[t.length - 1]!).toBeLessThan(1e-3)
  })

  it('answers atmosphere.sample: the sky from 2 m and from 40 km', async () => {
    const { app, world, targetRef } = await scene(8, 8)
    const planet = world.spawn(
      [Atmosphere, AtmospherePresets.earth],
      [Transform, { translation: [0, -R, 0] }],
    )
    sun(world, 45)
    camera(world, targetRef, [0, 2, 0], dir(0, 0), 13)
    app.update(1 / 60)
    const method = atmosphereMethods.find((m) => m.name === 'atmosphere.sample')!
    const call = (p: Record<string, unknown>) =>
      method.handler({ world } as never, method.params.deserialize(p) as never) as {
        luminance: number
        transmittance: number[]
        inside: boolean
        altitude: number
        entity: Entity
      }
    const ground = call({ direction: [0, 1, 0] })
    expect(ground.entity).toBe(planet)
    expect(ground.altitude).toBeCloseTo(2, 1)
    const high = call({ position: [0, 40_000, 0], direction: [0, 1, 0] })
    expect(high.inside).toBe(true)
    // At 40 km the sky is nearly black and almost all of space shows through.
    expect(high.luminance).toBeLessThan(ground.luminance * 0.05)
    expect(high.transmittance[1]).toBeGreaterThan(0.99)
    expect(() => call({ direction: [0, 1] })).toThrow(
      expect.objectContaining({ code: 'render/bad-vector' }),
    )
  })

  it('ignores Fog inside an atmosphere (render/fog-with-atmosphere) unless it adds', async () => {
    for (const mode of ['default', 'add'] as const) {
      const { app, world, targetRef } = await scene(8, 8)
      world.spawn([Atmosphere, AtmospherePresets.earth], [Transform, { translation: [0, -R, 0] }])
      sun(world, 45)
      const cam = camera(world, targetRef, [0, 2, 0], dir(0, 0), 13, [[Fog, { mode }]])
      app.update(1 / 60)
      const effects = world.resource(Cameras).get(cam)!.post.effects
      const warned = world
        .resource(LogResource)
        .tail(50, 'warn')
        .some((e) => e.code === 'render/fog-with-atmosphere')
      expect(warned).toBe(mode === 'default')
      expect((effects & PostEffect.Fog) !== 0).toBe(mode === 'add')
    }
  })

  it('reports render/atmosphere-inside-ground for a thickness of 0', async () => {
    const { app, world, targetRef } = await scene(8, 8)
    world.spawn([Atmosphere, { thickness: 0 }], [Transform, { translation: [0, -R, 0] }])
    camera(world, targetRef, [0, 2, 0], dir(0, 0), 13)
    app.update(1 / 60)
    app.update(1 / 60)
    const errors = world.resource(LogResource).errors()
    expect(errors.filter((e) => e.code === 'render/atmosphere-inside-ground')).toHaveLength(1)
    const d = describeRender(world).atmosphere as { atmospheres: { problem: { code: string } }[] }
    expect(d.atmospheres[0]!.problem.code).toBe('render/atmosphere-inside-ground')
  })
})
