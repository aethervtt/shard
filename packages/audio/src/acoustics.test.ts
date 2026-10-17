import { App } from '@aethervtt/shard-runtime'
import { OriginShift, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { AudioAcoustics, audioAcousticsPlugin, ReverbZone } from './acoustics'
import { AudioClips, audioClip } from './clip'
import { AudioListener, AudioSource } from './components'
import { audioEventsPlugin } from './events'
import { HeadlessAudioBackend } from './headless'
import { AudioMixer, audioMixerPlugin, configureAudioMixer } from './mix'
import { audioState } from './mixer'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup(query = false) {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend, maxVoicesPerClip: 64 }),
    audioEventsPlugin(),
    audioMixerPlugin(),
    audioAcousticsPlugin({
      query: query
        ? (_from, _to, out) => {
            out[0] = 0
          }
        : undefined,
    }),
  )
  await app.init()
  await configureAudioMixer(
    app.world,
    AudioMixer.deserialize({
      buses: [
        { id: 'master', parent: '' },
        { id: 'sfx', sends: Array.from({ length: 5 }, (_, i) => ({ target: `room${i}` })) },
        ...Array.from({ length: 5 }, (_, i) => ({ id: `room${i}`, return: true })),
      ],
    }),
  )
  return { app, world: app.world, backend }
}

describe('bounded acoustics', () => {
  it('keeps four slots through a five-zone rank swap with a full 100 ms fade', async () => {
    const { app, world } = await setup()
    const zones = Array.from({ length: 5 }, (_, i) =>
      world.spawn([ReverbZone, { returnBus: `room${i}`, wet: 1 }], Transform),
    )
    for (let i = 0; i < 20; i++) app.update(0.01)
    const state = world.resource(AudioAcoustics)
    expect(state.discarded).toBe(1)
    expect(state.slots.filter((s) => s.weight > 0)).toHaveLength(4)
    expect(state.slots.reduce((sum, s) => sum + s.weight, 0)).toBeCloseTo(0.8)
    const victim = state.slots[0]!.entity!
    world.set(zones[4]!, ReverbZone, { priority: 1 })
    app.update(0.01)
    expect(state.slots.find((s) => s.entity === victim)!.weight).toBeCloseTo(0.18)
    for (let i = 0; i < 22; i++) app.update(0.01)
    expect(state.slots.filter((s) => s.weight > 0)).toHaveLength(1)
    expect(state.slots.find((s) => s.entity === zones[4])!.weight).toBeCloseTo(1)
    app.dispose()
  })

  it('bounds queries among 512 emitters and observes stale voices', async () => {
    const { app, world } = await setup(true)
    const clip = world.resource(AudioClips).add(audioClip(sineWav(2)))
    for (let i = 0; i < 512; i++)
      world.spawn(
        [AudioSource, { clip, loop: true, priority: i < 64 ? 255 : 0 }],
        [Transform, { translation: [i % 10, 0, 0] }],
      )
    let queries = 0
    for (let i = 0; i < 30; i++) {
      app.update(1 / 60)
      const state = world.resource(AudioAcoustics)
      expect(state.queries).toBeLessThanOrEqual(16)
      queries += state.queries
    }
    expect(queries).toBeGreaterThan(16)
    const physical = audioState(world).voices.filter((v) => v.backend >= 0)
    expect(physical.length).toBeLessThanOrEqual(64)
    expect(physical.some((v) => v.transmission < 0.1)).toBe(true)
    expect(audioState(world).voices.some((v) => v.backend < 0 && v.acousticAt < 0)).toBe(true)
    app.dispose()
  })

  it('keeps influence and Doppler invariant when source, listener and zone rebase together', async () => {
    const { app, world, backend } = await setup()
    const clip = world.resource(AudioClips).add(audioClip(sineWav(2)))
    const listener = world.spawn(AudioListener, [Transform, { translation: [100, 0, 0] }])
    const source = world.spawn(
      [AudioSource, { clip, loop: true, doppler: 1 }],
      [Transform, { translation: [102, 0, 0] }],
    )
    const zone = world.spawn(
      [ReverbZone, { returnBus: 'room0' }],
      [Transform, { translation: [100, 0, 0] }],
    )
    for (let i = 0; i < 12; i++) app.update(0.01)
    const before = world.resource(AudioAcoustics).slots[0]!.weight
    world.set(listener, Transform, { translation: [0, 0, 0] })
    world.set(source, Transform, { translation: [2, 0, 0] })
    world.set(zone, Transform, { translation: [0, 0, 0] })
    world.trigger(OriginShift, { offset: [-100, 0, 0], grid: null, delta: [0, 0, 0] })
    app.update(0.01)
    expect(world.resource(AudioAcoustics).slots[0]!.weight).toBe(before)
    expect(backend.active[0]!.params.pitch).toBeCloseTo(1)
    expect(audioState(world).voices[0]!.transmission).toBe(1)
    app.dispose()
  })
})
