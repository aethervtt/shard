import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { forwardPlugin, Gpu, Graph, OffscreenTarget, renderPlugin } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { loadScene } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProtocolServer, type ProtocolServer } from './server'

// The profiler through the protocol (0074): perf.describe, perf.capture, perf.reset, the perf
// overlay, and render.describe's memory from the ledger.

const scene = {
  version: 1,
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': {},
        'core/Transform': { rotationEuler: [-40, 0, 0] },
      },
    },
    {
      name: 'box',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:cube?size=4' } },
        'core/Transform': { translation: [0, 0, -10] },
      },
    },
    { name: 'camera', components: { 'render/Camera3d': {}, 'core/Transform': {} } },
  ],
}

let app: App
let server: ProtocolServer
let gpu: Awaited<ReturnType<typeof createNodeGpuContext>>
let nextId = 1
const ok = async <T = Record<string, unknown>>(method: string, params?: unknown): Promise<T> => {
  const r = await server.handle({ jsonrpc: '2.0', id: nextId++, method, params })
  if (r!.error) throw new Error(`${method}: ${JSON.stringify(r!.error)}`)
  return r!.result as T
}

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  const target = new OffscreenTarget(gpu, { label: 'perf', width: 64, height: 64 })
  app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  loadScene(app.world, scene, { id: 'scenes/perf.scene.json' })
  server = createProtocolServer(app)
  for (let i = 0; i < 10; i++) app.update(1 / 60)
})
afterAll(() => {
  server.close()
  gpu.destroy()
})

describe('perf methods (0074)', () => {
  it('perf.describe returns the frame, schedules, systems, GPU and memory', async () => {
    const perf = await ok<{
      frame: { avg: number }
      schedules: Record<string, unknown>
      systems: { span: string }[]
      gpu: unknown
      memory: { gpu: { bytes: number }; heap?: unknown }
      clock: { resolutionMs: number; isolated: boolean }
    }>('perf.describe', { top: 200 })
    expect(perf.frame.avg).toBeGreaterThan(0)
    expect(Object.keys(perf.schedules)).toEqual(
      expect.arrayContaining(['schedule/Last', 'schedule/PostUpdate']),
    )
    const spans = perf.systems.map((s) => s.span)
    expect(spans).toContain('render/execute-graph')
    expect(spans.some((s) => s.startsWith('render/') && s !== 'render/execute-graph')).toBe(true)
    if (!gpu.features.has('timestamp-query')) expect(perf.gpu).toBe('unavailable')
    else expect(perf.gpu).toMatchObject({ quantized: expect.any(Boolean) })
    expect(perf.memory.gpu.bytes).toBe(gpu.memory().bytes)
    expect(perf.clock.isolated).toBe(true)
    const only = await ok<{ systems: { span: string }[] }>('perf.describe', { spans: ['render'] })
    expect(only.systems.every((s) => s.span === 'render' || s.span.startsWith('render/'))).toBe(
      true,
    )
  })

  it("render.describe's memory total equals the ledger's", async () => {
    const render = await ok<{ memory: { bytes: number; byCategory: object; textures: number } }>(
      'render.describe',
    )
    expect(render.memory.bytes).toBe(app.world.resource(Gpu).memory().bytes)
    expect(render.memory.bytes).toBeGreaterThan(0)
    expect(render.memory).toHaveProperty('textures')
  })

  it('perf.capture runs the frames headless and returns the summary and trace', async () => {
    const result = await ok<{
      summary: {
        frames: { count: number }
        top: { span: string; track: string }[]
        worst: unknown[]
      }
      trace: { traceEvents: { name: string; tid: number; ph: string }[] }
    }>('perf.capture', { frames: 30 })
    expect(result.summary.frames.count).toBe(30)
    expect(result.summary.worst.length).toBe(5)
    const names = new Set(result.trace.traceEvents.map((e) => e.name))
    // A main-thread span per render-graph node that ran.
    const views = Object.values(app.world.resource(Graph).describe().perView)
    const nodes = new Set(views.flatMap((v) => v.order))
    expect(nodes.size).toBeGreaterThan(1)
    for (const node of nodes) expect(names).toContain(`render/${node}`)
    expect(names).toContain('frame')
    expect(names).toContain('schedule/Last')
    // GPU spans per pass where timestamps come back (Dawn on Metal zeroes some; the timer drops them).
    const gpuSpans = result.trace.traceEvents.filter(
      (e) => e.ph === 'X' && e.name.startsWith('gpu:'),
    )
    if (gpuSpans.length > 0) expect(gpuSpans.every((e) => e.tid === 2)).toBe(true)
    // Where the timer produced frames, every pass the graph began has its GPU span.
    if (gpuSpans.some((e) => e.name === 'gpu:frame')) {
      const kinds = new Map(
        app.world
          .resource(Graph)
          .describe()
          .order.map((o) => [o.name, o.kind]),
      )
      const gpuNames = new Set(gpuSpans.map((e) => e.name))
      for (const node of nodes)
        if (kinds.get(node) !== 'raw') expect(gpuNames).toContain(`gpu:${node}`)
    }
  })

  it('perf.capture fails while one runs, and perf.reset clears the aggregates', async () => {
    const first = server.handle({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'perf.capture',
      params: { frames: 5 },
    })
    // The first capture steps its frames itself; a second one meanwhile fails.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await server.handle({
      jsonrpc: '2.0',
      id: nextId++,
      method: 'perf.capture',
      params: { frames: 5 },
    })
    expect((second!.error?.data as { code: string } | undefined)?.code).toBe('perf/capture-running')
    expect((await first)!.error).toBeUndefined()
    await ok('perf.reset')
    const perf = await ok<{ frame: unknown }>('perf.describe')
    expect(perf.frame).toBeNull()
  })

  it('the perf overlay draws frame time and the top spans', async () => {
    await ok('debug.overlays', { overlays: ['perf'] })
    for (let i = 0; i < 3; i++) app.update(1 / 60)
    const gizmos = await ok<{ labels: { text: string }[] }>('debug.gizmos')
    const texts = gizmos.labels.map((l) => l.text)
    expect(texts[0]).toMatch(/^frame /)
    expect(texts.length).toBeGreaterThan(1)
    expect(texts.length).toBeLessThanOrEqual(9)
    await ok('debug.overlays', { overlays: [] })
  })
})
