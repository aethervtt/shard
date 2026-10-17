import {
  allocationChecks,
  budget,
  gcWindow,
  timeout,
  timingMode,
} from '@aethervtt/shard-core/test-env'
import { App, Time } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { AudioAcoustics, audioAcousticsPlugin, ReverbZone, updateAudioAcoustics } from './acoustics'
import { AudioClips, audioClip } from './clip'
import { AudioSource } from './components'
import { AudioEvent } from './event-assets'
import {
  audioEventsPlugin,
  playAudioEvent,
  prepareAudio,
  setAudioParameter,
  updateAudioEvents,
} from './events'
import { HeadlessAudioBackend } from './headless'
import {
  AudioMixer,
  AudioSnapshot,
  acquireAudioSnapshot,
  audioMixerPlugin,
  configureAudioMixer,
  updateAudioMix,
} from './mix'
import { audioState, updateAudio } from './mixer'
import {
  audioMusicPlugin,
  MusicProgram,
  prepareMusic,
  prepareMusicSection,
  requestMusicSection,
  startMusic,
  updateMusic,
} from './music'
import { AudioParameters } from './parameters'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function measure(key: string, step: () => void, allocations = true): Promise<void> {
  step()
  if (timingMode !== 'bench') return
  for (let i = 0; i < 1000; i++) step()
  await new Promise((resolve) => setTimeout(resolve, 200))
  for (let i = 0; i < 3000; i++) step()
  const samples = new Float64Array(1000)
  ;(globalThis as { gc?: () => void }).gc?.()
  const window = gcWindow()
  for (let i = 0; i < samples.length; i++) {
    const at = performance.now()
    step()
    samples[i] = performance.now() - at
  }
  const collections = await window.end()
  samples.sort()
  const median = samples[samples.length >> 1]!
  console.log(`${key}: ${median.toFixed(5)} ms median; GC events: ${collections}`)
  expect(median).toBeLessThan(budget(key))
  if (allocationChecks && allocations) expect(collections).toBe(0)
}

it(
  '128 four-layer instances and 16 global parameters; 256 parameter commands',
  async () => {
    const backend = new HeadlessAudioBackend()
    const app = new App().addPlugin(
      TransformPlugin,
      audioPlugin({ backend, maxVoicesPerClip: 64 }),
      audioEventsPlugin(),
    )
    await app.init()
    const world = app.world
    const ref = world.resource(AudioClips).add(audioClip(sineWav(2, { rate: 8000 })))
    const global = world.resource(AudioParameters.store).add(
      AudioParameters.deserialize({
        parameters: Array.from({ length: 16 }, (_, i) => ({ name: `global${i}` })),
      }),
    )
    const event = AudioEvent.deserialize({
      mode: 'sustain',
      maxInstances: 256,
      globals: { guid: global.guid },
      parameters: [{ name: 'rpm' }],
      layers: Array.from({ length: 4 }, (_, i) => ({
        id: `layer${i}`,
        loop: true,
        choices: [{ clip: { guid: ref.guid } }],
        curves: [
          {
            parameter: `global${i}`,
            property: 'gainDb',
            points: [
              [0, 0],
              [1, 0],
            ],
          },
        ],
      })),
    })
    const lease = await prepareAudio(world, event)
    const ids = Array.from({ length: 128 }, () => playAudioEvent(world, event))
    app.update(1 / 60)
    const setup = updateAudio.setup!(world),
      context = { lastRunTick: world.tick }
    const step = () => {
      context.lastRunTick = world.tick
      updateAudioEvents.run(undefined, world, context as never)
    }
    await measure('audio/events', step)
    // Physical ranking has its own audio/update-virtual budget. Validate the combined result.
    updateAudio.run(setup, world, context as never)
    expect(audioState(world).voices.filter((v) => v.id > 0)).toHaveLength(512)
    expect(backend.activeVoices).toBe(64)
    let value = 0
    await measure(
      'audio/commands',
      () => {
        value = 1 - value
        for (let i = 0; i < 256; i++) setAudioParameter(world, ids[i % 128]!, 'rpm', value)
      },
      false,
    )
    lease.release()
    app.dispose()
  },
  timeout(30000),
)

it(
  '32 buses, 64 inserts, 16 snapshots; 64 voices and 32 zones',
  async () => {
    const backend = new HeadlessAudioBackend()
    const app = new App().addPlugin(
      TransformPlugin,
      audioPlugin({ backend, maxVoicesPerClip: 64 }),
      audioEventsPlugin(),
      audioMixerPlugin(),
      audioAcousticsPlugin({
        query: (_a, _b, out) => {
          out[0] = 0.5
        },
      }),
    )
    await app.init()
    const world = app.world
    const buses = Array.from({ length: 32 }, (_, i) => ({
      id: i === 0 ? 'master' : i === 1 ? 'sfx' : `bus${i}`,
      parent: i ? 'master' : '',
      return: i >= 28,
      effects: [
        { id: 'low', kind: 'lowpass' },
        { id: 'high', kind: 'highpass', frequency: 10 },
      ],
    }))
    await configureAudioMixer(world, AudioMixer.deserialize({ buses }))
    for (let i = 0; i < 16; i++)
      await acquireAudioSnapshot(
        world,
        AudioSnapshot.deserialize({ attack: 0, targets: [{ bus: 'sfx', value: -i }] }),
        0.5,
      )
    await measure('audio/mix', () => updateAudioMix(world, 1 / 60))
    const ref = world.resource(AudioClips).add(audioClip(sineWav(2, { rate: 8000 })))
    for (let i = 0; i < 64; i++) world.spawn([AudioSource, { clip: ref, loop: true }], Transform)
    for (let i = 0; i < 32; i++)
      world.spawn([ReverbZone, { returnBus: `bus${28 + (i % 4)}` }], Transform)
    app.update(1 / 60)
    const setup = updateAudioAcoustics.setup!(world)
    await measure('audio/acoustics', () => updateAudioAcoustics.run(setup, world, {} as never))
    expect(world.resource(AudioAcoustics).queries).toBeLessThanOrEqual(16)
    expect(backend.activeVoices).toBe(64)
    app.dispose()
  },
  timeout(30000),
)

it(
  'eight independent eight-stem transports after a 32-request replacement burst',
  async () => {
    const backend = new HeadlessAudioBackend()
    const app = new App().addPlugin(
      TransformPlugin,
      audioPlugin({ backend }),
      audioEventsPlugin(),
      audioMusicPlugin(),
    )
    await app.init()
    const world = app.world
    const ref = world.resource(AudioClips).add(audioClip(sineWav(2, { rate: 8000 })))
    const stems = Array.from({ length: 8 }, (_, i) => ({
      id: `stem${i}`,
      clip: { guid: ref.guid },
      endSample: 16000,
    }))
    const program = await prepareMusic(
      world,
      MusicProgram.deserialize({
        entry: 'a',
        sections: [
          { id: 'a', bars: 1, stems },
          { id: 'b', bars: 1, stems },
        ],
      }),
    )
    await prepareMusicSection(world, program, 'b')
    const transports = Array.from({ length: 8 }, () => startMusic(world, program))
    for (let i = 0; i < 32; i++) requestMusicSection(world, transports[i % 8]!, 'b')
    await measure('audio/music-schedule', () => {
      backend.advance(0.025)
      updateMusic(world)
    })
    expect(backend.activeVoices).toBe(64)
    expect(world.resource(Time).frame).toBe(0)
    program.release()
    app.dispose()
  },
  timeout(30000),
)
