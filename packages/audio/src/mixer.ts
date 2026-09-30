import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  findComponent,
  Rng,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type {
  AudioBackend,
  AudioDistanceModel,
  AudioPanningModel,
  AudioSpatialDesc,
  AudioVoiceParams,
} from '@aethervtt/shard-platform'
import { LogResource, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { type AudioClipAsset, AudioClips } from './clip'
import {
  type AudioBus,
  AudioBuses,
  type AudioDuck,
  AudioFinished,
  AudioListener,
  AudioSource,
  PANNING_MODELS,
  ROLLOFF_MODELS,
} from './components'
import { HeadlessAudioBackend } from './headless'

// --- state -------------------------------------------------------------------------------------

export type VoiceState = 'pending' | 'active' | 'virtual'

/** One sound playing (or waiting for its clip): a source's, or a one-shot from playSound. */
export interface Voice {
  id: number
  /** The source's entity; null for a one-shot. */
  entity: Entity | null
  ref: AssetRef | null
  clip: AudioClipAsset | undefined
  /** Asked the asset server for the clip already. */
  requested: boolean
  bus: string
  volume: number
  pitch: number
  /** A source's random factors, picked when its voice starts (pitchRandom, volumeRandom). */
  pitchScale: number
  volumeScale: number
  loop: boolean
  priority: number
  spatial: boolean
  rolloff: AudioDistanceModel
  panning: AudioPanningModel
  minDistance: number
  maxDistance: number
  rolloffFactor: number
  doppler: number
  x: number
  y: number
  z: number
  /** Last frame's position, for Doppler. */
  px: number
  py: number
  pz: number
  /** Clip time in seconds (keeps running while virtual). */
  time: number
  /** Seconds since it started. */
  elapsed: number
  startFrame: number
  state: VoiceState
  /** Whether it started this frame (logged, and not advanced). */
  fresh: boolean
  /** The backend's id while it holds a real voice; -1 otherwise. */
  backend: number
  /** Last frame a source loop saw its entity (entity voices only). */
  seen: number
  // Computed each frame.
  gain: number
  distance: number
  distanceGain: number
  pan: number
  rate: number
  occlusion: number
  spatialDesc: AudioSpatialDesc | null
  /** Mixed on master because its bus doesn't exist. */
  busMissing: boolean
}

export interface AudioLogEntry {
  frame: number
  event: 'start' | 'stop' | 'dropped'
  voice: number
  /** The clip's asset path (or guid for clips made in code). */
  clip: string | null
  entity: Entity | null
  /** The entity's scene path. */
  path: string | null
  bus: string
  /** World position of a spatial voice. */
  position: [number, number, number] | null
  /** Gain after volume, bus, and distance. */
  gain: number
  pan: number
  /** stop: ended, stopped, stolen, or removed. dropped: voice-limit. */
  reason?: 'ended' | 'stopped' | 'stolen' | 'removed' | 'voice-limit'
}

export interface AudioConfigValue {
  /** Real voices at once, across all clips. */
  maxVoices: number
  /** Real voices of one clip at once. */
  maxVoicesPerClip: number
  /** For Doppler, in m/s. */
  speedOfSound: number
  /**
   * Occlusion hook: a gain multiplier (0 blocked, 1 clear) for a spatial voice at a world point, e.g.
   * from a physics raycast to the listener. Called once per spatial voice per frame.
   */
  occlusion:
    | ((
        world: World,
        voice: { entity: Entity | null; x: number; y: number; z: number },
        listener: ArrayLike<number>,
      ) => number)
    | null
}

export const AudioConfig = defineResource<AudioConfigValue>('audio/Config', {
  description:
    'Voice limits (maxVoices 64, maxVoicesPerClip 8), speed of sound, and the occlusion hook.',
  init: () => ({ maxVoices: 64, maxVoicesPerClip: 8, speedOfSound: 343, occlusion: null }),
})

export interface AudioStateValue {
  backend: AudioBackend
  voices: Voice[]
  byEntity: Map<Entity, Voice>
  nextId: number
  log: AudioLogEntry[]
  /** Log entries dropped from the front (the log keeps the last LOG_LIMIT). */
  logOffset: number
  listener: Float64Array
  listenerEntity: Entity | null
  /** Listener position last frame, for Doppler. */
  listenerPrev: Float64Array
  listenerSent: boolean
  /** Final bus gains, and what the backend was last told. */
  busGains: Map<string, number>
  busSent: Map<string, number>
  /** Duck multiplier per bus (1 = not ducked). */
  duckLevels: Map<string, number>
  dropped: number
  frame: number
  /** Unknown buses already reported. */
  reported: Set<string>
  // Scratch for voice limits.
  ranked: Voice[]
  /** Per clip: [stamp, count], reset lazily by stamp (Map.clear would allocate every frame). */
  clipCounts: Map<AudioClipAsset, Int32Array>
  countStamp: number
  /** Voices ended since the last compaction. */
  ended: number
  /** Picks pitch and volume in ranges: the app's GlobalRng stream 'audio', so replays repeat. */
  rng: Rng
}

const LOG_LIMIT = 4096

export const AudioState = defineResource<AudioStateValue>('audio/State', {
  description: 'Voices, the backend, bus gains, and the audio log. Internal: use audio.describe.',
})

export function createAudioState(backend: AudioBackend, rng = new Rng(0)): AudioStateValue {
  return {
    backend,
    voices: [],
    byEntity: new Map(),
    nextId: 1,
    log: [],
    logOffset: 0,
    listener: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]),
    listenerEntity: null,
    listenerPrev: new Float64Array(3),
    listenerSent: false,
    busGains: new Map(),
    busSent: new Map(),
    duckLevels: new Map(),
    dropped: 0,
    frame: 0,
    reported: new Set(),
    ranked: [],
    clipCounts: new Map(),
    countStamp: 0,
    ended: 0,
    rng,
  }
}

