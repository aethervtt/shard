import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import {
  readKtx2,
  Texture,
  Textures,
  textureFromKtx2,
  toHalf,
  writeKtx2,
} from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { readBuffer } from './debug-views'
import { DefaultEnvironment, EnvironmentMap, Environments, Skybox } from './environment'
import { forwardPlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { captureBuffer, describeRender, renderPlugin } from './plugin'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { TONEMAP_CURVES, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))

async function scene(width = 64, height = width) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'env-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'env-target')
  return { app, world: app.world, targetRef }
}

/** An equirect HDR texture from a function of direction (x, y, z) → linear rgb. */
function equirect(
  width: number,
  height: number,
  fn: (x: number, y: number, z: number) => [number, number, number],
): Texture {
  const f = new Float32Array(width * height * 4)
  for (let j = 0; j < height; j++) {
    const theta = ((j + 0.5) / height) * Math.PI
    for (let i = 0; i < width; i++) {
      // Matches shard::env::common::equirect_uv: u = atan2(z, x) / 2π + 0.5, v = acos(y) / π.
      const phi = ((i + 0.5) / width - 0.5) * 2 * Math.PI
      const x = Math.sin(theta) * Math.cos(phi)
      const z = Math.sin(theta) * Math.sin(phi)
      const y = Math.cos(theta)
      const [r, g, b] = fn(x, y, z)
      const o = (j * width + i) * 4
      f[o] = r
      f[o + 1] = g
      f[o + 2] = b
      f[o + 3] = 1
    }
  }
  return Texture.create({
    width,
    height,
    format: 'rgba16float',
    usage: 'hdr',
    mips: [new Uint8Array(toHalf(f).buffer)],
  })
}

/** A studio-like environment: sky gradient, a bright key light, colored panels, dark ground. */
const studio = (x: number, y: number, z: number): [number, number, number] => {
  if (y < 0) return [0.08, 0.06, 0.05]
  let c: [number, number, number] = [0.25 + 0.3 * y, 0.35 + 0.35 * y, 0.6 + 0.4 * y]
  const key = x * 0.55 + y * 0.64 + z * 0.53
  if (key > 0.97) c = [40, 38, 34]
  if (Math.abs(x - 0.9) < 0.12 && y < 0.4) c = [3, 0.4, 0.2]
  if (Math.abs(x + 0.9) < 0.12 && y < 0.4) c = [0.2, 1.5, 3]
  return c
}

