import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  captureView,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  ProceduralSky,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { afterAll, describe, expect, it } from 'vitest'
import { levelTexel } from './clipmap'
import { WaterBody, WaterSpline } from './components'
import { readWaterInfo } from './debug'
import { waterOptics } from './optics'
import { waterPlugin } from './plugin'
import { waterAt, waterSample } from './query'
import { WaterRender } from './render'
import { INFO_SIZE } from './shaders'

const here = dirname(fileURLToPath(import.meta.url))
const contexts: GpuContext[] = []
afterAll(async () => {
  for (const g of contexts) {
    await g.device.queue.onSubmittedWorkDone()
    g.destroy()
  }
})

type Vec3 = [number, number, number]

const point = (x: number, y: number, z: number, width: number, flow: number) => ({
  position: [x, y, z] as Vec3,
  width,
  depth: 2,
  flow,
})

/** A lake at 4 m, r 60 m at the origin, and a river falling into it from the west. */
async function scene(tier: 'full' | 'baseline') {
  const g = await createNodeGpuContext(tier === 'baseline' ? { tier } : {})
  contexts.push(g)
  const target = new OffscreenTarget(g, { label: 'rivers', width: 160, height: 96 })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu: g, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    waterPlugin(),
  )
  await app.init()
  const world = app.world
  world.resource(Wind).speed = 0
  world.spawn(
    [DirectionalLight, { illuminance: 80_000, shadows: false }],
    [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.6, 2.4, 0) as never }],
  )
  const eye: Vec3 = [-140, 45, -70]
  const camera = world.spawn(
    [
      Camera3d,
      { target: world.resource(RenderTargets).add(target, 'rivers'), fovY: 55, near: 0.1 },
    ],
    [Exposure, { ev100: 14 }],
    [Tonemapping, { curve: 'agx', dither: false }],
    [ProceduralSky, { turbidity: 2.5 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [-60, 4, 0]) }],
  )
  const sand = world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [0.76, 0.66, 0.45, 1], roughness: 1 }))
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 800 })) }],
    [MeshMaterial, { material: sand }],
    [Transform, { translation: [0, 1, 0] }],
  )
  world.spawn(
    [WaterBody, { kind: 'lake', optics: waterOptics('lake') }],
    [
      WaterSpline,
      {
        points: Array.from({ length: 16 }, (_, i) =>
          point(
            60 * Math.cos((i / 16) * 2 * Math.PI),
            0,
            60 * Math.sin((i / 16) * 2 * Math.PI),
            0,
            0,
          ),
        ),
      },
    ],
    [Transform, { translation: [0, 4, 0] }],
  )
  world.spawn(
    [WaterBody, { kind: 'river', optics: waterOptics('river'), priority: 1 }],
    [
      WaterSpline,
      {
        closed: false,
        points: [
          point(-300, 9, -80, 18, 1.4),
          point(-150, 7, 40, 16, 1.2),
          point(-30, 5, 0, 16, 1.2),
        ],
      },
    ],
    Transform,
  )
  await settle(app, 80)
  for (let i = 0; i < 12; i++) app.update(1 / 60)
  await settle(app)
  return { app, world, view: `camera:${camera}` }
}

