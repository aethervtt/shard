import { PostUpdate } from '@aethervtt/shard-core'
import type { AudioBackend } from '@aethervtt/shard-platform'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { AudioClips } from './clip'
import { AudioBuses } from './components'
import { audioMethods } from './methods'
import { AudioConfig, AudioState, createAudioState, defaultBackend, updateAudio } from './mixer'

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
  })
}