/**
 * A value in [min, max]: uniform in log space for pitch (a range as far below 1 as above sounds
 * even), uniform for volume. min ≥ max gives min.
 */
export function pickInRange(rng: Rng, min: number, max: number, log: boolean): number {
  if (!(max > min)) return min
  const u = rng.float()
  return log && min > 0 ? min * (max / min) ** u : min + (max - min) * u
}

/** The world's audio state; throws if the audio plugin isn't added. */
export function audioState(world: World): AudioStateValue {
  const state = world.tryResource(AudioState)
  if (!state) {
    throw new ShardError('audio/no-plugin', 'The audio plugin is not enabled', {
      hint: 'Add "audio" to plugins in shard.json (or app.addPlugin(audioPlugin())).',
    })
  }
  return state
}

export function newVoice(state: AudioStateValue, entity: Entity | null, frame: number): Voice {
  return {
    id: state.nextId++,
    entity,
    ref: null,
    clip: undefined,
    requested: false,
    bus: 'sfx',
    volume: 1,
    pitch: 1,
    pitchScale: 1,
    volumeScale: 1,
    loop: false,
    priority: 128,
    spatial: false,
    rolloff: 'inverse',
    panning: 'equal-power',
    minDistance: 1,
    maxDistance: 100,
    rolloffFactor: 1,
    doppler: 0,
    x: 0,
    y: 0,
    z: 0,
    px: Number.NaN,
    py: 0,
    pz: 0,
    time: 0,
    elapsed: 0,
    startFrame: frame,
    state: 'pending',
    fresh: false,
    backend: -1,
    seen: frame,
    gain: 0,
    distance: 0,
    distanceGain: 1,
    pan: 0,
    rate: 1,
    occlusion: 1,
    spatialDesc: null,
    busMissing: false,
  }
}

// --- helpers -----------------------------------------------------------------------------------

