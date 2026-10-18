import { AudioPreviewPlan, audioClip, validateAudioPreview } from '@aethervtt/shard-audio'
import {
  type AnyField,
  type AssetRef,
  type Fields,
  type JsonObject,
  ShardError,
} from '@aethervtt/shard-core'
import { type AudioEditorRenderBundle, renderAudioEditorBundle } from './preview-render'
import { getAudioEditorSchema, validateAudioDocument } from './schema'
import type { AudioAssetCatalog, AudioDocument, AudioDocumentStore } from './types'

/** Resolves the existing render-plan format exclusively through the host catalog. */
export async function exportAudioEditorPreview(
  host: { assets: AudioAssetCatalog; documents: AudioDocumentStore },
  document: AudioDocument,
  overrides: JsonObject,
  signal?: AbortSignal,
) {
  const assets: AudioEditorRenderBundle['assets'] = []
  const revisions: { id: string; scope: string; revision: string; type: string }[] = []
  const resolved = new Map<string, AssetRef>()
  const pending = new Set<string>()
  const scope = host.assets.scope
  const docsScope = host.documents.scope
  let serial = 0
  const check = () => {
    if (signal?.aborted)
      throw new ShardError('audio-editor/disposed', 'Preview export was cancelled')
    if (scope !== host.assets.scope || docsScope !== host.documents.scope)
      throw new ShardError('audio-editor/asset-unavailable', 'Host scope changed during export')
  }
  async function resolve(id: string, type: string): Promise<AssetRef> {
    check()
    const key = JSON.stringify([type, id])
    const existing = resolved.get(key)
    if (existing) return existing
    if (pending.has(key))
      throw new ShardError('audio-editor/invalid-document', 'Export dependency cycle', { path: id })
    pending.add(key)
    const number = ++serial
    const guid = `editor-preview:${number}`
    const path = `editor-preview/${number}`
    const ref: AssetRef = { type, guid, path }
    let value: unknown
    if (type === 'AudioClip') {
      const entry = await host.assets.get(id, signal)
      if (entry.type !== type)
        throw new ShardError(
          'audio-editor/asset-unavailable',
          'Export reference is not an audio clip',
          { path: id },
        )
      const content = await host.assets.resolve(id, signal)
      try {
        check()
        if (!content.bytes)
          throw new ShardError(
            'audio-editor/unsupported-capability',
            'Offline export requires authorized encoded bytes',
            { path: id },
          )
        value = audioClip(Uint8Array.from(content.bytes), {
          id: JSON.stringify([scope, id, entry.revision]),
        })
        revisions.push({ id, scope, revision: entry.revision, type })
      } finally {
        content.release?.()
      }
    } else {
      const source = id === document.id ? document : await host.documents.read(id, signal)
      if (source.type !== type)
        throw new ShardError('audio-editor/invalid-document', `Expected ${type} document`, {
          path: id,
        })
      const checked = await validateAudioDocument(source, host.documents, host.assets, signal)
      if (checked.errors.length) throw checked.errors[0]
      const schema = getAudioEditorSchema(source.type)!
      value = await fields(schema.fields, schema.deserialize(checked.effective!.value))
      revisions.push({ id, scope: docsScope, revision: source.revision, type })
    }
    check()
    assets.push({ guid, path, type, value })
    resolved.set(key, ref)
    pending.delete(key)
    return ref
  }
  async function field(definition: AnyField, value: unknown): Promise<unknown> {
    if (definition.kind === 'handle' && value) {
      const ref = value as AssetRef
      const id = ref.guid ?? ref.path
      if (!id)
        throw new ShardError('audio-editor/asset-unavailable', 'Export reference has no host ID')
      return resolve(id, definition.assetType!)
    }
    if (definition.kind === 'list' && Array.isArray(value)) {
      const items: unknown[] = []
      for (const item of value) items.push(await field(definition.item!, item))
      return items
    }
    if (definition.kind === 'struct')
      return fields(definition.fields!, value as Record<string, unknown>)
    return value
  }
  async function fields(definitions: Fields, values: Record<string, unknown>) {
    const result = { ...values }
    for (const [name, definition] of Object.entries(definitions))
      result[name] = await field(definition, result[name])
    return result
  }
  const root = { guid: document.id }
  const defaults: JsonObject = {
    duration: 3,
    ...(document.type === 'audio/AudioEvent'
      ? { events: [{ id: 'audition', asset: root, at: 0 }] }
      : {}),
    ...(document.type === 'audio/MusicProgram'
      ? { music: [{ id: 'audition', asset: root, at: 0 }] }
      : {}),
    ...(document.type === 'audio/AudioMixer' ? { mixer: root } : {}),
  }
  const raw = { ...defaults, ...overrides }
  const errors = AudioPreviewPlan.validate(raw)
  if (errors.length) throw errors[0]
  const plan = AudioPreviewPlan.deserialize(raw)
  validateAudioPreview(plan)
  const resolvedPlan = (await fields(AudioPreviewPlan.fields, plan)) as unknown as typeof plan
  check()
  const result = await renderAudioEditorBundle(
    { plan: AudioPreviewPlan.serialize(resolvedPlan) as unknown as typeof plan, assets },
    { signal },
  )
  check()
  return {
    ...result,
    seed: plan.seed,
    assets: revisions,
    plan: AudioPreviewPlan.serialize(plan),
    document: { id: document.id, revision: document.revision, type: document.type },
  }
}
