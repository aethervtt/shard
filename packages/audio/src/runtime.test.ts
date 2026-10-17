import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { playSound, setBus, stopSound } from './api'
import { AudioClips, audioClip } from './clip'
import { AudioBuses, AudioSource } from './components'
import { HeadlessAudioBackend } from './headless'
import { audioLog, describeAudio, readAudioLog } from './methods'
import { AudioState } from './mixer'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup() {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(TransformPlugin, audioPlugin({ backend }))
  await app.init()
  const world = app.world
  const clip = audioClip(sineWav(2), { id: 'runtime-test' })
  const ref = world.resource(AudioClips).add(clip)
  return { app, world, backend, clip, ref }
}

describe('0077 playback foundation', () => {
  it('applies playing-source routing, loop and spatial edits without changing the logical voice', async () => {
    const { app, world, backend, ref } = await setup()
    const source = world.spawn(
      [AudioSource, { clip: ref, loop: true }],
      [Transform, { translation: [10, 0, 0] }],
    )
    app.update(1 / 60)
    const id = describeAudio(world).voices[0]!.voice
    world.set(source, AudioSource, { bus: 'music', loop: false, minDistance: 5, panning: 'hrtf' })
    app.update(1 / 60)
    expect(describeAudio(world).voices[0]).toMatchObject({
      voice: id,
      bus: 'music',
      loop: false,
      gain: 0.5,
    })
    expect(backend.active[0]).toMatchObject({
      bus: 'music',
      loop: false,
      spatial: { panning: 'hrtf', refDistance: 5 },
    })
    expect(backend.measure(backend.active[0]!).gain).toBeCloseTo(0.5)
    world.set(source, AudioSource, { spatial: false })
    app.update(1 / 60)
    expect(backend.active[0]!.spatial).toBeNull()
    expect(audioLog(world).filter((e) => e.event === 'start')).toHaveLength(1)
    app.dispose()
  })

  it('rejects invalid requests before consuming IDs, random choices or mutating a bus', async () => {
    const { app, world, clip } = await setup()
    const state = world.resource(AudioState)
    const next = state.nextId
    for (const pitch of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => playSound(world, clip, { volume: [0.2, 0.8], pitch })).toThrow()
    }
    expect(state.nextId).toBe(next)
    expect(state.voices).toHaveLength(0)
    expect(() => setBus(world, 'master', { parent: 'sfx' })).toThrow()
    expect(world.resource(AudioBuses).master!.parent).toBe('')
    expect(() => setBus(world, 'sfx', { volume: Number.NaN })).toThrow()
    expect(() => audioClip(sineWav(1), { loopStart: 0.8, loopEnd: 0.2 })).toThrow()
    app.dispose()
  })

  it('bounds ten minutes of 60-Hz voice churn and reports cursor loss', async () => {
    const { app, world, backend, clip } = await setup()
    for (let i = 0; i < 36000; i++) {
      const id = playSound(world, clip)
      app.update(1 / 60)
      stopSound(world, id)
    }
    const log = readAudioLog(world, 0)
    expect(log.entries).toHaveLength(4096)
    expect(log.truncated).toBe(true)
    expect(log.nextCursor - log.oldestCursor).toBe(4096)
    expect(readAudioLog(world, log.nextCursor).entries).toHaveLength(0)
    expect(backend.history.length).toBeLessThanOrEqual(4096)
    expect(backend.active).toHaveLength(0)
    app.dispose()
  })

  it('retains active preparation pins on unload and refuses pinned memory overcommit', async () => {
    const clip = audioClip(sineWav(1, { rate: 8000 }))
    const backend = new HeadlessAudioBackend({ decodedBudgetBytes: 32000 })
    const lease = await backend.prepare(clip)
    const id = backend.play({
      clip,
      bus: 'sfx',
      loop: true,
      offset: 0,
      spatial: null,
      gain: 1,
      pitch: 1,
      x: 0,
      y: 0,
      z: 0,
    })
    lease.release()
    lease.release()
    backend.collect()
    expect(backend.memory().decodedBytes).toBe(32000)
    await expect(backend.prepare(audioClip(sineWav(1, { rate: 8000 })))).rejects.toMatchObject({
      code: 'audio/memory-budget',
    })
    backend.stop(id)
    backend.collect()
    expect(backend.memory().decodedBytes).toBe(0)
  })

  it('cancels scheduled voices and wakes without render frames', () => {
    const backend = new HeadlessAudioBackend()
    const clip = audioClip(sineWav(1))
    const id = backend.play({
      clip,
      when: 1,
      bus: 'music',
      loop: false,
      offset: 0,
      spatial: null,
      gain: 1,
      pitch: 1,
      x: 0,
      y: 0,
      z: 0,
    })
    expect(backend.presentation(id)?.state).toBe('scheduled')
    expect(backend.cancel(id)).toBe('cancelled')
    let wakes = 0
    const stop = backend.clock.wake(() => wakes++, 0.025)
    for (let i = 0; i < 1200; i++) backend.advance(0.025)
    stop()
    stop()
    expect(wakes).toBe(1200)
    expect(backend.presentation(id)?.state).toBe('ended')
    expect(backend.active).toHaveLength(0)
    backend.dispose()
  })
})
