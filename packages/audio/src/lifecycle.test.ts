import type { AssetRef } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  AudioCheckpoint,
  captureAudioCheckpoint,
  resetAudioForLoad,
  restoreAudioCheckpoint,
} from './checkpoint'
import { AudioClips, audioClip } from './clip'
import { AudioEvent } from './event-assets'
import {
  AudioEventsState,
  AudioTransport,
  audioEvents,
  audioEventsPlugin,
  playAudioEvent,
  prepareAudio,
  stopAudioEvent,
} from './events'
import { HeadlessAudioBackend } from './headless'
import { AudioParameters } from './parameters'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup(options: { backend?: HeadlessAudioBackend; maxPending?: number } = {}) {
  const backend = options.backend ?? new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin({ maxPending: options.maxPending }),
  )
  await app.init()
  const clip = audioClip(sineWav(2), { id: 'old' }),
    ref = app.world.resource(AudioClips).add(clip)
  const event = AudioEvent.deserialize({
    mode: 'sustain',
    layers: [{ id: 'loop', loop: true, choices: [{ clip: { guid: ref.guid } }] }],
  })
  return { app, world: app.world, backend, clip, ref, event }
}

describe('audio lifetime and checkpoints', () => {
  it('pins active clip revisions while new instances use replacement data', async () => {
    const { app, world, backend, clip, event } = await setup()
    const firstLease = await prepareAudio(world, event)
    const first = playAudioEvent(world, event)
    app.update(0.01)
    Object.assign(clip, audioClip(sineWav(3), { id: 'new' }))
    const nextLease = await prepareAudio(world, event)
    const next = playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active.map((voice) => voice.clip)).toEqual(['old', 'new'])
    expect(
      audioEvents(world).instances.find((i) => i?.id === first)!.plan!.clips[0]![0]!.duration,
    ).toBe(2)
    stopAudioEvent(world, first, { release: 0 })
    stopAudioEvent(world, next, { release: 0 })
    firstLease.release()
    nextLease.release()
    backend.collect()
    expect(backend.memory().pinned).toBe(0)
    app.dispose()
  })

  it('releases shared parameter schemas and retains no zero-duration cooldowns', async () => {
    const { app, world, event } = await setup()
    const globals = AudioParameters.deserialize({ parameters: [{ name: 'weather' }] })
    const ref = world.resource(AudioParameters.store).add(globals)
    event.globals = ref as AssetRef<'audio/AudioParameters'>
    let lease = await prepareAudio(world, event)
    lease.release()
    expect(audioEvents(world).globalBanks.size).toBe(0)
    globals.parameters[0]!.max = 10
    lease = await prepareAudio(world, event)
    event.scope = 'emitter'
    const emitterLease = await prepareAudio(world, event)
    for (let i = 0; i < 1000; i++) {
      const entity = world.spawn(Transform),
        id = playAudioEvent(world, event, { entity })
      stopAudioEvent(world, id, { release: 0 })
      world.despawn(entity)
    }
    expect(audioEvents(world).cooldowns.size).toBe(0)
    lease.release()
    emitterLease.release()
    expect(audioEvents(world).globalBanks.size).toBe(0)
    app.dispose()
  })

  it('bounds delayed preparations and never starts after stop or disposal', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    class Delayed extends HeadlessAudioBackend {
      override async prepare(clip: Parameters<HeadlessAudioBackend['prepare']>[0]) {
        await barrier
        return super.prepare(clip)
      }
    }
    const { app, world, backend, event } = await setup({ backend: new Delayed(), maxPending: 1 })
    const id = playAudioEvent(world, event)
    expect(audioEvents(world).pending).toBe(1)
    await expect(prepareAudio(world, event)).rejects.toMatchObject({ code: 'audio/capacity' })
    stopAudioEvent(world, id, { release: 0 })
    app.dispose()
    release()
    for (let i = 0; i < 10; i++) await Promise.resolve()
    backend.collect()
    expect(backend.active).toHaveLength(0)
    expect(backend.memory().pinned).toBe(0)
    expect(world.resource(AudioEventsState).leases.size).toBe(0)
  })

  it('restores only opted-in sustained state and invalidates prior instances', async () => {
    const { app, world, backend, event } = await setup()
    const lease = await prepareAudio(world, event)
    const id = playAudioEvent(world, event, { persist: true })
    const transient = AudioEvent.deserialize({
      layers: [
        { id: 'hit', choices: [{ clip: { guid: event.layers[0]!.choices[0]!.clip!.guid } }] },
      ],
    })
    const transientLease = await prepareAudio(world, transient)
    playAudioEvent(world, transient)
    app.update(0.01)
    app.update(0.1)
    captureAudioCheckpoint(world)
    const checkpoint = world.resource(AudioCheckpoint)
    expect(checkpoint.events).toHaveLength(1)
    const phase = checkpoint.events[0]!.layers[0]!.cursor
    resetAudioForLoad(world)
    expect(backend.active).toHaveLength(0)
    expect(await restoreAudioCheckpoint(world)).toEqual([])
    expect(stopAudioEvent(world, id)).toBe(false)
    const instances = audioEvents(world).instances.filter((i) => i && i.state !== 'ended')
    expect(instances).toHaveLength(1)
    expect(instances[0]!.layers[0]!.voice!.time).toBe(phase)
    app.update(0.01)
    expect(backend.active).toHaveLength(1)
    lease.release()
    transientLease.release()
    app.dispose()
  })

  it('pumps realtime playback without visual frames and silences paused simulation events', async () => {
    const { app, world, backend, event } = await setup()
    const lease = await prepareAudio(world, event)
    const simulation = playAudioEvent(world, event)
    const realtime = playAudioEvent(world, event, { clock: 'realtime' })
    app.update(0.01)
    world.resource(AudioTransport).paused = true
    for (let i = 0; i < 40; i++) backend.advance(0.025)
    const state = audioEvents(world)
    expect(state.instances.find((i) => i?.id === simulation)!.layers[0]!.voice!.backend).toBe(-1)
    expect(state.instances.find((i) => i?.id === realtime)!.sampleTime).toBeGreaterThan(0.9)
    expect(backend.active).toHaveLength(1)
    lease.release()
    app.dispose()
  })
})
