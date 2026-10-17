import { assetServer } from '@aethervtt/shard-assets'
import type { AssetRef } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { preloadSound } from './api'
import { audioClip } from './clip'
import { AudioCollection, AudioEvent } from './event-assets'
import { audioEvents, audioEventsPlugin, playAudioEvent, prepareAudio } from './events'
import { HeadlessAudioBackend } from './headless'
import {
  AudioMixer,
  AudioSnapshot,
  acquireAudioSnapshot,
  audioMixerPlugin,
  configureAudioMixer,
} from './mix'
import { audioMusicPlugin, MusicProgram, prepareMusic, startMusic } from './music'
import { AudioParameters } from './parameters'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

it('resolves path-only handles and GUID collections before store lookup and shares canonical globals', async () => {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    audioMixerPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  try {
    const world = app.world,
      server = assetServer(world)
    const handle = (type: string, path: string): AssetRef => ({ type, path, guid: undefined })
    server.virtual(
      'clip-guid',
      'tone.wav',
      'AudioClip',
      () => audioClip(sineWav(2, { rate: 8000 })),
      { lazy: true },
    )
    server.virtual(
      'globals-guid',
      'shared.audio-parameters.json',
      AudioParameters.name,
      () => AudioParameters.deserialize({ parameters: [{ name: 'wet' }] }),
      { lazy: true },
    )
    const globals = handle(AudioParameters.name, 'shared.audio-parameters.json')
    const event = AudioEvent.deserialize({
      globals: { path: globals.path },
      layers: [{ id: 'tone', choices: [{ clip: { path: 'tone.wav' } }] }],
    })
    server.virtual('event-guid', 'tone.audio-event.json', AudioEvent.name, () => event, {
      lazy: true,
    })
    server.virtual(
      'collection-guid',
      'all.audio-collection.json',
      AudioCollection.name,
      () =>
        AudioCollection.deserialize({
          events: [{ path: 'tone.audio-event.json' }],
          clips: [{ path: 'tone.wav' }],
        }),
      { lazy: true },
    )
    server.virtual(
      'mixer-guid',
      'main.audio-mixer.json',
      AudioMixer.name,
      () =>
        AudioMixer.deserialize({
          globals: { path: globals.path },
          buses: [
            { id: 'master', parent: '' },
            { id: 'music' },
            { id: 'sfx', effects: [{ id: 'room', kind: 'reverb', ir: { path: 'tone.wav' } }] },
          ],
        }),
      { lazy: true },
    )
    server.virtual(
      'snapshot-guid',
      'quiet.audio-snapshot.json',
      AudioSnapshot.name,
      () => AudioSnapshot.deserialize({ targets: [{ bus: 'sfx', value: -6 }] }),
      { lazy: true },
    )
    server.virtual(
      'music-guid',
      'score.audio-music.json',
      MusicProgram.name,
      () =>
        MusicProgram.deserialize({
          globals: { path: globals.path },
          entry: 'a',
          sections: [
            {
              id: 'a',
              bars: 1,
              stems: [{ id: 'stem', clip: { path: 'tone.wav' }, endSample: 16000 }],
            },
          ],
        }),
      { lazy: true },
    )
    await configureAudioMixer(world, handle(AudioMixer.name, 'main.audio-mixer.json'))
    await acquireAudioSnapshot(world, handle(AudioSnapshot.name, 'quiet.audio-snapshot.json'))
    const lease = await prepareAudio(
      world,
      handle(AudioCollection.name, 'all.audio-collection.json'),
    )
    const byGuid = await prepareAudio(world, 'collection-guid')
    expect(byGuid.events[0]).toBe(lease.events[0])
    preloadSound(world, handle('AudioClip', 'tone.wav'))
    expect(backend.preloaded).toHaveLength(1)
    const id = playAudioEvent(world, handle(AudioEvent.name, 'tone.audio-event.json'))
    app.update(0.01)
    expect(audioEvents(world).instances.find((instance) => instance?.id === id)?.key).toBe(
      'event-guid',
    )
    const cold = playAudioEvent(world, event)
    for (let i = 0; i < 30; i++) await Promise.resolve()
    app.update(0.01)
    app.update(0.01)
    expect(audioEvents(world).instances.find((instance) => instance?.id === cold)?.state).toBe(
      'active',
    )
    server.virtual('other-guid', 'other.audio-event.json', AudioEvent.name, () =>
      AudioEvent.deserialize({
        layers: [{ id: 'other', choices: [{ clip: { path: 'tone.wav' } }] }],
      }),
    )
    const other = await prepareAudio(world, 'other.audio-event.json')
    const canonical = playAudioEvent(world, {
      type: AudioEvent.name,
      guid: 'event-guid',
      path: 'other.audio-event.json',
    })
    expect(audioEvents(world).instances.find((instance) => instance?.id === canonical)?.key).toBe(
      'event-guid',
    )
    other.release()
    const program = await prepareMusic(world, handle(MusicProgram.name, 'score.audio-music.json'))
    expect(program.key).toBe('music-guid')
    startMusic(world, program)
    expect([...audioEvents(world).globalBanks.keys()]).toEqual(['globals-guid'])
    byGuid.release()
    lease.release()
    program.release()
  } finally {
    await app.dispose()
  }
})
