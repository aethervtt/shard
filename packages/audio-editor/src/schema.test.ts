import { describe, expect, it } from 'vitest'
import { createMemoryAudioHost } from './memory'
import { createAudioEditorSession } from './model'
import { getAudioEditorSchema, validateAudioDocument } from './schema'
import type { AudioDocument } from './types'

const doc = (type: string, value: AudioDocument['value'], id = type): AudioDocument => ({
  id,
  name: id,
  type,
  revision: '1',
  value,
})
const parameters = doc('audio/AudioParameters', {
  parameters: [{ name: 'intensity', kind: 'continuous', min: 0, max: 1 }],
})
const event = doc('audio/AudioEvent', {
  globals: { guid: parameters.id },
  layers: [{ id: 'body', choices: [{ clip: { guid: 'clip' } }] }],
})
const mixer = doc('audio/AudioMixer', {
  buses: [
    { id: 'master', parent: '' },
    { id: 'music', parent: 'master' },
  ],
})
const snapshot = doc('audio/AudioSnapshot', { targets: [{ bus: 'music', value: -6 }] })
const collection = doc('audio/AudioCollection', {
  events: [{ guid: event.id }],
  clips: [{ guid: 'clip' }],
})
const music = doc('audio/MusicProgram', {
  entry: 'intro',
  sections: [
    { id: 'intro', bars: 1, stems: [{ id: 'stem', clip: { guid: 'clip' }, endSample: 96000 }] },
  ],
})
function host() {
  return createMemoryAudioHost({
    documents: [parameters, event, mixer, snapshot, collection, music],
    assets: [
      {
        id: 'clip',
        name: 'Sound',
        type: 'AudioClip',
        revision: '1',
        content: { bytes: new Uint8Array() },
      },
    ],
  })
}

describe('schema-backed authoring', () => {
  for (const document of [parameters, event, mixer, snapshot, collection, music]) {
    it(`round-trips ${document.type} with the runtime schema and preserves its source`, async () => {
      const fixture = host()
      const session = createAudioEditorSession(fixture)
      await session.open(document.id)
      const errors = await session.validate()
      expect(errors.map((error) => error.message)).toEqual([])
      const schema = getAudioEditorSchema(document.type)!
      expect(schema.deserialize(session.state.effective)).toEqual(
        schema.deserialize(document.value),
      )
      session.edit({ path: '/hostLabel', value: 'edited' })
      await session.save()
      session.undo()
      expect(session.state.document?.value).toEqual(document.value)
      expect(session.state.dirty).toBe(true)
      session.redo()
      expect(session.state.dirty).toBe(false)
      await session.dispose()
    })
  }
  it('reports inheritance cycles and mismatched asset types at their field paths', async () => {
    const fixture = host()
    const wrong = structuredClone(event)
    wrong.value.layers = [{ id: 'bad', choices: [{ clip: { guid: parameters.id } }] }]
    const result = await validateAudioDocument(wrong, fixture.documents, fixture.assets)
    expect(result.errors).toMatchObject([
      { code: 'audio-editor/invalid-document', path: '/layers/0/choices/0/clip' },
    ])
    const cycle = { ...event, value: { $extends: event.id } }
    const docs = { ...fixture.documents, read: async () => cycle }
    expect((await validateAudioDocument(cycle, docs, fixture.assets)).errors).toMatchObject([
      { path: '/$extends' },
    ])
  })
  it('renames a global bank and selected dependent curves in one revisioned transaction', async () => {
    const fixture = host()
    const dependent = structuredClone(event)
    dependent.value.layers = [
      {
        id: 'body',
        choices: [{ clip: { guid: 'clip' } }],
        curves: [
          {
            parameter: 'intensity',
            target: 'gainDb',
            points: [
              [0, -20],
              [1, 0],
            ],
          },
        ],
      },
    ]
    await fixture.documents.commit!([{ document: dependent, expectedRevision: '1' }])
    const session = createAudioEditorSession(fixture)
    await session.open(parameters.id)
    await session.renameParameter('intensity', 'power', [event.id])
    expect((await fixture.documents.read(parameters.id)).value.parameters).toMatchObject([
      { name: 'power' },
    ])
    expect((await fixture.documents.read(event.id)).value.layers).toMatchObject([
      { curves: [{ parameter: 'power' }] },
    ])
    expect(session.state.dirty).toBe(false)
    await session.dispose()
  })
})
