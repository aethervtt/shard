import { ShardError } from '@aethervtt/shard-core'
import { loadDeterministic3d } from '../rapier'
import { encodeTrack } from '../track/format'
import { builtinSettleRules, recordTrack, type SettleRule, trackCancelled } from '../track/record'
import type { TrackReply, TrackRequest } from './protocol'

/** The side of a worker that receives requests: a worker's global scope, or a stand-in for one. */
export interface TrackScope {
  postMessage(message: TrackReply, transfer?: Transferable[]): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  close?(): void
}

export interface ServeTracksOptions {
  /** Settle rules by name, besides the built-in `sleep`. */
  rules?: { [name: string]: SettleRule }
  /** Default: the worker's global scope. */
  scope?: TrackScope
}

type Job = Extract<TrackRequest, { type: 'record' }>

function replyError(id: number | null, err: unknown): TrackReply {
  if (err instanceof ShardError) {
    return {
      type: 'error',
      id,
      code: err.code,
      message: err.message,
      hint: err.hint,
      path: err.path,
    }
  }
  return {
    type: 'error',
    id,
    code: 'physics/track-failed',
    message: err instanceof Error ? err.message : String(err),
  }
}

/**
 * Handles track requests one recording at a time, replying through `post`. `serveTracks` binds it
 * to a worker; the inline client binds it to the calling thread.
 */
export function createTrackServer(
  post: (reply: TrackReply, transfer?: Transferable[]) => void,
  rules?: { [name: string]: SettleRule },
): { handle(request: TrackRequest): void; dispose(): void } {
  const allRules: { [name: string]: SettleRule } = { ...builtinSettleRules, ...rules }
  const queue: Job[] = []
  let current: { id: number; abort: AbortController } | undefined
  let draining = false
  let disposed = false

  async function run(job: Job): Promise<void> {
    const abort = new AbortController()
    current = { id: job.id, abort }
    try {
      const ref = job.settle ?? { rule: 'sleep' }
      const rule = allRules[ref.rule]
      if (!rule) {
        throw new ShardError('physics/unknown-settle-rule', `No settle rule "${ref.rule}"`, {
          hint: `This worker has: ${Object.keys(allRules).join(', ')}. Register yours with serveTracks({ rules }).`,
        })
      }
      const track = await recordTrack(job.scene, {
        signal: abort.signal,
        settle: rule(ref.params),
        contacts: job.contacts,
      })
      const buffer = encodeTrack(track)
      post({ type: 'track', id: job.id, buffer }, [buffer])
    } catch (err) {
      post(replyError(job.id, err))
    } finally {
      current = undefined
    }
  }

  async function drain(): Promise<void> {
    draining = true
    while (queue.length > 0 && !disposed) await run(queue.shift()!)
    draining = false
  }

  function dispose(): void {
    disposed = true
    queue.length = 0
    current?.abort.abort()
  }

  return {
    handle(request) {
      if (disposed) return
      switch (request.type) {
        case 'init':
          loadDeterministic3d().then(
            (R) => post({ type: 'ready', engine: `rapier3d-deterministic@${R.version()}` }),
            (err) => post(replyError(null, err)),
          )
          return
        case 'record':
          queue.push(request)
          if (!draining) void drain()
          return
        case 'cancel': {
          if (current?.id === request.id) {
            current.abort.abort()
            return
          }
          const i = queue.findIndex((job) => job.id === request.id)
          if (i >= 0) {
            queue.splice(i, 1)
            post(replyError(request.id, trackCancelled()))
          }
          return
        }
        case 'dispose':
          dispose()
      }
    },
    dispose,
  }
}

/**
 * A track worker's entry: records what the client asks for with the settle rules named here (and
 * `sleep`). A package with its own rules ships its own entry, e.g.
 * `serveTracks({ rules: { 'dice-settle': diceSettle } })`.
 */
export function serveTracks(options: ServeTracksOptions = {}): void {
  const scope = options.scope ?? (globalThis as unknown as TrackScope)
  const server = createTrackServer(
    (reply, transfer) => scope.postMessage(reply, transfer),
    options.rules,
  )
  scope.addEventListener('message', (event) => {
    const request = event.data as TrackRequest
    server.handle(request)
    if (request.type === 'dispose') scope.close?.()
  })
}
