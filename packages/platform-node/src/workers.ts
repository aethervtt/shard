import { availableParallelism } from 'node:os'
import { Worker } from 'node:worker_threads'
import {
  createInlineWorkers,
  createWorkerPool,
  defaultWorkerCount,
  type Workers,
  workerHostSource,
} from '@shard/platform'

/**
 * A pool of `worker_threads`. Idle workers are unref'd, so a CLI command exits once its jobs are
 * done. `size` 0 runs jobs inline. Default: one per core but one, 1 to 8.
 */
export function createNodeWorkers(size = defaultWorkerCount(availableParallelism())): Workers {
  if (size <= 0) return createInlineWorkers()
  const source = workerHostSource('node')
  return createWorkerPool({
    size,
    spawn: (events) => {
      const worker = new Worker(source, { eval: true })
      worker.unref()
      worker.on('message', (m) => events.message(m))
      worker.on('error', (err: Error) => events.exit(err.message))
      worker.on('exit', (code) => events.exit(`exit code ${code}`))
      return {
        post: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
        idle: (idle) => (idle ? worker.unref() : worker.ref()),
        terminate: () => void worker.terminate(),
      }
    },
  })
}
