import { Session } from 'node:inspector/promises'
import { PerformanceObserver } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import type { HeapStats } from '@aethervtt/shard-core'
import type { HostPerformance, HostSampler } from '@aethervtt/shard-platform'

// Node's instruments for the profiler (0074): V8's heap statistics, `gc` performance entries, and
// V8's sampling profiler through `node:inspector` for a capture's window.

/** `NODE_PERFORMANCE_GC_*` flags in a gc entry's `detail.kind`. */
const GC_KINDS: Record<number, string> = { 1: 'minor', 2: 'major', 4: 'incremental', 8: 'weakcb' }

/** Microseconds between samples: V8's default is 1000; finer finds short functions. */
const SAMPLE_INTERVAL_US = 100

let sampling = false

export function createNodePerformance(): HostPerformance {
  return {
    userAgent: `node/${process.version}`,
    heap: (): HeapStats => {
      const h = getHeapStatistics()
      return {
        usedBytes: h.used_heap_size,
        totalBytes: h.total_heap_size,
        limitBytes: h.heap_size_limit,
        source: 'v8',
      }
    },
    onGc: (listener) => {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          const kind = (entry as { detail?: { kind?: number } }).detail?.kind ?? 0
          listener(entry.startTime, entry.duration, GC_KINDS[kind] ?? 'other')
        }
      })
      observer.observe({ entryTypes: ['gc'] })
      return () => observer.disconnect()
    },
    startSampler: async (): Promise<HostSampler | undefined> => {
      // One inspector profile at a time per process (--cpu-prof's included).
      if (sampling) return undefined
      sampling = true
      const session = new Session()
      try {
        session.connect()
        await session.post('Profiler.enable')
        await session.post('Profiler.setSamplingInterval', { interval: SAMPLE_INTERVAL_US })
        await session.post('Profiler.start')
      } catch {
        sampling = false
        session.disconnect()
        return undefined
      }
      return {
        stop: async () => {
          try {
            const { profile } = await session.post('Profiler.stop')
            const { hottestFromCpuProfile } = await import('@aethervtt/shard-core/capture')
            return { hottest: hottestFromCpuProfile(profile), cpuprofile: profile }
          } finally {
            session.disconnect()
            sampling = false
          }
        },
      }
    },
  }
}
