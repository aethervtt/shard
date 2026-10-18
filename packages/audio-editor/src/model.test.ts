import { describe, expect, it } from 'vitest'
import {
  type AudioDocument,
  type AudioDocumentStore,
  createAudioEditorSession,
  createMemoryAudioHost,
} from './model'

const mixer = (id = 'opaque:1'): AudioDocument => ({
  id,
  name: 'Tavern',
  type: 'audio/AudioMixer',
  revision: 'r1',
  value: {
    buses: [
      { id: 'master', parent: '', gainDb: 0 },
      { id: 'ambience', parent: 'master', gainDb: -6 },
    ],
  },
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('audio editor document sessions', () => {
  it('imports without a DOM and edits, validates, saves and reopens opaque IDs', async () => {
    expect(typeof document).toBe('undefined')
    const host = createMemoryAudioHost({ documents: [mixer()] })
    const editor = createAudioEditorSession(host)
    await editor.open('opaque:1')
    expect(editor.state.diagnostics).toEqual([])
    editor.edit({ path: '/buses/1/gainDb', value: -12 })
    expect(editor.state.dirty).toBe(true)
    expect(await editor.validate()).toEqual([])
    await editor.save()
    expect(editor.state.dirty).toBe(false)
    const reopened = createAudioEditorSession(host)
    await reopened.open('opaque:1')
    expect(reopened.state.effective?.buses).toMatchObject([{ gainDb: 0 }, { gainDb: -12 }])
    await editor.dispose()
    await reopened.dispose()
  })

  it('no-op saves do not write or normalize source; unknown fields survive edits', async () => {
    const doc = mixer()
    doc.value.hostMetadata = { owner: 'alice' }
    doc.sourceText = 'original source bytes\n'
    const host = createMemoryAudioHost({ documents: [doc] })
    let writes = 0
    const commit = host.documents.commit!
    host.documents.commit = async (...args) => {
      writes++
      return commit(...args)
    }
    const editor = createAudioEditorSession(host)
    await editor.open(doc.id)
    await editor.save()
    expect(writes).toBe(0)
    expect(editor.state.document?.sourceText).toBe(doc.sourceText)
    editor.edit({ path: '/buses/0/gainDb', value: -2 })
    await editor.save()
    expect(writes).toBe(1)
    expect((await host.documents.read(doc.id)).value.hostMetadata).toEqual({ owner: 'alice' })
    await editor.dispose()
  })

  it('preserves inheritance, shows defaults and resets a local override', async () => {
    const parent = mixer('parent')
    const child = { ...mixer('child'), value: { $extends: 'parent' } }
    const host = createMemoryAudioHost({ documents: [parent, child] })
    const editor = createAudioEditorSession(host)
    await editor.open(child.id)
    expect(editor.state.effective?.buses).toHaveLength(2)
    editor.edit({ path: '/buses/1/gainDb', value: -9 })
    await editor.save()
    expect((await host.documents.read(child.id)).value.$extends).toBe('parent')
    editor.edit({ path: '/buses', remove: true })
    await editor.validate()
    expect(editor.state.effective?.buses).toMatchObject([{}, { gainDb: -6 }])
    await editor.dispose()
  })

  it('rejects malformed inherited edits without changing the draft or history', async () => {
    const parent = mixer('parent')
    const child = { ...mixer('child'), value: { $extends: 'parent' } }
    const editor = createAudioEditorSession(createMemoryAudioHost({ documents: [parent, child] }))
    await editor.open(child.id)
    expect(() => editor.edit({ path: '/buses/invalid', value: {} })).toThrow('Invalid array index')
    expect(editor.state.document?.value).toEqual(child.value)
    expect(editor.state.dirty).toBe(false)
    expect(editor.state.canUndo).toBe(false)
    await editor.dispose()
  })

  it('never reuses a seeded revision when two editors save concurrently', async () => {
    const doc = { ...mixer(), revision: 'memory:1' }
    const host = createMemoryAudioHost({ documents: [doc] })
    const first = createAudioEditorSession(host)
    const second = createAudioEditorSession(host)
    await first.open(doc.id)
    await second.open(doc.id)
    first.edit({ path: '/buses/0/gainDb', value: -1 })
    second.edit({ path: '/buses/0/gainDb', value: -2 })
    await first.save()
    expect(first.state.document?.revision).not.toBe(doc.revision)
    await expect(second.save()).rejects.toThrow()
    expect(second.state.dirty).toBe(true)
    await first.dispose()
    await second.dispose()
  })

  it('groups drag edits, cancels without a history entry and bounds retained history', async () => {
    const host = createMemoryAudioHost({ documents: [mixer()] })
    const editor = createAudioEditorSession({ ...host, historyLimit: 2 })
    await editor.open('opaque:1')
    editor.beginTransaction()
    for (let i = 1; i < 20; i++) editor.edit({ path: '/buses/0/gainDb', value: -i })
    editor.cancelTransaction()
    expect(editor.state.dirty).toBe(false)
    expect(editor.state.canUndo).toBe(false)
    editor.beginTransaction()
    editor.edit({ path: '/buses/0/gainDb', value: -1 })
    editor.edit({ path: '/buses/0/gainDb', value: -2 })
    editor.endTransaction()
    editor.undo()
    expect(editor.state.dirty).toBe(false)
    editor.redo()
    expect(editor.state.dirty).toBe(true)
    editor.edit({ path: '/buses/0/gainDb', value: -3 })
    editor.edit({ path: '/buses/0/gainDb', value: -4 })
    expect(editor.state.historyEvicted).toBe(1)
    await editor.save()
    editor.undo()
    expect(editor.state.dirty).toBe(true)
    await editor.dispose()
  })

  it('rejects invalid graphs and arbitrary media refs without losing the draft', async () => {
    const host = createMemoryAudioHost({ documents: [mixer()] })
    const editor = createAudioEditorSession(host)
    await editor.open('opaque:1')
    editor.edit({ path: '/buses/1/parent', value: 'ambience' })
    await expect(editor.save()).rejects.toMatchObject({ code: 'audio/mixer-cycle' })
    expect(editor.state.dirty).toBe(true)
    editor.undo()
    await editor.create({
      id: 'event',
      name: 'Event',
      type: 'audio/AudioEvent',
      revision: '',
      value: {
        layers: [
          { id: 'main', choices: [{ clip: { guid: 'https://untrusted.test/a.wav' }, weight: 1 }] },
        ],
      },
    })
    const errors = await editor.validate()
    expect(errors.some((e) => e.code === 'audio-editor/asset-unavailable')).toBe(true)
    await expect(editor.save()).rejects.toBeDefined()
    await editor.dispose()
  })

  it('shows concurrent remote edits, preserves local draft, and reloads explicitly', async () => {
    const host = createMemoryAudioHost({ documents: [mixer()] })
    const first = createAudioEditorSession(host)
    const second = createAudioEditorSession(host)
    await first.open('opaque:1')
    await second.open('opaque:1')
    first.edit({ path: '/buses/0/gainDb', value: -4 })
    second.edit({ path: '/buses/0/gainDb', value: -8 })
    await second.save()
    await settle()
    expect(first.state.conflict?.value.buses).toMatchObject([{ gainDb: -8 }, {}])
    expect(first.state.document?.value.buses).toMatchObject([{ gainDb: -4 }, {}])
    await expect(first.save()).rejects.toMatchObject({ code: 'audio-editor/conflict' })
    await first.reload()
    expect(first.state.dirty).toBe(false)
    expect(first.state.conflict).toBeUndefined()
    await first.dispose()
    await second.dispose()
  })

  it('keeps edits made while save is awaiting host acknowledgement dirty', async () => {
    const host = createMemoryAudioHost({ documents: [mixer()] })
    const commit = host.documents.commit!
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.documents.commit = async (...args) => {
      await held
      return commit(...args)
    }
    const editor = createAudioEditorSession(host)
    await editor.open('opaque:1')
    editor.edit({ path: '/buses/0/gainDb', value: -3 })
    const save = editor.save()
    editor.edit({ path: '/buses/0/gainDb', value: -6 })
    release()
    await save
    expect(editor.state.dirty).toBe(true)
    expect((await host.documents.read('opaque:1')).value.buses).toMatchObject([{ gainDb: -3 }, {}])
    await editor.dispose()
  })

  it('does not allow a late read to replace a newer selection or disposed session', async () => {
    const host = createMemoryAudioHost({ documents: [mixer('one'), mixer('two')] })
    const read = host.documents.read
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    host.documents.read = async (id) => {
      if (id === 'one') await held
      return read(id)
    }
    const editor = createAudioEditorSession(host)
    const old = editor.open('one')
    await editor.open('two')
    release()
    await old
    expect(editor.state.document?.id).toBe('two')
    await editor.dispose()
    await expect(editor.open('one')).rejects.toMatchObject({ code: 'audio-editor/disposed' })
  })

  it('opens future schemas read-only and supports hosts without commit capability', async () => {
    for (const host of [
      createMemoryAudioHost({ documents: [{ ...mixer(), schemaVersion: 999 }] }),
      createMemoryAudioHost({ documents: [mixer()], readOnly: true }),
    ]) {
      const editor = createAudioEditorSession(host)
      await editor.open('opaque:1')
      expect(editor.state.readOnly).toBe(true)
      expect(() => editor.edit({ path: '/buses', value: [] })).toThrow()
      await editor.dispose()
    }
  })

  it('validates all batch members before any write, refuses non-atomic hosts and detects stale revisions', async () => {
    const host = createMemoryAudioHost({ documents: [mixer('a'), mixer('b')] })
    const editor = createAudioEditorSession(host)
    const changes = [mixer('a'), mixer('b')].map((document) => ({
      document,
      expectedRevision: 'r1',
    }))
    changes[1]!.document.value.buses = []
    await expect(editor.commitDocuments(changes)).rejects.toBeDefined()
    expect((await host.documents.read('a')).revision).toBe('r1')
    changes[1]!.document = mixer('b')
    changes[1]!.expectedRevision = 'stale'
    await expect(editor.commitDocuments(changes)).rejects.toMatchObject({
      code: 'audio-editor/conflict',
    })
    expect((await host.documents.read('a')).revision).toBe('r1')
    const nonAtomic: AudioDocumentStore = { ...host.documents, atomic: false }
    const restricted = createAudioEditorSession({ ...host, documents: nonAtomic })
    await expect(restricted.commitDocuments(changes)).rejects.toMatchObject({
      code: 'audio-editor/unsupported-capability',
    })
    await editor.dispose()
    await restricted.dispose()
  })
})
