import { AssetServerResource } from '@aethervtt/shard-assets'
import {
  defineResource,
  defineSchema,
  defineSystem,
  First,
  ShardError,
  t,
} from '@aethervtt/shard-core'
import type { HostPerformance } from '@aethervtt/shard-platform'
import { Gpu, Graph, RenderScale, Window } from '@aethervtt/shard-render'
import {
  type App,
  AppControlResource,
  type AppMethod,
  definePlugin,
  FrameDemand,
  type Plugin,
  perfBreakdown,
} from '@aethervtt/shard-runtime'
import type { PerfDevice, PerfRecord } from '../record'
import { distribution, percentile, round, SampleRing } from '../stats'

export interface MetricsOptions {
  /**
   * The host's instruments: long tasks and downloads (`createWebPerformance()` from
   * `@aethervtt/shard-platform-web`, or a platform's `performance`). Without them both read 0.
   */
  performance?: HostPerformance
  /** How far back `frameTime` and `longTasks` look, in ms. Default 30 s. */
  windowMs?: number
  /** What records name the renderer: `shard@<sha>`. Default `shard`. */
  renderer?: string
  /**
   * The clock, in ms. Default `performance.now`, which counts from navigation start. It must be
   * the app's clock too (`AppOptions.now`).
   */
  now?: () => number
  /** Navigation start on that clock. Default 0. */
  navigationStart?: number
}

export interface RecordMeta {
  fixture: string
  scenario: string
  /** Overrides `MetricsOptions.renderer` for this record. */
  renderer?: string
}

const FRAME_SAMPLES = 1 << 15
const EVENT_SAMPLES = 1 << 12

/**
 * What an app measured for 0062's performance records: frame intervals, GPU frame times, traced
 * host writes, and long tasks, each timestamped so a record covers one window. Recording into it
 * each frame allocates nothing.
 */
export class Metrics {
  readonly windowMs: number
  readonly renderer: string
  private readonly app: App
  private readonly now: () => number
  private readonly navigationStart: number
  private readonly performance: HostPerformance | undefined
  private readonly frames = new SampleRing(FRAME_SAMPLES)
  private readonly gpuFrames = new SampleRing(FRAME_SAMPLES)
  private readonly traces = new SampleRing(EVENT_SAMPLES)
  private readonly longTasks = new SampleRing(EVENT_SAMPLES)
  private windowStart = Number.NEGATIVE_INFINITY
  private lastStart = Number.NaN
  /** The last frame asked for the next one, so the interval between them is a frame time. */
  private continued = false
  private gpuSamples = 0
  private scaleMin = Number.POSITIVE_INFINITY
  private scaleMax = Number.NEGATIVE_INFINITY
  private scaleAuto = false
  private scaled = false
  private pipelinesMs = Number.NaN
  private assetsMs = Number.NaN

  constructor(app: App, options: MetricsOptions = {}) {
    this.app = app
    this.windowMs = options.windowMs ?? 30_000
    this.renderer = options.renderer ?? 'shard'
    this.now = options.now ?? (() => performance.now())
    this.navigationStart = options.navigationStart ?? 0
    this.performance = options.performance
  }

  /** Starts a new window: what was measured so far no longer counts (startup numbers stay). */
  reset(): void {
    this.windowStart = this.now()
    this.frames.clear()
    this.gpuFrames.clear()
    this.traces.clear()
    this.longTasks.clear()
    this.lastStart = Number.NaN
    this.scaleMin = Number.POSITIVE_INFINITY
    this.scaleMax = Number.NEGATIVE_INFINITY
    this.scaleAuto = false
    this.scaled = false
  }

  /** @internal As a frame starts: the interval since the last one, if that one asked for this. */
  frameStart(): void {
    const now = this.now()
    if (this.continued && !Number.isNaN(this.lastStart)) this.frames.push(now, now - this.lastStart)
    this.lastStart = now
  }

