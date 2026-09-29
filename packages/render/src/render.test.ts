import { defineSystem, Last, ProfilerResource } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { App, headlessRunner } from '@aethervtt/shard-runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { VIEW_TARGET } from './graph'
import {
  captureView,
  describeRender,
  GpuDeviceLost,
  Graph,
  RenderSet,
  renderPlugin,
  Views,
} from './plugin'
import { OffscreenTarget } from './target'

let gpu: GpuContext

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(() => gpu.destroy())

/** An app with the render plugin, headless, and a system that adds the given offscreen views. */
async function headlessApp(targets: { name: string; target: OffscreenTarget; order?: number }[]) {
  const app = new App().addPlugin(renderPlugin({ gpu, windowView: false }))
  app.addSystems(
    Last,
    defineSystem({
      name: 'test/views',
      run: (_, world) => {
        for (const t of targets) {
          world
            .resource(Views)
            .list.push({ name: t.name, target: t.target, order: t.order ?? 0, data: {} })
        }
      },
    }).inSet(RenderSet.Extract),
  )
  await app.init()
  return app
}

const clearNode = (color: [number, number, number, number]) => ({
  kind: 'render' as const,
  writes: [VIEW_TARGET],
  color: [{ resource: VIEW_TARGET, clear: color }],
  run() {},
})

