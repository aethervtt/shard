import { defineSpan, Profiler, ProfilerResource, TRACK } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { App } from './app'
import {
  coveredMs,
  describeBudgets,
  detectPerfMachine,
  measureSlices,
  PerfBudgets,
  type PerfBudgetsData,
  resolvePerfScenario,
  scenarioSliceMs,
} from './budgets'
import { describePerf, gpuPassOverlap, PerfProviders } from './perf'
import { PerfScenario } from './scenario'

// Spec 0075 in a running app: the machine, budgets.json resolved for it, the declared scenario,
// and the profiler's aggregates against each (`perf.budgets`, the perf overlay).

/** machines.json and a budgets.json in their shape (bench/perf/ has the real ones). */
const files: PerfBudgetsData = {
  machines: {
    machines: {
      laptop: { cpu: 'Apple M4', gpu: 'apple', backend: 'metal', passTiming: 'ablation' },
      desktop: {
        cpu: 'AMD Ryzen 9 9950X3D',
        gpu: 'RTX 5060 Ti',
        backend: 'd3d12',
        passTiming: 'timestamps',
      },
    },
  },
  budgets: {
    spans: {
      'mirror/sync': { kind: 'target', laptop: 0.2, desktop: 0.2, note: '' },
      'nav/find-path': { kind: 'target', laptop: 2, desktop: 2, note: '' },
      'noise/fbm6': { kind: 'rate', per: 'point', laptop: 4e7, desktop: 2.4e7, note: '' },
    },
    scenarios: {
      'scatter-walk': {
        frame: { gpu: { laptop: 16.6, desktop: 8.3 }, cpu: { laptop: 8, desktop: 6 } },
        slices: {
          gpu: {
            'gpu:forward-opaque': 0.35,
            'gpu:foliage': 0.15,
            'gpu:shadows': 0.15,
            'gpu:tonemap': 0.05,
            headroom: 0.3,
          },
          cpu: { render: 0.3, scatter: 0.1, headroom: 0.6 },
        },
      },
      crowd: {
        frame: { gpu: { laptop: 16.6, desktop: 8.3 }, cpu: { laptop: 8, desktop: 6 } },
        slices: {
          gpu: { 'gpu:forward-opaque': 0.5, headroom: 0.5 },
          cpu: { render: 0.3, headroom: 0.7 },
        },
      },
    },
  },
}

const M4 = {
  vendor: 'apple',
  architecture: 'metal-3',
  device: 'apple-m4',
  description: 'Metal driver on macOS Version 26.2 (Build 25C56)',
}
const RTX = {
  vendor: 'nvidia',
  architecture: 'blackwell',
  device: '',
  description: 'D3D12 backend - NVIDIA GeForce RTX 5060 Ti',
}

/** A profiler on a clock the feed moves, so spans last exactly what they're given. */
function fakeProfiler(): Profiler & { clock: { t: number } } {
  const clock = { t: 0 }
  return Object.assign(new Profiler({ now: () => clock.t }), { clock })
}

/**
 * Feeds a profiler `frames` frames of the given spans (ms each). On a fake clock, a CPU span named
 * `outer>inner` runs `inner` (half its time) inside `outer`.
 */
function feed(
  profiler: Profiler,
  frames: number,
  spans: { cpu?: Record<string, number>; gpu?: Record<string, number> },
) {
  const clock = (profiler as Profiler & { clock?: { t: number } }).clock
  for (let f = 0; f < frames; f++) {
    const frame = profiler.beginFrame(f)
    for (const [name, ms] of Object.entries(spans.cpu ?? {})) {
      // An app's profiler keeps its real clock: the time is sampled.
      if (!clock) {
        profiler.sample(name, ms)
        continue
      }
      const [outer, inner] = name.split('>')
      const t = profiler.begin(defineSpan(outer!))
      if (inner) profiler.sample(inner, ms / 2)
      clock.t += ms
      profiler.end(t)
    }
    profiler.endFrame(frame)
    for (const [name, ms] of Object.entries(spans.gpu ?? {})) profiler.record(name, ms, TRACK.gpu)
  }
}

