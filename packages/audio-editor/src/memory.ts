import { clone, editorError } from './schema'
import type {
  AudioAssetCatalog,
  AudioAssetContent,
  AudioAssetEntry,
  AudioDocument,
  AudioDocumentStore,
} from './types'

/** Reference adapter for static hosts. No filesystem, fetch fallback or ambient browser storage. */
export function createMemoryAudioHost(
  options: {
    scope?: string
    documents?: readonly AudioDocument[]
    assets?: readonly (AudioAssetEntry & { content: AudioAssetContent })[]
    readOnly?: boolean
  } = {},
): { documents: AudioDocumentStore; assets: AudioAssetCatalog } {
  const scope = options.scope ?? 'memory'
  const records = new Map(options.documents?.map((doc) => [doc.id, clone(doc)]))
  const clips = new Map(options.assets?.map((asset) => [asset.id, asset]))
  const listeners = new Set<(ids: readonly string[]) => void>()
  let revision = 0
  const documents: AudioDocumentStore = {
    scope,
    atomic: true,
    async read(id, signal) {
      signal?.throwIfAborted()
      const doc = records.get(id)
      if (!doc) throw editorError('asset-unavailable', `Document ${id} is unavailable.`)
      return clone(doc)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    ...(options.readOnly
      ? {}
      : ({
          async commit(changes, signal) {
            signal?.throwIfAborted()
            const ids = new Set<string>()
            for (const change of changes) {
              if (ids.has(change.document.id))
                throw editorError('conflict', 'A batch repeats the same document.')
              ids.add(change.document.id)
              const current = records.get(change.document.id)
              if ((current?.revision ?? null) !== change.expectedRevision)
                throw editorError(
                  'conflict',
                  `Document ${change.document.id} changed since it was opened.`,
                )
            }
            const saved = changes.map((change) => ({
              ...clone(change.document),
              revision: `memory:${++revision}`,
            }))
            for (const doc of saved) records.set(doc.id, doc)
            for (const listener of listeners) listener([...ids])
            return clone(saved)
          },
        } satisfies Partial<AudioDocumentStore>)),
  }
  const assets: AudioAssetCatalog = {
    scope,
    async list(query) {
      query.signal?.throwIfAborted()
      const all: AudioAssetEntry[] = [...records.values()].map(({ id, name, type, revision }) => ({
        id,
        name,
        type,
        revision,
      }))
      for (const { content: _, ...entry } of clips.values()) all.push(entry)
      const filtered = all.filter(
        (entry) =>
          (!query.type || entry.type === query.type) &&
          (!query.search || entry.name.toLowerCase().includes(query.search.toLowerCase())),
      )
      const offset = Math.max(0, Number(query.cursor) || 0)
      const limit = Math.max(1, Math.min(100, query.limit ?? 50))
      return {
        items: clone(filtered.slice(offset, offset + limit)),
        total: filtered.length,
        nextCursor: offset + limit < filtered.length ? String(offset + limit) : undefined,
      }
    },
    async get(id, signal) {
      signal?.throwIfAborted()
      const clip = clips.get(id)
      if (clip) {
        const { content: _, ...entry } = clip
        return clone(entry)
      }
      const doc = await documents.read(id, signal)
      return { id: doc.id, name: doc.name, type: doc.type, revision: doc.revision }
    },
    async resolve(id, signal) {
      signal?.throwIfAborted()
      const entry = clips.get(id)
      if (!entry) throw editorError('asset-unavailable', `Audio asset ${id} is unavailable.`)
      return { ...entry.content, bytes: entry.content.bytes?.slice() }
    },
    subscribe: documents.subscribe,
  }
  return { documents, assets }
}
