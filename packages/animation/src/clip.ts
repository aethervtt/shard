import {
  AssetStore,
  defineAssetSchema,
  defineAssetType,
  defineImporter,
  type ImportedAsset,
} from '@shard/assets'
import {
  type AnyField,
  defineResource,
  defineSchema,
  findComponent,
  type JsonValue,
  ShardError,
} from '@shard/core'

export type Interpolation = 'linear' | 'step' | 'cubic'

/** One animated value: a component field on an entity under the player, keyframed. */
export interface AnimationChannel {
  /** Entity path relative to the player's entity: "Armature/Hips/Spine", or "" for itself. */
  target: string
  /** Component name, e.g. "core/Transform". */
  component: string
  /** Field of the component, e.g. "rotation". */
  field: string
  interpolation: Interpolation
  /** Key times in seconds, ascending. */
  times: Float32Array
  /** `width` floats per key; cubic keys are (in-tangent, value, out-tangent), 3 × width. */
  values: Float32Array
  /** Floats per value: 3 for a vec3, 4 for a quaternion, one per morph target for weights. */
  width: number
}

export interface ClipEvent {
  time: number
  name: string
  data?: JsonValue
}

export interface AnimationClipAsset {
  name: string
  duration: number
  channels: AnimationChannel[]
  events: ClipEvent[]
}

export const AnimationClips = defineResource<AssetStore<AnimationClipAsset, 'AnimationClip'>>(
  'animation/AnimationClips',
  {
    description: 'Animation clips (glTF and .anim.json) by guid.',
    init: () => new AssetStore('AnimationClip'),
  },
)

interface ClipHeader {
  name: string
  duration: number
  channels: (Omit<AnimationChannel, 'times' | 'values'> & {
    times: [number, number]
    values: [number, number]
  })[]
  events: ClipEvent[]
}

/** A clip's artifact: channels as JSON, their keys as one Float32Array in `bytes`. */
export function encodeClip(clip: AnimationClipAsset): { json: JsonValue; bytes: Uint8Array } {
  let length = 0
  for (const c of clip.channels) length += c.times.length + c.values.length
  const data = new Float32Array(length)
  let at = 0
  const push = (arr: Float32Array): [number, number] => {
    data.set(arr, at)
    const range: [number, number] = [at, arr.length]
    at += arr.length
    return range
  }
  const header: ClipHeader = {
    name: clip.name,
    duration: clip.duration,
    channels: clip.channels.map((c) => ({
      target: c.target,
      component: c.component,
      field: c.field,
      interpolation: c.interpolation,
      width: c.width,
      times: push(c.times),
      values: push(c.values),
    })),
    events: clip.events,
  }
  return { json: header as unknown as JsonValue, bytes: new Uint8Array(data.buffer) }
}

/** What `asset.get` shows for a clip: duration, its channels (target component.field), events. */
export function clipInfo(clip: AnimationClipAsset): Record<string, JsonValue> {
  return {
    duration: clip.duration,
    channelCount: clip.channels.length,
    channels: clip.channels
      .slice(0, 200)
      .map((c) => `${c.target || '(self)'} ${c.component}.${c.field}`),
    events: clip.events.map((e) => ({ time: e.time, name: e.name })),
  }
}

export const AnimationClipAssetType = defineAssetType<AnimationClipAsset>('AnimationClip', {
  store: AnimationClips,
  load: (artifact) => {
    const header = artifact.json as unknown as ClipHeader
    const data = new Float32Array(artifact.bytes!.slice().buffer)
    return {
      name: header.name,
      duration: header.duration,
      channels: header.channels.map((c) => ({
        ...c,
        times: data.subarray(c.times[0], c.times[0] + c.times[1]),
        values: data.subarray(c.values[0], c.values[0] + c.values[1]),
      })),
      events: header.events ?? [],
    }
  },
  // A reload replaces the clip's contents in place: players rebind it on their next frame.
  update: (existing, next) => Object.assign(existing, next),
})

// --- sampling --------------------------------------------------------------------------------

// Hot-path scalars ride in Float64Arrays: V8 boxes a double passed to (or returned from) a call
// it doesn't inline, and sampling makes one call per channel per frame.

const scratchTime = new Float64Array(1)
const scratchU = new Float64Array(1)

/**
 * Finds the key interval holding `t`, starting from `cursor` (last frame's key, so playback is
 * O(1) per channel). Returns i with times[i] <= t < times[i + 1], clamped to [0, n - 2].
 */
export function findKey(times: Float32Array, t: number, cursor: number): number {
  scratchTime[0] = t
  return findKeyAt(times, scratchTime, cursor)
}

