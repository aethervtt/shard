import { ShardError } from '@aethervtt/shard-core'
import { Hasher } from './hash'

/** A recorded track: every body's pose at every fixed step, plus the contacts that mattered. */
export interface Track {
  version: 1
  /** The Rapier build that recorded it, e.g. `rapier3d-deterministic@0.20.0`. */
  engine: string
  /** `sceneHash` of the scene it was recorded from. */
  sceneHash: number
  /** Seconds per step. */
  step: number
  /** Steps simulated; poses exist for steps 0 to `steps`. */
  steps: number
  bodyCount: number
  /** The settle rule ended it. */
  settled: boolean
  /** It ran to the scene's maxSteps without settling. */
  maxStepsHit: boolean
  /** (steps + 1) × bodies × 3, step-major. */
  positions: Float32Array
  /** (steps + 1) × bodies × 4 (x y z w), step-major. */
  rotations: Float32Array
  /** Contacts in the order they happened; `b` is -1 for a fixed collider. */
  contacts: TrackContacts
  /** Time spent stepping. Excluded from equality and hashing. */
  simulationMs: number
}

export interface TrackContacts {
  steps: Uint16Array
  a: Int16Array
  b: Int16Array
  /** Total contact force, N. */
  force: Float32Array
}

export const TRACK_VERSION = 1
/** The engine tracks are recorded and played with; another one fails with `physics/track-version`. */
export const TRACK_ENGINE = 'rapier3d-deterministic@0.20.0'

// The binary layout, little-endian: a 52-byte header, the engine name padded to 4 bytes, then the
// arrays, 4-byte ones first so every view is aligned.
const MAGIC = 0x4b525453 // 'STRK'
const HEADER = 52
const SETTLED = 1
const MAX_STEPS_HIT = 2

function corrupt(message: string): ShardError {
  return new ShardError('physics/track-invalid', message, {
    hint: 'Pass the ArrayBuffer encodeTrack made, whole.',
  })
}

/** One buffer, header and arrays: what a worker transfers and what a host can store. */
export function encodeTrack(track: Track): ArrayBuffer {
  const engineBytes = (track.engine.length + 3) & ~3
  const c = track.contacts.steps.length
  const size = HEADER + engineBytes + (track.positions.length + track.rotations.length) * 4 + c * 10
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  view.setUint32(0, MAGIC, true)
  view.setUint32(4, track.version, true)
  view.setUint32(8, track.sceneHash >>> 0, true)
  view.setFloat64(12, track.step, true)
  view.setUint32(20, track.steps, true)
  view.setUint32(24, track.bodyCount, true)
  view.setUint32(28, (track.settled ? SETTLED : 0) | (track.maxStepsHit ? MAX_STEPS_HIT : 0), true)
  view.setUint32(32, c, true)
  view.setFloat64(36, track.simulationMs, true)
  view.setUint32(44, track.engine.length, true)
  view.setUint32(48, 0, true)
  const bytes = new Uint8Array(buf)
  for (let i = 0; i < track.engine.length; i++)
    bytes[HEADER + i] = track.engine.charCodeAt(i) & 0x7f
  let o = HEADER + engineBytes
  new Float32Array(buf, o, track.positions.length).set(track.positions)
  o += track.positions.length * 4
  new Float32Array(buf, o, track.rotations.length).set(track.rotations)
  o += track.rotations.length * 4
  new Float32Array(buf, o, c).set(track.contacts.force)
  o += c * 4
  new Uint16Array(buf, o, c).set(track.contacts.steps)
  o += c * 2
  new Int16Array(buf, o, c).set(track.contacts.a)
  o += c * 2
  new Int16Array(buf, o, c).set(track.contacts.b)
  return buf
}

export interface DecodeTrackOptions {
  /** The engine the track must come from (default TRACK_ENGINE); null accepts any. */
  engine?: string | null
}

/**
 * A track from `encodeTrack`'s buffer. Its arrays are views on the buffer, not copies. A track from
 * another format version or engine fails with `physics/track-version`: poses from another build
 * of Rapier might not be what this one would record.
 */
