import {
  type CaptureOptions,
  type CaptureSummary,
  type CaptureWarning,
  type ChromeTrace,
  defineResource,
  type HeapStats,
  type HotFunction,
  type Profiler,
  ProfilerResource,
  ShardError,
  type SpanAggregate,
  type SpanStats,
  spanCovers,
  TRACK,
  trackName,
  type World,
} from '@aethervtt/shard-core'

// The agent surface of the profiler (0074): `perf.describe`'s aggregates, and captures with their
// summary and trace. Captures, sampling and trace writing load with `import()` on first use.

/** A sampling profiler the host runs for a capture's window. */
export interface PerfSampler {
  stop(): Promise<PerfSamples>
}

export interface PerfSamples {
  hottest: HotFunction[]
  /** Stretches of the same top function, for the trace's samples track (browsers). */
  samples?: { name: string; start: number; ms: number }[]
  /** A V8 `.cpuprofile` (Node), written next to the trace. */
  cpuprofile?: unknown
}

/**
 * What the host can measure for the profiler. The asset server fills it from the platform
 * (`HostPerformance` and the file system) when it's configured.
 */
export interface PerfHost {
  /** JS heap: `v8.getHeapStatistics()` in Node, the page's measurements in browsers. */
  heap?(): HeapStats | undefined
  /** Garbage collections as they happen (Node): start on the app's clock, pause, and kind. */
  onGc?(listener: (start: number, ms: number, kind: string) => void): () => void
  /** Starts sampling; undefined where the host can't (`perf/sampling-unavailable`). */
  startSampler?(): Promise<PerfSampler | undefined>
  /** Emits a span to the host's own profiler (Chrome's Performance panel). */
  measure?(name: string, track: string, start: number, ms: number): void
  /** Writes a project file (traces go to `.shard/captures/`). Absent on read-only hosts. */
  writeText?(path: string, text: string): Promise<void>
}

export const PerfHostResource = defineResource<PerfHost>('runtime/PerfHost', {
  description: "The host's profiling instruments (0074): heap, GC, sampling, and where traces go.",
})

export interface PerfProvidersData {
  /** GPU memory by category (the render plugin's ledger). */
  gpuMemory?: (world: World) => { bytes: number; byCategory: Record<string, number> }
  /** More `perf.describe` sections by name (0075 adds budgets). */
  sections: Map<string, (world: World) => unknown>
}

export const PerfProviders = defineResource<PerfProvidersData>('runtime/PerfProviders', {
  description: 'What packages add to perf.describe and capture summaries: GPU memory, sections.',
  init: () => ({ sections: new Map() }),
})

export interface PerfDescribeOptions {
  /** Only spans these keys cover (`spanCovers`: equal, or a prefix ending at "/"). */
  spans?: readonly string[]
  /** Most spans per track. Default 30. */
  top?: number
}

const r3 = (ms: number) => Math.round(ms * 1000) / 1000

function rounded(a: SpanAggregate) {
  const out: Record<string, unknown> = {
    span: a.span,
    last: r3(a.last),
    avg: r3(a.avg),
    p50: r3(a.p50),
    p95: r3(a.p95),
    max: r3(a.max),
    samples: a.samples,
  }
  if (a.coarse) out.coarse = true
  return out
}

/** The JS heap, from the host, or what the runtime itself can read. */
function heapOf(world: World): HeapStats | undefined {
  const fromHost = world.tryResource(PerfHostResource)?.heap?.()
  if (fromHost) return fromHost
  const g = globalThis as {
    process?: { memoryUsage?(): { heapUsed: number; heapTotal: number } }
    performance?: {
      memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
    }
  }
  const usage = g.process?.memoryUsage?.()
  if (usage) return { usedBytes: usage.heapUsed, totalBytes: usage.heapTotal, source: 'v8' }
  const memory = g.performance?.memory
  if (memory) {
    return {
      usedBytes: memory.usedJSHeapSize,
      totalBytes: memory.totalJSHeapSize,
      limitBytes: memory.jsHeapSizeLimit,
      source: 'performance.memory',
    }
  }
  return undefined
}

