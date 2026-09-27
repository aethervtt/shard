import {
  createInlineWorkers,
  createWorkerPool,
  defaultWorkerCount,
  type Workers,
  workerHostSource,
} from '@aethervtt/shard-platform'

let hostUrl: string | undefined

/**
 * A pool of module web workers, used by the web and Tauri platforms. Each runs the pool's host
 * script from a blob URL and imports job modules by absolute URL. `size` 0 runs jobs inline.
 * Default: one per core but one, 1 to 8.
 */
export function createWebWorkers(size?: number): Workers {
  const count = size ?? defaultWorkerCount(navigator.hardwareConcurrency || 2)
  if (count <= 0 || typeof Worker === 'undefined') return createInlineWorkers()
  hostUrl ??= URL.createObjectURL(new Blob([workerHostSource('web')], { type: 'text/javascript' }))
  const url = hostUrl
  return createWorkerPool({
    size: count,
    spawn: (events) => {
      const worker = new Worker(url, { type: 'module', name: 'shard-worker' })
      worker.onmessage = (e) => events.message(e.data)
      worker.onerror = (e) => {
        e.preventDefault()
        worker.terminate()
        events.exit(e.message || 'worker error')
      }
      return {
        post: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
        terminate: () => worker.terminate(),
      }
    },
  })
}
