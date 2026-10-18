import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import { expect, it } from 'vitest'
import { type AudioDocument, createAudioEditorSession, createMemoryAudioHost } from './model'

it('audio-editor/edit measures a 16-layer curve edit with schema and catalog validation', async () => {
  const doc: AudioDocument = {
    id: 'event',
    name: 'Sixteen layers',
    revision: '1',
    type: 'audio/AudioEvent',
    value: {
      parameters: [{ name: 'power', kind: 'continuous', min: 0, max: 1, initial: 0 }],
      layers: Array.from({ length: 16 }, (_, i) => ({
        id: `layer-${i}`,
        choices: [{ clip: { guid: 'clip' } }],
        curves: [
          {
            parameter: 'power',
            target: 'gainDb',
            points: [
              [0, -12],
              [1, 0],
            ],
          },
        ],
      })),
    },
  }
  const host = createMemoryAudioHost({
    documents: [doc],
    assets: [
      {
        id: 'clip',
        name: 'Clip',
        type: 'AudioClip',
        revision: '1',
        content: { bytes: new Uint8Array() },
      },
    ],
  })
  const editor = createAudioEditorSession(host)
  await editor.open('event')
  const errors = await editor.validate()
  expect(errors.map((e) => e.message)).toEqual([])
  if (timingMode === 'bench') {
    const times: number[] = []
    for (let i = 0; i < 120; i++) {
      const start = performance.now()
      editor.edit({ path: '/layers/0/curves/0/points/0/1', value: -12 + (i % 4) })
      await editor.validate()
      if (i >= 20) times.push(performance.now() - start)
    }
    times.sort((a, b) => a - b)
    console.log(
      JSON.stringify({
        key: 'audio-editor/edit',
        median: times[50],
        p95: times[95],
        samples: times.length,
      }),
    )
    expect(times[50]!).toBeLessThan(budget('audio-editor/edit'))
  }
  await editor.dispose()
})
