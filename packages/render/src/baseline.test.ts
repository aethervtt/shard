import { writeFileSync } from 'node:fs'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { RenderHealth } from './health'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight, LightingSettings, PointLight, SpotLight } from './lights'
import { describeRender, Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pngBytes, renderView, settle, watchBaseline } from './testing'
import { Tonemapping } from './view'

// The baseline tier (0064) on a WebGPU compatibility-mode device: what renders there, renders
// without compute, without storage in the vertex or fragment stage, and close to the full tier.

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

async function litScene(gpu: GpuContext, localLights = true) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const mat = (c: [number, number, number]) =>
    materials.add(new MaterialAsset({ baseColor: [...c, 1], roughness: 0.6 }))
  world.resource(AmbientLight).brightness = 200
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 12 })) }],
    [MeshMaterial, { material: mat([0.5, 0.5, 0.5]) }],
    Transform,
  )
  for (let i = 0; i < 5; i++) {
    world.spawn(
      [Mesh3d, { mesh: meshes.add(i % 2 ? sphere({ radius: 0.5 }) : cube({ size: 1 })) }],
      [MeshMaterial, { material: mat([0.2 + i * 0.15, 0.4, 0.8 - i * 0.12]) }],
      [Transform, { translation: [-3 + i * 1.5, 0.5, -1 + (i % 2)] }],
    )
  }
  world.spawn(
    [DirectionalLight, { illuminance: 8000, shadows: true }],
    [Transform, { rotation: lookAt([-3, 8, 4], [0, 0, 0]) }],
  )
  if (localLights) {
    world.spawn(
      [PointLight, { intensity: 400_000, range: 5, color: [1, 0.5, 0.2, 1] }],
      [Transform, { translation: [2, 1.5, 1] }],
    )
    world.spawn(
      [
        SpotLight,
        { intensity: 800_000, range: 8, outerAngle: 30, shadows: true, color: [0.3, 0.6, 1, 1] },
      ],
      [Transform, { translation: [-2, 4, 2], rotation: lookAt([-2, 4, 2], [-2, 0, 0]) }],
    )
  }
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'baseline', width: 128, height: 96 }), 'baseline')
  const cam = world.spawn(
    [Camera3d, { target: target as never, clearColor: [0.05, 0.05, 0.08, 1] }],
    [Exposure, { ev100: 11 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 5, 9], rotation: lookAt([0, 5, 9], [0, 0, 0]) }],
  )
  return { app, world, cam }
}

describe('the baseline tier on a compatibility device (0064)', () => {
  it('renders a lit, shadowed scene with no compute, no render-stage storage, and close to full', {
    timeout: 60_000,
  }, async () => {
    const found = watchBaseline(compat)
    const reference = await litScene(full)
    const a = await renderView(reference.app, `camera:${reference.cam}`)
    await reference.app.dispose()
    const errors = compat.errors.length
    const baseline = await litScene(compat)
    const b = await renderView(baseline.app, `camera:${baseline.cam}`)
    if (process.env.SHARD_GOLDEN_OUT) {
      writeFileSync(
        `${process.env.SHARD_GOLDEN_OUT}/baseline-full.png`,
        pngBytes(a.data, a.width, a.height),
      )
      writeFileSync(
        `${process.env.SHARD_GOLDEN_OUT}/baseline-compat.png`,
        pngBytes(b.data, b.width, b.height),
      )
    }
    expect(compat.errors.slice(errors).map((e) => e.message)).toEqual([])
    expect(found.computePasses).toBe(0)
    expect(found.renderStorage).toEqual([])
    expect((describeRender(baseline.world) as { tier: string }).tier).toBe('baseline')
    let sum = 0
    for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i]! - b.data[i]!)
    expect(sum / a.data.length).toBeLessThan(2)
    // The point and spot lights (clustered, CPU-binned on baseline) make a visible difference.
    const unlit = await litScene(compat, false)
    const c = await renderView(unlit.app, `camera:${unlit.cam}`)
    let lit = 0
    for (let p = 0; p < b.data.length; p += 4) {
      const d =
        Math.abs(b.data[p]! - c.data[p]!) +
        Math.abs(b.data[p + 1]! - c.data[p + 1]!) +
        Math.abs(b.data[p + 2]! - c.data[p + 2]!)
      if (d > 24) lit++
    }
    expect(lit).toBeGreaterThan(300)
    await unlit.app.dispose()
    expect(baseline.world.resource(Gpu)).toBe(compat)
    await baseline.app.dispose()
  })

  it('shades the nearest lights up to LightingSettings.baselineMaxLights, and says so in RenderHealth', {
    timeout: 60_000,
  }, async () => {
    const { app, world, cam } = await litScene(compat)
    const issue = () =>
      world.resource(RenderHealth).issues.find((i) => i.code === 'render/light-budget')
    await settle(app)
    expect(issue()).toBeUndefined()
    world.resource(LightingSettings).baselineMaxLights = 1
    await settle(app)
    const raised = issue()!
    expect(raised.severity).toBe('degraded')
    expect(raised.ref).toBe(`camera:${cam}`)
    expect(raised.message).toContain('the 1 farthest')
    expect(world.resource(RenderHealth).state).toBe('degraded')
    world.resource(LightingSettings).baselineMaxLights = 128
    await settle(app)
    expect(issue()).toBeUndefined()
    expect(world.resource(RenderHealth).state).toBe('ok')
    await app.dispose()
  })
})
