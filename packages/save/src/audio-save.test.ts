import {
  AudioCheckpoint,
  AudioClips,
  AudioEvent,
  AudioMusicState,
  audioEvents,
  audioEventsPlugin,
  audioMusicPlugin,
  audioPlugin,
  describeMusic,
  HeadlessAudioBackend,
  MusicProgram,
  pauseMusic,
  playAudioEvent,
  prepareAudio,
  prepareMusic,
  prepareMusicSection,
  requestMusicSection,
  setMusicParameter,
  startMusic,
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
    audioMusicPlugin(),
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
  return { app, world: app.world, backend, event, clips: [a, b] }
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

  it.each([false, true])(
    'restores section, phase and parameters through loadGame, paused=%s',
    async (paused) => {
      const { app, world, backend, clips } = await setup()
      const definition = MusicProgram.deserialize({
        entry: 'a',
        bpm: 120,
        parameters: [{ name: 'intensity' }],
        sections: clips.map((clip, i) => ({
          id: i === 0 ? 'a' : 'b',
          bars: 1,
          stems: [{ id: 'stem', clip: { guid: clip.guid }, endSample: 16000 }],
        })),
      })
      const program = await prepareMusic(world, definition)
      await prepareMusicSection(world, program, 'b')
      const id = startMusic(world, program, { section: 'b', persist: true })
      setMusicParameter(world, id, 'intensity', 0.75)
      backend.advance(0.52)
      if (paused) pauseMusic(world, id)
      else {
        requestMusicSection(world, id, 'a', { quantize: 'immediate' })
        await Promise.all(program.pending.values())
        backend.advance(0)
      }
      const file = captureGame(world)
      const saved = world.resource(AudioCheckpoint).music[0]!
      expect(saved.section).toBe('b')
      expect(saved.phase).toBeGreaterThan(0)
      expect(saved.destination).toBe(paused ? '' : 'a')
      const oldVoices = backend.active.map((voice) => voice.id)
      const result = await loadGame(world, file)
      expect(result.warnings).toEqual([])
      if (!paused) backend.advance(world.resource(AudioMusicState).commitLead)
      const transports = describeMusic(world).transports
      expect(transports).toHaveLength(1)
      expect(transports[0]).toMatchObject({ section: 'b', paused })
      expect(transports[0]!.tick).toBeCloseTo(saved.phase)
      expect(backend.active.every((voice) => !oldVoices.includes(voice.id))).toBe(true)
      captureGame(world)
      const restored = world.resource(AudioCheckpoint).music[0]!
      expect(restored.values[0]).toBe(0.75)
      if (paused) expect(backend.active).toHaveLength(0)
      else
        expect(
          world.resource(AudioMusicState).transports.find((transport) => !transport.stopped)!
            .pending?.section,
        ).toBe('a')
      program.release()
      await app.dispose()
    },
  )

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
