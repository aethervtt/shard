import { defineSystem, Last, ProfilerResource } from '@aethervtt/shard-core'
import { createGpuContext, type GpuContext } from '@aethervtt/shard-gpu'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { App, describePerf } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import { VIEW_TARGET } from './graph'
import { Graph, RenderSet, renderPlugin, Views } from './plugin'
import { OffscreenTarget } from './target'

// GPU timing on WebGL2 (0074): EXT_disjoint_timer_query_webgl2 times each pass, and GpuTimer reads
// the results as it reads WebGPU's timestamps. The shim runs over a fake context here.

async function app(gpu: GpuContext) {
  const target = new OffscreenTarget(gpu, { label: 'timed', width: 16, height: 16 })
  const app = new App().addPlugin(renderPlugin({ gpu, windowView: false }))
  app.addSystems(
    Last,
    defineSystem({
      name: 'test-perf/view',
      run: (_, world) =>
        world.resource(Views).list.push({ name: 'main', target, order: 0, data: {} }),
    }).inSet(RenderSet.Extract),
  )
  await app.init()
  const graph = app.world.resource(Graph)
  // Two passes on different targets: render nodes on the same attachments would share one.
  graph.addNode('first', {
    kind: 'render',
    writes: [VIEW_TARGET],
    color: [{ resource: VIEW_TARGET, clear: [0, 0, 0, 1] }],
    run() {},
  })
  graph.addNode('second', {
    kind: 'render',
    sideEffects: true,
    writes: [{ name: 'second', format: 'rgba8unorm' }],
    color: [{ resource: 'second', clear: [0, 0, 0, 1] }],
    run() {},
  })
  return app
}

async function frames(a: App, n: number) {
  for (let i = 0; i < n; i++) {
    a.update(1 / 60)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('GPU timing on WebGL2 (0074)', () => {
  it('times each pass with the timer extension: gpu:frame is non-zero', async () => {
    const fake = new FakeGl({ timerQuery: { elapsedNs: 1_500_000, polls: 1 } })
    const gpu = await createGpuContext({
      backend: 'webgl2',
      features: ['timestamp-query'],
      webgl2: { context: fake.context, persist: false },
    })
    try {
      expect(gpu.features.has('timestamp-query')).toBe(true)
      const a = await app(gpu)
      await frames(a, 8)
      const profiler = a.world.resource(ProfilerResource)
      expect(profiler.timing('gpu:first')?.last).toBeCloseTo(1.5, 6)
      expect(profiler.timing('gpu:second')?.last).toBeCloseTo(1.5, 6)
      // Back to back: the frame is the passes' sum.
      expect(profiler.timing('gpu:frame')?.last).toBeCloseTo(3, 6)
      expect(fake.queriesBegun).toBeGreaterThanOrEqual(16)
      expect(describePerf(a.world).gpu).toMatchObject({ frame: { avg: 3 } })
      await a.dispose()
    } finally {
      gpu.destroy()
    }
  })

  it('keeps every pass of a frame that takes seconds, as on a software renderer', async () => {
    const fake = new FakeGl({ timerQuery: { elapsedNs: 1_500_000_000, polls: 1 } })
    const gpu = await createGpuContext({
      backend: 'webgl2',
      features: ['timestamp-query'],
      webgl2: { context: fake.context, persist: false },
    })
    try {
      const a = await app(gpu)
      await frames(a, 8)
      const profiler = a.world.resource(ProfilerResource)
      // The first pass began 3 s before the frame's last end: real, not left over.
      expect(profiler.timing('gpu:first')?.last).toBeCloseTo(1500, 3)
      expect(profiler.timing('gpu:second')?.last).toBeCloseTo(1500, 3)
      expect(profiler.timing('gpu:frame')?.last).toBeCloseTo(3000, 3)
      await a.dispose()
    } finally {
      gpu.destroy()
    }
  })

  it('a disjoint operation drops the frame; without the extension, GPU timing is unavailable', async () => {
    const disjoint = new FakeGl({
      timerQuery: { elapsedNs: 1_000_000 },
      parameters: { 36795: true as unknown as number },
    })
    const timed = await createGpuContext({
      backend: 'webgl2',
      features: ['timestamp-query'],
      webgl2: { context: disjoint.context, persist: false },
    })
    try {
      const a = await app(timed)
      await frames(a, 6)
      expect(a.world.resource(ProfilerResource).timing('gpu:frame')).toBeUndefined()
      await a.dispose()
    } finally {
      timed.destroy()
    }
    const plain = new FakeGl()
    const gpu = await createGpuContext({
      backend: 'webgl2',
      features: ['timestamp-query'],
      webgl2: { context: plain.context, persist: false },
    })
    try {
      expect(gpu.features.has('timestamp-query')).toBe(false)
      const a = await app(gpu)
      await frames(a, 2)
      expect(describePerf(a.world).gpu).toBe('unavailable')
      await a.dispose()
    } finally {
      gpu.destroy()
    }
  })
})
