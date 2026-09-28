// `@aethervtt/shard-physics/track` (0053): record a physics track from a plain scene description
// and play it back. Imports only `@aethervtt/shard-core` and Rapier's deterministic build.

export {
  type DecodeTrackOptions,
  decodeTrack,
  encodeTrack,
  sampleTrack,
  TRACK_ENGINE,
  TRACK_VERSION,
  type Track,
  type TrackContacts,
  trackHash,
  type Writable,
} from './format'
export {
  builtinSettleRules,
  type RecordTrackOptions,
  recordTrack,
  type Settle,
  type SettleResult,
  type SettleRule,
  type SettleView,
  settleWhenAsleep,
  TRACK_CHUNK_MS,
  TRACK_CHUNK_STEPS,
  type TrackContactOptions,
  type TrackPhase,
  trackCancelled,
} from './record'
export {
  checkTrackScene,
  MAX_TRACK_BODIES,
  MAX_TRACK_STEPS,
  sceneHash,
  type TrackBody,
  type TrackCollider,
  type TrackGroup,
  type TrackScene,
  trackSceneFromJson,
  trackSceneToJson,
} from './scene'
