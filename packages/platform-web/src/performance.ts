import type { HostDownloads, HostPerformance } from '@aethervtt/shard-platform'

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
  }
  return shared
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