/** findKey with the time in `time[0]` (hot path: no boxed argument). */
export function findKeyAt(times: Float32Array, time: Float64Array, cursor: number): number {
  const t = time[0]!
  const n = times.length
  if (n < 2) return 0
  let i = cursor < n - 1 ? cursor : n - 2
  if (t >= times[i]!) {
    // Forward: usually the same key or the next one.
    while (i < n - 2 && t >= times[i + 1]!) i++
    return i
  }
  if (i > 0 && t >= times[i - 1]!) return i - 1
  // A jump back (loop wrap, seek): binary search.
  let lo = 0
  let hi = n - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (times[mid]! <= t) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Samples a channel at time `t` into `out` (width floats) and returns the key cursor. Quaternion
 * channels (`quat`) slerp between linear keys and are normalized after cubic ones.
 */
export function sampleChannel(
  c: AnimationChannel,
  t: number,
  cursor: number,
  quat: boolean,
  out: Float32Array,
): number {
  scratchTime[0] = t
  return sampleChannelAt(c, scratchTime, cursor, quat, out)
}

/** sampleChannel with the time in `time[0]` (hot path: no boxed argument). */
export function sampleChannelAt(
  c: AnimationChannel,
  time: Float64Array,
  cursor: number,
  quat: boolean,
  out: Float32Array,
): number {
  const t = time[0]!
  const times = c.times
  const v = c.values
  const w = c.width
  const n = times.length
  const cubic = c.interpolation === 'cubic'
  // Cubic keys store (in-tangent, value, out-tangent): the value is the middle third.
  const stride = cubic ? w * 3 : w
  const valueAt = cubic ? w : 0
  if (n === 0) return 0
  if (n === 1 || t <= times[0]!) {
    for (let k = 0; k < w; k++) out[k] = v[valueAt + k]!
    return 0
  }
  if (t >= times[n - 1]!) {
    const o = (n - 1) * stride + valueAt
    for (let k = 0; k < w; k++) out[k] = v[o + k]!
    return n - 2
  }
  const i = findKeyAt(times, time, cursor)
  const t0 = times[i]!
  const dt = times[i + 1]! - t0
  const u = dt > 0 ? (t - t0) / dt : 0
  const a = i * stride + valueAt
  const b = (i + 1) * stride + valueAt
  if (c.interpolation === 'step') {
    for (let k = 0; k < w; k++) out[k] = v[a + k]!
    return i
  }
  if (cubic) {
    // Hermite: value and out-tangent of key i, in-tangent and value of key i + 1 (glTF 2.0).
    const u2 = u * u
    const u3 = u2 * u
    const h00 = 2 * u3 - 3 * u2 + 1
    const h10 = u3 - 2 * u2 + u
    const h01 = -2 * u3 + 3 * u2
    const h11 = u3 - u2
    for (let k = 0; k < w; k++) {
      out[k] =
        h00 * v[a + k]! + h10 * dt * v[a + w + k]! + h01 * v[b + k]! + h11 * dt * v[b - w + k]!
    }
    if (quat) normalize4(out)
    return i
  }
  if (quat) {
    scratchU[0] = u
    slerpAt(out, v, a, v, b, scratchU)
    return i
  }
  for (let k = 0; k < w; k++) out[k] = v[a + k]! + (v[b + k]! - v[a + k]!) * u
  return i
}

function normalize4(q: Float32Array): void {
  const len = Math.sqrt(q[0]! * q[0]! + q[1]! * q[1]! + q[2]! * q[2]! + q[3]! * q[3]!)
  if (len > 0) {
    q[0] = q[0]! / len
    q[1] = q[1]! / len
    q[2] = q[2]! / len
    q[3] = q[3]! / len
  }
}

/** Slerp from quaternion a (at ao) to b (at bo) by t, the short way round, into out[0..3]. */
export function slerpInto(
  out: Float32Array,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  t: number,
): void {
  scratchU[0] = t
  slerpAt(out, a, ao, b, bo, scratchU)
}

/** slerpInto with the amount in `amount[0]` (hot path: no boxed argument). */
export function slerpAt(
  out: Float32Array,
  a: ArrayLike<number>,
  ao: number,
  b: ArrayLike<number>,
  bo: number,
  amount: Float64Array,
): void {
  const t = amount[0]!
  const ax = a[ao]!
  const ay = a[ao + 1]!
  const az = a[ao + 2]!
  const aw = a[ao + 3]!
  let bx = b[bo]!
  let by = b[bo + 1]!
  let bz = b[bo + 2]!
  let bw = b[bo + 3]!
  let cos = ax * bx + ay * by + az * bz + aw * bw
  if (cos < 0) {
    cos = -cos
    bx = -bx
    by = -by
    bz = -bz
    bw = -bw
  }
  let s0: number
  let s1: number
  if (cos > 0.9995) {
    // Nearly parallel: lerp, then normalize.
    s0 = 1 - t
    s1 = t
  } else {
    const theta = Math.acos(cos)
    const sin = Math.sin(theta)
    s0 = Math.sin((1 - t) * theta) / sin
    s1 = Math.sin(t * theta) / sin
  }
  out[0] = s0 * ax + s1 * bx
  out[1] = s0 * ay + s1 * by
  out[2] = s0 * az + s1 * bz
  out[3] = s0 * aw + s1 * bw
  if (cos > 0.9995) normalize4(out)
}

// --- property clips (*.anim.json) ------------------------------------------------------------

/** Field kinds a track can animate, with their width (0: a list of numbers, any length). */
const ANIMATABLE: Record<string, number> = {
  f32: 1,
  f64: 1,
  i8: 1,
  i16: 1,
  i32: 1,
  u8: 1,
  u16: 1,
  u32: 1,
  vec2: 2,
  vec3: 3,
  vec4: 4,
  quat: 4,
  color: 4,
}

/** The width of an animatable field, or undefined (lists of numbers: 0, any length). */
export function animatableWidth(field: AnyField): number | undefined {
  if (field.kind === 'list') return field.item && ANIMATABLE[field.item.kind] === 1 ? 0 : undefined
  return ANIMATABLE[field.kind]
}

const ClipSettings = defineSchema('animation/ClipSettings', {}, { description: 'No settings.' })

function fail(code: string, message: string, path: string, hint?: string): ShardError {
  return new ShardError(code, message, { path, ...(hint ? { hint } : {}) })
}

/**
 * Reads a property clip: tracks animate numeric fields of components on entities under the player
 * (by path), validated against each component's schema. Errors point into the file.
 */
export function parsePropertyClip(json: unknown, name: string): AnimationClipAsset {
  if (!json || typeof json !== 'object' || Array.isArray(json))
    throw fail('animation/invalid-clip', 'A clip file is an object with "tracks"', '')
  const file = json as { duration?: unknown; tracks?: unknown; events?: unknown }
  if (!Array.isArray(file.tracks))
    throw fail('animation/invalid-clip', '"tracks" must be a list', '/tracks')
  const channels: AnimationChannel[] = []
  let end = 0
  for (const [i, raw] of file.tracks.entries()) {
    const ptr = `/tracks/${i}`
    const track = raw as {
      path?: unknown
      component?: unknown
      field?: unknown
      keys?: unknown
      interpolation?: unknown
    }
    if (!track || typeof track !== 'object')
      throw fail('animation/invalid-track', 'A track is an object', ptr)
    const path = track.path ?? ''
    if (typeof path !== 'string')
      throw fail('animation/invalid-track', '"path" must be a string', `${ptr}/path`)
    if (typeof track.component !== 'string')
      throw fail('animation/invalid-track', '"component" must be a name', `${ptr}/component`)
    const def = findComponent(track.component)
    if (!def) {
      throw fail(
        'animation/unknown-target',
        `No component "${track.component}"`,
        `${ptr}/component`,
        'Use a component name as scenes write it, e.g. "core/Transform" or "render/PointLight".',
      )
    }
    const column = def.layout.find((c) => c.name === track.field)
    if (!column) {
      throw fail(
        'animation/unknown-target',
        `${def.name} has no field "${String(track.field)}"`,
        `${ptr}/field`,
        `Its fields: ${def.layout.map((c) => c.name).join(', ')}.`,
      )
    }
    const width = animatableWidth(column.field)
    if (width === undefined) {
      throw fail(
        'animation/invalid-track',
        `${def.name}.${column.name} is a ${column.field.kind}; tracks animate numbers, vectors, quaternions, and colors`,
        `${ptr}/field`,
      )
    }
    const interpolation = track.interpolation ?? 'linear'
    if (interpolation !== 'linear' && interpolation !== 'step' && interpolation !== 'cubic') {
      throw fail(
        'animation/invalid-track',
        '"interpolation" is "linear", "step", or "cubic"',
        `${ptr}/interpolation`,
      )
    }
    if (!Array.isArray(track.keys) || track.keys.length === 0)
      throw fail('animation/invalid-track', '"keys" must list [time, value] pairs', `${ptr}/keys`)
    const times: number[] = []
    const values: number[][] = []
    let keyWidth = width
    for (const [k, key] of track.keys.entries()) {
      const kp = `${ptr}/keys/${k}`
      if (!Array.isArray(key) || key.length !== 2 || typeof key[0] !== 'number')
        throw fail('animation/invalid-track', 'A key is [time, value]', kp)
      if (k > 0 && key[0] < times[k - 1]!)
        throw fail('animation/invalid-track', 'Key times must not decrease', `${kp}/0`)
      let value: unknown
      try {
        value = width === 0 ? key[1] : column.field.fromJson(key[1], undefined)
      } catch (err) {
        throw fail('animation/invalid-track', (err as Error).message, `${kp}/1`)
      }
      const list = typeof value === 'number' ? [value] : Array.from(value as ArrayLike<number>)
      if (keyWidth === 0) keyWidth = list.length
      if (list.length !== keyWidth || list.some((x) => typeof x !== 'number')) {
        throw fail(
          'animation/invalid-track',
          `${def.name}.${column.name} takes ${keyWidth === 1 ? 'a number' : `${keyWidth} numbers`}`,
          `${kp}/1`,
        )
      }
      if (column.field.kind === 'quat') {
        const len = Math.hypot(...list) || 1
        for (let c = 0; c < 4; c++) list[c] = list[c]! / len
      }
      times.push(key[0])
      values.push(list)
    }
    end = Math.max(end, times[times.length - 1]!)
    channels.push({
      target: path,
      component: def.name,
      field: column.name,
      interpolation,
      width: keyWidth,
      times: Float32Array.from(times),
      values:
        interpolation === 'cubic' ? smoothKeys(times, values) : Float32Array.from(values.flat()),
    })
  }
  const events: ClipEvent[] = []
  if (file.events !== undefined) {
    if (!Array.isArray(file.events))
      throw fail('animation/invalid-clip', '"events" must be a list', '/events')
    for (const [i, raw] of file.events.entries()) {
      const e = raw as { time?: unknown; name?: unknown; data?: JsonValue }
      if (!e || typeof e.time !== 'number' || typeof e.name !== 'string')
        throw fail(
          'animation/invalid-clip',
          'An event is { "time": s, "name": "..." }',
          `/events/${i}`,
        )
      events.push({ time: e.time, name: e.name, ...(e.data !== undefined ? { data: e.data } : {}) })
      end = Math.max(end, e.time)
    }
  }
  events.sort((a, b) => a.time - b.time)
  let duration = end
  if (file.duration !== undefined) {
    if (typeof file.duration !== 'number' || file.duration < 0)
      throw fail('animation/invalid-clip', '"duration" must be seconds (≥ 0)', '/duration')
    duration = file.duration
  }
  return { name, duration, channels, events }
}

/** Cubic keys with Catmull-Rom tangents: (in-tangent, value, out-tangent) per key. */
function smoothKeys(times: number[], values: number[][]): Float32Array {
  const n = times.length
  const w = values[0]!.length
  const out = new Float32Array(n * w * 3)
  for (let k = 0; k < n; k++) {
    const prev = Math.max(0, k - 1)
    const next = Math.min(n - 1, k + 1)
    const span = times[next]! - times[prev]!
    for (let c = 0; c < w; c++) {
      const slope = span > 0 ? (values[next]![c]! - values[prev]![c]!) / span : 0
      out[k * w * 3 + c] = slope
      out[k * w * 3 + w + c] = values[k]![c]!
      out[k * w * 3 + 2 * w + c] = slope
    }
  }
  return out
}

const decoder = new TextDecoder()

/** `*.anim.json`: property clips, imported as AnimationClip. */
export const ClipImporter = defineImporter({
  name: 'animation-clip',
  version: 1,
  extensions: ['.anim.json'],
  settings: ClipSettings,
  async import(source) {
    let json: unknown
    try {
      json = JSON.parse(decoder.decode(source.bytes))
    } catch (cause) {
      throw new ShardError('animation/invalid-clip', `${source.path} isn't valid JSON`, {
        path: '',
        cause,
      })
    }
    const base = source.path
      .split('/')
      .pop()!
      .replace(/\.anim\.json$/, '')
    const clip = parsePropertyClip(json, base)
    const asset: ImportedAsset = {
      label: '',
      type: 'AnimationClip',
      ...encodeClip(clip),
      info: clipInfo(clip),
    }
    return { assets: [asset] }
  },
})

defineAssetSchema('anim.schema.json', () => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Animation clip (*.anim.json)',
  type: 'object',
  properties: {
    $schema: { type: 'string' },
    duration: {
      type: 'number',
      minimum: 0,
      description: 'Seconds. Default: the last key or event.',
    },
    tracks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['component', 'field', 'keys'],
        properties: {
          path: {
            type: 'string',
            description: 'Entity path under the player ("" is the player entity itself).',
          },
          component: { type: 'string', description: 'e.g. "core/Transform", "render/PointLight".' },
          field: { type: 'string', description: 'A numeric, vector, quaternion, or color field.' },
          interpolation: { enum: ['linear', 'step', 'cubic'] },
          keys: {
            type: 'array',
            description: '[time, value] pairs, times ascending.',
            items: { type: 'array', minItems: 2, maxItems: 2 },
          },
        },
      },
    },
    events: {
      type: 'array',
      items: {
        type: 'object',
        required: ['time', 'name'],
        properties: { time: { type: 'number' }, name: { type: 'string' }, data: {} },
      },
    },
  },
  required: ['tracks'],
}))