export function decodeTrack(buffer: ArrayBuffer, options?: DecodeTrackOptions): Track {
  if (buffer.byteLength < HEADER) throw corrupt('The buffer is too short for a track')
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC) throw corrupt("The buffer isn't a track")
  const version = view.getUint32(4, true)
  const engineLength = view.getUint32(44, true)
  if (HEADER + engineLength > buffer.byteLength) throw corrupt('The track header is cut off')
  const bytes = new Uint8Array(buffer, HEADER, engineLength)
  let engine = ''
  for (let i = 0; i < engineLength; i++) engine += String.fromCharCode(bytes[i]!)
  const expected = options?.engine === undefined ? TRACK_ENGINE : options.engine
  if (version !== TRACK_VERSION || (expected !== null && engine !== expected)) {
    throw new ShardError(
      'physics/track-version',
      `The track is version ${version} from ${engine}; expected version ${TRACK_VERSION} from ${expected ?? 'any engine'}`,
      { hint: 'Record it again with this build, or play it with the build that recorded it.' },
    )
  }
  const steps = view.getUint32(20, true)
  const bodyCount = view.getUint32(24, true)
  const flags = view.getUint32(28, true)
  const c = view.getUint32(32, true)
  const poses = (steps + 1) * bodyCount
  let o = HEADER + ((engineLength + 3) & ~3)
  if (o + poses * 28 + c * 10 > buffer.byteLength) throw corrupt('The track is cut off')
  const positions = new Float32Array(buffer, o, poses * 3)
  o += poses * 12
  const rotations = new Float32Array(buffer, o, poses * 4)
  o += poses * 16
  const force = new Float32Array(buffer, o, c)
  o += c * 4
  const contactSteps = new Uint16Array(buffer, o, c)
  o += c * 2
  const a = new Int16Array(buffer, o, c)
  o += c * 2
  const b = new Int16Array(buffer, o, c)
  return {
    version: TRACK_VERSION,
    engine,
    sceneHash: view.getUint32(8, true),
    step: view.getFloat64(12, true),
    steps,
    bodyCount,
    settled: (flags & SETTLED) !== 0,
    maxStepsHit: (flags & MAX_STEPS_HIT) !== 0,
    positions,
    rotations,
    contacts: { steps: contactSteps, a, b, force },
    simulationMs: view.getFloat64(36, true),
  }
}

/** A hash over the header and every array (not simulationMs): equal tracks hash equal. */
export function trackHash(track: Track): number {
  const h = new Hasher()
  h.u32(track.version).str(track.engine).u32(track.sceneHash).f64(track.step)
  h.u32(track.steps).u32(track.bodyCount).bool(track.settled).bool(track.maxStepsHit)
  h.array(track.positions).array(track.rotations)
  const c = track.contacts
  h.array(c.steps).array(c.a).array(c.b).array(c.force)
  return h.digest()
}

/** Anything indexable to write numbers into: a typed array, a tuple, a component column. */
export interface Writable {
  [index: number]: number
}

/**
 * A body's pose at `time` seconds (clamped to the track), interpolated between the two steps
 * around it: positions linearly, rotations by slerp. Allocates nothing.
 */
export function sampleTrack(
  track: Track,
  time: number,
  body: number,
  outPos: Writable,
  outRot: Writable,
): void {
  const n = track.bodyCount
  if (body < 0 || body >= n || !Number.isInteger(body)) {
    throw new ShardError('physics/track-body', `The track has no body ${body}`, {
      hint: `Bodies are 0 to ${n - 1}, in the scene's order.`,
    })
  }
  let f = time / track.step
  if (!(f > 0)) f = 0
  if (f > track.steps) f = track.steps
  const i0 = Math.floor(f)
  const i1 = i0 < track.steps ? i0 + 1 : i0
  const t = f - i0
  const p = track.positions
  const a3 = (i0 * n + body) * 3
  const b3 = (i1 * n + body) * 3
  outPos[0] = p[a3]! + (p[b3]! - p[a3]!) * t
  outPos[1] = p[a3 + 1]! + (p[b3 + 1]! - p[a3 + 1]!) * t
  outPos[2] = p[a3 + 2]! + (p[b3 + 2]! - p[a3 + 2]!) * t
  const r = track.rotations
  const a4 = (i0 * n + body) * 4
  const b4 = (i1 * n + body) * 4
  const ax = r[a4]!
  const ay = r[a4 + 1]!
  const az = r[a4 + 2]!
  const aw = r[a4 + 3]!
  let bx = r[b4]!
  let by = r[b4 + 1]!
  let bz = r[b4 + 2]!
  let bw = r[b4 + 3]!
  // The short way around.
  let cos = ax * bx + ay * by + az * bz + aw * bw
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let ka = 1 - t
  let kb = t
  // Nearly the same rotation: slerp's sin ratio loses precision, and lerp is exact enough.
  if (cos < 0.9995) {
    const angle = Math.acos(cos)
    const sin = Math.sin(angle)
    ka = Math.sin((1 - t) * angle) / sin
    kb = Math.sin(t * angle) / sin
  }
  const x = ax * ka + bx * kb
  const y = ay * ka + by * kb
  const z = az * ka + bz * kb
  const w = aw * ka + bw * kb
  const len = Math.sqrt(x * x + y * y + z * z + w * w) || 1
  outRot[0] = x / len
  outRot[1] = y / len
  outRot[2] = z / len
  outRot[3] = w / len
}
