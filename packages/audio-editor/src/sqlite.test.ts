import { DatabaseSync } from 'node:sqlite'
import { ShardError } from '@aethervtt/shard-core'
import { expect, it } from 'vitest'
import {
  type AudioDocument,
  type AudioDocumentStore,
  createAudioEditorSession,
  createMemoryAudioHost,
} from './model'

it('database host commits opaque document IDs atomically and reloads persisted mixer values', async () => {
  // Mirrors the host boundary, not Aether's production schema or server authorization code.
  const db = new DatabaseSync(':memory:')
  db.exec('CREATE TABLE documents (id TEXT PRIMARY KEY, revision INTEGER, value TEXT)')
  const initial: AudioDocument = {
    id: 'db-42',
    name: 'Tavern',
    type: 'audio/AudioMixer',
    revision: '1',
    value: { buses: [{ id: 'master', parent: '', gainDb: 0 }] },
  }
  db.prepare('INSERT INTO documents VALUES (?, ?, ?)').run(initial.id, 1, JSON.stringify(initial))
  const listeners = new Set<(ids: readonly string[]) => void>()
  const documents: AudioDocumentStore = {
    scope: 'world-7',
    atomic: true,
    async read(id) {
      const row = db.prepare('SELECT revision, value FROM documents WHERE id = ?').get(id) as
        | { revision: number; value: string }
        | undefined
      if (!row) throw new ShardError('audio-editor/asset-unavailable', 'Document does not exist')
      return { ...JSON.parse(row.value), revision: String(row.revision) } as AudioDocument
    },
    async commit(changes) {
      db.exec('BEGIN IMMEDIATE')
      const saved: AudioDocument[] = []
      try {
        for (const { document, expectedRevision } of changes) {
          const revision = String(Number(expectedRevision ?? 0) + 1)
          const next = { ...document, revision }
          const result = db
            .prepare('UPDATE documents SET revision = ?, value = ? WHERE id = ? AND revision = ?')
            .run(Number(revision), JSON.stringify(next), document.id, Number(expectedRevision))
          if (result.changes !== 1)
            throw new ShardError('audio-editor/conflict', 'Document revision changed')
          saved.push(next)
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      for (const listener of listeners) listener(saved.map((doc) => doc.id))
      return saved
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  const { assets } = createMemoryAudioHost()
  const first = createAudioEditorSession({ documents, assets })
  const second = createAudioEditorSession({ documents, assets })
  try {
    await first.open('db-42')
    await second.open('db-42')
    first.edit({ path: '/buses/0/gainDb', value: -12 })
    second.edit({ path: '/buses/0/gainDb', value: -6 })
    await first.save()
    await expect(second.save()).rejects.toMatchObject({ code: 'audio-editor/conflict' })
    await second.reload()
    expect(second.state.document?.value.buses).toEqual([{ id: 'master', parent: '', gainDb: -12 }])
    expect(second.state.document?.revision).toBe('2')
    expect(second.state.dirty).toBe(false)
  } finally {
    await first.dispose()
    await second.dispose()
    db.close()
  }
})
