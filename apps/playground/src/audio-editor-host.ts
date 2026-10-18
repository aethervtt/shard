import type {
  AudioAssetCatalog,
  AudioAssetEntry,
  AudioDocument,
  AudioDocumentStore,
} from '@aethervtt/shard-audio-editor/model'
import { type JsonObject, type JsonValue, ShardError } from '@aethervtt/shard-core'

const sources = import.meta.glob('../../../examples/audio-lab/data/audio/*.json', {
  eager: true,
  import: 'default',
})
const media = import.meta.glob('../../../examples/audio-lab/assets/**/*.wav', {
  eager: true,
  query: '?url',
  import: 'default',
})
const types: Record<string, string> = {
  'audio-event': 'audio/AudioEvent',
  'audio-mixer': 'audio/AudioMixer',
  'audio-music': 'audio/MusicProgram',
  'audio-parameters': 'audio/AudioParameters',
  'audio-snapshot': 'audio/AudioSnapshot',
  'audio-collection': 'audio/AudioCollection',
}
const documentNames: Record<string, string> = {
  engine: 'Engine',
  footstep: 'Footsteps',
  spell: 'Layered spell',
  main: 'Tavern mixer',
  score: 'Explore and combat',
  globals: 'World parameters',
  kit: 'Prepared audio collection',
  underwater: 'Underwater',
  dialogue: 'Dialogue focus',
  pause: 'Paused world',
}
const pathOf = (key: string) => key.split('examples/audio-lab/')[1]!
const identity = (path: string) => `world:audio:${path.replace(/[^a-zA-Z0-9]/g, '-')}`
function references(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(references)
  if (value && typeof value === 'object') {
    if (typeof value.path === 'string') return { guid: identity(value.path) }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, references(item)]))
  }
  return value
}

/** A website-owned catalog and revisioned document store; all media delivery is host-private. */
export function createDemoAudioHost(scope: string) {
  const records = new Map<string, AudioDocument>()
  const urls = new Map<string, string>()
  const entries = new Map<string, AudioAssetEntry>()
  const listeners = new Set<(ids: readonly string[]) => void>()
  let writes = 0
  for (const [key, value] of Object.entries(sources)) {
    const path = pathOf(key),
      filename = path.split('/').pop()!,
      id = identity(path)
    const type = types[filename.split('.')[1]!]!
    const name = documentNames[filename.split('.')[0]!] ?? filename
    const document = {
      id,
      name,
      type,
      revision: '1',
      value: references(value as JsonValue) as JsonObject,
    }
    records.set(id, document)
    entries.set(id, { id, name, type, revision: '1' })
  }
  for (const [key, url] of Object.entries(media)) {
    const path = pathOf(key),
      id = identity(path)
    urls.set(id, String(url))
    entries.set(id, { id, name: path.split('/').pop()!, type: 'AudioClip', revision: '1' })
  }
  const documents: AudioDocumentStore = {
    scope,
    atomic: true,
    async read(id, signal) {
      signal?.throwIfAborted()
      const document = records.get(id)
      if (!document)
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'This world has no such audio document',
          { path: id },
        )
      return structuredClone(document)
    },
    async commit(changes, signal) {
      signal?.throwIfAborted()
      for (const change of changes) {
        if ((records.get(change.document.id)?.revision ?? null) !== change.expectedRevision)
          throw new ShardError('audio-editor/conflict', 'Another editor saved this document', {
            path: change.document.id,
          })
      }
      const saved = changes.map(({ document }) => ({
        ...structuredClone(document),
        revision: String(Number(records.get(document.id)?.revision ?? 0) + 1),
      }))
      for (const document of saved) {
        records.set(document.id, document)
        entries.set(document.id, {
          id: document.id,
          name: document.name,
          type: document.type,
          revision: document.revision,
        })
        writes++
      }
      queueMicrotask(() => {
        for (const listener of listeners) listener(saved.map((document) => document.id))
      })
      return structuredClone(saved)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const assets: AudioAssetCatalog = {
    scope,
    async list(query) {
      query.signal?.throwIfAborted()
      const items = [...entries.values()].filter(
        (entry) =>
          (!query.type || entry.type === query.type) &&
          (!query.search || entry.name.toLowerCase().includes(query.search.toLowerCase())),
      )
      const offset = Number(query.cursor ?? 0),
        limit = Math.min(100, query.limit ?? 50)
      return {
        items: structuredClone(items.slice(offset, offset + limit)),
        total: items.length,
        ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}),
      }
    },
    async get(id, signal) {
      signal?.throwIfAborted()
      const entry = entries.get(id)
      if (!entry)
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'This world has no such audio asset',
          { path: id },
        )
      return { ...entry }
    },
    async resolve(id, signal) {
      const url = urls.get(id)
      if (!url)
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'This world denied the audio reference',
          { path: id },
        )
      const response = await fetch(url, { signal })
      if (!response.ok)
        throw new ShardError('audio-editor/asset-unavailable', 'The world audio download failed', {
          path: id,
        })
      return { bytes: new Uint8Array(await response.arrayBuffer()), mime: 'audio/wav' }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return { documents, assets, records, writes: () => writes, listeners: () => listeners.size }
}
