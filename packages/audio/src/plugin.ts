import { PostUpdate } from '@aethervtt/shard-core'
import type { AudioBackend } from '@aethervtt/shard-platform'
import { definePlugin, GlobalRng, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { OriginShift, TransformSystems } from '@aethervtt/shard-transform'
import { AudioCheckpointHooks } from './checkpoint-bridge'
import * as clipModule from './clip'
import { AudioClips } from './clip'
import * as componentsModule from './components'
import { AudioBuses, AudioUserControls } from './components'
import { AudioInspectors } from './inspection'
import { audioMethods } from './methods'
import * as mixerModule from './mixer'
import {
  AudioConfig,
  AudioState,
  createAudioState,
  defaultBackend,
  endVoice,
  updateAudio,
} from './mixer'

export interface AudioPluginOptions {
  /** Where sound goes (`platform.audio`). Default: the headless backend, which records voices. */
  backend?: AudioBackend
  maxVoices?: number
  maxVoicesPerClip?: number
}

/**
 * Audio sources, the listener, one-shots, buses and ducking, spatial panning and attenuation,
 * voice limits, and the audio log. Sound goes to the backend the host gives it.
 */
export function audioPlugin(options: AudioPluginOptions = {}): Plugin {
  let ownedSession = false
  let unshift: (() => void) | undefined
  return definePlugin({
    name: 'audio',
    provides: [
      clipModule,
      componentsModule,
      mixerModule,
      { AudioInspectors, AudioCheckpointHooks },
    ],
    dependencies: ['core/transform'],
    build(app) {
      const w = app.world
      w.initResource(AudioInspectors)
      w.insertResource(AudioCheckpointHooks, {
        capture() {},
        restore: async () => [],
        reset(world) {
          const state = world.tryResource(AudioState)
          if (state) for (const voice of state.voices) endVoice(world, state, voice, 'stopped', 0)
        },
      })
      w.initResource(AudioClips)
      w.initResource(AudioBuses)
      w.initResource(AudioUserControls)
      const config = w.initResource(AudioConfig)
      if (options.maxVoices !== undefined) config.maxVoices = options.maxVoices
      if (options.maxVoicesPerClip !== undefined) config.maxVoicesPerClip = options.maxVoicesPerClip
      const supplied = options.backend ?? defaultBackend()
      const backend =
        supplied.runtime?.capabilities.sessions && supplied.createSession
          ? supplied.createSession({ maxVoices: config.maxVoices })
          : supplied
      ownedSession = backend !== supplied || !options.backend
      backend.onError = (err) => w.tryResource(LogResource)?.error(err)
      // Pitch and volume ranges draw from the app's seed, so a replay picks the same values.
      const rng = w.tryResource(GlobalRng)?.stream('audio')
      w.insertResource(AudioState, createAudioState(backend, rng))
      unshift = w.observe(OriginShift, ({ data }) => {
        const state = w.resource(AudioState),
          offset = data.offset
        state.listener[3] = state.listener[3]! + offset[0]
        state.listener[7] = state.listener[7]! + offset[1]
        state.listener[11] = state.listener[11]! + offset[2]
        state.listenerPrev[0] = state.listenerPrev[0]! + offset[0]
        state.listenerPrev[1] = state.listenerPrev[1]! + offset[1]
        state.listenerPrev[2] = state.listenerPrev[2]! + offset[2]
        for (let i = 0; i < state.voices.length; i++) {
          const voice = state.voices[i]!
          voice.x += offset[0]
          voice.y += offset[1]
          voice.z += offset[2]
          voice.px += offset[0]
          voice.py += offset[1]
          voice.pz += offset[2]
        }
      })
      app.addSystems(PostUpdate, updateAudio.after(TransformSystems))
      app.addMethod(...audioMethods)
    },
    dispose(app) {
      unshift?.()
      // Silence this app's voices; a host's backend may be another app's too, so it stays (0052).
      const state = app.world.tryResource(AudioState)
      if (!state) return
      for (const voice of state.voices) endVoice(app.world, state, voice, 'removed')
      state.voices.length = 0
      if (ownedSession) state.backend.dispose?.()
    },
  })
}