  /** @internal As a frame ends: GPU time, render scale, and whether another frame follows. */
  frameEnd(): void {
    const world = this.app.world
    const now = this.now()
    const demand = world.resource(FrameDemand)
    this.continued =
      demand.mode !== 'on-demand' ||
      demand.active ||
      world.resource(AppControlResource).pendingSteps > 0
    const timer = world.tryResource(Graph)?.timer
    if (timer && timer.frameSamples !== this.gpuSamples) {
      this.gpuSamples = timer.frameSamples
      this.gpuFrames.push(now, timer.frameMs)
    }
    const scale = world.tryResource(RenderScale)
    if (scale) {
      this.scaled = true
      if (scale.scale < this.scaleMin) this.scaleMin = scale.scale
      if (scale.scale > this.scaleMax) this.scaleMax = scale.scale
      if (scale.mode === 'auto') this.scaleAuto = true
    }
  }

  /** @internal */
  trace(ms: number): void {
    this.traces.push(this.now(), ms)
  }

  /** @internal */
  longTask(start: number, duration: number): void {
    this.longTasks.push(start, duration)
  }

  /** @internal The first usable frame was presented: startup work in flight until now counts. */
  usable(at: number): void {
    const world = this.app.world
    this.pipelinesMs = world.tryResource(Gpu)?.pipelines.busyMs(at) ?? 0
    this.assetsMs = world.tryResource(AssetServerResource)?.busyMs(at) ?? 0
  }

  /**
   * The record of this app so far: startup, and the current window (since `reset()`, at most
   * `windowMs`). Throws `verify/not-usable` before the first usable frame.
   */
  record(meta: RecordMeta): PerfRecord {
    const startup = this.app.startup
    if (Number.isNaN(startup.usable) || Number.isNaN(this.pipelinesMs)) {
      throw new ShardError('verify/not-usable', 'The app has no usable frame to measure from yet', {
        hint: 'The host calls app.markUsable() once the scene is interactive; records start after the frame that follows.',
      })
    }
    const now = this.now()
    const since = Math.max(this.windowStart, now - this.windowMs)
    const nav = this.navigationStart
    const frames = this.frames.since(since)
    const gpu = this.gpuFrames.since(since)
    const traces = this.traces.since(this.windowStart)
    const tasks = this.longTasks.since(since)
    let totalMs = 0
    let maxMs = 0
    for (const d of tasks) {
      totalMs += d
      if (d > maxMs) maxMs = d
    }
    const frameTime: PerfRecord['frameTime'] = {
      ...roundAll(distribution(frames)),
      n: frames.length,
    }
    if (gpu.length > 0) frameTime.gpuP95 = round(percentile(gpu, 0.95))
    const device = this.app.world.tryResource(Gpu)
    const memory = device?.memory() ?? { bytes: 0, byCategory: {} }
    return {
      version: 2,
      renderer: meta.renderer ?? this.renderer,
      fixture: meta.fixture,
      scenario: meta.scenario,
      device: this.device(),
      renderScale: this.scaled
        ? { mode: this.scaleAuto ? 'auto' : 'fixed', min: this.scaleMin, max: this.scaleMax }
        : { mode: 'none', min: 1, max: 1 },
      coldStart: {
        total: round(startup.initEnd - nav),
        modules: round(startup.initStart - nav),
        device: round(device?.deviceMs ?? 0),
        pipelines: round(this.pipelinesMs),
        assets: round(this.assetsMs),
      },
      firstUsableFrame: round(startup.usable - nav),
      patchToFrame: {
        p50: round(percentile(traces, 0.5)),
        p95: round(percentile(traces, 0.95)),
        n: traces.length,
      },
      frameTime,
      longTasks: { count: tasks.length, totalMs: round(totalMs), maxMs: round(maxMs) },
      gpuMemory: { bytes: memory.bytes, byCategory: memory.byCategory as Record<string, number> },
      download: this.performance?.downloads?.() ?? { transferred: 0, decoded: 0 },
      breakdown: perfBreakdown(this.app.world),
    }
  }

