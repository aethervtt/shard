import { PostUpdate } from '@aethervtt/shard-core'
import type { AudioBackend } from '@aethervtt/shard-platform'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import * as clipModule from './clip'
import { AudioClips } from './clip'
import * as componentsModule from './components'
import { AudioBuses } from './components'
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
  return definePlugin({
    name: 'audio',
    provides: [clipModule, componentsModule, mixerModule],
    dependencies: ['core/transform'],
    build(app) {
      const w = app.world
      w.initResource(AudioClips)
      w.initResource(AudioBuses)
      const config = w.initResource(AudioConfig)
      if (options.maxVoices !== undefined) config.maxVoices = options.maxVoices
      if (options.maxVoicesPerClip !== undefined) config.maxVoicesPerClip = options.maxVoicesPerClip
      const backend = options.backend ?? defaultBackend()
      backend.onError = (err) => w.tryResource(LogResource)?.error(err)
      w.insertResource(AudioState, createAudioState(backend))
      app.addSystems(PostUpdate, updateAudio.after(TransformSystems))
      app.addMethod(...audioMethods)
    },
    dispose(app) {
      // Silence this app's voices; a host's backend may be another app's too, so it stays (0052).
      const state = app.world.tryResource(AudioState)
      if (!state) return
      for (const voice of state.voices) endVoice(app.world, state, voice, 'removed')
      state.voices.length = 0
      if (!options.backend) state.backend.dispose?.()
    },
  })
}
