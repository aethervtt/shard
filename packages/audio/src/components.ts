import {
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type Entity,
  type Infer,
  t,
} from '@shard/core'
import { Transform } from '@shard/transform'

export const ROLLOFF_MODELS = ['inverse', 'linear', 'exponential'] as const
export const PANNING_MODELS = ['hrtf', 'equal-power'] as const

export const AudioSource = defineComponent(
  'audio/AudioSource',
  {
    clip: t.handle('AudioClip', { description: 'The sound: a WAV, Ogg, MP3, or FLAC file.' }),
    bus: t.string({
      default: 'sfx',
      description:
        'The bus it mixes into (audio/Buses): master, music, sfx, ui, voice, or one the game adds.',
    }),
    volume: t.f32({
      default: 1,
      min: 0,
      description: 'Linear gain (1 = as recorded, 0.5 ≈ -6 dB).',
    }),
    pitch: t.f32({
      default: 1,
      min: 0.01,
      max: 16,
      description: 'Playback rate: 2 plays an octave up in half the time.',
    }),
    loop: t.bool({ description: "Loop (between the clip's loopStart and loopEnd) until stopped." }),
    autoplay: t.bool({ default: true, description: 'Start playing when the source is added.' }),
    playing: t.bool({
      description:
        "Whether it plays. Set it to start (from startTime) or stop; cleared when a clip that doesn't loop ends (audio/AudioFinished).",
    }),
    spatial: t.bool({
      default: true,
      description:
        'Pan and fade by position relative to the AudioListener. Off: plays flat (music, UI).',
    }),
    minDistance: t.f32({
      default: 1,
      min: 0,
      unit: 'm',
      description: 'Full volume up to here; the distance model fades from here on.',
    }),
    maxDistance: t.f32({
      default: 100,
      min: 0,
      unit: 'm',
      description:
        "linear: silent (and virtual) from here on. inverse and exponential don't use it.",
    }),
    rolloff: t.enum(ROLLOFF_MODELS, {
      description:
        'inverse: min / (min + factor × (d - min)), like real sound. linear: fades to 0 at maxDistance. exponential: (d / min)^-factor.',
    }),
    rolloffFactor: t.f32({ default: 1, min: 0, description: 'How fast it fades with distance.' }),
    panning: t.enum(PANNING_MODELS, {
      default: 'equal-power',
      description: 'hrtf: 3D over headphones (costlier). equal-power: left-right stereo pan.',
    }),
    doppler: t.f32({
      min: 0,
      description: 'Pitch shift from relative motion: 0 off, 1 physical (343 m/s). Off by default.',
    }),
    priority: t.u8({
      default: 128,
      description: 'Over the voice limit, lower priorities lose their voice first (0-255).',
    }),
    startTime: t.f32({ min: 0, unit: 's', description: 'Where in the clip playback starts.' }),
  },
  {
    description:
      'Plays a clip from this entity: follows its GlobalTransform when spatial. Set playing to start or stop it.',
    requires: [Transform],
  },
)

export type AudioSourceValue = Infer<typeof AudioSource>

export const AudioListener = defineTag('audio/AudioListener', {
  description:
    'Where the player hears from: put it on the camera. The first one found is used; without one, the world origin looking down -Z.',
  requires: [Transform],
})

/** One mixing bus. `parent` chains buses: a bus's gain is multiplied by its parent's. */
export interface AudioBus {
  volume: number
  muted: boolean
  /** The bus it feeds; '' for the root (master). */
  parent: string
  /** Lowers this bus while any voice plays on one of `when`'s buses (dialogue over music). */
  duck?: AudioDuck | null
}

export interface AudioDuck {
  /** How much of the gain is taken away while ducked: 0.3 plays at 70%. */
  by: number
  /** Seconds to go down once a trigger voice starts. */
  attack: number
  /** Seconds to come back after the last trigger voice ends. */
  release: number
  /** The buses whose voices trigger it (default: voice). */
  when: string[]
}

export type AudioBusesValue = Record<string, Partial<AudioBus>>

export const DEFAULT_BUSES = ['master', 'music', 'sfx', 'ui', 'voice'] as const

export const AudioBuses = defineResource<AudioBusesValue>('audio/Buses', {
  description:
    "Mixing buses by name: { volume, muted, parent (default master), duck }. master, music, sfx, ui, and voice exist; add more in a scene file's resources.",
  init: () => ({
    master: { volume: 1, muted: false, parent: '' },
    music: { volume: 1, muted: false, parent: 'master' },
    sfx: { volume: 1, muted: false, parent: 'master' },
    ui: { volume: 1, muted: false, parent: 'master' },
    voice: { volume: 1, muted: false, parent: 'master' },
  }),
})

export interface AudioFinishedData {
  /** The source's entity, or null for a one-shot from playSound. */
  entity: Entity | null
  voice: number
  /** The clip's path. */
  clip: string | null
}

export const AudioFinished = defineEvent<AudioFinishedData>('audio/AudioFinished', {
  description: "A clip that doesn't loop played to its end (the source's playing was cleared).",
})
