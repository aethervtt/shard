import { type AssetRef, ShardError, type World } from '@aethervtt/shard-core'
import type { AudioDistanceModel, AudioPanningModel } from '@aethervtt/shard-platform'
import type { AudioClipAsset } from './clip'
import { type AudioBus, AudioBuses } from './components'
import { audioState, busOf, endVoice, newVoice, unknownBus } from './mixer'

export interface PlaySoundOptions {
  /** World position. With one the sound is spatial; without, it plays flat. */
  position?: ArrayLike<number>
  bus?: string
  volume?: number
  pitch?: number
  loop?: boolean
  /** 0-255; over the voice limit, lower priorities lose their voice first. Default 128. */
  priority?: number
  /** Where in the clip to start, in seconds. */
  offset?: number
  minDistance?: number
  maxDistance?: number
  rolloff?: AudioDistanceModel
  rolloffFactor?: number
  panning?: AudioPanningModel
}

function isClip(value: unknown): value is AudioClipAsset {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as AudioClipAsset).bytes instanceof Uint8Array
  )
}

/**
 * Plays a clip once without an entity (shots, impacts, UI clicks) and returns its voice id. A clip
 * that isn't loaded yet starts when it is. The sound is logged in `audio.log` like any other.
 *
 * ```ts
 * playSound(world, weapon.sound, { position: muzzle, bus: 'sfx' })
 * ```
 */
export function playSound(
  world: World,
  clip: AssetRef | AudioClipAsset | string,
  options: PlaySoundOptions = {},
): number {
  const state = audioState(world)
  const bus = options.bus ?? 'sfx'
  const buses = world.resource(AudioBuses)
  if (!buses[bus]) throw unknownBus(bus, buses)
  const voice = newVoice(state, null, state.frame)
  if (isClip(clip)) voice.clip = clip
  else
    voice.ref =
      typeof clip === 'string' ? { type: 'AudioClip', guid: undefined, path: clip } : { ...clip }
  voice.bus = bus
  voice.volume = options.volume ?? 1
  voice.pitch = options.pitch ?? 1
  voice.loop = options.loop ?? false
  voice.priority = options.priority ?? 128
  voice.time = options.offset ?? 0
  const p = options.position
  if (p) {
    voice.spatial = true
    voice.x = p[0]!
    voice.y = p[1]!
    voice.z = p[2]!
    voice.minDistance = options.minDistance ?? 1
    voice.maxDistance = options.maxDistance ?? 100
    voice.rolloff = options.rolloff ?? 'inverse'
    voice.rolloffFactor = options.rolloffFactor ?? 1
    voice.panning = options.panning ?? 'equal-power'
  }
  state.voices.push(voice)
  return voice.id
}

/** Stops a voice from playSound, fading out over `fade` seconds. False if it already ended. */
export function stopSound(world: World, voice: number, fade = 0): boolean {
  const state = audioState(world)
  const v = state.voices.find((x) => x.id === voice)
  if (!v) return false
  endVoice(world, state, v, 'stopped', fade)
  return true
}

/** Whether a voice (from playSound, or a source's) is still playing, real or virtual. */
export function isSoundPlaying(world: World, voice: number): boolean {
  return audioState(world).voices.some((v) => v.id === voice)
}

/** Changes a bus's volume or mute. Throws audio/unknown-bus for a bus that doesn't exist. */
export function setBus(
  world: World,
  name: string,
  settings: Partial<Omit<AudioBus, 'duck'>>,
): void {
  const buses = world.resource(AudioBuses)
  const bus = buses[name]
  if (!bus) throw unknownBus(name, buses)
  Object.assign(bus, settings)
}

export interface DuckOptions {
  /** How much gain to take away while ducked: 0.3 plays the bus at 70%. */
  by: number
  /** Seconds to go down. Default 0.1. */
  attack?: number
  /** Seconds to come back after the last trigger voice ends. Default 0.5. */
  release?: number
  /** Buses whose voices trigger it. Default: voice. */
  when?: string | string[]
}

/**
 * Lowers `bus` while any voice plays on the `when` buses (dialogue over music), and brings it back
 * over `release` once they stop. Stored on the bus (audio/Buses), so scene files can set it too.
 * `null` removes it.
 *
 * ```ts
 * duck(world, 'music', { by: 0.7, attack: 0.1, release: 0.5 })
 * ```
 */
export function duck(world: World, bus: string, options: DuckOptions | null): void {
  const buses = world.resource(AudioBuses)
  if (!buses[bus]) throw unknownBus(bus, buses)
  if (options === null) {
    buses[bus]!.duck = null
    return
  }
  if (!(options.by >= 0 && options.by <= 1)) {
    throw new ShardError('audio/invalid-duck', `duck by must be 0 to 1, got ${options.by}`, {
      hint: 'by is the share of gain taken away: 0.3 plays the bus at 70%.',
    })
  }
  const when =
    options.when === undefined
      ? ['voice']
      : Array.isArray(options.when)
        ? options.when
        : [options.when]
  for (const name of when) if (!buses[name]) throw unknownBus(name, buses)
  buses[bus]!.duck = {
    by: options.by,
    attack: options.attack ?? 0.1,
    release: options.release ?? 0.5,
    when,
  }
}

/** A bus's settings with defaults filled in, or undefined. */
export function getBus(world: World, name: string): AudioBus | undefined {
  return busOf(world.resource(AudioBuses), name)
}