function scenePath(world: World, entity: Entity | null): string | null {
  if (entity === null) return null
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

export function clipLabel(voice: Voice): string | null {
  return voice.ref?.path ?? voice.ref?.guid ?? voice.clip?.id ?? null
}

function record(
  world: World,
  state: AudioStateValue,
  voice: Voice,
  event: AudioLogEntry['event'],
  reason?: AudioLogEntry['reason'],
): void {
  const entry: AudioLogEntry = {
    frame: state.frame,
    event,
    voice: voice.id,
    clip: clipLabel(voice),
    entity: voice.entity,
    path: scenePath(world, voice.entity),
    bus: voice.bus,
    position: voice.spatial ? [voice.x, voice.y, voice.z] : null,
    gain: voice.gain,
    pan: voice.pan,
  }
  if (reason) entry.reason = reason
  state.log.push(entry)
  if (state.log.length > LOG_LIMIT) {
    const drop = state.log.length - LOG_LIMIT
    state.log.splice(0, drop)
    state.logOffset += drop
  }
}

/** Ends a voice: stops its backend voice and logs why (voices never started just disappear). */
export function endVoice(
  world: World,
  state: AudioStateValue,
  voice: Voice,
  reason: 'ended' | 'stopped' | 'stolen' | 'removed',
  fade = 0,
): void {
  if (voice.backend !== -1) {
    state.backend.stop(voice.backend, fade)
    voice.backend = -1
  }
  if (voice.state !== 'pending' && !voice.fresh) record(world, state, voice, 'stop', reason)
  voice.state = 'pending'
  voice.id = -voice.id
  state.ended++
  if (voice.entity !== null && state.byEntity.get(voice.entity) === voice)
    state.byEntity.delete(voice.entity)
}

function isEnded(voice: Voice): boolean {
  return voice.id < 0
}

/** Resolves a voice's clip, asking the asset server for it once. */
function resolveClip(world: World, voice: Voice): AudioClipAsset | undefined {
  if (voice.clip) return voice.clip
  const ref = voice.ref
  if (!ref) return undefined
  const clips = world.resource(AudioClips)
  let clip = clips.get(ref)
  if (!clip && !voice.requested) {
    voice.requested = true
    const server = assetServer(world)
    if (ref.guid === undefined && ref.path !== undefined) {
      const resolved = server.resolve(ref.path)
      if (resolved) ref.guid = resolved.guid
    }
    clip = clips.get(ref)
    if (!clip && (ref.guid !== undefined || ref.path !== undefined)) {
      server.load(ref).catch((err: unknown) => world.tryResource(LogResource)?.error(err))
    }
  }
  voice.clip = clip
  return clip
}

/** Normalized bus settings (missing fields take defaults). */
export function busOf(
  buses: Record<string, Partial<AudioBus>>,
  name: string,
): AudioBus | undefined {
  const b = buses[name]
  if (!b) return undefined
  return {
    volume: b.volume ?? 1,
    muted: b.muted ?? false,
    parent: b.parent ?? (name === 'master' ? '' : 'master'),
    duck: b.duck ?? null,
  }
}

/** Writes a bus's final gain (volume, mute, duck, parents) into `out`. */
function busGain(
  buses: Record<string, Partial<AudioBus>>,
  ducks: Map<string, number>,
  name: string,
  out: Float64Array,
): void {
  let gain = 1
  let current = name
  // Parents chain up to master; the depth cap stops a cycle.
  for (let depth = 0; depth < 16 && current !== ''; depth++) {
    const b = buses[current]
    if (!b) break
    gain *= (b.muted ? 0 : (b.volume ?? 1)) * (ducks.get(current) ?? 1)
    current = b.parent ?? (current === 'master' ? '' : 'master')
  }
  out[0] = gain
}

function spatialDescOf(voice: Voice): AudioSpatialDesc | null {
  if (!voice.spatial) return null
  const d = voice.spatialDesc
  if (
    d &&
    d.panning === voice.panning &&
    d.distanceModel === voice.rolloff &&
    d.refDistance === voice.minDistance &&
    d.maxDistance === voice.maxDistance &&
    d.rolloffFactor === voice.rolloffFactor
  ) {
    return d
  }
  voice.spatialDesc = {
    panning: voice.panning,
    distanceModel: voice.rolloff,
    refDistance: voice.minDistance,
    maxDistance: voice.maxDistance,
    rolloffFactor: voice.rolloffFactor,
  }
  return voice.spatialDesc
}

/** Adds one to a clip's count for the current stamp and returns the new count. */
function bumpClip(state: AudioStateValue, clip: AudioClipAsset): number {
  let entry = state.clipCounts.get(clip)
  if (!entry) {
    entry = new Int32Array(2)
    state.clipCounts.set(clip, entry)
  }
  if (entry[0] !== state.countStamp) {
    entry[0] = state.countStamp
    entry[1] = 0
  }
  return ++entry[1]!
}

/** A clip's count for the current stamp. */
function clipCount(state: AudioStateValue, clip: AudioClipAsset): number {
  const entry = state.clipCounts.get(clip)
  return entry && entry[0] === state.countStamp ? entry[1]! : 0
}

/** Higher priority first; then louder; then newer (older voices are stolen first). */
function rank(a: Voice, b: Voice): number {
  return b.priority - a.priority || b.gain - a.gain || b.id - a.id
}

/** Scratch for numbers computed out of line (a returned double would be boxed). */
const num = new Float64Array(1)
const frame2 = new Float64Array(2)
const params: AudioVoiceParams = { gain: 0, pitch: 1, x: 0, y: 0, z: 0 }

// --- the system --------------------------------------------------------------------------------

/**
 * Plays audio: follows the listener and every AudioSource, advances clip time, applies buses and
 * ducking, pans and attenuates spatial voices, virtualizes the inaudible, enforces voice limits,
 * and drives the backend. Runs after transform propagation.
 */
export const updateAudio = defineSystem({
  name: 'audio/update',
  setup: (world) => ({
    listeners: world.query({ with: [AudioListener, GlobalTransform] }),
    sources: world.query({ with: [AudioSource, GlobalTransform] }),
  }),
  run: ({ listeners, sources }, world, ctx) => {
    const state = world.resource(AudioState)
    const time = world.resource(Time)
    const config = world.resource(AudioConfig)
    const buses = world.resource(AudioBuses)
    const backend = state.backend
    const dt = time.delta
    const frame = time.frame
    state.frame = frame

    // Listener: the first AudioListener, else the origin.
    const L = state.listener
    const prevX = L[3]!
    const prevY = L[7]!
    const prevZ = L[11]!
    let listenerEntity: Entity | null = null
    let listenerChanged = false
    for (let t = 0; t < listeners.tables.length && listenerEntity === null; t++) {
      const table = listeners.tables[t]!
      if (table.count === 0) continue
      listenerEntity = table.entities[0]!
      const m = table.column(GlobalTransform, 'matrix')
      for (let i = 0; i < 12; i++) {
        if (L[i] !== m[i]) {
          L[i] = m[i]!
          listenerChanged = true
        }
      }
    }
    if (listenerEntity === null && state.listenerEntity !== null) {
      L.fill(0)
      L[0] = 1
      L[5] = 1
      L[10] = 1
      listenerChanged = true
    }
    state.listenerEntity = listenerEntity
    const lp = state.listenerPrev
    if (state.listenerSent) {
      lp[0] = prevX
      lp[1] = prevY
      lp[2] = prevZ
    } else {
      lp[0] = L[3]!
      lp[1] = L[7]!
      lp[2] = L[11]!
    }
    if (listenerChanged || !state.listenerSent) {
      backend.setListener(L)
      state.listenerSent = true
    }

    // Sources: start, stop, and follow.
    for (let t = 0; t < sources.tables.length; t++) {
      const table = sources.tables[t]!
      const n = table.count
      if (n === 0) continue
      const clipCol = table.column(AudioSource, 'clip')
      const busCol = table.column(AudioSource, 'bus')
      const volume = table.column(AudioSource, 'volume')
      const pitch = table.column(AudioSource, 'pitch')
      const pitchRandom = table.column(AudioSource, 'pitchRandom')
      const volumeRandom = table.column(AudioSource, 'volumeRandom')
      const loop = table.column(AudioSource, 'loop')
      const autoplay = table.column(AudioSource, 'autoplay')
      const playing = table.column(AudioSource, 'playing')
      const spatial = table.column(AudioSource, 'spatial')
      const minD = table.column(AudioSource, 'minDistance')
      const maxD = table.column(AudioSource, 'maxDistance')
      const rolloff = table.column(AudioSource, 'rolloff')
      const factor = table.column(AudioSource, 'rolloffFactor')
      const panning = table.column(AudioSource, 'panning')
      const doppler = table.column(AudioSource, 'doppler')
      const priority = table.column(AudioSource, 'priority')
      const startTime = table.column(AudioSource, 'startTime')
      const matrix = table.column(GlobalTransform, 'matrix')
      let changed = false
      for (let row = 0; row < n; row++) {
        const entity = table.entities[row]!
        if (autoplay[row] && table.isAdded(AudioSource, row, ctx.lastRunTick)) {
          playing[row] = 1
          changed = true
        }
        let voice = state.byEntity.get(entity)
        const ref = clipCol[row] as AssetRef | null | undefined
        if (voice && (!playing[row] || !sameClip(voice.ref, ref))) {
          endVoice(world, state, voice, 'stopped', 0.02)
          voice = undefined
        }
        if (!playing[row]) continue
        if (!voice) {
          if (!ref) continue
          voice = newVoice(state, entity, frame)
          voice.ref = ref
          voice.time = startTime[row]!
          // Each start picks its factors; the voice keeps them while it plays (loops included).
          voice.pitchScale = rangeFactor(state.rng, pitchRandom, row, true)
          voice.volumeScale = rangeFactor(state.rng, volumeRandom, row, false)
          state.voices.push(voice)
          state.byEntity.set(entity, voice)
        }
        voice.seen = frame
        voice.bus = (busCol[row] as string | undefined) || 'sfx'
        voice.volume = volume[row]! * voice.volumeScale
        voice.pitch = Math.max(0.01, pitch[row]! * voice.pitchScale)
        voice.loop = loop[row] === 1
        voice.priority = priority[row]!
        voice.spatial = spatial[row] === 1
        voice.minDistance = minD[row]!
        voice.maxDistance = maxD[row]!
        voice.rolloff = ROLLOFF_MODELS[rolloff[row]!]!
        voice.rolloffFactor = factor[row]!
        voice.panning = PANNING_MODELS[panning[row]!]!
        voice.doppler = doppler[row]!
        voice.x = matrix[row * 12 + 3]!
        voice.y = matrix[row * 12 + 7]!
        voice.z = matrix[row * 12 + 11]!
      }
      if (changed) table.markChanged(AudioSource)
    }

    const log = world.tryResource(LogResource)
    const voices = state.voices
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i]!
      if (isEnded(voice)) continue
      // Entity voices whose source went away (despawned, or AudioSource removed).
      if (voice.entity !== null && voice.seen !== frame) {
        endVoice(world, state, voice, 'removed', 0.02)
        continue
      }
      if (!buses[voice.bus]) {
        voice.busMissing = true
        if (!state.reported.has(voice.bus)) {
          state.reported.add(voice.bus)
          log?.error(unknownBus(voice.bus, buses))
        }
      } else voice.busMissing = false
      if (voice.state === 'pending') {
        const clip = resolveClip(world, voice)
        if (!clip) continue
        voice.state = 'active'
        voice.fresh = true
        voice.startFrame = frame
        voice.elapsed = 0
        continue
      }
      // Advance clip time by last frame's rate.
      const clip = voice.clip!
      voice.time += dt * voice.rate
      voice.elapsed += dt
      const end =
        voice.loop && clip.loopEnd > 0 ? Math.min(clip.loopEnd, clip.duration) : clip.duration
      if (voice.time >= end - 1e-6) {
        if (voice.loop) {
          const start = clip.loopEnd > 0 && clip.loopStart < end ? clip.loopStart : 0
          const span = end - start
          voice.time = span > 0 ? start + ((voice.time - end) % span) : start
        } else {
          finish(world, state, voice)
        }
      }
    }

    // Buses: ducking, then final gains.
    for (const name in buses) {
      const duck = buses[name]!.duck as AudioDuck | null | undefined
      let level = state.duckLevels.get(name) ?? 1
      if (!duck) {
        if (level !== 1) state.duckLevels.delete(name)
        continue
      }
      const when = duck.when ?? DEFAULT_DUCK_TRIGGER
      let triggered = false
      for (let i = 0; i < voices.length && !triggered; i++) {
        const v = voices[i]!
        if (!isEnded(v) && v.state !== 'pending' && when.includes(v.bus)) triggered = true
      }
      const by = Math.min(1, Math.max(0, duck.by ?? 0.5))
      const floor = 1 - by
      if (triggered) {
        const attack = duck.attack ?? 0.1
        level = attack > 0 ? Math.max(floor, level - (by / attack) * dt) : floor
      } else {
        const release = duck.release ?? 0.5
        level = release > 0 ? Math.min(1, level + (by / release) * dt) : 1
      }
      state.duckLevels.set(name, level)
    }
    for (const name in buses) {
      busGain(buses, state.duckLevels, name, num)
      const gain = num[0]!
      state.busGains.set(name, gain)
      if (state.busSent.get(name) !== gain) {
        backend.setBus(name, gain)
        state.busSent.set(name, gain)
      }
    }

    // Per voice: distance, pan, Doppler, occlusion, and the final gain.
    const c = config.speedOfSound
    let audible = 0
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i]!
      if (isEnded(voice) || voice.state === 'pending') continue
      const bus = voice.busMissing ? 'master' : voice.bus
      const busG = state.busGains.get(bus) ?? 1
      let rate = voice.pitch
      if (voice.spatial) {
        placeVoice(voice, L)
        if (voice.doppler > 0 && dt > 0 && !Number.isNaN(voice.px)) {
          frame2[0] = dt
          frame2[1] = c
          dopplerShift(voice, L, lp, frame2, num)
          rate *= num[0]!
        }
        voice.occlusion = config.occlusion ? config.occlusion(world, voice, L) : 1
      } else {
        voice.distance = 0
        voice.pan = 0
        voice.distanceGain = 1
        voice.occlusion = 1
      }
      voice.px = voice.x
      voice.py = voice.y
      voice.pz = voice.z
      voice.rate = rate
      voice.gain = voice.volume * voice.occlusion * busG * voice.distanceGain
      // Past the distance where it's silent: keep time, hold no voice.
      voice.state = voice.spatial && voice.distanceGain <= 0 ? 'virtual' : 'active'
      if (voice.state === 'active') audible++
    }

    // Voice limits: highest priority, then loudest, keep a real voice.
    const maxVoices = config.maxVoices
    const perClip = config.maxVoicesPerClip
    state.countStamp++
    let overClip = false
    for (let i = 0; i < voices.length && !overClip; i++) {
      const v = voices[i]!
      if (isEnded(v) || v.state !== 'active') continue
      if (bumpClip(state, v.clip!) > perClip) overClip = true
    }
    if (audible > maxVoices || overClip) {
      const ranked = state.ranked
      ranked.length = 0
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i]!
        if (!isEnded(v) && v.state === 'active') ranked.push(v)
      }
      ranked.sort(rank)
      state.countStamp++
      let real = 0
      for (let i = 0; i < ranked.length; i++) {
        const v = ranked[i]!
        if (real < maxVoices && clipCount(state, v.clip!) < perClip) {
          real++
          bumpClip(state, v.clip!)
          continue
        }
        if (v.entity !== null) {
          v.state = 'virtual'
        } else if (v.fresh) {
          record(world, state, v, 'dropped', 'voice-limit')
          state.dropped++
          state.ended++
          v.id = -v.id
        } else {
          endVoice(world, state, v, 'stolen', 0.02)
        }
      }
      ranked.length = 0
    }

    // Log starts, then drive the backend.
    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i]!
      if (isEnded(voice) || voice.state === 'pending') continue
      if (voice.fresh) {
        record(world, state, voice, 'start')
        voice.fresh = false
      }
      if (voice.state === 'virtual') {
        if (voice.backend !== -1) {
          backend.stop(voice.backend, 0.05)
          voice.backend = -1
        }
        continue
      }
      params.gain = voice.volume * voice.occlusion
      params.pitch = voice.rate
      params.x = voice.x
      params.y = voice.y
      params.z = voice.z
      if (voice.backend === -1) {
        voice.backend = backend.play({
          clip: voice.clip!,
          bus: voice.busMissing ? 'master' : voice.bus,
          loop: voice.loop,
          offset: voice.time,
          spatial: spatialDescOf(voice),
          gain: params.gain,
          pitch: params.pitch,
          x: params.x,
          y: params.y,
          z: params.z,
        })
      } else {
        backend.update(voice.backend, params)
      }
    }

    // Drop ended voices, keeping order.
    if (state.ended > 0) {
      let kept = 0
      for (let i = 0; i < voices.length; i++) {
        const v = voices[i]!
        if (!isEnded(v)) voices[kept++] = v
      }
      voices.length = kept
      state.ended = 0
    }
  },
})

