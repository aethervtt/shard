import {
  defineComponent,
  defineSystem,
  FixedUpdate,
  PostUpdate,
  ProfilerResource,
  ProfilerSettings,
  type Query,
  t,
  Update,
  type World,
} from '@aethervtt/shard-core'
import {
  allocationChecks,
  budget,
  gcWindow,
  timeout,
  timingMode,
} from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { App } from './app'
import { LogResource } from './log'
import { capturePerf, describePerf, PerfHostResource } from './perf'
import { Time } from './time'

/** Spins for `ms` of wall time: the fixture's hitch. */
function busyWait(ms: number): void {
  const end = performance.now() + ms
  while (performance.now() < end) {
    // spin
  }
}

/** A busy-wait of 20 ms on frame `at`, in a system of its own. */
const hitch = (at: number) =>
  defineSystem({
    name: 'test-perf/hitch',
    run: (_, world) => {
      if (world.resource(Time).frame === at) busyWait(20)
    },
  })

const steady = defineSystem({ name: 'test-perf/steady', run: () => busyWait(0.05) })

async function appWith(...systems: ReturnType<typeof defineSystem>[]) {
  const app = new App()
  app.addSystems(Update, ...systems)
  await app.init()
  return app
}

describe('perf.describe (0074)', () => {
  it('returns systems, schedules and the frame; schedules sum to within 5% of frame', async () => {
    // Systems that take most of the frame, as real ones do: the frame's own bookkeeping (events,
    // state transitions) stays a small share of it even on a loaded machine.
    const app = await appWith(
      defineSystem({ name: 'test-perf/work', run: () => busyWait(0.6) }),
      steady,
    )
    app.addSystems(PostUpdate, defineSystem({ name: 'test-perf/post', run: () => busyWait(0.3) }))
    app.addSystems(FixedUpdate, defineSystem({ name: 'test-perf/fixed', run: () => busyWait(0.2) }))
    for (let i = 0; i < 130; i++) app.update(1 / 60)
    const perf = describePerf(app.world)
    expect(perf.frame).toMatchObject({ span: 'frame', samples: 120 })
    expect(Object.keys(perf.schedules).sort()).toEqual([
      'schedule/FixedUpdate',
      'schedule/PostUpdate',
      'schedule/Update',
    ])
    expect(Object.keys(perf.commands)).toContain('commands/Update')
    expect(perf.systems.map((s) => s.span)).toEqual(
      expect.arrayContaining(['test-perf/steady', 'test-perf/post', 'test-perf/fixed']),
    )
    const profiler = app.world.resource(ProfilerResource)
    let schedules = 0
    for (const name of Object.keys(perf.schedules)) schedules += profiler.timing(name)!.avg
    const frame = profiler.timing('frame')!.avg
    expect(Math.abs(frame - schedules) / frame).toBeLessThan(0.05)
    expect(perf.clock.isolated).toBe(true)
    expect(perf.memory.ecs.entities).toBe(0)
    expect(perf.memory.heap?.usedBytes).toBeGreaterThan(0)
    // Keys filter spans the way budgets do.
    expect(describePerf(app.world, { spans: ['schedule/Update'] }).schedules).toHaveProperty(
      'schedule/Update',
    )
    expect(describePerf(app.world, { spans: ['test-perf'] }).systems.length).toBe(4)
  })

  it('ProfilerSettings turns the profiler off, and perf.reset clears it', async () => {
    const app = await appWith(steady)
    app.update(1 / 60)
    const profiler = app.world.resource(ProfilerResource)
    profiler.reset()
    expect(profiler.timing('test-perf/steady')).toBeUndefined()
    app.world.resource(ProfilerSettings).enabled = false
    app.update(1 / 60)
    expect(profiler.timing('test-perf/steady')).toBeUndefined()
    const off = new App({ profiler: { enabled: false } })
    await off.init()
    off.update(1 / 60)
    expect(off.world.resource(ProfilerResource).timing('frame')).toBeUndefined()
  })
})

