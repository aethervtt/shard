import { audioClip } from '@aethervtt/shard-audio'
import { type JsonObject, ShardError } from '@aethervtt/shard-core'
import type { Platform } from '@aethervtt/shard-platform'
import { loadProject } from '@aethervtt/shard-project/manifest'
import type { AudioAssetCatalog, AudioAssetEntry, AudioDocument, AudioDocumentStore } from './types'

const types: Record<string, string> = {
  'audio-event': 'audio/AudioEvent',
  'audio-mixer': 'audio/AudioMixer',
  'audio-music': 'audio/MusicProgram',
  'audio-parameters': 'audio/AudioParameters',
  'audio-snapshot': 'audio/AudioSnapshot',
  'audio-collection': 'audio/AudioCollection',
}

function revision(text: string): string {
  // Full source is an exact, collision-free revision token; it is host-private, not serialized.
  return text
}

/**
 * A project-file host. It uses the project's manifest and audio import probe, never a DOM picker.
 * Commits serialize within this adapter and preflight source revisions. PlatformFileSystem has no
 * cross-process CAS primitive: concurrent external writers must be coordinated by the host.
 * Multi-document atomic commits are explicitly unsupported.
 */
export async function openAudioProject(platform: Platform, scope = 'project') {
  const { manifest } = await loadProject(platform)
  const fs = platform.fs
  if (!fs.list)
    throw new ShardError(
      'audio-editor/unsupported-capability',
      'This host cannot list project assets',
    )
  const paths = new Map<string, { path: string; type: string; name: string }>()
  const aliases = new Map<string, string>()
  const listeners = new Set<(ids: readonly string[]) => void>()
  let disposed = false
  const check = (signal?: AbortSignal) => {
    if (disposed) throw new ShardError('audio-editor/disposed', 'The project adapter is closed')
    signal?.throwIfAborted()
  }
  const scan = async (dir: string) => {
    for (const entry of await fs.list!(dir)) {
      const path = `${dir}/${entry.name}`
      if (entry.kind === 'dir') await scan(path)
      else {
        const suffix = /\.([^.]+)\.json$/.exec(path)?.[1]
        const type = suffix
          ? types[suffix]
          : /\.(wav|ogg|mp3|flac|opus)$/i.test(path)
            ? 'AudioClip'
            : undefined
        if (!type) continue
        let id = path
        if (await fs.exists(`${path}.meta`)) {
          const meta = JSON.parse(await fs.readText(`${path}.meta`)) as { guid?: string }
          if (meta.guid) id = meta.guid
        }
        paths.set(id, { path, type, name: entry.name })
        aliases.set(path, id)
      }
    }
  }
  for (const root of manifest.assetRoots) await scan(root)
  const lookup = (id: string) => {
    const item = paths.get(id) ?? paths.get(aliases.get(id) ?? '')
    if (!item)
      throw new ShardError('audio-editor/asset-unavailable', `Unknown project audio asset: ${id}`, {
        path: id,
        hint: 'Import it into a project asset root first.',
      })
    return item
  }
  const read = async (id: string, signal?: AbortSignal): Promise<AudioDocument> => {
    check(signal)
    const item = lookup(id)
    if (item.type === 'AudioClip')
      throw new ShardError(
        'audio-editor/invalid-document',
        'A clip is not an authored audio document',
        { path: id },
      )
    const text = await fs.readText(item.path)
    check(signal)
    return {
      id,
      name: item.name,
      type: item.type,
      revision: revision(text),
      value: JSON.parse(text) as JsonObject,
      sourceText: text,
    }
  }
  let pending = Promise.resolve()
  const documents: AudioDocumentStore = {
    scope,
    atomic: false,
    read,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    ...(fs.writable
      ? {
          commit(
            changes: Parameters<NonNullable<AudioDocumentStore['commit']>>[0],
            signal?: AbortSignal,
          ) {
            const operation = pending.then(async () => {
              check(signal)
              if (changes.length !== 1)
                throw new ShardError(
                  'audio-editor/unsupported-capability',
                  'Project files do not support atomic multi-document commits',
                )
              const change = changes[0]!
              if (change.expectedRevision === null) {
                if (paths.has(change.document.id) || aliases.has(change.document.id))
                  throw new ShardError('audio-editor/conflict', 'This document ID already exists')
                const extension = Object.entries(types).find(
                  ([, type]) => type === change.document.type,
                )?.[0]
                if (!extension)
                  throw new ShardError(
                    'audio-editor/unsupported-schema',
                    'This type is not an audio source document',
                  )
                if (!fs.remove)
                  throw new ShardError(
                    'audio-editor/unsupported-capability',
                    'Creating project sources requires rollback-capable file access',
                  )
                let directory: string | undefined
                for (const root of manifest.assetRoots) {
                  if (await fs.exists(root)) {
                    directory = root
                    break
                  }
                }
                if (!directory)
                  throw new ShardError(
                    'audio-editor/unsupported-capability',
                    'Create a project asset root before adding audio documents',
                  )
                const stem =
                  change.document.name
                    .replace(/\.(audio-[a-z]+\.)?json$/i, '')
                    .replace(/[^a-zA-Z0-9_-]+/g, '-')
                    .replace(/^-+|-+$/g, '') || 'audio'
                let path = `${directory}/${stem}.${extension}.json`
                let suffix = 1
                while ((await fs.exists(path)) || (await fs.exists(`${path}.meta`)))
                  path = `${directory}/${stem}-${suffix++}.${extension}.json`
                const text = `${JSON.stringify(change.document.value, null, 2)}\n`
                check(signal)
                try {
                  await fs.writeText(
                    `${path}.meta`,
                    `${JSON.stringify({ guid: change.document.id, importer: `data/${extension}`, settings: {} }, null, 2)}\n`,
                  )
                  await fs.writeText(path, text)
                } catch (cause) {
                  await fs.remove(path)
                  await fs.remove(`${path}.meta`)
                  throw cause
                }
                const name = path.slice(directory.length + 1)
                paths.set(change.document.id, { path, type: change.document.type, name })
                aliases.set(path, change.document.id)
                const saved = {
                  ...change.document,
                  name,
                  revision: revision(text),
                  sourceText: text,
                }
                for (const listener of listeners) listener([saved.id])
                return [saved]
              }
              const current = await read(change.document.id, signal)
              if (current.revision !== change.expectedRevision)
                throw new ShardError(
                  'audio-editor/conflict',
                  'The source changed outside this editor',
                  { path: change.document.id, hint: 'Reload the remote version before saving.' },
                )
              if (JSON.stringify(current.value) === JSON.stringify(change.document.value))
                return [current]
              check(signal)
              const text = `${JSON.stringify(change.document.value, null, 2)}\n`
              await fs.writeText(lookup(change.document.id).path, text)
              const saved = { ...change.document, revision: revision(text), sourceText: text }
              for (const listener of listeners) listener([saved.id])
              return [saved]
            })
            pending = operation.then(
              () => {},
              () => {},
            )
            return operation
          },
        }
      : {}),
  }
  const assets: AudioAssetCatalog = {
    scope,
    async list(query) {
      check(query.signal)
      const all = [...paths].filter(
        ([, item]) =>
          (!query.type || item.type === query.type) &&
          (!query.search || item.name.toLowerCase().includes(query.search.toLowerCase())),
      )
      const offset = Number(query.cursor ?? 0),
        limit = Math.min(query.limit ?? 50, 100)
      return {
        items: await Promise.all(
          all.slice(offset, offset + limit).map(([id]) => assets.get(id, query.signal)),
        ),
        total: all.length,
        ...(offset + limit < all.length ? { nextCursor: String(offset + limit) } : {}),
      }
    },
    async get(id, signal): Promise<AudioAssetEntry> {
      check(signal)
      const item = lookup(id)
      // Metadata browsing never reads/decodes audio. Revision tracks host mtime when available.
      const stat = await fs.stat?.(item.path)
      return {
        id,
        name: item.name,
        type: item.type,
        revision: stat ? `${stat.mtime}:${stat.size}` : 'project',
        ...(stat ? { bytes: stat.size } : {}),
      }
    },
    async resolve(id, signal) {
      check(signal)
      const item = lookup(id)
      if (item.type !== 'AudioClip')
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'Only audio clips can resolve playable bytes',
          { path: id },
        )
      const bytes = await fs.readBytes(item.path)
      check(signal)
      audioClip(bytes, { id })
      return { bytes }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  const unwatch = await fs.watch?.('', (event) => {
    const id = aliases.get(event.path)
    if (id) for (const listener of listeners) listener([id])
  })
  return {
    name: manifest.name,
    documents,
    assets,
    dispose() {
      if (disposed) return
      disposed = true
      unwatch?.()
      listeners.clear()
    },
  }
}
