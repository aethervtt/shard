import {
  AudioCheckpoint,
  AudioClips,
  AudioEvent,
  audioEvents,
  audioEventsPlugin,
  audioPlugin,
  HeadlessAudioBackend,
  playAudioEvent,
  prepareAudio,
  stopAudioEvent,
} from '@aethervtt/shard-audio'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { savePlugin } from './plugin'
import { captureGame, loadGame } from './save'

async function setup() {
  const backend = new HeadlessAudioBackend()
  const app = new App().addPlugin(
    TransformPlugin,
    ScenePlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    savePlugin(),
  )
  await app.init()
  // Tiny valid metadata-only clips suffice for logical save testing; no host decoder involved.
  const clip = {
    codec: 'wav' as const,
    normalize: false,
    id: 'a',
    bytes: new Uint8Array(48),
    duration: 2,
    channels: 1,
    sampleRate: 8000,
    loopStart: 0,
    loopEnd: 2,
    stream: false,
  }
  const a = app.world.resource(AudioClips).add(clip)
  const b = app.world.resource(AudioClips).add({ ...clip, id: 'b', bytes: new Uint8Array(48) })
  const event = AudioEvent.deserialize({
    mode: 'sustain',
    cooldown: 2,
    layers: [
      {
        id: 'loop',
        loop: true,
        selector: 'sequence',
        choices: [{ clip: { guid: a.guid } }, { clip: { guid: b.guid } }],
      },
    ],
  })
  return { app, world: app.world, backend, event }
}

describe('saved audio integration', () => {
  it('restores sustained audio once and never replays an old checkpoint into a legacy save', async () => {
    const { app, world, backend, event } = await setup()
    const lease = await prepareAudio(world, event)
    playAudioEvent(world, event, { persist: true })
    app.update(0.1)
    const file = captureGame(world)
    expect(file.resources['audio/Checkpoint']).toBeDefined()
    expect((await loadGame(world, file)).warnings).toEqual([])
    app.update(0.1)
    expect(backend.active).toHaveLength(1)
    const legacy = structuredClone(file)
    delete legacy.resources['audio/Checkpoint']
    expect((await loadGame(world, legacy)).warnings).toEqual([])
    app.update(0.1)
    expect(world.tryResource(AudioCheckpoint)).toBeUndefined()
    expect(backend.active).toHaveLength(0)
    expect(audioEvents(world).instances.filter((i) => i && i.state !== 'ended')).toHaveLength(0)
    lease.release()
    await app.dispose()
  })

  it('rewinds session selection history and restores cooldown remainder independently of live sounds', async () => {
    const { app, world, backend, event } = await setup()
    let lease = await prepareAudio(world, event)
    const id = playAudioEvent(world, event)
    app.update(0.1)
    stopAudioEvent(world, id, { release: 0 })
    app.update(0.4)
    const file = captureGame(world)
    expect(world.resource(AudioCheckpoint).events).toHaveLength(0)
    app.update(2)
    playAudioEvent(world, event)
    app.update(0.1)
    expect(backend.active[0]!.clip).toBe('b')
    await loadGame(world, file)
    lease = await prepareAudio(world, event)
    expect(() => playAudioEvent(world, event)).toThrow()
    app.update(1.51)
    playAudioEvent(world, event)
    app.update(0.01)
    expect(backend.active[0]!.clip).toBe('b')
    lease.release()
    await app.dispose()
  })
})
