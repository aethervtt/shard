import { assetServer } from '@aethervtt/shard-assets'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { captureAudioCheckpoint, resetAudioForLoad, restoreAudioCheckpoint } from './checkpoint'
import { AudioClips, audioClip } from './clip'
import { audioEvents, audioEventsPlugin } from './events'
import { HeadlessAudioBackend } from './headless'
import {
  AudioMusicState,
  audioMusicPlugin,
  cancelMusicRequest,
  describeMusic,
  MusicProgram,
  pauseMusic,
  prepareMusic,
  requestMusicSection,
  resumeMusic,
  seekMusic,
  setMusicParameter,
  startMusic,
  updateMusic,
} from './music'
import { AudioParameters } from './parameters'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function setup(budget = 1024 * 1024) {
  const backend = new HeadlessAudioBackend({ decodedBudgetBytes: budget })
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  const world = app.world
  const sections = ['a', 'b', 'c'].map((id, i) => {
    const ref = world
      .resource(AudioClips)
      .add(audioClip(sineWav(2, { rate: 8000, frequency: 220 * (i + 1) }), { id }))
    return { id, bars: 1, stems: [{ id: 'stem', clip: { guid: ref.guid }, endSample: 16000 }] }
  })
  const definition = MusicProgram.deserialize({
    bpm: 120,
    entry: 'a',
    sections,
    parameters: [{ name: 'combat', initial: 0 }],
  })
  return { app, world, backend, definition }
}
async function ready(program: Awaited<ReturnType<typeof prepareMusic>>) {
  await Promise.all(program.pending.values())
  await Promise.resolve()
}
function advance(backend: HeadlessAudioBackend, seconds: number) {
  for (let i = 0; i < Math.ceil(seconds / 0.025); i++) backend.advance(0.025)
}

