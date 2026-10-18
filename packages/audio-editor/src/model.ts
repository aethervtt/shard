import type { JsonObject, JsonValue, ShardError } from '@aethervtt/shard-core'
import {
  asEditorError,
  clone,
  editorError,
  equal,
  getAudioEditorSchema,
  knownFields,
  merge,
  validateAudioDocument,
} from './schema'
import type {
  AudioDocument,
  AudioDocumentChange,
  AudioEditorEdit,
  AudioEditorOptions,
  AudioEditorState,
} from './types'

export * from './memory'
export * from './schema'
export * from './types'

interface HistoryEntry {
  before: JsonObject
  after: JsonObject
  bytes: number
}
function segments(path: string): string[] {
  if (!path.startsWith('/') || path === '/')
    throw editorError('invalid-document', 'Use a JSON pointer to a document field.', path)
  const parts = path
    .slice(1)
    .split('/')
    .map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
  if (parts.some((part) => part === '__proto__' || part === 'constructor' || part === 'prototype'))
    throw editorError('invalid-document', 'Unsafe document field.', path)
  return parts
}
/** Editor work is event-driven; allocating history and view snapshots does not enter engine frames. */
export class AudioEditorSession {
  readonly documents: AudioEditorOptions['documents']
  readonly assets: AudioEditorOptions['assets']
  readonly preview: AudioEditorOptions['preview']
  private current: AudioEditorState = {
    dirty: false,
    readOnly: false,
    loading: false,
    saving: false,
    diagnostics: [],
    canUndo: false,
    canRedo: false,
    historyEvicted: 0,
    previewState: 'idle',
  }
  private baseline?: AudioDocument
  private listeners = new Set<(state: AudioEditorState) => void>()
  private history: HistoryEntry[] = []
  private future: HistoryEntry[] = []
  private transaction?: JsonObject
  private readonly limit: number
  private readonly byteLimit: number
  private disposed = false
  private generation = 0
  private validationGeneration = 0
  private validationAbort?: AbortController
  private readAbort?: AbortController
  private previewAbort?: AbortController
  private unsubscribe?: () => void
  private unsubscribeAssets?: () => void

