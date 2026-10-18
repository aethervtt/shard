import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { AudioClips, audioClip } from './clip'
import { audioEventsPlugin } from './events'
import { HeadlessAudioBackend } from './headless'
import {
  AudioMusicState,
  audioMusicPlugin,
  cancelMusicRequest,
  describeMusic,
  MusicProgram,
  musicBarTicks,
  musicTimeAtTick,
  pauseMusic,
  prepareMusic,
  requestMusicSection,
  resumeMusic,
  seekMusic,
  startMusic,
  stopMusic,
  updateMusic,
} from './music'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup(maxVoices = 16, bpm = 120, numerator = 4, denominator = 4) {
  const backend = new HeadlessAudioBackend({ maxVoices })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend, maxVoices }),
    audioEventsPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  const seconds = (((numerator * 4) / denominator) * 60) / bpm
  const clip = audioClip(sineWav(seconds, { rate: 8000 }), { id: 'stem' })
  const ref = app.world.resource(AudioClips).add(clip)
  const stems = Array.from({ length: 4 }, (_, i) => ({
    id: `stem${i}`,
    clip: { guid: ref.guid },
    endSample: Math.floor(seconds * 8000),
    rateConform: true,
    maxConformCents: 1,
  }))
  const definition = MusicProgram.deserialize({
    bpm,
    numerator,
    denominator,
    entry: 'explore',
    sections: [
      { id: 'explore', bars: 1, stems },
      { id: 'combat', bars: 1, stems },
    ],
  })
  const program = await prepareMusic(app.world, definition)
  return { app, world: app.world, backend, program }
}

describe('adaptive music transport', () => {
  it('starts four stems at one timestamp and schedules a transition without render frames', async () => {
    const { app, world, backend, program } = await setup()
    const id = startMusic(world, program)
    expect(backend.active).toHaveLength(4)
    expect(new Set(backend.active.map((v) => backend.presentation(v.id)!.scheduledAt)).size).toBe(1)
    const request = requestMusicSection(world, id, 'combat', { quantize: 'bar' })
    await Promise.all(program.pending.values())
    for (let i = 0; i < 1200; i++) backend.advance(0.025)
    expect(request.state).toBe('done')
    expect(describeMusic(world).transports[0]!.section).toBe('combat')
    expect(backend.active).toHaveLength(4)
    expect(
      world
        .resource(AudioMusicState)
        .trace.read()
        .entries.filter((e) => e.kind === 'music-transition'),
    ).toHaveLength(1)
    stopMusic(world, id)
    program.release()
    backend.collect()
    expect(backend.active).toHaveLength(0)
    expect(backend.memory().pinned).toBe(0)
    app.dispose()
  })

  it('keeps the old section when the whole incoming section cannot fit', async () => {
    const { app, world, backend, program } = await setup(6)
    const id = startMusic(world, program)
    const request = requestMusicSection(world, id, 'combat')
    await Promise.all(program.pending.values())
    for (let i = 0; i < 100; i++) backend.advance(0.025)
    expect(request.state).toBe('failed')
    expect(request.error).toBe('audio/music-capacity')
    expect(backend.active).toHaveLength(4)
    expect(describeMusic(world).transports[0]!.section).toBe('explore')
    program.release()
    app.dispose()
  })

  it('cancels committed sources and preserves phase across pause, seek and resume', async () => {
    const { app, world, backend, program } = await setup()
    const id = startMusic(world, program)
    const request = requestMusicSection(world, id, 'combat')
    await Promise.all(program.pending.values())
    for (let i = 0; i < 77; i++) backend.advance(0.025)
    expect(request.state).toBe('committed')
    expect(cancelMusicRequest(world, id, request.id)).toBe('cancelled')
    expect(backend.active).toHaveLength(4)
    pauseMusic(world, id)
    expect(backend.active).toHaveLength(0)
    const phase = describeMusic(world).transports[0]!.tick
    backend.advance(5)
    expect(describeMusic(world).transports[0]!.tick).toBe(phase)
    seekMusic(world, id, 960)
    resumeMusic(world, id)
    expect(backend.active).toHaveLength(4)
    expect(backend.active[0]!.offset).toBeCloseTo(0.5)
    program.release()
    app.dispose()
  })

  it('reports a missed deadline once and defers while the old loop keeps playing', async () => {
    const { app, world, backend, program } = await setup()
    const id = startMusic(world, program)
    const request = requestMusicSection(world, id, 'combat')
    await Promise.all(program.pending.values())
    backend.advance(1.85)
    backend.advance(0.25)
    expect(request.state).toBe('pending')
    expect(request.at).toBeCloseTo(4.02)
    expect(describeMusic(world).transports[0]!.misses).toBe(1)
    updateMusic(world)
    expect(describeMusic(world).transports[0]!.misses).toBe(1)
    expect(backend.active).toHaveLength(4)
    program.release()
    app.dispose()
  })

  it('rounds absolute boundaries once with exact compound-meter ticks', () => {
    for (const numerator of [3, 7])
      expect(musicBarTicks({ numerator, denominator: 8 })).toBe(numerator * 480)
    for (let tick = 0; tick < ((1800 * 123) / 60) * 960; tick += 960) {
      expect(
        Math.abs(musicTimeAtTick(0.023, tick, 123, 48000) - (0.023 + ((tick / 960) * 60) / 123)),
      ).toBeLessThanOrEqual(0.5 / 48000 + 1e-10)
    }
  })

  it('requires explicit bounded pitch-changing rate conform', async () => {
    const { app, world, program } = await setup(16, 123)
    const definition = MusicProgram.deserialize(MusicProgram.serialize(program.definition))
    definition.sections[0]!.stems[0]!.rateConform = false
    await expect(prepareMusic(world, definition)).rejects.toMatchObject({
      code: 'audio/music-invalid',
    })
    definition.sections[0]!.stems[0]!.rateConform = true
    definition.sections[0]!.stems[0]!.maxConformCents = 0
    await expect(prepareMusic(world, definition)).rejects.toMatchObject({
      code: 'audio/music-invalid',
    })
    program.release()
    app.dispose()
  })
})