  private device(): PerfDevice {
    const gpu = this.app.world.tryResource(Gpu)
    const info = gpu?.adapter.info
    const name = info
      ? [info.vendor, info.architecture, info.description].filter(Boolean).join(' ')
      : ''
    const page = globalThis as {
      innerWidth?: number
      innerHeight?: number
      devicePixelRatio?: number
    }
    const target = this.app.world.tryResource(Window)
    const dpr = page.devicePixelRatio ?? target?.pixelRatio ?? 1
    const viewport: [number, number] =
      page.innerWidth !== undefined
        ? [page.innerWidth, page.innerHeight ?? 0]
        : [Math.round((target?.width ?? 0) / dpr), Math.round((target?.height ?? 0) / dpr)]
    return { ua: this.performance?.userAgent ?? 'unknown', gpu: name || 'unknown', dpr, viewport }
  }
}

function roundAll(d: { p50: number; p95: number; p99: number }) {
  return { p50: round(d.p50), p95: round(d.p95), p99: round(d.p99) }
}

export const MetricsResource = defineResource<Metrics>('verify/Metrics', {
  description: "What the app measured for performance records (0062): metricsPlugin's.",
})

const frameStart = defineSystem({
  name: 'verify/frame-start',
  description: 'Times the interval since the last frame, when that frame asked for this one.',
  setup: (world) => ({ metrics: world.resource(MetricsResource) }),
  run: ({ metrics }) => metrics.frameStart(),
})

/** `metrics.record` and `metrics.reset`, for agents measuring a running app. */
export const metricsMethods: AppMethod[] = [
  {
    name: 'metrics.record',
    description:
      'A performance record (spec 0062) of the running app: cold start, first usable frame, patch-to-frame latency, frame times, long tasks, GPU memory, downloads, and the breakdown (0074: the 10 CPU and GPU spans with the highest p95), over the window since metrics.reset (at most 30 s).',
    params: defineSchema('verify/MetricsRecordParams', {
      fixture: t.string({ required: true, description: 'What was loaded, e.g. "tabletop-small".' }),
      scenario: t.string({ required: true, description: 'What ran, e.g. "tabletop-pan".' }),
      renderer: t.string({ description: 'Overrides the renderer name, e.g. "shard@1a2b3c4".' }),
    }),
    handler: ({ world }, p) =>
      metricsOf(world).record({
        fixture: p.fixture as string,
        scenario: p.scenario as string,
        renderer: (p.renderer as string) || undefined,
      }),
  },
  {
    name: 'metrics.reset',
    description:
      'Starts a new measurement window: frame times, traces and long tasks so far no longer count.',
    params: defineSchema('verify/MetricsResetParams', {}),
    handler: ({ world }) => {
      metricsOf(world).reset()
      return null
    },
  },
]

function metricsOf(world: App['world']): Metrics {
  const metrics = world.tryResource(MetricsResource)
  if (!metrics) {
    throw new ShardError('verify/no-metrics', 'This app has no metrics', {
      hint: 'Add metricsPlugin() from @aethervtt/shard-verify/metrics.',
    })
  }
  return metrics
}

/**
 * Records 0062's performance metrics: `world.resource(MetricsResource).record(meta)` or the
 * protocol's `metrics.record`. The host calls `app.markUsable()` once the scene is interactive,
 * and `app.trace(label)` after writes whose latency counts.
 */
export function metricsPlugin(options: MetricsOptions = {}): Plugin {
  const off: (() => void)[] = []
  return definePlugin({
    name: 'verify/metrics',
    provides: [MetricsResource],
    dependencies: ['core/time'],
    build(app) {
      const metrics = new Metrics(app, options)
      app.insertResource(MetricsResource, metrics)
      app.addSystems(First, frameStart)
      app.addMethod(...metricsMethods)
      off.push(
        app.onFrame(() => metrics.frameEnd()),
        app.onTrace((_, ms) => metrics.trace(ms)),
      )
      const longTasks = options.performance?.onLongTask?.((start, d) => metrics.longTask(start, d))
      if (longTasks) off.push(longTasks)
      void app.whenUsable().then((at) => metrics.usable(at))
    },
    dispose() {
      for (const fn of off.splice(0)) fn()
    },
  })
}
