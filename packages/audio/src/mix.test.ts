import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { playSound, setAudioUserBus, setBus } from './api'
import { audioClip } from './clip'
import { audioEventsPlugin } from './events'
import { HeadlessAudioBackend } from './headless'
import {
  AudioMixer,
  AudioSnapshot,
  acquireAudioSnapshot,
  audioMixerPlugin,
  configureAudioMixer,
  describeAudioMix,
  releaseAudioSnapshot,
  updateAudioMix,
} from './mix'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup() {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    audioMixerPlugin(),
  )
  await app.init()
  const mixer = AudioMixer.deserialize({
    buses: [
      { id: 'master', parent: '' },
      { id: 'sfx', gainDb: 20 * Math.log10(0.5) },
      { id: 'steps', parent: 'sfx', gainDb: 20 * Math.log10(0.5) },
    ],
  })
  await configureAudioMixer(app.world, mixer)
  return { app, world: app.world, backend, mixer }
}

describe('authored audio mixing', () => {
  it('applies ancestor gains exactly once and retains the old mixer after an invalid edit', async () => {
    const { app, world, backend, mixer } = await setup()
    playSound(world, audioClip(sineWav(1)), { bus: 'steps' })
    app.update(0.01)
    expect(backend.measure(backend.active[0]!).gain).toBeCloseTo(0.25)
    mixer.buses[1]!.parent = 'steps'
    await expect(configureAudioMixer(world, mixer)).rejects.toMatchObject({
      code: 'audio/mixer-cycle',
    })
    expect(backend.measure(backend.active[0]!).gain).toBeCloseTo(0.25)
    app.dispose()
  })

  it('composes equal-priority snapshots independently of activation order and preserves user settings', async () => {
    const run = async (reverse: boolean) => {
      const { app, world, backend } = await setup()
      const underwater = AudioSnapshot.deserialize({
        attack: 0,
        release: 0,
        targets: [{ bus: 'sfx', value: -20 }],
      })
      const dialogue = AudioSnapshot.deserialize({
        attack: 0,
        release: 0,
        targets: [{ bus: 'sfx', value: -10 }],
      })
      const handles = []
      for (const snapshot of reverse ? [dialogue, underwater] : [underwater, dialogue])
        handles.push(await acquireAudioSnapshot(world, snapshot, 0.5))
      setBus(world, 'sfx', { volume: 0.5 })
      updateAudioMix(world, 0)
      const result = describeAudioMix(world).fields.find((field) => field.bus === 'sfx')!.effective
      expect(result).toBe(-15)
      expect(backend.buses.get('sfx')).toBeCloseTo(10 ** (-15 / 20) * 0.5)
      releaseAudioSnapshot(world, handles[0]!)
      updateAudioMix(world, 0)
      expect(describeAudioMix(world).snapshots).toHaveLength(1)
      releaseAudioSnapshot(world, handles[1]!)
      updateAudioMix(world, 0)
      expect(backend.buses.get('sfx')).toBeCloseTo(0.25)
      app.dispose()
      return result
    }
    expect(await run(false)).toBe(await run(true))
  })

  it('preserves user mute through gameplay gain, snapshots and graph replacement', async () => {
    const { app, world, backend, mixer } = await setup()
    setAudioUserBus(world, 'sfx', { volume: 0 })
    setBus(world, 'sfx', { volume: 2 })
    const id = await acquireAudioSnapshot(
      world,
      AudioSnapshot.deserialize({ attack: 0, release: 0, targets: [{ bus: 'sfx', value: 6 }] }),
    )
    updateAudioMix(world, 0)
    expect(backend.buses.get('steps')).toBe(0)
    releaseAudioSnapshot(world, id)
    await configureAudioMixer(world, mixer)
    updateAudioMix(world, 0)
    expect(backend.buses.get('steps')).toBe(0)
    expect(backend.buses.get('master')).toBe(1)
    await app.dispose()
  })

  it('models scheduled fades without applying future values early', () => {
    const backend = new HeadlessAudioBackend()
    const id = backend.play({
      clip: audioClip(sineWav(10)),
      bus: 'music',
      loop: true,
      gain: 1,
      pitch: 1,
      offset: 0,
      spatial: null,
      x: 0,
      y: 0,
      z: 0,
      when: 0,
    })
    backend.automate(id, {
      property: 'gain',
      at: 1,
      value: 0,
      duration: 2,
      curve: 'equal-power-out',
    })
    expect(backend.active[0]!.params.gain).toBe(1)
    backend.advance(2)
    expect(backend.active[0]!.params.gain).toBeCloseTo(Math.SQRT1_2)
    backend.automate(id, { property: 'gain', at: 2, value: 1, duration: 1 })
    backend.advance(0.5)
    expect(backend.active[0]!.params.gain).toBeCloseTo((1 + Math.SQRT1_2) / 2)
    backend.advance(0.5)
    expect(backend.active[0]!.params.gain).toBe(1)
    backend.dispose()
  })
})
