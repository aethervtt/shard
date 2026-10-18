import type { ComponentDef, JsonObject, JsonValue, ShardError } from '@aethervtt/shard-core'

/** IDs and revisions are opaque host values. They are never interpreted as URLs or paths. */
export interface AudioDocument {
  id: string
  name: string
  type: string
  revision: string
  schemaVersion?: number
  value: JsonObject
  sourceText?: string
}
export interface AudioDocumentChange {
  document: AudioDocument
  expectedRevision: string | null
}
export interface AudioDocumentStore {
  readonly scope: string
  readonly atomic?: boolean
  read(id: string, signal?: AbortSignal): Promise<AudioDocument>
  commit?(changes: readonly AudioDocumentChange[], signal?: AbortSignal): Promise<AudioDocument[]>
  subscribe?(listener: (ids: readonly string[]) => void): () => void
}
export interface AudioAssetEntry {
  id: string
  name: string
  type: string
  revision: string
  duration?: number
  sampleRate?: number
  channels?: number
  bytes?: number
}
export interface AudioAssetQuery {
  search?: string
  type?: string
  cursor?: string
  limit?: number
  signal?: AbortSignal
}
export interface AudioAssetPage {
  items: AudioAssetEntry[]
  nextCursor?: string
  total?: number
}
export interface AudioAssetContent {
  bytes?: Uint8Array
  url?: string
  mime?: string
  /** Host-authorized import settings; identity remains the catalog ID. */
  settings?: {
    mode?: 'decoded' | 'stream'
    normalize?: boolean
    loopStart?: number
    loopEnd?: number
  }
  release?(): void
}
export interface AudioAssetCatalog {
  readonly scope: string
  list(query: AudioAssetQuery): Promise<AudioAssetPage>
  get(id: string, signal?: AbortSignal): Promise<AudioAssetEntry>
  resolve(id: string, signal?: AbortSignal): Promise<AudioAssetContent>
  pick?(type: string, signal?: AbortSignal): Promise<string | undefined>
  subscribe?(listener: (ids: readonly string[]) => void): () => void
}
export interface AudioWaveform {
  peaks: Float32Array
  duration: number
  sampleRate: number
}
export interface AudioPreviewAdapter {
  readonly mode: 'audition' | 'attached'
  readonly target?: string
  readonly capabilities: Readonly<Record<string, boolean>>
  play(document: AudioDocument, signal?: AbortSignal): Promise<unknown>
  stop(): void | Promise<void>
  inspect(): unknown | Promise<unknown>
  command?(name: string, params: Record<string, unknown>): unknown | Promise<unknown>
  waveform?(id: string, bins: number, signal?: AbortSignal): Promise<AudioWaveform>
  export?(document: AudioDocument, plan: JsonObject, signal?: AbortSignal): Promise<unknown>
  dispose(): void | Promise<void>
}
export interface AudioEditorState {
  document?: AudioDocument
  /** Resolved inherited values plus schema defaults, for display only. */
  effective?: JsonObject
  schema?: ComponentDef
  dirty: boolean
  readOnly: boolean
  loading: boolean
  saving: boolean
  conflict?: AudioDocument
  diagnostics: ShardError[]
  canUndo: boolean
  canRedo: boolean
  historyEvicted: number
  previewState: 'idle' | 'preparing' | 'playing' | 'failed'
  previewResult?: unknown
}
export interface AudioEditorOptions {
  documents: AudioDocumentStore
  assets: AudioAssetCatalog
  preview?: AudioPreviewAdapter
  historyLimit?: number
  historyBytes?: number
}
export interface AudioEditorEdit {
  path: string
  value?: JsonValue
  remove?: boolean
}