describe('captures (0074)', () => {
  it('a 300-frame capture puts the hitch frame first, with its system first in over', {
    timeout: timeout(30_000),
  }, async () => {
    const app = await appWith(steady, hitch(150))
    app.update(1 / 60) // capture from frame 1 on
    const { summary, trace, tracePath } = await capturePerf(app.world, {
      frames: 300,
      step: () => app.update(1 / 60),
    })
    expect(tracePath).toBeUndefined() // no host to write to: inline
    expect(trace?.traceEvents.length).toBeGreaterThan(300)
    expect(summary.frames.count).toBe(300)
    expect(summary.worst[0]!.frame).toBe(150)
    expect(summary.worst[0]!.cpuMs).toBeGreaterThanOrEqual(20)
    expect(summary.worst[0]!.over[0]!.span).toBe('test-perf/hitch')
    expect(summary.worst[0]!.over[0]!.ms).toBeGreaterThanOrEqual(20)
    expect(summary.top.map((s) => s.span)).toContain('test-perf/steady')
    expect(summary.memory.heap?.source).toBe('v8')
  })

  it('a flight recorder at 15 ms stops 30 frames after the hitch, with 120 before', {
    timeout: timeout(30_000),
  }, async () => {
    const app = await appWith(steady, hitch(200))
    const { summary } = await capturePerf(app.world, {
      until: { frameMs: 15 },
      before: 120,
      after: 30,
      step: () => app.update(1 / 60),
    })
    expect(summary.capture.trigger?.frame).toBe(200)
    expect(summary.capture.range).toEqual([80, 230])
    expect(app.world.resource(Time).frame).toBe(231)
    expect(summary.worst[0]!.frame).toBe(200)
  })

  it('a second capture while one runs fails with perf/capture-running', async () => {
    const app = await appWith(steady)
    const first = capturePerf(app.world, { frames: 5 })
    await started(app.world)
    await expect(capturePerf(app.world, { frames: 5 })).rejects.toMatchObject({
      code: 'perf/capture-running',
    })
    for (let i = 0; i < 8; i++) app.update(1 / 60)
    expect((await first).summary.frames.count).toBe(5)
  })

  it('writes the trace and asks the host to sample; without a sampler, says so', async () => {
    const app = await appWith(steady)
    const files = new Map<string, string>()
    app.world.insertResource(PerfHostResource, {
      writeText: async (path, text) => void files.set(path, text),
    })
    const { summary, tracePath } = await capturePerf(app.world, {
      frames: 3,
      sample: true,
      step: () => app.update(1 / 60),
    })
    expect(tracePath).toMatch(/^\.shard\/captures\/.+\.trace\.json$/)
    expect(JSON.parse(files.get(tracePath!)!).traceEvents.length).toBeGreaterThan(3)
    expect(summary.warnings.map((w) => w.code)).toContain('perf/sampling-unavailable')
  })

  it('logs an unbalanced span once, as perf/span-mismatch', async () => {
    const app = await appWith(
      defineSystem({
        name: 'test-perf/unbalanced',
        run: (_, world) => {
          const profiler = world.resource(ProfilerResource)
          profiler.begin({ name: 'test-perf/left-open', id: -1 })
        },
      }),
    )
    for (let i = 0; i < 3; i++) app.update(1 / 60)
    const warnings = app.world
      .resource(LogResource)
      .tail(50, 'warn')
      .filter((e) => e.code === 'perf/span-mismatch')
    expect(warnings.length).toBe(1)
  })
})

const Position = defineComponent('test-perf/Position', { value: t.vec3 })
const Velocity = defineComponent('test-perf/Velocity', { value: t.vec3 })

function integrateSystem() {
  return defineSystem({
    name: 'test-perf/integrate',
    setup: (world: World) => ({ q: world.query({ with: [Position, Velocity] }) as Query }),
    run: ({ q }) => {
      const tables = q.tables
      for (let i = 0; i < tables.length; i++) {
        const table = tables[i]!
        const pos = table.column(Position, 'value')
        const vel = table.column(Velocity, 'value')
        for (let k = 0, n = table.count * 3; k < n; k++) pos[k]! += vel[k]! / 60
        table.markChanged(Position)
      }
    },
  })
}

/** Resolves once a capture started (its module loads with `import()` first). */
async function started(world: World): Promise<void> {
  const profiler = world.resource(ProfilerResource)
  while (!profiler.sink) await new Promise((resolve) => setTimeout(resolve, 0))
}

async function benchApp(profiler = true) {
  const app = new App({ profiler: { enabled: profiler } })
  app.addSystems(Update, integrateSystem())
  await app.init()
  for (let i = 0; i < 100_000; i++) {
    app.world.spawn([Position, { value: [i, 0, 0] }], [Velocity, { value: [1, 1, 1] }])
  }
  return app
}

describe('profiler overhead (0074)', () => {
  it('always-on profiling, and a running capture, allocate nothing over 1,000 frames of 100k', {
    timeout: timeout(120_000),
  }, async () => {
    const app = await benchApp()
    const frames = allocationChecks ? 1_000 : 50
    for (let i = 0; i < 200; i++) app.update(1 / 60) // let V8 optimize
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    let window = gcWindow()
    for (let i = 0; i < frames; i++) app.update(1 / 60)
    const always = await window.end()
    // A capture, after it starts: its buffer is preallocated.
    const capture = capturePerf(app.world, { frames: frames + 10, events: 1 << 16 })
    await started(app.world)
    app.update(1 / 60)
    gc?.()
    window = gcWindow()
    for (let i = 0; i < frames; i++) app.update(1 / 60)
    const capturing = await window.end()
    for (let i = 0; i < 20; i++) app.update(1 / 60)
    expect((await capture).summary.frames.count).toBe(frames + 10)
    if (allocationChecks) {
      expect(always).toBe(0)
      expect(capturing).toBe(0)
    }
  })

  // Timing only: the work runs under `pnpm bench`.
  it.runIf(timingMode === 'bench')(
    'costs under 1% of frame time always on, and under 5% while capturing',
    { timeout: timeout(300_000) },
    async () => {
      const on = await benchApp(true)
      const off = await benchApp(false)
      const best = (app: App) => {
        let ms = Number.POSITIVE_INFINITY
        for (let batch = 0; batch < 20; batch++) {
          const start = performance.now()
          for (let i = 0; i < 50; i++) app.update(1 / 60)
          ms = Math.min(ms, (performance.now() - start) / 50)
        }
        return ms
      }
      for (let i = 0; i < 300; i++) {
        on.update(1 / 60)
        off.update(1 / 60)
      }
      const baseline = Math.min(best(off), best(off))
      const always = Math.min(best(on), best(on))
      const capture = capturePerf(on.world, { frames: 2_100, events: 1 << 18 })
      await started(on.world)
      const capturing = best(on)
      for (let i = 0; i < 200; i++) on.update(1 / 60)
      await capture
      console.log(
        `profiler overhead: off ${baseline.toFixed(4)} ms, on ${always.toFixed(4)} ms, capturing ${capturing.toFixed(4)} ms`,
      )
      expect(always / baseline).toBeLessThan(budget('profiler/always-on'))
      expect(capturing / baseline).toBeLessThan(budget('profiler/capturing'))
    },
  )
})
