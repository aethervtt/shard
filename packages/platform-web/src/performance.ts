import type { HeapStats } from '@aethervtt/shard-core'
import type { SelfProfileTrace } from '@aethervtt/shard-core/capture'
import type { HostDownloads, HostPerformance, HostSampler } from '@aethervtt/shard-platform'

/** Resource timing entries kept before the browser stops recording: enough for a large scene. */
const RESOURCE_BUFFER = 10_000
/** Long tasks kept for listeners that join late; older ones fall off. */
const TASK_HISTORY = 1_000

let shared: HostPerformance | undefined

/**
 * The page's own instruments (0062): a `longtask` observer, and resource timing for downloads.
 * One per page: the observer starts on the first call and keeps every long task since, buffered
 * ones from before it included. Three.js pages can use it too, so both renderers measure alike.
 */
export function createWebPerformance(): HostPerformance {
  if (shared) return shared
  const listeners = new Set<(startMs: number, durationMs: number) => void>()
  const tasks: [number, number][] = []
  const observes =
    typeof PerformanceObserver !== 'undefined' &&
    PerformanceObserver.supportedEntryTypes?.includes('longtask')
  if (observes) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        tasks.push([entry.startTime, entry.duration])
        if (tasks.length > TASK_HISTORY) tasks.shift()
        for (const listener of listeners) listener(entry.startTime, entry.duration)
      }
    }).observe({ type: 'longtask', buffered: true })
  }
  const timing = typeof performance !== 'undefined' && 'getEntriesByType' in performance
  if (timing && performance.setResourceTimingBufferSize) {
    performance.setResourceTimingBufferSize(RESOURCE_BUFFER)
  }
  shared = {
    userAgent: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
    ...(observes && {
      onLongTask(listener: (startMs: number, durationMs: number) => void) {
        // Tasks from before the listener joined, then every new one.
        for (const [start, duration] of tasks) listener(start, duration)
        listeners.add(listener)
        return () => void listeners.delete(listener)
      },
    }),
    ...(timing && { downloads }),
    heap,
    startSampler,
    measure,
  }
  return shared
}

// --- the profiler's instruments (0074) -------------------------------------------------------

/** `measureUserAgentSpecificMemory` is slow and asynchronous: once every 5 s at most. */
const MEMORY_EVERY_MS = 5000
let measured: HeapStats | undefined
let measuring = false
let measuredAt = Number.NEGATIVE_INFINITY

interface PageMemory {
  measureUserAgentSpecificMemory?(): Promise<{ bytes: number }>
  memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number }
}

/** The heap: the isolated page's measurement (the last one), or Chrome's `performance.memory`. */
function heap(): HeapStats | undefined {
  const page = performance as unknown as PageMemory
  if (globalThis.crossOriginIsolated && page.measureUserAgentSpecificMemory) {
    const now = performance.now()
    if (!measuring && now - measuredAt >= MEMORY_EVERY_MS) {
      measuring = true
      measuredAt = now
      page
        .measureUserAgentSpecificMemory()
        .then((r) => {
          measured = { usedBytes: r.bytes, source: 'measureUserAgentSpecificMemory' }
        })
        .catch(() => {})
        .finally(() => {
          measuring = false
        })
    }
    if (measured) return measured
  }
  const memory = page.memory
  if (!memory) return undefined
  return {
    usedBytes: memory.usedJSHeapSize,
    totalBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
    source: 'performance.memory',
  }
}

interface SelfProfiler {
  stop(): Promise<unknown>
}
type SelfProfilerCtor = new (options: {
  sampleInterval: number
  maxBufferSize: number
}) => SelfProfiler

/** Milliseconds between samples asked for; browsers round up (Chrome samples every 10 ms or so). */
const SAMPLE_INTERVAL_MS = 1

/**
 * The JS Self-Profiling API: needs `Document-Policy: js-profiling` on the page (shard dev and the
 * playground send it). Undefined where it's missing or the policy isn't there.
 */
async function startSampler(): Promise<HostSampler | undefined> {
  const Ctor = (globalThis as { Profiler?: SelfProfilerCtor }).Profiler
  if (!Ctor) return undefined
  let profiler: SelfProfiler
  try {
    profiler = new Ctor({ sampleInterval: SAMPLE_INTERVAL_MS, maxBufferSize: 100_000 })
  } catch {
    return undefined
  }
  return {
    stop: async () => {
      const trace = (await profiler.stop()) as SelfProfileTrace
      const { hottestFromSelfProfile, samplesFromSelfProfile } = await import(
        '@aethervtt/shard-core/capture'
      )
      return {
        hottest: hottestFromSelfProfile(trace, SAMPLE_INTERVAL_MS),
        samples: samplesFromSelfProfile(trace, SAMPLE_INTERVAL_MS),
      }
    },
  }
}

/** A span in Chrome's Performance panel, on a Shard track (DevTools extensibility API). */
function measure(name: string, track: string, start: number, ms: number): void {
  try {
    performance.measure(name, {
      start,
      end: start + ms,
      detail: {
        devtools: { dataType: 'track-entry', track: `shard ${track}`, trackGroup: 'Shard' },
      },
    })
  } catch {
    // Older browsers don't take a detail; the span is simply missing there.
  }
}

/** The document and every resource it fetched: scripts, WASM, images, data. */
function downloads(): HostDownloads {
  const result: HostDownloads = { transferred: 0, decoded: 0 }
  const add = (entry: PerformanceResourceTiming) => {
    result.transferred += entry.transferSize
    result.decoded += entry.decodedBodySize
  }
  for (const entry of performance.getEntriesByType('navigation')) {
    add(entry as PerformanceResourceTiming)
  }
  for (const entry of performance.getEntriesByType('resource')) {
    add(entry as PerformanceResourceTiming)
  }
  return result
}
