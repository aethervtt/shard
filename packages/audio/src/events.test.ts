import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { AudioClips, audioClip } from './clip'
import { AudioEvent, validateAudioEvent } from './event-assets'
import {
  AudioTransport,
  audioEvents,
  audioEventsPlugin,
  playAudioEvent,
  prepareAudio,
  setAudioParameter,
  stopAudioEvent,
} from './events'
import { HeadlessAudioBackend } from './headless'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup() {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(TransformPlugin, audioPlugin({ backend }), audioEventsPlugin())
  await app.init()
  const clips = app.world.resource(AudioClips)
  const a = clips.add(audioClip(sineWav(2), { id: 'a' }))
  const b = clips.add(audioClip(sineWav(2), { id: 'b' }))
  const event = AudioEvent.deserialize({
    layers: [
      {
        id: 'body',
        choices: [{ clip: { guid: a.guid } }, { clip: { guid: b.guid } }],
        selector: 'sequence',
      },
    ],
  })
  return { app, world: app.world, backend, event }
}

describe('authored audio events', () => {
  it('prepares, selects deterministically, starts at sample zero, and releases every pin', async () => {
    const { app, world, backend, event } = await setup()
    const lease = await prepareAudio(world, event)
    const first = playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active[0]).toMatchObject({ clip: 'a', offset: 0 })
    stopAudioEvent(world, first, { release: 0 })
    const second = playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active[0]!.clip).toBe('b')
    lease.release()
    expect(backend.memory().pinned).toBeGreaterThan(0)
    stopAudioEvent(world, second, { release: 0 })
    backend.collect()
    expect(backend.memory().pinned).toBe(0)
    expect(backend.memory().decodedBytes).toBe(0)
    app.dispose()
  })

  it('pauses without consuming triggers and advances pitch-linked cursor only once', async () => {
    const { app, world, backend, event } = await setup()
    event.mode = 'sustain'
    event.layers[0]!.loop = true
    const lease = await prepareAudio(world, event)
    world.resource(AudioTransport).paused = true
    const id = playAudioEvent(world, event, { pitchLinked: true })
    app.update(0.1)
    expect(backend.active).toHaveLength(0)
    world.resource(AudioTransport).paused = false
    world.resource(AudioTransport).timeScale = 2
    app.update(0.1)
    expect(backend.active).toHaveLength(1)
    const instance = audioEvents(world).instances.find((item) => item?.id === id)!
    const cursor = instance.layers[0]!.voice!.time
    app.update(0.1)
    expect(instance.layers[0]!.voice!.time - cursor).toBeCloseTo(0.2)
    world.resource(AudioTransport).paused = true
    app.update(0.1)
    const paused = instance.layers[0]!.voice!.time
    app.update(0.1)
    expect(instance.layers[0]!.voice!.time).toBe(paused)
    world.resource(AudioTransport).paused = false
    app.update(0.1)
    expect(
      audioEvents(world)
        .trace.read()
        .entries.filter((e) => e.kind === 'layer-start'),
    ).toHaveLength(1)
    lease.release()
    app.dispose()
  })

  it('validates references and parameter bindings before preparation commits', async () => {
    const { app, world, event } = await setup()
    event.layers[0]!.choices[0]!.clip = null
    expect(() => validateAudioEvent(event)).toThrow()
    await expect(prepareAudio(world, event)).rejects.toThrow()
    expect(audioEvents(world).plans.size).toBe(0)
    app.dispose()
  })

  it('uses smoothed local parameters for gain and rejects unknown names', async () => {
    const { app, world, event } = await setup()
    const definition = AudioEvent.deserialize({
      ...AudioEvent.serialize(event),
      mode: 'sustain',
      parameters: [{ name: 'intensity', min: 0, max: 1, initial: 0, smooth: 0.1 }],
      layers: [
        {
          id: 'loop',
          loop: true,
          choices: event.layers[0]!.choices.map((choice) => ({
            clip: { guid: choice.clip!.guid },
          })),
          curves: [
            {
              parameter: 'intensity',
              property: 'gainDb',
              points: [
                [0, -60],
                [1, 0],
              ],
            },
          ],
        },
      ],
    })
    const lease = await prepareAudio(world, definition)
    const id = playAudioEvent(world, definition)
    app.update(0.01)
    setAudioParameter(world, id, 'intensity', 1)
    app.update(0.1)
    const instance = audioEvents(world).instances.find((item) => item?.id === id)!
    expect(instance.parameters!.values[0]).toBeCloseTo(1 - Math.exp(-1))
    expect(instance.layers[0]!.voice!.volume).toBeGreaterThan(0.001)
    expect(() => setAudioParameter(world, id, 'unknown', 1)).toThrow()
    lease.release()
    app.dispose()
  })
})