const DEFAULT_DUCK_TRIGGER = ['voice']

/** A factor from a source's [min, max] column (either order; [1, 1] is off). */
function rangeFactor(rng: Rng, column: ArrayLike<number>, row: number, log: boolean): number {
  const a = column[row * 2]!
  const b = column[row * 2 + 1]!
  const min = Math.max(log ? 0.01 : 0, Math.min(a, b))
  return pickInRange(rng, min, Math.max(min, a, b), log)
}

function sameClip(a: AssetRef | null, b: AssetRef | null | undefined): boolean {
  if (!a || !b) return a === (b ?? null)
  if (a === b) return true
  return a.guid !== undefined && b.guid !== undefined ? a.guid === b.guid : a.path === b.path
}

/** A clip that doesn't loop reached its end: clear the source's playing, send AudioFinished. */
function finish(world: World, state: AudioStateValue, voice: Voice): void {
  const entity = voice.entity
  const id = voice.id
  const clip = clipLabel(voice)
  endVoice(world, state, voice, 'ended')
  if (entity !== null && world.isAlive(entity) && world.has(entity, AudioSource)) {
    const table = world.entityTable(entity)
    const row = world.entityRow(entity)
    table.column(AudioSource, 'playing')[row] = 0
    table.markChanged(AudioSource, row)
  }
  world.send(AudioFinished, { entity, voice: id, clip })
}