describe('image-based lighting', () => {
  it('white furnace: a rough white dielectric under a uniform environment reflects L within 5%', async () => {
    const { app, world, targetRef } = await scene(32, 32)
    const L = 1000
    const env = world.resource(Textures).add(equirect(16, 8, () => [1, 1, 1]))
    const white = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [1, 1, 1, 1], roughness: 1 }))
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 1, segments: 48 })) }],
      [MeshMaterial, { material: white }],
      Transform,
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 20 }],
      [Exposure, { ev100: 9 }],
      [EnvironmentMap, { texture: env, intensity: L }],
      [Transform, { translation: [0, 0, 5] }],
    )
    await settle(app)
    const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
    app.update(1 / 60)
    const hdr = await shot
    const [r, g, b] = pixel(hdr, 16, 16)
    for (const c of [r!, g!, b!]) expect(Math.abs(c - L) / L).toBeLessThan(0.05)
  })

  it('renders a metallic × roughness grid under an HDR environment with every curve', async () => {
    const results: number[] = []
    for (const curve of TONEMAP_CURVES) {
      const { app, world, targetRef } = await scene(160, 96)
      const env = world.resource(Textures).add(equirect(256, 128, studio))
      const ball = world.resource(Meshes).add(sphere({ radius: 0.42, segments: 32 }))
      const materials = world.resource(Materials)
      for (let m = 0; m < 2; m++) {
        for (let r = 0; r < 5; r++) {
          const material = materials.add(
            new MaterialAsset({
              baseColor: m ? [0.95, 0.75, 0.4, 1] : [0.8, 0.1, 0.1, 1],
              metallic: m,
              roughness: 0.05 + r * 0.22,
            }),
          )
          world.spawn(
            [Mesh3d, { mesh: ball }],
            [MeshMaterial, { material }],
            [Transform, { translation: [(r - 2) * 1, m ? -0.5 : 0.5, 0] }],
          )
        }
      }
      const cam = world.spawn(
        [Camera3d, { target: targetRef, fovY: 36 }],
        [Exposure, { ev100: 10.5 }],
        [EnvironmentMap, { texture: env, intensity: 1000 }],
        Skybox,
        [Tonemapping, { curve, dither: false }],
        [Transform, { translation: [0, 0, 4.2] }],
      )
      const image = await renderView(app, `camera:${cam}`)
      results.push(compareGolden(here, `ibl-grid-${curve}`, image).mean)
      if (curve === 'agx') {
        // Metals reflect the environment: the smooth gold ball shows the blue panel and the key.
        let hi = 0
        let lo = 255
        for (let y = 50; y < 80; y++) {
          for (let x = 8; x < 40; x++) {
            const [v] = pixel(image, x, y)
            hi = Math.max(hi, v!)
            lo = Math.min(lo, v!)
          }
        }
        expect(hi - lo).toBeGreaterThan(60)
      }
    }
    for (const mean of results) expect(mean).toBeLessThan(1.5)
  })

  it('orients equirect maps as documented and accepts cube-map KTX2 sources', async () => {
    const look = async (texture: Texture, dir: [number, number, number]) => {
      const { app, world, targetRef } = await scene(8, 8)
      const env = world.resource(Textures).add(texture)
      const up: [number, number, number] = Math.abs(dir[1]) > 0.5 ? [0, 0, -1] : [0, 1, 0]
      const cam = world.spawn(
        [Camera3d, { target: targetRef, fovY: 10 }],
        [Exposure, { ev100: 0 }],
        [EnvironmentMap, { texture: env, intensity: 1 }],
        Skybox,
        [Transform, { rotation: lookAt([0, 0, 0], dir, up) }],
      )
      await settle(app)
      const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
      app.update(1 / 60)
      return pixel(await shot, 4, 4).slice(0, 3)
    }
    const axes = (x: number, y: number, z: number): [number, number, number] => {
      const a = [Math.abs(x), Math.abs(y), Math.abs(z)]
      if (a[0]! > a[1]! && a[0]! > a[2]!) return x > 0 ? [1, 0, 0] : [0, 1, 1]
      if (a[1]! > a[2]!) return y > 0 ? [0, 1, 0] : [1, 0, 1]
      return z > 0 ? [0, 0, 1] : [1, 1, 0]
    }
    const map = equirect(64, 32, axes)
    const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]!) < 0.05)
    expect(near(await look(map, [1, 0, 0]), [1, 0, 0])).toBe(true)
    expect(near(await look(map, [0, 0, -1]), [1, 1, 0])).toBe(true)
    expect(near(await look(map, [0, 1, 0]), [0, 1, 0])).toBe(true)
    // A cube KTX2 with one color per face (+X, -X, +Y, -Y, +Z, -Z): same colors, same directions.
    const size = 4
    const faces = [
      [1, 0, 0],
      [0, 1, 1],
      [0, 1, 0],
      [1, 0, 1],
      [0, 0, 1],
      [1, 1, 0],
    ]
    const level = new Float32Array(size * size * 4 * 6)
    for (let f = 0; f < 6; f++)
      for (let i = 0; i < size * size; i++) level.set([...faces[f]!, 1], (f * size * size + i) * 4)
    const ktx = writeKtx2({ width: size, height: size, levels: [level] } as never, 'hdr', 6)
    expect(readKtx2(ktx).faces).toBe(6)
    const cube = await textureFromKtx2(ktx, { cpu: true })
    expect(cube.faces).toBe(6)
    expect(near(await look(cube, [1, 0, 0]), [1, 0, 0])).toBe(true)
    expect(near(await look(cube, [0, -1, 0]), [1, 0, 1])).toBe(true)
    expect(near(await look(cube, [0, 0, 1]), [0, 0, 1])).toBe(true)
  })
})

/** Mean CIE76 ΔE between two sRGB RGBA8 images (D65). */
function meanDeltaE(a: Uint8Array, b: Uint8Array): number {
  const lab = (d: Uint8Array, o: number) => {
    const lin = [0, 1, 2].map((c) => {
      const v = d[o + c]! / 255
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    const [r, g, b] = lin as [number, number, number]
    const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    const z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116)
    return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))]
  }
  let sum = 0
  for (let o = 0; o < a.length; o += 4) {
    const p = lab(a, o)
    const q = lab(b, o)
    sum += Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!)
  }
  return sum / (a.length / 4)
}