  constructor(options: AudioEditorOptions) {
    this.documents = options.documents
    this.assets = options.assets
    this.preview = options.preview
    this.limit = Math.max(1, options.historyLimit ?? 200)
    this.byteLimit = Math.max(1, options.historyBytes ?? 16 * 1024 * 1024)
    this.unsubscribe = this.documents.subscribe?.((ids) => {
      if (this.disposed || this.current.saving) return
      if (this.current.document && ids.includes(this.current.document.id)) void this.remoteChanged()
      else void this.refresh()
    })
    this.unsubscribeAssets = this.assets.subscribe?.(() => {
      if (!this.disposed) void this.refresh()
    })
  }
  get state(): AudioEditorState {
    return {
      ...this.current,
      document: this.current.document && clone(this.current.document),
      effective: this.current.effective && clone(this.current.effective),
      conflict: this.current.conflict && clone(this.current.conflict),
      diagnostics: [...this.current.diagnostics],
    }
  }
  subscribe(listener: (state: AudioEditorState) => void): () => void {
    this.alive()
    this.listeners.add(listener)
    listener(this.state)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private alive(): void {
    if (this.disposed) throw editorError('disposed', 'This editor session has been disposed.')
  }
  private editable(): AudioDocument {
    this.alive()
    if (this.current.readOnly) throw editorError('read-only', 'This document is read-only.')
    if (!this.current.document) throw editorError('invalid-document', 'Open a document first.')
    return this.current.document
  }
  private emit(): void {
    if (this.disposed) return
    this.current.canUndo = this.history.length > 0
    this.current.canRedo = this.future.length > 0
    this.current.dirty =
      !!this.current.document &&
      (!this.baseline?.revision || !equal(this.current.document.value, this.baseline.value))
    for (const listener of this.listeners) listener(this.state)
  }
  private adopt(document: AudioDocument): void {
    const schema = getAudioEditorSchema(document.type)
    this.baseline = clone(document)
    this.current = {
      ...this.current,
      document: clone(document),
      schema,
      effective: undefined,
      conflict: undefined,
      loading: false,
      diagnostics: [],
      historyEvicted: 0,
      readOnly: !this.documents.commit || !schema || (document.schemaVersion ?? 1) > schema.version,
    }
    this.history = []
    this.future = []
    this.transaction = undefined
  }
  async open(id: string): Promise<void> {
    this.alive()
    if (this.current.saving) throw editorError('conflict', 'Wait for the current save to finish.')
    if (this.current.dirty && this.current.document?.id !== id)
      throw editorError(
        'conflict',
        'Save or discard the current draft before opening another document.',
      )
    if (this.current.dirty && this.current.document?.id === id) return
    this.readAbort?.abort()
    const controller = new AbortController()
    this.readAbort = controller
    const generation = ++this.generation
    this.current.loading = true
    this.emit()
    try {
      const document = await this.documents.read(id, controller.signal)
      if (this.disposed || generation !== this.generation) return
      if (document.id !== id)
        throw editorError('invalid-document', 'The host returned a different document ID.')
      this.adopt(document)
      await this.refresh()
    } catch (error) {
      if (this.disposed || generation !== this.generation) return
      this.current.loading = false
      this.current.diagnostics = [asEditorError(error)]
      this.emit()
      throw error
    }
  }
  async create(document: AudioDocument): Promise<void> {
    this.alive()
    if (this.current.dirty || this.current.saving)
      throw editorError('conflict', 'Save or discard the current draft first.')
    if (!this.documents.commit)
      throw editorError('read-only', 'The host does not support creating documents.')
    ++this.generation
    this.readAbort?.abort()
    this.adopt({ ...document, revision: '' })
    await this.refresh()
  }
  async createNew(type: string, name: string, id = crypto.randomUUID()): Promise<void> {
    const schema = getAudioEditorSchema(type)
    if (!schema) throw editorError('unsupported-schema', `Unknown audio schema ${type}.`)
    await this.create({
      id,
      name,
      type,
      revision: '',
      schemaVersion: schema.version,
      value: schema.serialize(schema.defaults()),
    })
  }
  async duplicate(name: string, id = crypto.randomUUID()): Promise<void> {
    await this.saveAs(id, name)
  }
  edit(edit: AudioEditorEdit): void {
    const doc = this.editable()
    const parts = segments(edit.path)
    const before = clone(doc.value)
    const next = clone(doc.value)
    const top = parts[0]!
    // Editing inside an inherited aggregate creates an explicit override of that aggregate.
    if (parts.length > 1 && next[top] === undefined && this.current.effective?.[top] !== undefined)
      next[top] = clone(this.current.effective[top]!)
    let parent: JsonObject | JsonValue[] = next
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!
      let child: JsonValue | undefined = (parent as JsonObject)[key]
      if (!child || typeof child !== 'object') {
        child = {}
        ;(parent as JsonObject)[key] = child
      }
      parent = child
    }
    const key = parts.at(-1)!
    if (Array.isArray(parent)) {
      const index = key === '-' ? parent.length : Number(key)
      if (!Number.isInteger(index) || index < 0 || index > parent.length)
        throw editorError('invalid-document', 'Invalid array index.', edit.path)
      if (edit.remove) parent.splice(index, 1)
      else if (edit.value !== undefined) parent[index] = clone(edit.value)
    } else if (edit.remove) delete parent[key]
    else if (edit.value !== undefined) parent[key] = clone(edit.value)
    doc.value = next
    if (!this.transaction) this.record(before, doc.value)
    this.current.effective = merge(this.current.effective ?? {}, doc.value)
    this.emit()
    void this.refresh()
  }
  replace(value: JsonObject): void {
    const doc = this.editable()
    const before = clone(doc.value)
    doc.value = clone(value)
    if (!this.transaction) this.record(before, doc.value)
    this.emit()
    void this.refresh()
  }
  beginTransaction(_label?: string): void {
    const doc = this.editable()
    if (this.transaction)
      throw editorError('conflict', 'Finish the current edit transaction first.')
    this.transaction = clone(doc.value)
  }
  endTransaction(): void {
    const doc = this.editable()
    if (!this.transaction) return
    this.record(this.transaction, doc.value)
    this.transaction = undefined
    this.emit()
  }
  commitTransaction(): void {
    this.endTransaction()
  }
  cancelTransaction(): void {
    const doc = this.editable()
    if (!this.transaction) return
    doc.value = this.transaction
    this.transaction = undefined
    this.emit()
    void this.refresh()
  }
  private record(before: JsonObject, after: JsonObject): void {
    if (equal(before, after)) return
    const entry = {
      before: clone(before),
      after: clone(after),
      bytes: 2 * (JSON.stringify(before).length + JSON.stringify(after).length),
    }
    this.history.push(entry)
    this.future = []
    let bytes = this.history.reduce((total, item) => total + item.bytes, 0)
    while (this.history.length > this.limit || bytes > this.byteLimit) {
      bytes -= this.history.shift()!.bytes
      this.current.historyEvicted++
    }
  }
  undo(): void {
    const doc = this.editable()
    if (this.transaction) this.cancelTransaction()
    const entry = this.history.pop()
    if (!entry) return
    this.future.push(entry)
    doc.value = clone(entry.before)
    this.emit()
    void this.refresh()
  }
  redo(): void {
    const doc = this.editable()
    const entry = this.future.pop()
    if (!entry) return
    this.history.push(entry)
    doc.value = clone(entry.after)
    this.emit()
    void this.refresh()
  }
  private async refresh(): Promise<void> {
    const document = this.current.document
    if (!document || this.disposed) {
      this.emit()
      return
    }
    const sequence = ++this.validationGeneration
    this.validationAbort?.abort()
    this.validationAbort = new AbortController()
    const result = await validateAudioDocument(
      clone(document),
      this.documents,
      this.assets,
      this.validationAbort.signal,
    )
    if (
      this.disposed ||
      sequence !== this.validationGeneration ||
      document.id !== this.current.document?.id
    )
      return
    this.current.diagnostics = result.errors
    // Preserve a usable form for invalid drafts; only play/save require successful validation.
    this.current.effective = result.effective?.value ?? clone(document.value)
    this.emit()
  }
  async validate(): Promise<ShardError[]> {
    this.alive()
    await this.refresh()
    return [...this.current.diagnostics]
  }
  async save(): Promise<AudioDocument | undefined> {
    const doc = this.editable()
    if (this.current.saving) throw editorError('conflict', 'A save is already in progress.')
    if (this.transaction) this.endTransaction()
    if (!this.current.dirty) return clone(doc)
    if (this.current.conflict)
      throw editorError('conflict', 'Resolve the external edit before saving.')
    const snapshot = clone(doc)
    this.current.saving = true
    this.emit()
    try {
      const result = await validateAudioDocument(snapshot, this.documents, this.assets)
      if (result.errors.length) throw result.errors[0]
      const saved = await this.documents.commit!([
        { document: snapshot, expectedRevision: this.baseline?.revision || null },
      ])
      const confirmed = saved.find((item) => item.id === doc.id)
      if (!confirmed?.revision)
        throw editorError('invalid-document', 'The host did not acknowledge the saved revision.')
      if (this.disposed) return clone(confirmed)
      this.baseline = clone(confirmed)
      doc.revision = confirmed.revision
      doc.sourceText = confirmed.sourceText
      // New local edits made during save remain dirty against the acknowledged baseline.
      if (equal(doc.value, snapshot.value)) doc.value = clone(confirmed.value)
      return clone(confirmed)
    } catch (error) {
      if (!this.disposed) this.current.diagnostics = [asEditorError(error)]
      throw error
    } finally {
      this.current.saving = false
      this.emit()
    }
  }
  async saveAs(id: string, name: string): Promise<void> {
    const current = this.editable()
    if (this.current.saving) throw editorError('conflict', 'Wait for the pending save.')
    if (id === current.id)
      throw editorError('conflict', 'Save as needs a different host document ID.')
    const document = { ...clone(current), id, name, revision: '' }
    delete document.sourceText
    this.current.saving = true
    this.emit()
    try {
      const result = await validateAudioDocument(document, this.documents, this.assets)
      if (result.errors.length) throw result.errors[0]
      const saved = await this.documents.commit!([{ document, expectedRevision: null }])
      this.alive()
      const created = saved.find((item) => item.id === id)
      if (!created?.revision)
        throw editorError('invalid-document', 'The host did not acknowledge the created document.')
      const pending = equal(current.value, document.value) ? undefined : clone(current.value)
      this.adopt(created)
      if (pending) this.current.document!.value = pending
      await this.refresh()
    } finally {
      this.current.saving = false
      this.emit()
    }
  }
  async reload(): Promise<void> {
    this.alive()
    if (this.current.saving) throw editorError('conflict', 'Wait for the pending save.')
    const id = this.current.document?.id
    if (!id) return
    const doc = await this.documents.read(id)
    this.alive()
    if (this.current.document?.id !== id) return
    this.adopt(doc)
    await this.refresh()
  }
  private async remoteChanged(): Promise<void> {
    const id = this.current.document?.id
    if (!id) return
    try {
      const remote = await this.documents.read(id)
      if (
        this.disposed ||
        this.current.document?.id !== id ||
        remote.revision === this.baseline?.revision
      )
        return
      if (this.current.dirty) this.current.conflict = clone(remote)
      else this.adopt(remote)
      await this.refresh()
    } catch (error) {
      if (!this.disposed) {
        this.current.diagnostics = [asEditorError(error)]
        this.emit()
      }
    }
  }
  /** Batch edits have an explicit adapter capability and one compare-and-swap boundary. */
  async commitDocuments(changes: readonly AudioDocumentChange[]): Promise<AudioDocument[]> {
    this.alive()
    if (!this.documents.commit || (changes.length > 1 && !this.documents.atomic))
      throw editorError(
        'unsupported-capability',
        'The host cannot commit this atomic document batch.',
      )
    const overlay = new Map(changes.map((change) => [change.document.id, change.document]))
    const documents = {
      ...this.documents,
      read: async (id: string, signal?: AbortSignal) =>
        clone(overlay.get(id) ?? (await this.documents.read(id, signal))),
    }
    for (const change of changes) {
      const validation = await validateAudioDocument(change.document, documents, this.assets)
      if (validation.errors.length) throw validation.errors[0]
    }
    return this.documents.commit(changes)
  }
  /** Explicit dependent IDs avoid renaming an unrelated parameter with the same display name. */
  async renameParameter(
    from: string,
    to: string,
    dependentIds: readonly string[] = [],
  ): Promise<void> {
    const current = this.editable()
    if (this.current.dirty || this.current.saving)
      throw editorError('conflict', 'Save the current draft before a parameter rename.')
    if (!to || from === to)
      throw editorError('invalid-document', 'Choose a different nonempty parameter name.')
    const global = current.type === 'audio/AudioParameters'
    if (dependentIds.length && !global)
      throw editorError(
        'invalid-document',
        'Local parameter renames cannot change other documents.',
      )
    const ids = [...new Set([current.id, ...dependentIds])]
    if (ids.length > 1 && !this.documents.atomic)
      throw editorError(
        'unsupported-capability',
        'This host does not support atomic reference renames.',
      )
    const changes: AudioDocumentChange[] = []
    for (const id of ids) {
      const source = await this.documents.read(id)
      const next = clone(source)
      if (id !== current.id) {
        const globals = next.value.globals as JsonObject | undefined
        if ((globals?.guid ?? globals?.path) !== current.id)
          throw editorError(
            'invalid-document',
            `Document ${id} does not reference this parameter bank.`,
          )
        const locals = next.value.parameters
        if (
          Array.isArray(locals) &&
          locals.some(
            (p) => typeof p === 'object' && p !== null && !Array.isArray(p) && p.name === from,
          )
        )
          throw editorError(
            'conflict',
            `Document ${id} shadows this global parameter with a local name.`,
          )
      } else {
        const definitions = next.value.parameters
        if (!Array.isArray(definitions))
          throw editorError('invalid-document', 'This document has no authored parameters.')
        let found = false
        for (const entry of definitions) {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
          if (entry.name === to)
            throw editorError('conflict', 'That parameter name already exists.')
          if (entry.name === from) {
            entry.name = to
            found = true
          }
        }
        if (!found)
          throw editorError(
            'invalid-document',
            'Parameter is inherited or does not exist; rename it in its defining document.',
          )
      }
      const update = (value: JsonValue, known: JsonValue): void => {
        if (Array.isArray(value) && Array.isArray(known)) {
          value.forEach((item, index) => {
            update(item, known[index] ?? null)
          })
          return
        }
        if (
          !value ||
          typeof value !== 'object' ||
          Array.isArray(value) ||
          !known ||
          typeof known !== 'object'
        )
          return
        for (const key of Object.keys(known)) {
          if ((key === 'parameter' || key === 'selectParameter') && value[key] === from)
            value[key] = to
          else update(value[key]!, (known as JsonObject)[key]!)
        }
      }
      const schema = getAudioEditorSchema(next.type)
      if (!schema)
        throw editorError('unsupported-schema', `Unsupported document schema ${next.type}.`)
      update(next.value, knownFields(schema.fields, next.value))
      changes.push({ document: next, expectedRevision: source.revision })
    }
    await this.commitDocuments(changes)
    await this.reload()
  }
  async play(): Promise<unknown> {
    this.alive()
    if (!this.preview)
      throw editorError('unsupported-capability', 'This host does not provide audio preview.')
    if (!this.current.document)
      throw editorError('invalid-document', 'Open a document to audition.')
    this.previewAbort?.abort()
    const controller = new AbortController()
    this.previewAbort = controller
    this.current.previewState = 'preparing'
    this.emit()
    try {
      // The adapter begins gesture unlock synchronously and validates the draft before playback.
      const result = await this.preview.play(clone(this.current.document), controller.signal)
      if (!this.disposed && !controller.signal.aborted) {
        this.current.previewState = 'playing'
        this.current.previewResult = result
        this.emit()
      }
      return result
    } catch (error) {
      if (!this.disposed && !controller.signal.aborted) {
        this.current.previewState = 'failed'
        this.current.diagnostics = [asEditorError(error)]
        this.emit()
      }
      throw error
    }
  }
  async stop(): Promise<void> {
    this.previewAbort?.abort()
    await this.preview?.stop()
    this.current.previewState = 'idle'
    this.current.previewResult = undefined
    this.emit()
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    ++this.validationGeneration
    this.readAbort?.abort()
    this.validationAbort?.abort()
    this.previewAbort?.abort()
    this.unsubscribe?.()
    this.unsubscribeAssets?.()
    this.listeners.clear()
    this.history = []
    this.future = []
    this.transaction = undefined
    this.baseline = undefined
    this.current.document = undefined
    this.current.effective = undefined
    this.current.conflict = undefined
    this.current.previewResult = undefined
    await this.preview?.dispose()
  }
}
export function createAudioEditorSession(options: AudioEditorOptions): AudioEditorSession {
  return new AudioEditorSession(options)
}