/** GPU memory from the ledger, and the JS heap. */
export function perfMemory(world: World): CaptureSummary['memory'] {
  const gpu = world.tryResource(PerfProviders)?.gpuMemory?.(world) ?? { bytes: 0, byCategory: {} }
  const heap = heapOf(world)
  return heap ? { gpu, heap } : { gpu }
}

/**
 * `perf.describe` (0074): per-frame, per-schedule, per-system CPU time, GPU passes, worker and
 * async spans, memory (GPU ledger, JS heap, ECS tables), and the clock.
 */
export function describePerf(world: World, options: PerfDescribeOptions = {}) {
  const profiler = world.resource(ProfilerResource)
  const keys = options.spans
  const top = options.top ?? 30
  const wanted = (name: string) => !keys || keys.some((k) => spanCovers(k, name))
  const byTrack: Record<string, SpanAggregate[]> = { main: [], gpu: [], worker: [], async: [] }
  const schedules: Record<string, unknown> = {}
  const commands: Record<string, unknown> = {}
  for (const name of profiler.names()) {
    if (!wanted(name)) continue
    const stats = profiler.stats(name)!
    if (name.startsWith('schedule/')) schedules[name] = rounded(stats)
    else if (name.startsWith('commands/')) commands[name] = rounded(stats)
    else if (name !== 'frame' && name !== 'gpu:frame') byTrack[stats.track]?.push(stats)
  }
  const list = (track: string) =>
    (byTrack[track] ?? [])
      .sort((a, b) => b.avg - a.avg || (a.span < b.span ? -1 : 1))
      .slice(0, top)
      .map(rounded)
  const frame = profiler.stats('frame')
  const gpuFrame = profiler.stats('gpu:frame')
  const clock = profiler.clock
  const ecs = world.stats()
  let ecsBytes = 0
  for (const t of ecs.tables) ecsBytes += t.bytes
  const providers = world.tryResource(PerfProviders)
  const sections: Record<string, unknown> = {}
  for (const [name, fn] of providers?.sections ?? []) sections[name] = fn(world)
  return {
    enabled: profiler.enabled,
    window: profiler.window,
    clock: {
      resolutionMs: clock.resolutionMs,
      isolated: clock.isolated,
      /** Spans that average under this read mostly the clock's step (`coarse`). */
      coarseBelowMs: r3(clock.resolutionMs * 4),
    },
    frame: frame ? rounded(frame) : null,
    schedules,
    commands,
    systems: list('main'),
    gpu:
      profiler.gpu.status === 'unavailable'
        ? ('unavailable' as const)
        : {
            frame: gpuFrame ? rounded(gpuFrame) : null,
            quantized: profiler.gpu.quantized,
            passes: list('gpu'),
          },
    workers: list('worker'),
    async: list('async'),
    memory: {
      ...perfMemory(world),
      ecs: { entities: ecs.entities, archetypes: ecs.archetypes, bytes: ecsBytes },
    },
    ...sections,
  }
}

export interface PerfCaptureOptions extends Omit<CaptureOptions, 'devtools'> {
  /** Samples with the host's profiler (V8's in Node, JS Self-Profiling in browsers). */
  sample?: boolean
  /** Also shows spans in Chrome's Performance panel (`performance.measure`). Allocates. */
  devtools?: boolean
  /** Writes the trace to `.shard/captures/` when the host can (default true); else it's inline. */
  write?: boolean
  /**
   * Runs one frame, for hosts without a frame loop (headless, tests). Without it the capture waits
   * for the loop's frames.
   */
  step?: () => void | Promise<void>
}

export interface PerfCaptureResult {
  summary: CaptureSummary
  /** Where the trace went, project-relative. */
  tracePath?: string
  /** The trace itself, when it wasn't written. */
  trace?: ChromeTrace
  /** The sampling profile (Node), next to the trace. */
  profilePath?: string
}

/** A file-name stamp: 2026-10-07T12-30-05-123Z. */
export function captureStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-')
}

/**
 * The spans with the highest p95 over the profiler's window, for perf records (0062's version 2):
 * CPU (main thread, workers, async) and GPU, `frame` and `gpu:frame` aside.
 */
