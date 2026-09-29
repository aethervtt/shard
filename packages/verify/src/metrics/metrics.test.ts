import { allocationChecks, gcWindow, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import type { HostPerformance } from '@aethervtt/shard-platform'
import {
  Camera3d,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderScale,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App, FrameDemand } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { perfRecordJsonSchema, validateJson } from '../record'
import { MetricsResource, metricsMethods, metricsPlugin } from './metrics'

/** A host whose long tasks and downloads the test decides. */
function fakeHost() {
  let listener: ((start: number, duration: number) => void) | undefined
  const host: HostPerformance = {
    userAgent: 'TestBrowser/1.0',
    onLongTask: (l) => {
      listener = l
      return () => {
        listener = undefined
      }
    },
    downloads: () => ({ transferred: 1200, decoded: 3400 }),
  }
  return { host, longTask: (start: number, duration: number) => listener?.(start, duration) }
}

/** An app without a renderer on a clock the test moves. */
async function clocked(options: { windowMs?: number } = {}) {
  let now = 30
  const clock = () => now
  const { host, longTask } = fakeHost()
  const app = new App({ now: clock }).addPlugin(
    metricsPlugin({ now: clock, performance: host, renderer: 'shard@test', ...options }),
  )
  await app.init()
  const metrics = app.world.resource(MetricsResource)
  return {
    app,
    metrics,
    longTask,
    at: (ms: number) => {
      now = ms
    },
    /** Runs a frame `ms` after the last. */
    frame: (ms: number) => {
      now += ms
      app.update(ms / 1000)
    },
  }
}

async function validates(record: unknown) {
  const { default: Ajv } = await import('ajv/dist/2020')
  const validate = new Ajv({ strict: false }).compile(perfRecordJsonSchema())
  expect(validate(record), JSON.stringify(validate.errors)).toBe(true)
  expect(validateJson(perfRecordJsonSchema(), record)).toEqual([])
}

describe('metricsPlugin (0062)', () => {
  it('refuses to record before the first usable frame', async () => {
    const { metrics, frame } = await clocked()
    frame(16)
    expect(() => metrics.record({ fixture: 'f', scenario: 's' })).toThrow(
      expect.objectContaining({ code: 'verify/not-usable' }),
    )
  })

  it('records startup, frame times, traces, and long tasks, and the record validates', async () => {
    const { app, metrics, longTask, at, frame } = await clocked()
    at(100)
    app.markUsable()
    frame(16)
    await app.whenUsable()
    await Promise.resolve()
    for (let i = 0; i < 18; i++) frame(16)
    frame(40) // one slow frame
    const traced = app.trace('move')
    frame(16)
    expect(await traced).toBe(16)
    longTask(150, 80)
    longTask(170, 55)
    const record = metrics.record({ fixture: 'table-small', scenario: 'idle' })
    expect(record).toMatchObject({
      version: 1,
      renderer: 'shard@test',
      fixture: 'table-small',
      scenario: 'idle',
      device: { ua: 'TestBrowser/1.0', gpu: 'unknown' },
      renderScale: { mode: 'none', min: 1, max: 1 },
      coldStart: { total: 30, modules: 30, device: 0, pipelines: 0, assets: 0 },
      firstUsableFrame: 116,
      patchToFrame: { p50: 16, p95: 16, n: 1 },
      longTasks: { count: 2, totalMs: 135, maxMs: 80 },
      gpuMemory: { bytes: 0, byCategory: {} },
      download: { transferred: 1200, decoded: 3400 },
    })
    expect(record.frameTime).toMatchObject({ p50: 16, p95: 16, p99: 40, n: 20 })
    expect(record.frameTime.gpuP95).toBeUndefined()
    await validates(record)
  })

  it('skips idle gaps between on-demand frames', async () => {
    const { app, metrics, frame } = await clocked()
    app.markUsable()
    frame(16)
    await app.whenUsable()
    const demand = app.world.resource(FrameDemand)
    demand.mode = 'on-demand'
    demand.hold('test')
    frame(16)
    frame(16) // 16 ms after one that held a demand: counts
    demand.release('test')
    frame(16) // the frame after this one is a wake-up
    frame(2000)
    demand.hold('test')
    frame(16)
    frame(16)
    const { frameTime } = metrics.record({ fixture: 'f', scenario: 's' })
    expect(frameTime.n).toBe(4)
    expect(frameTime.p99).toBe(16)
  })

  it('looks back one window, and reset starts a new one', async () => {
    const { app, metrics, longTask, frame, at } = await clocked({ windowMs: 1000 })
    app.markUsable()
    frame(16)
    await app.whenUsable()
    for (let i = 0; i < 10; i++) frame(50)
    longTask(100, 60)
    for (let i = 0; i < 100; i++) frame(16) // 1.6 s: the slow frames fall out of the window
    const record = metrics.record({ fixture: 'f', scenario: 's' })
    expect(record.frameTime.p99).toBe(16)
    expect(record.longTasks.count).toBe(0)
    metrics.reset()
    at(3000)
    frame(33)
    frame(33)
    expect(metrics.record({ fixture: 'f', scenario: 's' }).frameTime).toMatchObject({
      n: 1,
      p50: 33,
    })
  })

  it('records frames without allocating', async () => {
    const { app, frame } = await clocked()
    app.markUsable()
    frame(16)
    await app.whenUsable()
    for (let i = 0; i < 2000; i++)
      frame(16) // let V8 optimize, and fill the rings
    ;(globalThis as { gc?: () => void }).gc?.()
    const gcs = gcWindow()
    for (let i = 0; i < 50_000; i++) frame(16)
    const collections = await gcs.end()
    if (allocationChecks) expect(collections).toBe(0)
  })

  it('serves metrics.record and metrics.reset', async () => {
    const { app, frame } = await clocked()
    app.markUsable()
    frame(16)
    await app.whenUsable()
    frame(16)
    const record = app.methods.find((m) => m.name === 'metrics.record')!
    const result = record.handler(
      { app, world: app.world },
      { fixture: 'fx', scenario: 'sc', renderer: 'shard@abc' },
    )
    expect(result).toMatchObject({ fixture: 'fx', scenario: 'sc', renderer: 'shard@abc' })
    expect(metricsMethods.map((m) => m.name)).toEqual(['metrics.record', 'metrics.reset'])
  })
})

describe('metricsPlugin with a renderer (0062)', () => {
  let gpu: GpuContext
  beforeAll(async () => {
    gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  })
  afterAll(() => gpu.destroy())

  it(
    'measures GPU memory, the device, pipelines, GPU frame time, and a pinned render scale',
    async () => {
      const app = new App().addPlugin(
        TransformPlugin,
        renderPlugin({ gpu, windowView: false }),
        forwardPlugin({ msaa: 1 }),
        metricsPlugin(),
      )
      await app.init()
      const w = app.world
      w.patchResource(RenderScale, { mode: 'fixed', scale: 1 })
      const target = new OffscreenTarget(gpu, {
        label: 'metrics',
        width: 64,
        height: 64,
        renderScale: true,
      })
      const ref = w.resource(RenderTargets).add(target, 'metrics')
      w.spawn(
        [Mesh3d, { mesh: w.resource(Meshes).add(cube({ size: 1 })) }],
        [
          MeshMaterial,
          {
            material: w
              .resource(Materials)
              .add(new MaterialAsset({ baseColor: [0.4, 0.6, 0.9, 1] })),
          },
        ],
        Transform,
      )
      w.spawn([Camera3d, { target: ref }], [Transform, { translation: [0, 0, 3] }])
      app.markUsable()
      for (let i = 0; i < 30; i++) {
        app.update(1 / 60)
        await gpu.pipelines.whenIdle()
        await new Promise((r) => setTimeout(r, 1))
      }
      await app.whenUsable()
      const record = w.resource(MetricsResource).record({ fixture: 'cube', scenario: 'static' })
      expect(record.gpuMemory.bytes).toBeGreaterThan(0)
      expect(record.gpuMemory.bytes).toBe(
        Object.values(record.gpuMemory.byCategory).reduce((a, b) => a + b, 0),
      )
      expect(record.gpuMemory.byCategory.targets).toBeGreaterThan(0)
      expect(record.device.gpu).not.toBe('unknown')
      // The host made the device before the app; its request still counts.
      expect(record.coldStart.device).toBeGreaterThan(0)
      expect(record.renderScale).toEqual({ mode: 'fixed', min: 1, max: 1 })
      expect(record.frameTime.gpuP95).toBeGreaterThan(0)
      await validates(record)
      await app.dispose()
    },
    timeout(30_000),
  )
})
