import { writeFileSync } from 'node:fs'
import { quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { DefaultEnvironment, EnvironmentMap, Environments, Skybox } from './environment'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { renderPlugin } from './plugin'
import { AutoExposure, Bloom, DepthOfField, Fog, Ssao } from './post'
import { ExposureMeters } from './post-nodes'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { meanDifference, pngBytes, renderView, settle, watchBaseline } from './testing'
import { Tonemapping } from './view'

// The baseline tier's effects (0064): image-based lighting prefiltered by fragment passes, the
// atmosphere's LUTs, sky-view, froxels and environment bake as fragment passes, and auto exposure
// metered from a read-back image. Each scene renders on a compatibility-mode device as it does on
// the full tier, with no compute pass and no storage in a render stage.

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  full.destroy()
  compat.destroy()
})

const W = 96
const H = 64

async function scene(gpu: GpuContext) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'effects', width: W, height: H }), 'effects')
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  for (let i = 0; i < 3; i++) {
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.45, segments: 32 })) }],
      [
        MeshMaterial,
        {
          material: materials.add(
            new MaterialAsset({
              baseColor: [0.9, 0.9, 0.9, 1],
              metallic: i / 2,
              roughness: 0.2 + i * 0.35,
            }),
          ),
        },
      ],
      [Transform, { translation: [-1.1 + i * 1.1, 0.45, 0] }],
    )
  }
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 30 })) }],
    [MeshMaterial, { material: materials.add(new MaterialAsset({ roughness: 0.9 })) }],
    Transform,
  )
  return { app, world, target }
}

/** An equirect sky: gradient, a warm key light, darker ground. */
function studio(): Texture {
  const w = 32
  const h = 16
  const half = new Uint16Array(w * h * 4)
  const toHalf = (v: number) => {
    const f = new Float32Array([v])
    const x = new Uint32Array(f.buffer)[0]!
    const e = ((x >> 23) & 0xff) - 127 + 15
    if (e <= 0) return 0
    if (e >= 31) return 0x7bff
    return ((x >> 16) & 0x8000) | (e << 10) | ((x >> 13) & 0x3ff)
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const up = 1 - (j + 0.5) / (h / 2)
      const c = up < 0 ? [0.08, 0.06, 0.05] : [0.25 + 0.3 * up, 0.35 + 0.35 * up, 0.6 + 0.4 * up]
      if (i === 5 && j === 4) c.splice(0, 3, 40, 36, 30)
      const o = (j * w + i) * 4
      half[o] = toHalf(c[0]!)
      half[o + 1] = toHalf(c[1]!)
      half[o + 2] = toHalf(c[2]!)
      half[o + 3] = toHalf(1)
    }
  }
  return Texture.create({
    width: w,
    height: h,
    format: 'rgba16float',
    usage: 'hdr',
    mips: [new Uint8Array(half.buffer)],
  })
}

function camera(
  world: Awaited<ReturnType<typeof scene>>['world'],
  target: unknown,
  extra: unknown[],
  ev100: number,
) {
  return world.spawn(
    [Camera3d, { target: target as never, fovY: 50 }],
    [Exposure, { ev100 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 1.4, 3.6], rotation: lookAt([0, 1.4, 3.6], [0, 0.4, 0]) }],
    ...(extra as []),
  )
}

type Setup = (s: Awaited<ReturnType<typeof scene>>) => number

async function compare(name: string, setup: Setup) {
  const shots: Uint8Array[] = []
  const found = watchBaseline(compat)
  const errors = compat.errors.length
  for (const gpu of [full, compat]) {
    const s = await scene(gpu)
    const cam = setup(s)
    await settle(s.app)
    const image = await renderView(s.app, `camera:${cam}`)
    shots.push(image.data)
    if (process.env.SHARD_GOLDEN_OUT) {
      const out = `${process.env.SHARD_GOLDEN_OUT}/effects-${name}-${gpu.tier}.png`
      writeFileSync(out, pngBytes(image.data, W, H))
    }
    if (gpu === compat) {
      expect(s.world.resource(Environments).baseline, name).toBeDefined()
      await s.app.dispose()
    } else {
      await s.app.dispose()
    }
  }
  expect(compat.errors.slice(errors).map((e) => e.message)).toEqual([])
  expect(found.computePasses, name).toBe(0)
  expect(found.renderStorage, name).toEqual([])
  return meanDifference(shots[0]!, shots[1]!)
}

describe('the baseline tier’s effects on a compatibility device (0064)', () => {
  it('prefilters an environment map by fragment passes: lighting and skybox as on the full tier', {
    timeout: 120_000,
  }, async () => {
    const diff = await compare('environment', ({ world, target }) => {
      const env = world.resource(Textures).add(studio())
      return camera(
        world,
        target,
        [
          [EnvironmentMap, { texture: env, intensity: 4000 }],
          [Skybox, {}],
        ],
        11,
      )
    })
    expect(diff).toBeLessThan(1.5)
  })

  it('draws the procedural sky and lights by its bake, from fragment-pass LUTs and froxels', {
    timeout: 120_000,
  }, async () => {
    const diff = await compare('sky', ({ world, target }) => {
      world.spawn(
        [DirectionalLight, { illuminance: 100_000 }],
        [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.5, -1.2, 0) as never }],
      )
      world.resource(DefaultEnvironment).sky = {}
      return camera(world, target, [], 13)
    })
    expect(diff).toBeLessThan(1.5)
  })

  it('runs bloom, depth of field, SSAO and fog, and meters auto exposure without compute', {
    timeout: 120_000,
  }, async () => {
    const metered: number[] = []
    const diff = await compare('post', ({ world, target }) => {
      world.spawn(
        [DirectionalLight, { illuminance: 30_000 }],
        [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as never }],
      )
      const cam = camera(
        world,
        target,
        [
          [Bloom, { intensity: 0.2 }],
          [DepthOfField, { focusDistance: 3.5, maxBlur: 0.02 }],
          [Ssao, { radius: 0.6, intensity: 1.2 }],
          [Fog, { density: 0.04, heightFalloff: 0.3 }],
          [AutoExposure, {}],
        ],
        12,
      )
      // Both tiers' meters, once they've read.
      queueMicrotask(async () => {
        for (let i = 0; i < 400 && !world.resource(ExposureMeters).get(cam)?.readings; i++) {
          await new Promise((r) => setTimeout(r, 5))
        }
        const m = world.resource(ExposureMeters).get(cam)
        if (m?.metered !== undefined) metered.push(m.metered)
      })
      return cam
    })
    expect(diff).toBeLessThan(2)
    expect(metered).toHaveLength(2)
    // The same histogram meter over fewer pixels: within an eighth of an EV.
    expect(Math.abs(metered[0]! - metered[1]!)).toBeLessThan(0.125)
  })
})