describe('rivers in the shared surface (0123)', () => {
  for (const tier of ['full', 'baseline'] as const) {
    it(
      `matches waterAt’s surface and flow at 1 000 texels of the info texture (${tier})`,
      async () => {
        const s = await scene(tier)
        expect(s.world.resource(Gpu).tier).toBe(tier)
        const levels = await readWaterInfo(s.world)
        const clip = s.world.resource(WaterRender).clip
        const t = levelTexel(0)
        const sample = waterSample()
        let seed = 3
        const rand = () => {
          seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
          return seed / 4294967296
        }
        let river = 0
        let compared = 0
        let worstSurface = 0
        let worstFlow = 0
        const mismatches: string[] = []
        const wetAt = (x: number, z: number) => waterAt(s.world, [x, 0, z], sample).body !== null
        while (compared < 1000) {
          // Over the river and the lake: x from −320 to 70 m, z from −110 to 70 m.
          const x = Math.floor((-320 + rand() * 390 - clip.corner(0, 0)) / t)
          const y = Math.floor((-110 + rand() * 180 - clip.corner(0, 1)) / t)
          if (x < 0 || y < 0 || x >= INFO_SIZE || y >= INFO_SIZE) continue
          const wx = clip.corner(0, 0) + (x + 0.5) * t
          const wz = clip.corner(0, 1) + (y + 0.5) * t
          // Skip texels a bank crosses: the raster's straight pieces and the CPU's distance differ
          // there by a fraction of a texel.
          const h = t * 0.75
          const corners = [
            wetAt(wx - h, wz - h),
            wetAt(wx + h, wz - h),
            wetAt(wx - h, wz + h),
            wetAt(wx + h, wz + h),
          ]
          if (corners.some((c) => c !== corners[0])) continue
          compared++
          const o = (y * INFO_SIZE + x) * 4
          const f = levels[0]!
          waterAt(s.world, [wx, 0, wz], sample)
          const gpuWet = f[o]! > -1e8
          if (gpuWet !== (sample.body !== null)) {
            mismatches.push(`(${wx}, ${wz}): gpu ${f[o]}, cpu ${sample.surfaceHeight}`)
            continue
          }
          if (!gpuWet) continue
          if (Math.hypot(sample.flow[0], sample.flow[2]) > 0.1) river++
          worstSurface = Math.max(worstSurface, Math.abs(f[o]! - sample.surfaceHeight))
          worstFlow = Math.max(
            worstFlow,
            Math.abs(f[o + 2]! - sample.flow[0]),
            Math.abs(f[o + 3]! - sample.flow[2]),
          )
        }
        console.log(
          `${tier}: ${river} river texels; worst surface ${worstSurface.toExponential(2)} m, flow ${worstFlow.toExponential(2)} m/s; ${mismatches.length} wet/dry mismatches`,
        )
        expect(mismatches).toEqual([])
        expect(river).toBeGreaterThan(20)
        expect(worstSurface).toBeLessThan(0.01)
        expect(worstFlow).toBeLessThan(0.01)
        expect(s.world.resource(LogResource).tail(100, 'warn')).toEqual([])
        await s.app.dispose()
      },
      timeout(120_000),
    )
  }

  it(
    'carries the river’s ripples downstream and leaves the still lake’s alone',
    async () => {
      const shoot = async (s: Awaited<ReturnType<typeof scene>>) => {
        const shot = captureView(s.world, s.view)
        s.app.update(1 / 60)
        return shot
      }
      const full = await scene('full')
      const a = await shoot(full)
      for (let i = 0; i < 60; i++) full.app.update(1 / 60)
      await settle(full.app)
      const b = await shoot(full)
      // From the south-west, the lake fills the left of the image and the river runs off right.
      let river = 0
      let lake = 0
      for (let y = 30; y < 70; y++) {
        for (let x = 0; x < 160; x++) {
          const o = (y * 160 + x) * 4
          const d = Math.abs(a.data[o]! - b.data[o]!) + Math.abs(a.data[o + 1]! - b.data[o + 1]!)
          if (x > 100) river += d
          else if (x > 20 && x < 70) lake += d
        }
      }
      console.log(`changed over 1 s: river ${river}, lake ${lake}`)
      compareGolden(here, 'river-full', a)
      expect(river).toBeGreaterThan(lake * 3)
      const baseline = await scene('baseline')
      const c = await shoot(baseline)
      expect(compareGolden(here, 'river-full', c).mean).toBeLessThan(2)
      await full.app.dispose()
      await baseline.app.dispose()
    },
    timeout(180_000),
  )
})