describe('which machine an app runs on (0075)', () => {
  it('matches both named machines from the CPU model and the adapter, as pnpm bench does', () => {
    expect(detectPerfMachine(files.machines, { cpu: 'Apple M4', adapter: M4 })).toMatchObject({
      machine: 'laptop',
      source: 'detected',
      warnings: [],
    })
    expect(
      detectPerfMachine(files.machines, { cpu: 'AMD Ryzen 9 9950X3D 16-Core', adapter: RTX }),
    ).toMatchObject({ machine: 'desktop', source: 'detected' })
  })

  it("can't tell without the CPU model (a browser): no machine, a warning, the closest named", () => {
    const d = detectPerfMachine(files.machines, { adapter: M4 })
    expect(d.machine).toBeNull()
    expect(d.closest).toBe('laptop')
    expect(d.warnings.map((w) => w.code)).toEqual(['perf/unknown-machine'])
    // Named instead: ?machine= on a page, SHARD_MACHINE in Node.
    expect(detectPerfMachine(files.machines, { adapter: M4, override: 'laptop' })).toMatchObject({
      machine: 'laptop',
      source: 'override',
      warnings: [],
    })
    const typo = detectPerfMachine(files.machines, { override: 'lapotp' })
    expect(typo.machine).toBeNull()
    expect(typo.warnings.map((w) => w.code)).toEqual(['perf/unknown-machine'])
    const mismatch = detectPerfMachine(files.machines, {
      cpu: 'Apple M4',
      adapter: M4,
      override: 'desktop',
    })
    expect(mismatch.warnings.map((w) => w.code)).toEqual(['perf/machine-mismatch'])
  })

  it('resolves a scenario on a machine: slices in ms from shares, and shares alone without one', () => {
    const walk = files.budgets.scenarios['scatter-walk']!
    const laptop = resolvePerfScenario(walk, 'laptop')
    expect(laptop.frame).toEqual({ gpu: 16.6, cpu: 8 })
    expect(laptop.slices.gpu['gpu:foliage']).toBeCloseTo(16.6 * walk.slices.gpu['gpu:foliage']!)
    const none = resolvePerfScenario(walk, null)
    expect(none.slices.gpu['gpu:foliage']).toBeNull()
    expect(none.shares.gpu['gpu:foliage']).toBe(walk.slices.gpu['gpu:foliage'])
    const withOverride = { ...walk, overrides: { desktop: { gpu: { 'gpu:foliage': 1.5 } } } }
    expect(resolvePerfScenario(withOverride, 'desktop').slices.gpu['gpu:foliage']).toBe(1.5)
  })
})

describe('slices from the profiler (0075)', () => {
  it('a key covers its spans by the covers rule, nested ones counted once', () => {
    const profiler = fakeProfiler()
    // render/execute-graph holds render/forward-opaque (an encode inside the system).
    feed(profiler, 10, {
      cpu: { 'render/execute-graph>render/forward-opaque': 2, 'render/forward-queue': 1, scene: 3 },
    })
    expect(coveredMs(profiler, 'render')).toBeCloseTo(3)
    expect(coveredMs(profiler, 'render/forward-opaque')).toBeCloseTo(1)
    expect(coveredMs(profiler, 'renderer')).toBeUndefined()
  })

  it("measures each slice's share of the frame against its budget share, headroom a floor", () => {
    const profiler = fakeProfiler()
    feed(profiler, 20, {
      gpu: {
        'gpu:frame': 10,
        'gpu:forward-opaque': 5,
        'gpu:foliage/draw': 1,
        'gpu:foliage/cull': 0.5,
        'gpu:shadows/cascade0': 1,
        'gpu:tonemap': 0.5,
      },
    })
    const walk = files.budgets.scenarios['scatter-walk']!
    const { frame, slices } = measureSlices(profiler, walk, 'laptop')
    expect(frame.gpu).toEqual({ budgetMs: 16.6, measuredMs: 10 })
    const gpu = Object.fromEntries(slices.filter((s) => s.track === 'gpu').map((s) => [s.slice, s]))
    expect(gpu['gpu:forward-opaque']).toMatchObject({ measuredShare: 0.5, verdict: 'over' })
    expect(gpu['gpu:foliage']).toMatchObject({ measuredMs: 1.5, measuredShare: 0.15 })
    expect(gpu.headroom).toMatchObject({ measuredMs: 2, measuredShare: 0.2 })
    expect(gpu.headroom!.verdict).toBe(0.2 < walk.slices.gpu.headroom! ? 'over' : 'pass')
  })

  it('pass times that sum past 110% of gpu:frame overlap; describePerf says so', async () => {
    const app = new App()
    await app.init()
    const profiler = app.world.resource(ProfilerResource)
    feed(profiler, 5, {
      gpu: {
        'gpu:frame': 9.4,
        'gpu:tonemap': 3,
        'gpu:post/upscale': 3,
        'gpu:gizmos': 3,
        'gpu:forward-opaque': 9,
      },
    })
    expect(gpuPassOverlap(profiler)).toMatchObject({
      overlapping: true,
      frameMs: 9.4,
      passesMs: 18,
    })
    const d = describePerf(app.world) as { gpu: { overlapping: boolean; note?: string } }
    expect(d.gpu.overlapping).toBe(true)
    expect(d.gpu.note).toContain('perf.ablate')
    // A pass group (gpu:span/post) isn't a pass of its own.
    const calm = new Profiler()
    feed(calm, 5, {
      gpu: { 'gpu:frame': 9, 'gpu:forward-opaque': 6, 'gpu:tonemap': 2, 'gpu:span/post': 2 },
    })
    expect(gpuPassOverlap(calm)!.overlapping).toBe(false)
  })
})

