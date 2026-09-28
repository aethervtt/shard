import { ShardError } from '@aethervtt/shard-core'
import { decodeTrack, type Track } from '../track/format'
import { type SettleRule, type TrackContactOptions, trackCancelled } from '../track/record'
import type { TrackScene } from '../track/scene'
import type { SettleRuleRef, TrackReply, TrackRequest } from './protocol'
import { createTrackServer } from './serve'

/** What the client needs of a worker. A DOM `Worker` is one; Node's `worker_threads` needs an adapter. */
export interface TrackWorkerLike {
  postMessage(message: TrackRequest, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void
  addEventListener(type: 'error' | 'messageerror', listener: (event: Event) => void): void
  terminate(): void
}

export interface TrackClientOptions {
  /**
   * Makes the worker: `trackWorker` from this module, a host's own entry (a package with its own
   * settle rules), or `'inline'` to record on the calling thread (Node, tests).
   */
  spawn: (() => TrackWorkerLike) | 'inline'
  /** With `'inline'`: settle rules besides `sleep`. A worker gets its rules from its entry. */
  rules?: { [name: string]: SettleRule }
}

export interface TrackRecordOptions {
  /** Aborting it rejects at once with `physics/track-cancelled`, and stops the worker's recording. */
  signal?: AbortSignal
  /** A rule the worker registered, and its parameters (default `sleep`). */
  settle?: SettleRuleRef
  contacts?: TrackContactOptions
}

export interface TrackClient {
  /** Starts the worker and loads Rapier's WASM. Call it early to have it warm for the first roll. */
  ready(): Promise<void>
  record(scene: TrackScene, options?: TrackRecordOptions): Promise<Track>
  /** Stops the worker; pending recordings reject with `physics/track-cancelled`. */
  dispose(): void
  readonly disposed: boolean
  /** Workers spawned so far (a crash respawns on the next call). */
  readonly spawns: number
}

interface Pending {
  resolve(track: Track): void
  reject(err: unknown): void
  cleanup(): void
}

/** A worker on the calling thread: the same server, replies delivered as tasks. */
function inlineWorker(rules: TrackClientOptions['rules']): TrackWorkerLike {
  const listeners: ((event: MessageEvent) => void)[] = []
  const server = createTrackServer((reply) => {
    queueMicrotask(() => {
      for (const listener of listeners) listener({ data: reply } as MessageEvent)
    })
  }, rules)
  return {
    postMessage: (message) => server.handle(message),
    addEventListener(type: string, listener: (event: never) => void) {
      if (type === 'message') listeners.push(listener as (event: MessageEvent) => void)
    },
    terminate: () => server.dispose(),
  }
}

function crashed(reason: string): ShardError {
  return new ShardError('physics/worker-crashed', `The track worker crashed: ${reason}`, {
    hint: 'The next recording starts a new worker.',
  })
}

/**
 * Records tracks off the main thread. One worker, started on first use; a crash rejects what's
 * pending with `physics/worker-crashed`, and the next call starts another.
 */
export function createTrackClient(options: TrackClientOptions): TrackClient {
  let worker: TrackWorkerLike | undefined
  let warm: Promise<void> | undefined
  let readyReject: ((err: unknown) => void) | undefined
  let disposed = false
  let spawns = 0
  let nextId = 1
  const pending = new Map<number, Pending>()

  function settle(id: number): Pending | undefined {
    const p = pending.get(id)
    if (!p) return undefined
    pending.delete(id)
    p.cleanup()
    return p
  }

  function rejectAll(err: unknown): void {
    for (const id of [...pending.keys()]) settle(id)!.reject(err)
  }

  function crash(reason: string): void {
    const w = worker
    worker = undefined
    warm = undefined
    const err = crashed(reason)
    readyReject?.(err)
    readyReject = undefined
    rejectAll(err)
    w?.terminate()
  }

  function onReply(reply: TrackReply): void {
    if (reply.type === 'ready') {
      readyReject = undefined
      return
    }
    if (reply.id === null) {
      // init failed: nothing can record on this worker.
      crash(reply.type === 'error' ? reply.message : 'init failed')
      return
    }
    const p = settle(reply.id)
    if (!p) return // cancelled here already
    if (reply.type === 'track') {
      try {
        p.resolve(decodeTrack(reply.buffer))
      } catch (err) {
        p.reject(err)
      }
      return
    }
    p.reject(new ShardError(reply.code, reply.message, { hint: reply.hint, path: reply.path }))
  }

  function ensure(): TrackWorkerLike {
    if (disposed) {
      throw new ShardError('physics/track-client-disposed', 'The track client was disposed', {
        hint: 'Create another with createTrackClient.',
      })
    }
    if (worker) return worker
    const w = options.spawn === 'inline' ? inlineWorker(options.rules) : options.spawn()
    spawns++
    worker = w
    warm = new Promise<void>((resolve, reject) => {
      readyReject = reject
      w.addEventListener('message', (event) => {
        if (worker !== w) return
        const reply = event.data as TrackReply
        if (reply.type === 'ready') resolve()
        onReply(reply)
      })
    })
    // Nobody may be waiting on ready(); a crash still rejects the recordings themselves.
    warm.catch(() => {})
    const onCrash = (event: Event) => {
      if (worker !== w) return
      const message = (event as ErrorEvent).message
      crash(message || (event.type === 'messageerror' ? 'a message could not be read' : 'error'))
    }
    w.addEventListener('error', onCrash)
    w.addEventListener('messageerror', onCrash)
    w.postMessage({ type: 'init' })
    return w
  }

  return {
    get disposed() {
      return disposed
    },
    get spawns() {
      return spawns
    },
    async ready() {
      ensure()
      await warm
    },
    record(scene, recordOptions = {}) {
      let w: TrackWorkerLike
      try {
        w = ensure()
      } catch (err) {
        return Promise.reject(err)
      }
      const { signal } = recordOptions
      if (signal?.aborted) return Promise.reject(trackCancelled())
      const id = nextId++
      return new Promise<Track>((resolve, reject) => {
        const onAbort = () => {
          if (!settle(id)) return
          if (worker === w) w.postMessage({ type: 'cancel', id })
          reject(trackCancelled())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        pending.set(id, {
          resolve,
          reject,
          cleanup: () => signal?.removeEventListener('abort', onAbort),
        })
        w.postMessage({
          type: 'record',
          id,
          scene,
          settle: recordOptions.settle,
          contacts: recordOptions.contacts,
        })
      })
    },
    dispose() {
      if (disposed) return
      disposed = true
      const w = worker
      worker = undefined
      warm = undefined
      rejectAll(new ShardError('physics/track-cancelled', 'The track client was disposed'))
      if (w) {
        w.postMessage({ type: 'dispose' })
        w.terminate()
      }
    },
  }
}
