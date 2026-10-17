import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
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

async function settle() {
  for (let i = 0; i < 40; i++) await Promise.resolve()
}
async function setup(backend = new HeadlessAudioBackend()) {
  const app = new App().addPlugin(TransformPlugin, audioPlugin({ backend }), audioEventsPlugin())
  await app.init()
  const world = app.world
  const a = world.resource(AudioClips).add(audioClip(sineWav(2), { id: 'a' }))
  const b = world.resource(AudioClips).add(audioClip(sineWav(3), { id: 'b' }))
  const event = AudioEvent.deserialize({
    mode: 'sustain',
    layers: [{ id: 'loop', loop: true, choices: [{ clip: { guid: a.guid } }] }],
  })
  return { app, world, event, a, b, backend }
}

describe('event admission, gates and blocked clocks', () => {
  it('rejects later contenders before decoding even when the first decode is delayed', async () => {
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    class Delayed extends HeadlessAudioBackend {
      decoded: string[] = []
      override async prepare(clip: Parameters<HeadlessAudioBackend['prepare']>[0]) {
        this.decoded.push(clip.id!)
        if (clip.id === 'a') await barrier
        return super.prepare(clip)
      }
    }
    const backend = new Delayed()
    const { app, world, event, b } = await setup(backend)
    event.group = 'exclusive'
    event.maxInstances = 1
    const other = AudioEvent.deserialize(AudioEvent.serialize(event))
    other.layers[0]!.choices[0]!.clip = b
    const first = playAudioEvent(world, event)
    const second = playAudioEvent(world, other)
    await settle()
    expect(backend.decoded).toEqual(['a'])
    expect(audioEvents(world).instances.find((i) => i?.id === first)!.ordinal).toBe(0)
    expect(audioEvents(world).instances.find((i) => i?.id === second)!).toMatchObject({
      state: 'failed',
      ordinal: -1,
      error: 'audio/capacity',
    })
    release()
    await settle()
    app.update(0.01)
    expect(backend.active.map((v) => v.clip)).toEqual(['a'])
    app.dispose()
  })

  it('validates bindings before a steal can silence an existing event', async () => {
    const { app, world, event } = await setup()
    event.group = 'exclusive'
    event.maxInstances = 1
    event.policy = 'steal-oldest'
    const lease = await prepareAudio(world, event)
    const id = playAudioEvent(world, event)
    app.update(0.01)
    app.update(0.01)
    expect(() => playAudioEvent(world, event, { parameters: { missing: 1 } })).toThrow()
    expect(audioEvents(world).instances.find((i) => i?.id === id)!.state).toBe('active')
    expect(audioEvents(world).ordinal).toBe(1)
    lease.release()
    app.dispose()
  })

  it.each(['resume', 'restart'] as const)(
    'reopens a %s gate during release without becoming permanently silent',
    async (policy) => {
      const { app, world, event } = await setup()
      event.parameters = AudioEvent.deserialize({
        parameters: [{ name: 'on', initial: 1 }],
      }).parameters
      Object.assign(event.layers[0]!, {
        trigger: 'while',
        loopPolicy: policy,
        release: 1,
        condition: { parameter: 'on', min: 0.5, max: 1, label: '' },
      })
      const lease = await prepareAudio(world, event)
      const id = playAudioEvent(world, event)
      app.update(0.01)
      app.update(0.2)
      const layer = audioEvents(world).instances.find((i) => i?.id === id)!.layers[0]!
      const voice = layer.voice
      setAudioParameter(world, id, 'on', 0)
      app.update(0.1)
      expect(layer.ending).toBe(true)
      setAudioParameter(world, id, 'on', 1)
      app.update(0.1)
      expect(layer.ending).toBe(false)
      if (policy === 'resume') expect(layer.voice).toBe(voice)
      else expect(layer.voice).not.toBe(voice)
      app.update(1.1)
      expect(layer.voice!.id).toBeGreaterThan(0)
      lease.release()
      app.dispose()
    },
  )

  it.each([0, 0.5, 2])(
    'keeps default sample time independent from simulation scale %s',
    async (scale) => {
      const { app, world, event } = await setup()
      const lease = await prepareAudio(world, event)
      const normal = playAudioEvent(world, event)
      const linked = playAudioEvent(world, event, { pitchLinked: true })
      world.resource(AudioTransport).timeScale = scale
      app.update(0.01)
      app.update(0.1)
      const instances = audioEvents(world).instances
      expect(instances.find((i) => i?.id === normal)!.layers[0]!.voice!.time).toBeCloseTo(0.1)
      expect(instances.find((i) => i?.id === linked)!.layers[0]!.voice!.time).toBeCloseTo(
        0.1 * scale,
      )
      expect(instances.find((i) => i?.id === normal)!.decisionTime).toBeCloseTo(0.11 * scale)
      lease.release()
      app.dispose()
    },
  )

  it('expires blocked transients without frames and holds wait events until unlock', async () => {
    class Suspended extends HeadlessAudioBackend {
      override state: 'running' | 'suspended' = 'suspended'
    }
    const backend = new Suspended()
    const { app, world, event } = await setup(backend)
    event.mode = 'oneshot'
    event.layers[0]!.loop = false
    const lease = await prepareAudio(world, event)
    const drop = playAudioEvent(world, event)
    event.blocked = 'wait'
    const waitingLease = await prepareAudio(world, event)
    const waiting = playAudioEvent(world, event)
    for (let i = 0; i < 20; i++) backend.advance(0.025)
    const instances = audioEvents(world).instances
    expect(instances.find((i) => i?.id === drop)!.state).toBe('ended')
    expect(instances.find((i) => i?.id === waiting)!.decisionTime).toBe(0)
    backend.state = 'running'
    app.update(0.01)
    expect(backend.active).toHaveLength(1)
    expect(backend.active[0]!.offset).toBe(0)
    lease.release()
    waitingLease.release()
    app.dispose()
  })

  it('keeps sequence history after the final lease is released', async () => {
    const { app, world, event, b, backend } = await setup()
    event.layers[0]!.selector = 'sequence'
    event.layers[0]!.choices.push({ ...event.layers[0]!.choices[0]!, clip: b })
    let lease = await prepareAudio(world, event)
    const id = playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active[0]!.clip).toBe('a')
    stopAudioEvent(world, id, { release: 0 })
    lease.release()
    lease = await prepareAudio(world, event)
    playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active[0]!.clip).toBe('b')
    lease.release()
    app.dispose()
  })

  it('restores source identity and in-flight release while bypassing new-play cooldowns', async () => {
    const { app, world, event } = await setup()
    event.cooldown = 5
    const ref = world.resource(AudioEvent.store).add(event)
    // A loaded ref needs no filesystem/server.
    const { AssetServerResource } = await import('@aethervtt/shard-assets')
    world.insertResource(AssetServerResource, {
      pin() {},
      unpin() {},
      resolve() {
        return ref
      },
    } as never)
    const lease = await prepareAudio(world, ref)
    const id = playAudioEvent(world, ref, { persist: true })
    app.update(0.01)
    stopAudioEvent(world, id, { release: 1 })
    app.update(0.2)
    captureAudioCheckpoint(world)
    expect(world.resource(AudioCheckpoint).events[0]!.source!.guid).toBe(ref.guid)
    resetAudioForLoad(world)
    expect(await restoreAudioCheckpoint(world)).toEqual([])
    const restored = audioEvents(world).instances.find((i) => i?.state === 'stopping')!
    expect(restored.key).toBe(ref.guid)
    expect(restored.layers[0]!.ending).toBe(true)
    app.update(1.1)
    expect(restored.state).toBe('ended')
    lease.release()
    app.dispose()
  })

  it('skips missing clip revisions with a diagnostic and no leaked instance', async () => {
    const { app, world, event, a } = await setup()
    const lease = await prepareAudio(world, event)
    playAudioEvent(world, event, { persist: true })
    app.update(0.01)
    captureAudioCheckpoint(world)
    resetAudioForLoad(world)
    Object.assign(world.resource(AudioClips).get(a)!, audioClip(sineWav(4), { id: 'changed' }))
    expect(await restoreAudioCheckpoint(world)).toMatchObject([{ code: 'audio/restore' }])
    expect(audioEvents(world).instances.filter((i) => i && i.state !== 'ended')).toEqual([])
    expect(audioEvents(world).plans.size).toBe(0)
    lease.release()
    app.dispose()
  })
})