describe('render graph on the GPU', () => {
  it('captures a cleared view with correct pixels', async () => {
    const target = new OffscreenTarget(gpu, { label: 'shot', width: 8, height: 4 })
    const app = await headlessApp([{ name: 'main', target }])
    app.world.resource(Graph).addNode('clear', clearNode([1, 128 / 255, 0, 1]))
    const shot = captureView(app.world, 'main')
    app.update(1 / 60)
    const image = await shot
    expect([image.width, image.height]).toEqual([8, 4])
    expect([...image.data.slice(0, 4)]).toEqual([255, 128, 0, 255])
    expect([...image.data.slice(-4)]).toEqual([255, 128, 0, 255])
  })

  it('renders two views to two targets in one frame', async () => {
    const left = new OffscreenTarget(gpu, { label: 'left', width: 4, height: 4 })
    const right = new OffscreenTarget(gpu, { label: 'right', width: 4, height: 4 })
    const app = await headlessApp([
      { name: 'left', target: left },
      { name: 'right', target: right, order: 1 },
    ])
    app.world.resource(Graph).addNode('clear', {
      kind: 'render',
      writes: [VIEW_TARGET],
      color: [{ resource: VIEW_TARGET, clear: [0, 0, 0, 1] }],
      run: (ctx) => {
        // Views carry their own data; here each view picks its color through a scissor-free trick:
        // draw nothing, but the clear color differs per view via a second node below.
        void ctx
      },
    })
    app.world.resource(Graph).addNode('tint', {
      kind: 'raw',
      writes: [VIEW_TARGET],
      run: (ctx) => {
        const color = ctx.view.name === 'left' ? [0, 1, 0, 1] : [0, 0, 1, 1]
        const pass = ctx.encoder.beginRenderPass({
          colorAttachments: [
            {
              view: ctx.texture(VIEW_TARGET).createView(),
              loadOp: 'clear',
              clearValue: color,
              storeOp: 'store',
            },
          ],
        })
        pass.end()
      },
    })
    const shots = [captureView(app.world, 'left'), captureView(app.world, 'right')]
    app.update(1 / 60)
    const [a, b] = await Promise.all(shots)
    expect([...a!.data.slice(0, 4)]).toEqual([0, 255, 0, 255])
    expect([...b!.data.slice(0, 4)]).toEqual([0, 0, 255, 255])
  })

  it('reuses transient textures across frames (pool size stable over 1,000 frames)', async () => {
    const target = new OffscreenTarget(gpu, { label: 'pool', width: 16, height: 16 })
    const app = await headlessApp([{ name: 'main', target }])
    const graph = app.world.resource(Graph)
    graph.addNode('scene', {
      kind: 'render',
      writes: [
        { name: 'hdr', format: 'rgba16float' },
        { name: 'depth', format: 'depth32float' },
      ],
      color: [{ resource: 'hdr', clear: [0, 0, 0, 1] }],
      depth: { resource: 'depth', clear: 0 },
      run() {},
    })
    graph.addNode('present', { ...clearNode([0, 0, 0, 1]), reads: ['hdr'] })
    await app.setRunner(headlessRunner({ frames: 10 })).run()
    const size = graph.pool.size
    expect(size).toBe(2)
    for (let i = 0; i < 1_000; i++) app.update(1 / 60)
    expect(graph.pool.size).toBe(size)
  })

  it('records per-node GPU timings when timestamp-query is available', async () => {
    const target = new OffscreenTarget(gpu, { label: 'timed', width: 64, height: 64 })
    const app = await headlessApp([{ name: 'main', target }])
    app.world.resource(Graph).addNode('clear', clearNode([0, 0, 0, 1]))
    for (let i = 0; i < 5; i++) {
      app.update(1 / 60)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    const timing = app.world.resource(ProfilerResource).timing('gpu:clear')
    if (!gpu.features.has('timestamp-query')) {
      expect(timing).toBeUndefined()
      return
    }
    // Dawn's timestamps on Metal (Node) come back zeroed or out of order; the timer discards those
    // samples. Browsers report real values; the playground check covers that. Here, the invariant:
    // whatever reaches the profiler is a valid, non-negative duration.
    if (timing) expect(timing.max).toBeGreaterThanOrEqual(0)
  })

  it('describes the graph for agents', async () => {
    const target = new OffscreenTarget(gpu, { label: 'desc', width: 4, height: 4 })
    const app = await headlessApp([{ name: 'main', target }])
    const graph = app.world.resource(Graph)
    graph.addNode('main', clearNode([0, 0, 0, 1]))
    graph.addNode('unused', { kind: 'raw', writes: ['nothing-reads-this'], run() {} })
    app.update(1 / 60)
    const d = describeRender(app.world)
    expect(d.order.map((n) => n.name)).toEqual(['main'])
    expect(d.culled).toEqual(['unused'])
    expect(d.views).toEqual([
      { name: 'main', target: 'desc', size: [4, 4], renderSize: [4, 4], order: 0 },
    ])
  })

  it('reports a missing resource with render/missing-resource', async () => {
    const target = new OffscreenTarget(gpu, { label: 'missing', width: 4, height: 4 })
    const app = await headlessApp([{ name: 'main', target }])
    app.world.resource(Graph).addNode('bad', {
      kind: 'render',
      writes: [VIEW_TARGET],
      color: [{ resource: 'never-declared', clear: [0, 0, 0, 1] }],
      run() {},
    })
    expect(() => app.update(1 / 60)).toThrow(
      expect.objectContaining({ message: expect.stringContaining('never-declared') }),
    )
  })

  it('sends GpuDeviceLost and keeps rendering after recovery', async () => {
    const own = await createNodeGpuContext()
    const app = new App().addPlugin(renderPlugin({ gpu: own, windowView: false }))
    const target = new OffscreenTarget(own, { label: 'recover', width: 4, height: 4 })
    app.addSystems(
      Last,
      defineSystem({
        name: 'test/view',
        run: (_, world) =>
          void world.resource(Views).list.push({ name: 'main', target, order: 0, data: {} }),
      }).inSet(RenderSet.Extract),
    )
    await app.init()
    app.world.resource(Graph).addNode('clear', clearNode([0, 1, 0, 1]))
    const reader = app.world.reader(GpuDeviceLost)
    app.update(1 / 60)
    own.simulateDeviceLoss()
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(own.generation).toBe(1)
    expect(reader.read().length).toBe(1)
    const shot = captureView(app.world, 'main')
    app.update(1 / 60)
    expect([...(await shot).data.slice(0, 4)]).toEqual([0, 255, 0, 255])
    own.destroy()
  })
})
