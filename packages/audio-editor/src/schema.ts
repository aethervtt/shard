import type { DataType } from '@aethervtt/shard-assets'
import {
  AudioCollection,
  AudioEvent,
  AudioMixer,
  AudioParameters,
  AudioSnapshot,
  MusicProgram,
} from '@aethervtt/shard-audio'
import {
  type AnyField,
  type Fields,
  type JsonObject,
  type JsonValue,
  ShardError,
} from '@aethervtt/shard-core'
import type { AudioAssetCatalog, AudioDocument, AudioDocumentStore } from './types'

export const audioEditorTypes: readonly DataType[] = [
  AudioEvent,
  AudioParameters,
  AudioCollection,
  AudioMixer,
  AudioSnapshot,
  MusicProgram,
]
export function getAudioEditorSchema(type: string): DataType | undefined {
  return audioEditorTypes.find((schema) => schema.name === type)
}
export function editorError(
  code: string,
  message: string,
  path?: string,
  cause?: unknown,
): ShardError {
  return new ShardError(`audio-editor/${code}`, message, {
    path,
    cause,
    hint: 'Check the selected document and host capabilities, then try again.',
  })
}
export function asEditorError(error: unknown): ShardError {
  return error instanceof ShardError
    ? error
    : editorError('invalid-document', String(error), undefined, error)
}
export function clone<T>(value: T): T {
  return structuredClone(value)
}
export function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
export function merge(base: JsonObject, overrides: JsonObject): JsonObject {
  const out = clone(base)
  for (const key of Object.keys(overrides)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
    const value = overrides[key]!
    const previous = out[key]
    out[key] =
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      previous &&
      typeof previous === 'object' &&
      !Array.isArray(previous)
        ? merge(previous, value)
        : clone(value)
  }
  return out
}
export function knownFields(fields: Fields, value: JsonObject): JsonObject {
  const out: JsonObject = {}
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(value, key)) out[key] = knownField(fields[key]!, value[key]!)
  }
  return out
}
function knownField(field: AnyField, value: JsonValue): JsonValue {
  if (
    field.kind === 'struct' &&
    field.fields &&
    value &&
    typeof value === 'object' &&
    !Array.isArray(value)
  )
    return knownFields(field.fields, value)
  if (field.kind === 'list' && field.item && Array.isArray(value))
    return value.map((item) => knownField(field.item!, item))
  return value
}
export interface AudioReference {
  id: string
  type: string
  path: string
}
export function audioDocumentReferences(
  fields: Fields,
  value: JsonObject,
  prefix = '',
): AudioReference[] {
  const refs: AudioReference[] = []
  for (const key of Object.keys(fields))
    collectReference(fields[key]!, value[key], `${prefix}/${key}`, refs)
  return refs
}
function collectReference(
  field: AnyField,
  value: JsonValue | undefined,
  path: string,
  refs: AudioReference[],
) {
  if (!value) return
  if (field.kind === 'handle' && typeof value === 'object' && !Array.isArray(value)) {
    const id = value.guid ?? value.path
    if (typeof id === 'string') refs.push({ id, type: field.assetType!, path })
  } else if (
    field.kind === 'struct' &&
    field.fields &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    refs.push(...audioDocumentReferences(field.fields, value, path))
  } else if (field.kind === 'list' && field.item && Array.isArray(value)) {
    value.forEach((item, index) => {
      collectReference(field.item!, item, `${path}/${index}`, refs)
    })
  }
}
export async function materializeAudioDocument(
  document: AudioDocument,
  documents: AudioDocumentStore,
  signal?: AbortSignal,
  chain: string[] = [],
): Promise<AudioDocument> {
  if (chain.includes(document.id) || chain.length >= 32)
    throw editorError(
      'invalid-document',
      'Document inheritance contains a cycle or exceeds 32 levels.',
      '/$extends',
    )
  const schema = getAudioEditorSchema(document.type)
  if (!schema || (document.schemaVersion ?? 1) > schema.version)
    throw editorError('unsupported-schema', `Unsupported document schema ${document.type}.`)
  let value = clone(document.value)
  if (value.$extends !== undefined) {
    if (typeof value.$extends !== 'string')
      throw editorError('invalid-document', '$extends must be a host document ID.', '/$extends')
    const parent = await documents.read(value.$extends, signal)
    if (parent.type !== document.type)
      throw editorError('invalid-document', 'Inherited document type does not match.', '/$extends')
    const inherited = await materializeAudioDocument(parent, documents, signal, [
      ...chain,
      document.id,
    ])
    value = merge(inherited.value, value)
    delete value.$extends
  }
  // The schema owns defaults and serialization. Source metadata remains in the authored document.
  const known = knownFields(schema.fields, value)
  const normalized = schema.serialize(schema.deserialize(known))
  return { ...document, value: normalized }
}
export async function validateAudioDocument(
  document: AudioDocument,
  documents: AudioDocumentStore,
  assets: AudioAssetCatalog,
  signal?: AbortSignal,
): Promise<{ effective?: AudioDocument; errors: ShardError[] }> {
  try {
    const effective = await materializeAudioDocument(document, documents, signal)
    const schema = getAudioEditorSchema(document.type)!
    const errors = schema.importer.check?.(effective.value, () => undefined) ?? []
    const references = audioDocumentReferences(schema.fields, effective.value)
    for (const ref of references) {
      try {
        const asset = await assets.get(ref.id, signal)
        if (asset.type !== ref.type)
          errors.push(
            editorError(
              'invalid-document',
              `Expected ${ref.type}, received ${asset.type}.`,
              ref.path,
            ),
          )
      } catch (cause) {
        errors.push(
          editorError(
            'asset-unavailable',
            `The host cannot resolve asset ${ref.id}.`,
            ref.path,
            cause,
          ),
        )
      }
    }
    return { effective, errors }
  } catch (error) {
    return { errors: [asEditorError(error)] }
  }
}