/**
 * A voice's distance, pan, and distance gain: `listenerRelative` and `distanceGain` (spatial.ts),
 * inlined on the voice, because doubles passed to a call that isn't inlined get boxed.
 */
function placeVoice(voice: Voice, L: Float64Array): void {
  const rx = voice.x - L[3]!
  const ry = voice.y - L[7]!
  const rz = voice.z - L[11]!
  const d = Math.sqrt(rx * rx + ry * ry + rz * rz)
  voice.distance = d
  const r0 = L[0]!
  const r1 = L[4]!
  const r2 = L[8]!
  const b0 = L[2]!
  const b1 = L[6]!
  const b2 = L[10]!
  const side = (rx * r0 + ry * r1 + rz * r2) / (Math.sqrt(r0 * r0 + r1 * r1 + r2 * r2) || 1)
  const back = (rx * b0 + ry * b1 + rz * b2) / (Math.sqrt(b0 * b0 + b1 * b1 + b2 * b2) || 1)
  if (Math.abs(side) < 1e-9 && Math.abs(back) < 1e-9) voice.pan = 0
  else {
    let azimuth = Math.atan2(side, -back)
    const half = Math.PI / 2
    if (azimuth > half) azimuth = Math.PI - azimuth
    else if (azimuth < -half) azimuth = -Math.PI - azimuth
    voice.pan = azimuth / half
  }
  const ref = voice.minDistance
  const max = voice.maxDistance
  const rolloff = voice.rolloffFactor
  if (voice.rolloff === 'linear') {
    const f = rolloff < 0 ? 0 : rolloff > 1 ? 1 : rolloff
    if (max <= ref) voice.distanceGain = 1 - f
    else {
      const c = d < ref ? ref : d > max ? max : d
      voice.distanceGain = 1 - (f * (c - ref)) / (max - ref)
    }
  } else if (ref <= 0) voice.distanceGain = 0
  else {
    const c = d < ref ? ref : d
    voice.distanceGain =
      voice.rolloff === 'inverse' ? ref / (ref + rolloff * (c - ref)) : (c / ref) ** -rolloff
  }
}