describe('music ownership and recovery', () => {
  it.each([false, true])(
    'audible cancellation is identical with preceding scheduler wake=%s',
    async (reconcile) => {
      const { app, world, backend, definition } = await setup()
      const program = await prepareMusic(world, definition)
      const id = startMusic(world, program)
      const request = requestMusicSection(world, id, 'b', { fadeBeats: 2 })
      await ready(program)
      advance(backend, 1.95)
      expect(request.state).toBe('committed')
      world.resource(AudioMusicState).wake?.()
      backend.advance(0.2)
      if (reconcile) updateMusic(world)
      expect(cancelMusicRequest(world, id, request.id)).toBe('already-started')
      expect(describeMusic(world).transports[0]).toMatchObject({ section: 'b', paused: true })
      backend.advance(0.03)
      expect(backend.active).toHaveLength(0)
      expect(world.resource(AudioMusicState).transports[0]).toMatchObject({
        retiring: [],
        pending: null,
        committed: null,
        stingers: [],
      })
      program.release()
      app.dispose()
    },
  )

  it.each(['resume', 'seek'] as const)(
    'evaluates automatic rules immediately after %s rebases a long-running clock',
    async (action) => {
      const { app, world, backend, definition } = await setup()
      definition.transitions = MusicProgram.deserialize({
        entry: 'a',
        transitions: [
          {
            id: 'combat',
            from: 'a',
            to: 'b',
            parameter: 'combat',
            min: 0.5,
            max: 1,
            quantize: 'beat',
          },
        ],
      }).transitions
      const program = await prepareMusic(world, definition)
      const id = startMusic(world, program)
      advance(backend, 12)
      if (action === 'resume') {
        pauseMusic(world, id)
        setMusicParameter(world, id, 'combat', 1)
        resumeMusic(world, id)
      } else {
        setMusicParameter(world, id, 'combat', 1)
        seekMusic(world, id, 0)
      }
      advance(backend, 0.1)
      const transport = world.resource(AudioMusicState).transports[0]!
      expect(transport.pending?.section ?? transport.committed?.section).toBe('b')
      await ready(program)
      advance(backend, 1)
      expect(describeMusic(world).transports[0]!.section).toBe('b')
      program.release()
      app.dispose()
    },
  )

  it('rejects unresolved global curves and predicates without retaining PCM or globals', async () => {
    const { app, world, backend, definition } = await setup()
    definition.globals = world
      .resource(AudioParameters.store)
      .add(AudioParameters.deserialize({ parameters: [{ name: 'weather' }] }))
    definition.sections[0]!.stems[0]!.curves = [
      { parameter: 'missing', property: 'gainDb', points: [[0, 0]] },
    ]
    await expect(prepareMusic(world, definition)).rejects.toMatchObject({
      code: 'audio/unknown-parameter',
    })
    backend.collect()
    expect(backend.memory().pinned).toBe(0)
    expect(backend.memory().decodedBytes).toBe(0)
    definition.sections[0]!.stems[0]!.curves = []
    definition.transitions = MusicProgram.deserialize({
      entry: 'a',
      transitions: [{ id: 'bad', from: 'a', to: 'b', parameter: 'missing' }],
    }).transitions
    await expect(prepareMusic(world, definition)).rejects.toMatchObject({
      code: 'audio/unknown-parameter',
    })
    expect(world.resource(AudioMusicState).programs.size).toBe(0)
    app.dispose()
  })

  it('reclaims retired sections so three branches fit a two-section decoded budget', async () => {
    const { app, world, backend, definition } = await setup(128000)
    const program = await prepareMusic(world, definition)
    const id = startMusic(world, program)
    requestMusicSection(world, id, 'b', { quantize: 'beat', fadeBeats: 0.1 })
    await ready(program)
    advance(backend, 1)
    expect([...program.sections.keys()]).toEqual(['b'])
    requestMusicSection(world, id, 'c', { quantize: 'beat', fadeBeats: 0.1 })
    await ready(program)
    advance(backend, 1)
    expect(describeMusic(world).transports[0]!.section).toBe('c')
    expect([...program.sections.keys()]).toEqual(['c'])
    expect(backend.memory().decodedBytes).toBeLessThanOrEqual(128000)
    program.release()
    app.dispose()
  })

  it('clears failed readiness so a later valid destination can be requested', async () => {
    const { app, world, backend, definition } = await setup()
    definition.sections[1]!.stems[0]!.endSample = 999999
    const program = await prepareMusic(world, definition)
    const id = startMusic(world, program)
    const request = requestMusicSection(world, id, 'b')
    await Promise.allSettled(program.pending.values())
    for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(request.state).toBe('failed')
    expect(world.resource(AudioMusicState).transports[0]!.pending).toBeNull()
    requestMusicSection(world, id, 'c', { quantize: 'beat' })
    await ready(program)
    advance(backend, 1)
    expect(describeMusic(world).transports[0]!.section).toBe('c')
    program.release()
    app.dispose()
  })

  it('smooths shared parameters without render frames and keeps cadences equivalent', async () => {
    const run = async (cadence: number) => {
      const { app, world, backend, definition } = await setup()
      const globals = world
        .resource(AudioParameters.store)
        .add(AudioParameters.deserialize({ parameters: [{ name: 'level', smooth: 0.1 }] }))
      definition.globals = globals
      definition.sections[0]!.stems[0]!.curves = [
        {
          parameter: 'level',
          property: 'gainDb',
          points: [
            [0, -40],
            [1, 0],
          ],
        },
      ]
      const program = await prepareMusic(world, definition)
      const id = startMusic(world, program)
      setMusicParameter(world, id, 'level', 1)
      requestMusicSection(world, id, 'b', { quantize: 'bar' })
      await ready(program)
      for (let i = 0; i < 1200; i++) {
        backend.advance(0.025)
        if (cadence && i % cadence === 0) app.update(0)
        if (i === 39) expect(program.globals.values[0]).toBeGreaterThan(0.99)
      }
      const trace = world
        .resource(AudioMusicState)
        .trace.read()
        .entries.map(({ frame: _frame, ...entry }) => entry)
      expect(trace.some((entry) => entry.kind === 'music-transition')).toBe(true)
      expect(audioEvents(world).globalList).toHaveLength(1)
      program.release()
      await app.dispose()
      return trace
    }
    expect(await run(1)).toEqual(await run(7))
    expect(await run(0)).toEqual(await run(1))
  })

  it('rejects metadata completions from before a save reset without retaining a program', async () => {
    const { app, world, backend, definition } = await setup()
    let complete!: () => void
    const barrier = new Promise<void>((resolve) => {
      complete = resolve
    })
    assetServer(world).virtual(
      'delayed-score',
      'score.audio-music.json',
      'audio/MusicProgram',
      async () => {
        await barrier
        return definition
      },
      { lazy: true },
    )
    const preparing = prepareMusic(world, 'score.audio-music.json')
    resetAudioForLoad(world)
    complete()
    await expect(preparing).rejects.toMatchObject({ code: 'audio/music-capacity' })
    expect(world.resource(AudioMusicState).programs.size).toBe(0)
    backend.collect()
    expect(backend.memory().pinned).toBe(0)
    await app.dispose()
  })

  it('restores parameters before scheduling the initial stem gain', async () => {
    const { app, world, backend, definition } = await setup()
    definition.sections[0]!.stems[0]!.curves = [
      {
        parameter: 'combat',
        property: 'gainDb',
        points: [
          [0, -40],
          [1, -6],
        ],
      },
    ]
    const program = await prepareMusic(world, definition)
    const id = startMusic(world, program, { persist: true })
    setMusicParameter(world, id, 'combat', 1)
    advance(backend, 0.2)
    captureAudioCheckpoint(world)
    resetAudioForLoad(world)
    expect(await restoreAudioCheckpoint(world)).toEqual([])
    expect(backend.active[0]!.params.gain).toBeCloseTo(10 ** (-6 / 20))
    program.release()
    app.dispose()
  })
})
