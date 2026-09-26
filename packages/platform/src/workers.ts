import { ShardError } from '@shard/core'
import type { Platform } from './index'

export interface WorkerRunOptions {
  /** Buffers that move to the worker instead of being copied. The caller can't use them after. */
  readonly transfer?: readonly ArrayBuffer[]
  /** `high` jobs start before every queued `normal` one. Default `normal`. */
  readonly priority?: 'high' | 'normal'
}

/**
 * A pool of background threads that run functions exported by ES modules. Results never depend on
 * which worker ran a job; when order matters, callers apply results in the order they asked.
 */
export interface Workers {
  /** Worker threads. 0 means jobs run inline on the calling thread. */
  readonly size: number
  /**
   * Runs `fn` from the module at `module` (a URL, such as
   * `new URL('./worker.js', import.meta.url).href`) with `args`, and resolves with its result.
   * Worker modules are plain JavaScript: they load in a worker without a bundler. Typed arrays
   * in the result (the result itself or its own properties) move back instead of being copied.
   * Rejects with `platform/worker-crashed` if the worker dies (the pool replaces it), or with the
   * error the function threw.
   */
  run<T>(
    module: string,
    fn: string,
    args: readonly unknown[],
    options?: WorkerRunOptions,
  ): Promise<T>
  /** Stops every worker. Jobs still running or queued reject. */
  dispose(): void
}

/** What a host gives the pool for one worker thread. */
export interface WorkerThread {
  post(message: unknown, transfer: readonly ArrayBuffer[]): void
  /** Lets the host exit while this worker is idle (Node); optional. */
  idle?(idle: boolean): void
  terminate(): void
}

export interface WorkerThreadEvents {
  message(message: unknown): void
  /** The worker died: an uncaught error, or it exited. */
  exit(reason: string): void
}

export interface WorkerPoolOptions {
  size: number
  /** Starts one worker running `workerHostSource`. */
  spawn(events: WorkerThreadEvents): WorkerThread
}

interface Job {
  id: number
  module: string
  fn: string
  args: readonly unknown[]
  transfer: readonly ArrayBuffer[]
  resolve(value: unknown): void
  reject(error: unknown): void
}

interface Slot {
  thread: WorkerThread | undefined
  job: Job | undefined
}

interface Reply {
  id: number
  ok: boolean
  result?: unknown
  error?: { code?: string; message: string; hint?: string; path?: string }
}

/** The shared queue: a worker per slot, one job per worker at a time, FIFO with a priority lane. */
export function createWorkerPool(options: WorkerPoolOptions): Workers {
  const slots: Slot[] = []
  const high: Job[] = []
  const normal: Job[] = []
  let nextId = 1
  let disposed = false

  const start = (slot: Slot) => {
    const events: WorkerThreadEvents = {
      message: (message) => {
        const reply = message as Reply
        const job = slot.job
        if (!job || job.id !== reply.id) return
        slot.job = undefined
        if (reply.ok) job.resolve(reply.result)
        else job.reject(toError(reply.error!))
        pump()
      },
      exit: (reason) => {
        if (slot.thread !== thread) return
        slot.thread = undefined
        const job = slot.job
        slot.job = undefined
        job?.reject(
          new ShardError(
            'platform/worker-crashed',
            `A worker died running "${job.fn}": ${reason}`,
            {
              hint: 'The pool started a replacement; the job can be retried.',
              path: job.module,
            },
          ),
        )
        if (!disposed) pump()
      },
    }
    const thread = options.spawn(events)
    slot.thread = thread
    return thread
  }

  const pump = () => {
    for (const slot of slots) {
      if (slot.job) continue
      const job = high.shift() ?? normal.shift()
      if (!job) {
        slot.thread?.idle?.(true)
        continue
      }
      const thread = slot.thread ?? start(slot)
      slot.job = job
      thread.idle?.(false)
      const { id, module, fn, args } = job
      try {
        thread.post({ id, module, fn, args }, job.transfer)
      } catch (err) {
        slot.job = undefined
        job.reject(err)
      }
    }
  }

  for (let i = 0; i < options.size; i++) slots.push({ thread: undefined, job: undefined })

  return {
    size: options.size,
    run: <T>(module: string, fn: string, args: readonly unknown[], opts: WorkerRunOptions = {}) =>
      new Promise<T>((resolve, reject) => {
        if (disposed) {
          reject(new ShardError('platform/workers-disposed', 'The worker pool was disposed'))
          return
        }
        const job: Job = {
          id: nextId++,
          module,
          fn,
          args,
          transfer: opts.transfer ?? [],
          resolve: resolve as (value: unknown) => void,
          reject,
        }
        ;(opts.priority === 'high' ? high : normal).push(job)
        pump()
      }),
    dispose: () => {
      disposed = true
      const stopped = new ShardError('platform/workers-disposed', 'The worker pool was disposed')
      for (const job of [...high.splice(0), ...normal.splice(0)]) job.reject(stopped)
      for (const slot of slots) {
        slot.job?.reject(stopped)
        slot.job = undefined
        slot.thread?.terminate()
        slot.thread = undefined
      }
    },
  }
}