/**
 * The Doppler factor for a voice: OpenAL's formula (Web Audio dropped its own), from last frame's
 * source and listener motion along the line between them.
 */
function dopplerShift(
  voice: Voice,
  L: Float64Array,
  lp: Float64Array,
  /** [dt, speed of sound]: doubles passed as arguments to a call that isn't inlined get boxed. */
  frame: Float64Array,
  out: Float64Array,
): void {
  const dt = frame[0]!
  const c = frame[1]!
  out[0] = 1
  // Source to listener.
  const sx = L[3]! - voice.x
  const sy = L[7]! - voice.y
  const sz = L[11]! - voice.z
  const len = Math.sqrt(sx * sx + sy * sy + sz * sz)
  if (len < 1e-6) return
  const f = voice.doppler
  const limit = c / f
  let vls = ((L[3]! - lp[0]!) * sx + (L[7]! - lp[1]!) * sy + (L[11]! - lp[2]!) * sz) / (len * dt)
  let vss =
    ((voice.x - voice.px) * sx + (voice.y - voice.py) * sy + (voice.z - voice.pz) * sz) / (len * dt)
  if (vls > limit) vls = limit
  if (vss > limit) vss = limit
  const shift = (c - f * vls) / (c - f * vss)
  if (shift > 0 && Number.isFinite(shift)) out[0] = Math.min(16, shift)
}

export function unknownBus(bus: string, buses: Record<string, unknown>): ShardError {
  return new ShardError('audio/unknown-bus', `No audio bus "${bus}"`, {
    hint: `Buses: ${Object.keys(buses).join(', ')}. Add one to the audio/Buses resource (a scene file's "resources"), or use one of these. The voice plays on master.`,
  })
}

/** A fresh backend for hosts that don't have one. */
export function defaultBackend(): AudioBackend {
  return new HeadlessAudioBackend()
}
