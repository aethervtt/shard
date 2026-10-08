import { quat } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AblationDriver, ablatePasses, runAblation } from './ablation'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Mesh3d, MeshMaterial } from './forward'
import { AmbientLight, DirectionalLight } from './lights'
import { captureView, Gpu, Graph, renderPlugin } from './plugin'
import { Bloom, Ssao } from './post'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { renderView, settle } from './testing'

describe('runAblation (0075)', () => {
  /** A fake GPU: 10 ms a frame, minus what's disabled, plus a drift that grows every frame. */
  function fake(costs: Record<string, number>) {
    let disabled: readonly string[] = []
    let frame = 0
    const calls: string[][] = []
    const driver: AblationDriver = {
      disable(passes) {
        disabled = passes
        calls.push([...passes])
      },
      async frame() {
        frame++
        if (frame % 7 === 0) return undefined // a frame whose timing didn't land
        let ms = 10 + frame * 0.0005
        for (const p of disabled) ms -= costs[p] ?? 0
        return ms
      },
    }
    return { driver, calls }
  }

  it("reports each pass's cost as the median drop in gpu:frame, and restores every pass", async () => {
    const { driver, calls } = fake({ shadows: 2, tonemap: 0.5, gizmos: 0.1 })
    const result = await runAblation(driver, {
      passes: ['shadows', 'tonemap', 'gizmos'],
      frames: 20,
      rounds: 5,
      together: true,
    })
    expect(result.passes.map((p) => p.pass)).toEqual(['shadows', 'tonemap', 'gizmos'])
    expect(result.passes[0]!.ms).toBeCloseTo(2, 1)
    expect(result.passes[1]!.ms).toBeCloseTo(0.5, 1)
    expect(result.passes[2]!.ms).toBeCloseTo(0.1, 1)
    expect(result.passes[0]!.rounds).toHaveLength(5)
    expect(result.together!.pass).toBe('shadows+tonemap+gizmos')
    expect(result.together!.ms).toBeCloseTo(2.6, 1)
    expect(result.frameMs).toBeGreaterThan(10)
    expect(result.samples).toBeGreaterThan(0)
    expect(calls.at(-1)).toEqual([])
  })

  it('restores every pass when a frame throws', async () => {
    const { driver, calls } = fake({})
    let n = 0
    const failing: AblationDriver = {
      disable: driver.disable,
      async frame() {
        if (++n === 30) throw new Error('device lost')
        return driver.frame()
      },
    }
    await expect(runAblation(failing, { passes: ['a'], frames: 10, rounds: 2 })).rejects.toThrow()
    expect(calls.at(-1)).toEqual([])
  })
})

describe('ablating render-graph nodes (Dawn)', () => {
  let gpu: GpuContext
  beforeAll(async () => {
    gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  })
  afterAll(() => gpu.destroy())

  async function scene() {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin(),
    )
    await app.init()
    const { world } = app
    const target = new OffscreenTarget(gpu, { label: 'ablation', width: 64, height: 64 })
    const targetRef = world.resource(RenderTargets).add(target, 'ablation')
    const meshes = world.resource(Meshes)
    const red = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.8, 0.1, 0.1, 1], roughness: 0.4 }))
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 10 })) }],
      [Transform, { translation: [0, -1, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(cube()) }],
      [MeshMaterial, { material: red }],
      [Transform, { translation: [-1, -0.5, 0] }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.6 })) }],
      [Transform, { translation: [1, -0.4, 0] }],
    )
    world.spawn(
      [DirectionalLight, { illuminance: 100_000 }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.8, 0.6, 0) as never }],
    )
    world.resource(AmbientLight).brightness = 1500
    const cam = world.spawn(
      [Camera3d, { target: targetRef }],
      [Bloom, { intensity: 0.2 }],
      [Ssao, {}],
      [Transform, { translation: [0, 2, 5], rotation: lookAt([0, 2, 5], [0, -0.5, 0]) }],
    )
    return { app, world, view: `camera:${cam}` }
  }

  it('raises no validation error for any node, and frames after it match frames before', {
    timeout: 120_000,
  }, async () => {
    const { app, world, view } = await scene()
    const graph = world.resource(Graph)
    const before = await renderView(app, view)
    const ran = (graph.describe().perView as Record<string, { order: string[] }>)[view]!.order
    expect(ran).toEqual(expect.arrayContaining(['prepass', 'ssao', 'forward-opaque', 'tonemap']))
    // Disabled, the opaque pass still clears its targets but draws nothing.
    graph.ablate(['forward-opaque'])
    const without = captureView(world, view)
    app.update(1 / 60)
    expect(Buffer.from((await without).data).equals(Buffer.from(before.data))).toBe(false)
    for (const name of graph.nodeNames()) {
      graph.ablate([name])
      for (let i = 0; i < 2; i++) app.update(1 / 60)
      await gpu.device.queue.onSubmittedWorkDone()
      expect(world.resource(Gpu).errors, `ablating ${name}`).toEqual([])
    }
    graph.ablate(ran) // all of them at once, too
    app.update(1 / 60)
    await gpu.device.queue.onSubmittedWorkDone()
    expect(world.resource(Gpu).errors).toEqual([])
    graph.ablate([])
    await settle(app)
    const shot = captureView(world, view)
    app.update(1 / 60)
    const after = await shot
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true)
    expect(() => graph.ablate(['no-such-node'])).toThrow(
      expect.objectContaining({ code: 'render/unknown-node' }),
    )
  })

  it("measures passes through GpuTimer's gpu:frame and leaves the graph as it found it", {
    timeout: 60_000,
  }, async () => {
    const { app, world, view } = await scene()
    const graph = world.resource(Graph)
    const before = await renderView(app, view)
    const ran = (graph.describe().perView as Record<string, { order: string[] }>)[view]!.order
    const passes = ran.slice(0, 2)
    if (!graph.timer.enabled) {
      // A device without timestamp queries (some baseline-tier adapters) can't measure.
      await expect(ablatePasses(world, { passes }, () => app.update(1 / 60))).rejects.toMatchObject(
        { code: 'render/gpu-timing-unavailable' },
      )
      return
    }
    const result = await ablatePasses(
      world,
      { passes, frames: 3, rounds: 1, settle: 1, together: true },
      () => app.update(1 / 60),
    )
    expect(result.passes.map((p) => p.pass)).toEqual(passes)
    expect(result.together!.pass).toBe(passes.join('+'))
    expect(result.samples).toBeGreaterThan(0)
    expect(Number.isFinite(result.frameMs)).toBe(true)
    expect(graph.ablated()).toEqual([])
    expect(world.resource(Gpu).errors).toEqual([])
    await settle(app)
    const shot = captureView(world, view)
    app.update(1 / 60)
    expect(Buffer.from((await shot).data).equals(Buffer.from(before.data))).toBe(true)
    await expect(
      ablatePasses(world, { passes: ['nope'] }, () => app.update(1 / 60)),
    ).rejects.toMatchObject({ code: 'render/unknown-node' })
  })
})
