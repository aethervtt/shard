// `@aethervtt/shard-physics/worker/testing`: a track worker on Node's `worker_threads`, for tests.

import { Worker } from 'node:worker_threads'
import type { TrackWorkerLike } from './client'

/**
 * Runs the TypeScript worker entry at `entry` in a worker thread, through the web Worker interface
 * the track client expects. Needs `tsx` installed.
 *
 * The thread registers tsx itself before it imports the entry. `--import tsx` in `execArgv` is not
 * enough: tsx registers its hooks in a worker thread only on Node 22.22.3 and later (where it can
 * tell a worker from Node's own loader thread). On earlier 22.x it skips them, and Node's built-in
 * type stripping then loads the entry and fails on its extensionless imports.
 */
export function nodeTrackWorker(entry: URL): TrackWorkerLike {
  const tsx = JSON.stringify(import.meta.resolve('tsx/esm/api'))
  const worker = new Worker(
    `import(${tsx}).then((tsx) => { tsx.register(); return import(${JSON.stringify(entry.href)}) })`,
    { eval: true },
  )
  const listeners: Record<string, ((event: never) => void)[]> = {
    message: [],
    error: [],
    messageerror: [],
  }
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners[type]!) listener(event as never)
  }
  worker.on('message', (data) => emit('message', { data }))
  worker.on('error', (err: Error) => emit('error', { type: 'error', message: err.message }))
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
    addEventListener: (type: string, listener: (event: never) => void) =>
      void listeners[type]!.push(listener),
    terminate: () => void worker.terminate(),
  }
}