describe('procedural sky', () => {
  const rad = (deg: number) => (deg * Math.PI) / 180

  async function skyScene(elevation: number) {
    const { app, world, targetRef } = await scene(128, 72)
    const sun = world.spawn(
      [DirectionalLight, { illuminance: 100_000 }],
      // Pitch the light down by the elevation, facing -X: the sun sits in the +X sky.
      [
        Transform,
        { rotation: quat.fromEuler([0, 0, 0, 1], -rad(elevation), rad(-90), 0) as never },
      ],
    )
    world.resource(DefaultEnvironment).sky = {}
    const rough = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.8, 0.8, 0.8, 1], roughness: 1 }))
    const ball = world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(sphere({ radius: 0.5, segments: 32 })) }],
      [MeshMaterial, { material: rough }],
      [Transform, { translation: [0, 0.2, -3] }],
    )
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 200 })) }],
      [MeshMaterial, { material: rough }],
      [Transform, { translation: [0, -0.3, 0] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 70 }],
      [Exposure, { ev100: elevation > 30 ? 13 : elevation > 0 ? 11 : 7 }],
      [Transform, { translation: [0, 0.4, 0], rotation: lookAt([0, 0.4, 0], [3, 1.2, -3]) }],
    )
    return { app, world, cam, sun, ball }
  }

  it('renders plausible skies at 60°, 10°, and −2° sun elevations (golden images)', async () => {
    const colors: Record<number, number[]> = {}
    for (const elevation of [60, 10, -2]) {
      const { app, world, cam } = await skyScene(elevation)
      const image = await renderView(app, `camera:${cam}`)
      const name = `${elevation < 0 ? 'm' : ''}${Math.abs(elevation)}`
      expect(compareGolden(here, `sky-${name}`, image).mean).toBeLessThan(1.5)
      // Against 0019's single-scattering sky: ProceduralSky is now an Earth Atmosphere (spec 0044),
      // lighter with multiple scattering (mean ΔE 7.6 at 60°, 7.0 at 10°). After sunset 0019 went
      // black; the twilight sky now stays lit (ΔE 24).
      const before = new Uint8Array(readFileSync(join(here, '__golden__', `sky-0019-${name}.rgba`)))
      expect(meanDeltaE(before, image.data)).toBeLessThan(elevation < 0 ? 26 : 8.5)
      // The sky high above the horizon, in HDR (cd/m²).
      const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
      app.update(1 / 60)
      colors[elevation] = pixel(await shot, 64, 4).slice(0, 3)
      const sky = describeRender(world).environment as {
        views: Record<string, { environment: { source: string; sunDiskLuminance: number } }>
      }
      expect(sky.views[`camera:${cam}`]!.environment.source).toBe('procedural-sky')
    }
    const [r60, g60, b60] = colors[60]!
    expect(b60!).toBeGreaterThan(r60! * 1.5) // blue at noon
    expect(b60!).toBeGreaterThan(g60!)
    const [r10, , b10] = colors[10]!
    expect(r10! / b10!).toBeGreaterThan(r60! / b60!) // warmer toward dusk
    const lum = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
    expect(lum(colors[-2]!)).toBeLessThan(lum(colors[60]!) / 5) // dark after sunset
    // Single scattering of a 100 000 lux sun: hundreds to thousands of cd/m² at noon.
    expect(lum(colors[60]!)).toBeGreaterThan(500)
  })

  it('rebakes when the sun moves, and a rough sphere ambient follows', async () => {
    const { app, world, cam, sun } = await skyScene(60)
    await settle(app)
    const env = world.resource(Environments).cameras.get(cam)!.environment!
    const bakes = env.bakes
    // A rough sphere's ambient is the SH irradiance; read it for an upward normal.
    const skyIrradiance = async () => {
      const sh = new Float32Array(await readBuffer(gpu, env.sh.buffer, 9 * 16))
      // Band 0 plus band 1's y term (normal = +Y): Y00 = 0.282095, Y1-1 = 0.488603 · y.
      return [0, 1, 2].map((c) => sh[c]! * 0.282095 + sh[4 + c]! * 0.488603)
    }
    const noon = await skyIrradiance()
    world.set(sun, Transform, {
      rotation: quat.fromEuler([0, 0, 0, 1], -rad(8), rad(-90), 0) as never,
    })
    await settle(app)
    expect(env.bakes).toBeGreaterThan(bakes)
    const dusk = await skyIrradiance()
    // Bluish at noon, warmer and dimmer toward dusk.
    expect(noon[2]!).toBeGreaterThan(noon[0]!)
    expect(dusk[0]! / dusk[2]!).toBeGreaterThan(noon[0]! / noon[2]!)
    expect(dusk[1]!).toBeLessThan(noon[1]!)
    // The rough sphere is lit by it: its HDR color changes with the sky.
    const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
    app.update(1 / 60)
    expect((await shot).data.some((v) => Number.isNaN(v))).toBe(false)
  })
})
