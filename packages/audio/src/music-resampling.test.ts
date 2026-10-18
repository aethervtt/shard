import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { AudioClips, audioClip } from './clip'
import { audioEventsPlugin } from './events'
import { HeadlessAudioBackend } from './headless'
import { audioMusicPlugin, MusicProgram, prepareMusic } from './music'
import { audioPlugin } from './plugin'
import { sineWav } from './testing-utils'

async function fixture(samples: number, endSample = 23415) {
  const backend = new HeadlessAudioBackend()
  const prepare = backend.prepare.bind(backend)
  backend.prepare = async (clip) => {
    const lease = await prepare(clip)
    return { ...lease, sampleRate: 48000, samples, release: () => lease.release() }
  }
  const app = new App().addPlugin(
    TransformPlugin,
    audioPlugin({ backend }),
    audioEventsPlugin(),
    audioMusicPlugin(),
  )
  await app.init()
  const ref = app.world.resource(AudioClips).add(audioClip(sineWav(23415 / 12000, { rate: 12000 })))
  const definition = MusicProgram.deserialize({
    bpm: 123,
    entry: 'main',
    sections: [
      {
        id: 'main',
        bars: 1,
        stems: [
          {
            id: 'stem',
            clip: { guid: ref.guid },
            endSample,
            rateConform: true,
            maxConformCents: 1,
          },
        ],
      },
    ],
  })
  return { app, backend, definition }
}

describe('decoded music marker boundaries', () => {
  it('uses the decoded endpoint when the resampler omits its final source-sample interpolation tail', async () => {
    const { app, backend, definition } = await fixture(93657)
    try {
      const program = await prepareMusic(app.world, definition)
      const stem = program.sections.get('main')!.stems[0]!
      expect(stem.clip.loopEnd).toBe(93657 / 48000)
      expect(Math.abs(1200 * Math.log2(stem.rate))).toBeLessThan(1)
      program.release()
      expect(backend.memory().pinned).toBe(0)
    } finally {
      await app.dispose()
    }
  })

  it('rejects larger decoder truncation and authored markers beyond the source', async () => {
    for (const [samples, end] of [
      [93656, 23415],
      [93660, 23416],
    ] as const) {
      const { app, backend, definition } = await fixture(samples, end)
      try {
        await expect(prepareMusic(app.world, definition)).rejects.toMatchObject({
          code: 'audio/music-invalid',
        })
        expect(backend.memory().pinned).toBe(0)
      } finally {
        await app.dispose()
      }
    }
  })
})
