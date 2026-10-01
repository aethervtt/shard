import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  captureView,
  describeRender,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderHealth,
  RenderTargets,
  renderPlugin,
  Shaders,
  Tonemapping,
} from '@aethervtt/shard-render'
import { meanDifference, settle, watchBaseline } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ParticleSystem } from './components'
import { ParticleEffect, ParticleEffects } from './effect'
import { particlesPlugin } from './plugin'
import { Particles } from './sim'

// Particles on the baseline tier (0064): every system runs the CPU backend (and says why), alpha
// emitters sort on the CPU, particles reach the vertex stage through data textures, and a module
// only the GPU backend runs is reported, not silently dropped.

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

const smoke = (update: unknown[]) => ({
  emitters: [
    {
      name: 'smoke',
      capacity: 512,
      spawn: { rate: 300 },
      shape: { type: 'sphere', radius: 0.4 },
      init: { lifetime: 2, speed: [0.2, 0.6], size: [0.2, 0.4], color: '#9ab' },
      update,
      render: { blend: 'alpha', emissive: 800 },
    },
  ],
})

async function scene(gpu: GpuContext, backend: 'gpu' | 'cpu', update: unknown[]) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    particlesPlugin,
  )
  await app.init()
  const world = app.world
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'particles', width: 96, height: 72 }), 'particles')
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 10 })) }],
    [MeshMaterial, { material: world.resource(Materials).add(new MaterialAsset({})) }],
    Transform,
  )
  const effect = world.resource(ParticleEffects).add(ParticleEffect.fromJson(smoke(update)))
  world.spawn(
    [ParticleSystem, { effect, backend, seed: 7 }],
    [Transform, { translation: [0, 1, 0] }],
  )
  const cam = world.spawn(
    [Camera3d, { target: target as never, fovY: 50 }],
    [Exposure, { ev100: 10 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: [0, 1.5, 4], rotation: lookAt([0, 1.5, 4], [0, 1, 0]) }],
  )
  await settle(app, 3)
  for (let i = 0; i < 30; i++) {
    app.update(1 / 60)
    await world.resource(Shaders).whenIdle()
    await gpu.pipelines.whenIdle()
  }
  const shot = captureView(world, `camera:${cam}`)
  app.update(1 / 60)
  return { app, world, image: (await shot).data }
}

describe('particles on the baseline tier (0064)', () => {
  it('run the CPU backend, sort on the CPU, and draw as the full tier’s CPU backend does', {
    timeout: 60_000,
  }, async () => {
    const found = watchBaseline(compat)
    const errors = compat.errors.length
    const reference = await scene(full, 'cpu', [{ module: 'drag', coefficient: 0.3 }])
    const baseline = await scene(compat, 'gpu', [{ module: 'drag', coefficient: 0.3 }])
    const systems = (
      describeRender(baseline.world) as unknown as {
        particles: { systems: { backend: string; backendReason?: string }[] }
      }
    ).particles.systems
    expect(systems[0]).toMatchObject({
      backend: 'cpu',
      backendReason: 'the baseline tier has no compute',
    })
    const e = [...baseline.world.resource(Particles).systems.values()][0]!.emitters[0]!
    expect(e.sort).toBeDefined()
    expect(e.particles.textured).toBe(true)
    // Same seeds, same CPU simulation: the images agree (the GPU sorts one, the CPU the other).
    expect(meanDifference(reference.image, baseline.image)).toBeLessThan(0.5)
    expect(compat.errors.slice(errors)).toEqual([])
    expect(found.computePasses).toBe(0)
    expect(found.renderStorage).toEqual([])
    await reference.app.dispose()
    await baseline.app.dispose()
  })

  it('reports a module only the GPU backend runs, and clears the report once it goes', {
    timeout: 60_000,
  }, async () => {
    const s = await scene(compat, 'gpu', [
      { module: 'gravity' },
      { module: 'collision' },
      {
        module: 'color-over-life',
        gradient: [
          [0, [1, 1, 1, 1]],
          [1, [1, 0, 0, 0]],
        ],
      },
      {
        module: 'size-over-life',
        curve: [
          [0, 1],
          [1, 0],
        ],
      },
    ])
    const issue = () =>
      s.world
        .resource(RenderHealth)
        .issues.find(
          (i) => i.code === 'render/feature-unsupported' && i.ref === 'particles/collision',
        )
    expect(issue()?.severity).toBe('degraded')
    expect(issue()?.message).toContain('"collision"')
    // Render modules run in the draw's shader on either backend: nothing to report.
    const unsupported = s.world
      .resource(RenderHealth)
      .issues.filter((i) => i.code === 'render/feature-unsupported')
    expect(unsupported.map((i) => i.ref)).toEqual(['particles/collision'])
    for (const [entity] of s.world.resource(Particles).systems) s.world.despawn(entity)
    await settle(s.app, 3)
    expect(issue()).toBeUndefined()
    await s.app.dispose()
  })
})