describe('perf.budgets (0075)', () => {
  it('without budgets from the host: no machine, and a perf/no-budgets warning', async () => {
    const app = new App()
    await app.init()
    const out = describeBudgets(app.world)
    expect(out.machine).toBeNull()
    expect(out.warnings.map((w) => w.code)).toEqual(['perf/no-budgets'])
  })

  it('lists every budget with its latest p95 over budget first, and the scenario slices', async () => {
    const app = new App({ perfScenario: 'scatter-walk' })
    app.insertResource(PerfBudgets, { ...files, cpu: 'Apple M4' })
    await app.init()
    app.world.initResource(PerfProviders).adapter = () => M4
    expect(app.perfScenario).toBe('scatter-walk')
    const profiler = app.world.resource(ProfilerResource)
    feed(profiler, 10, {
      cpu: { 'mirror/sync': 0.5, 'nav/find-path': 1 },
      gpu: { 'gpu:frame': 10, 'gpu:forward-opaque': 5 },
    })
    const out = describeBudgets(app.world)
    expect(out.machine).toBe('laptop')
    expect(out.warnings).toEqual([])
    expect(out.budgets[0]).toMatchObject({ key: 'mirror/sync', verdict: 'over', limit: 0.2 })
    expect(out.budgets.find((b) => b.key === 'nav/find-path')).toMatchObject({ verdict: 'pass' })
    // Units and rates are per item: no aggregate measures them.
    expect(out.budgets.find((b) => b.key === 'noise/fbm6')!.verdict).toBe('unmeasured')
    expect(out.scenario!.name).toBe('scatter-walk')
    expect(out.scenario!.slices[0]).toMatchObject({ slice: 'gpu:forward-opaque', verdict: 'over' })
    // Another scenario on request; one budgets.json lacks throws.
    expect(describeBudgets(app.world, { scenario: 'crowd' }).scenario!.name).toBe('crowd')
    expect(() => describeBudgets(app.world, { scenario: 'nope' })).toThrow(
      expect.objectContaining({ code: 'perf/unknown-budget' }),
    )
  })

  it("gives a slice in ms on the detected machine: 0045's foliage target", async () => {
    const app = new App()
    app.insertResource(PerfBudgets, { ...files, cpu: 'Apple M4' })
    await app.init()
    app.world.initResource(PerfProviders).adapter = () => M4
    const share = files.budgets.scenarios['scatter-walk']!.slices.gpu['gpu:foliage']!
    expect(scenarioSliceMs(app.world, 'scatter-walk', 'gpu', 'gpu:foliage')).toBeCloseTo(
      16.6 * share,
    )
    // A browser: no CPU model, no machine, no number (and so no adaptation by default).
    app.insertResource(PerfBudgets, files)
    expect(scenarioSliceMs(app.world, 'scatter-walk', 'gpu', 'gpu:foliage')).toBeUndefined()
    expect(app.world.resource(PerfScenario).name).toBeNull()
  })
})
