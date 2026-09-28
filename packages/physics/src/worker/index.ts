// `@aethervtt/shard-physics/worker` (0053): record tracks off the main thread, with cancellation,
// crash restart and disposal.

export {
  createTrackClient,
  type TrackClient,
  type TrackClientOptions,
  type TrackRecordOptions,
  type TrackWorkerLike,
} from './client'
export type { SettleRuleRef, TrackReply, TrackRequest } from './protocol'
export { createTrackServer, type ServeTracksOptions, serveTracks, type TrackScope } from './serve'

/**
 * The default track worker, bundled by the host's bundler: Vite and webpack both recognize this
 * `new Worker(new URL(…, import.meta.url))` form and bundle the entry with Rapier inside it.
 */
export function trackWorker(): Worker {
  return new Worker(new URL('./track-worker.ts', import.meta.url), { type: 'module' })
}