export function perfBreakdown(world: World, limit = 10): { cpu: SpanStats[]; gpu: SpanStats[] } {
  const profiler = world.resource(ProfilerResource)
  const cpu: SpanStats[] = []
  const gpu: SpanStats[] = []
  for (const name of profiler.names()) {
    if (name === 'frame' || name === 'gpu:frame') continue
    const a = profiler.stats(name)!
    const stats: SpanStats = {
      span: name,
      track: a.track,
      calls: a.samples,
      total: r3(a.avg * a.samples),
      p50: r3(a.p50),
      p95: r3(a.p95),
      max: r3(a.max),
    }
    ;(a.track === 'gpu' ? gpu : cpu).push(stats)
  }
  const order = (x: SpanStats, y: SpanStats) => y.p95 - x.p95 || (x.span < y.span ? -1 : 1)
  return { cpu: cpu.sort(order).slice(0, limit), gpu: gpu.sort(order).slice(0, limit) }
}

const gcNames = new Map<string, string>()

/**
 * Captures N frames, or a flight recorder's window around a slow frame (0074). Resolves with the
 * summary, and the trace's path (or the trace) once it has them.
 */
export async function capturePerf(
  world: World,
  options: PerfCaptureOptions = {},
): Promise<PerfCaptureResult> {
  const profiler: Profiler = world.resource(ProfilerResource)
  if (profiler.sink) {
    throw new ShardError('perf/capture-running', 'A capture is already running on this app', {
      hint: 'Wait for it to finish, then capture again.',
    })
  }
  const { startCapture } = await import('@aethervtt/shard-core/capture')
  const host = world.tryResource(PerfHostResource)
  const warnings: CaptureWarning[] = []
  let sampler: PerfSampler | undefined
  if (options.sample) {
    sampler = await host?.startSampler?.()
    if (!sampler) {
      warnings.push(
        new ShardError('perf/sampling-unavailable', "This host can't sample JavaScript", {
          hint: 'Node samples with node:inspector; browsers need the JS Self-Profiling API and a Document-Policy: js-profiling header (shard dev and the playground send it).',
        }).toJSON(),
      )
    }
  }
  const measure = host?.measure
  const { step, sample: _, devtools, write, ...captureOptions } = options
  const recorder = startCapture(profiler, {
    ...captureOptions,
    devtools:
      devtools && measure
        ? (name, track, start, ms) => measure(name, trackName(track), start, ms)
        : undefined,
  })
  const offGc = host?.onGc?.((start, ms, kind) => {
    let name = gcNames.get(kind)
    if (!name) {
      name = `gc/${kind}`
      gcNames.set(kind, name)
    }
    profiler.event(name, TRACK.gc, start, ms)
  })
  let capture: Awaited<typeof recorder.done>
  try {
    if (step) {
      while (recorder.running) await step()
    } else {
      // A loop that stops (paused, on demand) shouldn't hang the capture forever.
      const limitMs = ((options.timeout ?? 60) + (options.frames ?? 300) / 10) * 1000
      const timer = setTimeout(() => recorder.stop(), limitMs)
      try {
        await recorder.done
      } finally {
        clearTimeout(timer)
      }
    }
    capture = await recorder.done
  } catch (err) {
    recorder.stop()
    throw err
  } finally {
    offGc?.()
  }
  const sampled = sampler ? await sampler.stop() : undefined
  const summary = capture.summary({
    clock: { ...profiler.clock, gpuQuantized: profiler.gpu.quantized },
    memory: perfMemory(world),
    hottest: sampled?.hottest,
    warnings,
  })
  const trace = capture.trace({ samples: sampled?.samples })
  const result: PerfCaptureResult = { summary }
  if (write !== false && host?.writeText) {
    const stamp = captureStamp()
    result.tracePath = `.shard/captures/${stamp}.trace.json`
    await host.writeText(result.tracePath, JSON.stringify(trace))
    if (sampled?.cpuprofile) {
      result.profilePath = `.shard/captures/${stamp}.cpuprofile`
      await host.writeText(result.profilePath, JSON.stringify(sampled.cpuprofile))
    }
  } else {
    result.trace = trace
  }
  return result
}