function toError(e: NonNullable<Reply['error']>): ShardError {
  return new ShardError(e.code ?? 'platform/worker-job-failed', e.message, {
    hint: e.hint,
    path: e.path,
  })
}

/**
 * A pool of size 0: jobs run inline on the calling thread, each after an `await`. Hosts without
 * threads and tests that turn workers off use it, and everything that uses a pool works the same.
 */
export function createInlineWorkers(): Workers {
  const modules = new Map<string, Promise<Record<string, unknown>>>()
  let disposed = false
  return {
    size: 0,
    run: async <T>(module: string, fn: string, args: readonly unknown[]) => {
      if (disposed)
        throw new ShardError('platform/workers-disposed', 'The worker pool was disposed')
      let mod = modules.get(module)
      if (!mod) {
        mod = import(/* @vite-ignore */ module) as Promise<Record<string, unknown>>
        modules.set(module, mod)
      }
      const f = (await mod)[fn]
      if (typeof f !== 'function') {
        throw new ShardError('platform/worker-no-export', `"${module}" has no export "${fn}"`, {
          hint: 'Worker functions are named exports of the module passed to run().',
        })
      }
      return (await f(...args)) as T
    },
    dispose: () => {
      disposed = true
    },
  }
}

let inline: Workers | undefined

/** The platform's pool, or a shared inline one on hosts without threads. */
export function workersOf(platform: Pick<Platform, 'workers'> | undefined): Workers {
  if (platform?.workers) return platform.workers
  inline ??= createInlineWorkers()
  return inline
}

/** How many workers a host with `cores` logical cores gets: one per core but one, 1 to 8. */
export function defaultWorkerCount(cores: number): number {
  return Math.max(1, Math.min(8, Math.floor(cores) - 1))
}

/**
 * The script every worker runs. It imports job modules on first use (cached), calls the export,
 * and posts the result back, moving typed arrays in it. `node` reads `worker_threads`; `web`
 * uses the worker global.
 */
export function workerHostSource(host: 'node' | 'web'): string {
  const body = `
const modules = new Map()
const load = (url) => {
  let m = modules.get(url)
  if (!m) { m = import(url); modules.set(url, m) }
  return m
}
const transfers = (value) => {
  const out = []
  const add = (x) => {
    if (ArrayBuffer.isView(x) && x.buffer instanceof ArrayBuffer && !out.includes(x.buffer)) out.push(x.buffer)
  }
  add(value)
  if (value && typeof value === 'object' && !ArrayBuffer.isView(value)) for (const k of Object.keys(value)) add(value[k])
  return out
}
const handle = async (msg, post) => {
  const { id, module, fn, args } = msg
  try {
    const mod = await load(module)
    const f = mod[fn]
    if (typeof f !== 'function') {
      throw Object.assign(new Error('"' + module + '" has no export "' + fn + '"'), { code: 'platform/worker-no-export' })
    }
    const result = await f(...args)
    post({ id, ok: true, result }, transfers(result))
  } catch (e) {
    post({ id, ok: false, error: { code: e && e.code, message: String((e && e.message) || e), hint: e && e.hint, path: e && e.path } }, [])
  }
}
`
  return host === 'node'
    ? `${body}
const { parentPort } = require('node:worker_threads')
parentPort.on('message', (m) => handle(m, (r, t) => parentPort.postMessage(r, t)))
`
    : `${body}
self.onmessage = (e) => handle(e.data, (r, t) => self.postMessage(r, t))
`
}
