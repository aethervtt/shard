import {
  type AssetRef,
  allComponents,
  defineEvent,
  defineResource,
  isPlainObject,
  type JsonValue,
  ShardError,
  type World,
} from '@shard/core'
import type { Platform } from '@shard/platform'
import { LogResource } from '@shard/runtime'
import { randomGuid, sha256Hex } from './hash'
import {
  type Artifact,
  findAssetType,
  findImporter,
  type ImportContext,
  type ImportedAsset,
  type ImporterDef,
  importerFor,
} from './types'

export type AssetState = 'unloaded' | 'loading' | 'loaded' | 'failed'

export interface AssetEntry {
  readonly guid: string
  path: string
  readonly type: string
  /** '' for a source's main asset. */
  readonly label: string
  /** The source file's path; undefined for virtual assets (`procedural:`). */
  source: string | undefined
  state: AssetState
  error: ShardError | undefined
  /** Increments on every load and reload. */
  version: number
}

export type AssetEventKind = 'loaded' | 'modified' | 'failed' | 'removed' | 'unloaded'

export interface AssetEventData {
  guid: string
  path: string
  kind: AssetEventKind
}

/** Sent when an asset loads, reloads, fails, is unloaded, or its source is removed. */
export const AssetEvent = defineEvent<AssetEventData>('assets/AssetEvent', {
  description: 'An asset loaded, changed, failed, was unloaded, or was removed.',
})

interface ErrorJson {
  code: string
  message: string
  path?: string
  hint?: string
}

interface ArtifactFiles {
  bytes?: string
  json?: string
}

interface AssetRecord {
  label: string
  type: string
  artifact: ArtifactFiles
  dependencies: string[]
  info?: Record<string, JsonValue>
}

interface DepRecord {
  path: string
  hash: string
  size: number
  mtime: number
  /** A directory listing (ImportContext.list): `hash` is of its file names. */
  listing?: boolean
}

interface SourceRecord {
  path: string
  guid: string
  importer: string
  importerVersion: number
  settings: Record<string, JsonValue>
  key: string | undefined
  sourceHash: string | undefined
  size: number
  mtime: number
  metaSize: number
  metaMtime: number
  deps: DepRecord[]
  assets: AssetRecord[]
  error: ErrorJson | undefined
  warnings: { message: string; path?: string }[]
}

interface MetaFile {
  guid: string
  importer?: string
  settings?: Record<string, JsonValue>
}

export interface ScanReport {
  /** Sources that were imported (new, or changed inputs). */
  imported: string[]
  /** Sources whose inputs hadn't changed. */
  unchanged: number
  failed: { path: string; error: ErrorJson }[]
  removed: string[]
  moved: { from: string; to: string }[]
  /** `.meta` files whose source is missing. */
  orphanedMetas: string[]
  ms: number
}

export interface AssetInfo {
  guid: string
  path: string
  type: string
  state: AssetState
  version: number
  source?: string
  importer?: string
  settings?: Record<string, JsonValue>
  key?: string
  /** Asset paths this asset needs at runtime. */
  dependencies: string[]
  /** Files read while importing it. */
  importDependencies: string[]
  /** Assets and sources that depend on this one. */
  dependents: string[]
  subAssets?: { label: string; type: string; path: string }[]
  /** Cache paths of the artifact files, named by content hash. */
  artifact?: { bytes?: string; json?: string }
  info?: Record<string, JsonValue>
  warnings: { message: string; path?: string }[]
  error?: ErrorJson
}

export interface AssetServerOptions {
  platform: Platform
  /** Project folders to import from. Default `["assets", "materials", "data", "prefabs"]`. */
  roots?: readonly string[]
  /** Default `.shard/cache`. */
  cacheDir?: string
  /** Written after scans on writable hosts; read on hosts that can't list files. */
  catalogPath?: string
}

const INDEX_VERSION = 1
const IGNORED_DIRS = new Set(['node_modules'])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function errorJson(err: unknown, path?: string): ErrorJson {
  if (err instanceof ShardError) {
    const json = err.toJSON() as unknown as ErrorJson
    return { code: json.code, message: json.message, path: json.path ?? path, hint: json.hint }
  }
  return { code: 'assets/import-failed', message: String((err as Error)?.message ?? err), path }
}

function toShardError(json: ErrorJson): ShardError {
  return new ShardError(json.code, json.message, { path: json.path, hint: json.hint })
}

/** POSIX-style normalization of a project path: resolves `.` and `..`, drops leading `./`. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

function dirnameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

function subGuid(guid: string, label: string): string {
  return label === '' ? guid : `${guid}/${label}`
}

function subPath(path: string, label: string): string {
  return label === '' ? path : `${path}#${label}`
}

/**
 * The asset database for one world: imports sources into cached artifacts, keeps the catalog of
 * paths and guids, loads artifacts into stores, hot reloads, and unloads what nothing references.
 * Works without a platform too (memory only), which is how procedural and runtime assets live.
 */
export class AssetServer {
  readonly world: World
  private platform: Platform | undefined
  private roots: readonly string[] = ['assets', 'materials', 'data', 'prefabs']
  private cacheDir = '.shard/cache'
  private catalogPath = '.shard/catalog.json'
  private readonly sources = new Map<string, SourceRecord>()
  private readonly entries = new Map<string, AssetEntry>()
  private readonly byPath = new Map<string, AssetEntry>()
  private readonly loading = new Map<string, Promise<void>>()
  private readonly memory = new Map<string, Uint8Array | string>()
  private readonly virtuals = new Map<string, () => unknown>()
  private readonly pins = new Map<string, Set<string>>()
  private readonly listeners = new Set<(event: AssetEventData) => void>()
  private claimedMoves = new Set<SourceRecord>()
  private indexLoaded = false
  private queue: Promise<unknown> = Promise.resolve()

  constructor(world: World) {
    this.world = world
  }

  /** Attaches the host's file system. Call before `scan`. */
  configure(options: AssetServerOptions): this {
    this.platform = options.platform
    if (options.roots) this.roots = options.roots
    if (options.cacheDir) this.cacheDir = options.cacheDir
    if (options.catalogPath) this.catalogPath = options.catalogPath
    this.indexLoaded = false
    return this
  }

  get assetRoots(): readonly string[] {
    return this.roots
  }

  // --- catalog ---------------------------------------------------------------

  /** The entry for a path (`assets/ship.glb#Mesh/Hull`), a guid, or a ref. */
  entry(ref: AssetRef | string | { guid?: string; path?: string }): AssetEntry | undefined {
    if (typeof ref === 'string') return this.byPath.get(ref) ?? this.entries.get(ref)
    if (ref.guid !== undefined) {
      const byGuid = this.entries.get(ref.guid)
      if (byGuid) return byGuid
    }
    return ref.path === undefined ? undefined : this.byPath.get(ref.path)
  }

  /** A ref for a path or guid, or undefined if the catalog has no such asset. */
  resolve<T extends string = string>(pathOrGuid: string): AssetRef<T> | undefined {
    const e = this.entry(pathOrGuid)
    return e ? { type: e.type as T, guid: e.guid, path: e.path } : undefined
  }

  state(ref: AssetRef | string): AssetState | undefined {
    return this.entry(ref)?.state
  }

  /** Every catalog entry, optionally filtered. */
  list(filter: { type?: string; prefix?: string; state?: AssetState } = {}): AssetEntry[] {
    const out: AssetEntry[] = []
    for (const e of this.entries.values()) {
      if (filter.type && e.type !== filter.type) continue
      if (filter.prefix && !e.path.startsWith(filter.prefix)) continue
      if (filter.state && e.state !== filter.state) continue
      out.push(e)
    }
    return out.sort((a, b) => a.path.localeCompare(b.path))
  }

  /**
   * Registers (once) and loads a virtual asset: made by code rather than imported, e.g. procedural
   * meshes (`proc:<key>`). Created synchronously, so it's usable immediately.
   */
  virtual(guid: string, path: string, type: string, create: () => unknown): AssetEntry {
    let entry = this.entries.get(guid)
    if (!entry) {
      entry = {
        guid,
        path,
        type,
        label: '',
        source: undefined,
        state: 'unloaded',
        error: undefined,
        version: 0,
      }
      this.addEntry(entry)
      this.virtuals.set(guid, create)
    }
    if (entry.state !== 'loaded') this.loadVirtual(entry)
    return entry
  }

  /**
   * Replaces a virtual asset's contents (registering it if new) and reloads it in place, like a hot
   * reload of a file: listeners get a 'modified' event.
   */
  updateVirtual(guid: string, path: string, type: string, create: () => unknown): AssetEntry {
    const entry = this.entries.get(guid)
    if (!entry) return this.virtual(guid, path, type, create)
    this.virtuals.set(guid, create)
    this.loadVirtual(entry, entry.state === 'loaded')
    return entry
  }

  // --- loading ---------------------------------------------------------------

  /** Loads an asset (and its dependencies). Resolves once it's in its store; rejects if it failed. */
  load(ref: AssetRef | string): Promise<void> {
    const entry = this.entry(ref)
    if (!entry) {
      const label = typeof ref === 'string' ? ref : (ref.path ?? ref.guid)
      return Promise.reject(
        new ShardError('assets/not-found', `No asset "${label}" in the catalog`, {
          path: typeof ref === 'string' ? ref : ref.path,
          hint: 'Check the path, or run `shard import` to import new files.',
        }),
      )
    }
    if (entry.state === 'loaded') return Promise.resolve()
    if (this.virtuals.has(entry.guid)) {
      this.loadVirtual(entry)
      return entry.error ? Promise.reject(entry.error) : Promise.resolve()
    }
    const pending = this.loading.get(entry.guid)
    if (pending) return pending
    const promise = this.loadEntry(entry, false).finally(() => this.loading.delete(entry.guid))
    this.loading.set(entry.guid, promise)
    return promise
  }

  /**
   * Loads an asset again from its artifact (e.g. after GPU device loss, when CPU copies were
   * released). Keeps the old object until the new one is ready. Returns false for virtual assets.
   */
  reload(ref: AssetRef | string): Promise<void> {
    const entry = this.entry(ref)
    if (!entry || entry.source === undefined) return Promise.resolve()
    const pending = this.loading.get(entry.guid)
    if (pending) return pending
    const promise = this.loadEntry(entry, true).finally(() => this.loading.delete(entry.guid))
    this.loading.set(entry.guid, promise)
    return promise
  }

  /** Starts loading without waiting; failures are logged, not thrown. */
  request(ref: AssetRef | string): Promise<void> {
    const p = this.load(ref)
    p.catch(() => {})
    return p
  }

  /** Resolves once every ref has loaded or failed. */
  async whenSettled(refs: Iterable<AssetRef | string>): Promise<void> {
    await Promise.allSettled([...refs].map((r) => this.load(r)))
  }

  private loadVirtual(entry: AssetEntry, reload = false): void {
    const type = findAssetType(entry.type)
    const create = this.virtuals.get(entry.guid)!
    try {
      if (!type) throw this.unknownType(entry)
      this.world.initResource(type.store).set(entry.guid, create())
      entry.state = 'loaded'
      entry.error = undefined
      entry.version++
      this.emit(entry, reload ? 'modified' : 'loaded')
    } catch (err) {
      entry.state = 'failed'
      entry.error = err instanceof ShardError ? err : toShardError(errorJson(err, entry.path))
      this.emit(entry, 'failed')
    }
  }

  private async loadEntry(entry: AssetEntry, reload: boolean): Promise<void> {
    if (!reload) entry.state = 'loading'
    try {
      const type = findAssetType(entry.type)
      if (!type) throw this.unknownType(entry)
      const asset = this.assetRecord(entry)
      if (!asset) {
        throw new ShardError('assets/not-found', `No import record for "${entry.path}"`, {
          path: entry.path,
          hint: 'Run `shard import`.',
        })
      }
      // Dependencies settle first; a failed dependency doesn't fail this asset.
      await Promise.allSettled(asset.dependencies.map((d) => this.load(d)))
      const artifact = await this.readArtifact(asset.artifact)
      const base = entry.path.split('#')[0]!
      const item = await type.load(artifact, {
        guid: entry.guid,
        path: entry.path,
        resolve: (p) => this.resolve(p.startsWith('#') ? `${base}${p}` : p),
      })
      const store = this.world.initResource(type.store)
      const existing = store.byGuid(entry.guid)
      if (existing !== undefined && type.update) type.update(existing, item)
      else store.set(entry.guid, item)
      entry.state = 'loaded'
      entry.error = undefined
      entry.version++
      this.emit(entry, reload ? 'modified' : 'loaded')
    } catch (err) {
      const error =
        err instanceof ShardError
          ? err
          : new ShardError('assets/load-failed', `Couldn't load ${entry.path}: ${String(err)}`, {
              path: entry.path,
              cause: err,
            })
      this.world.tryResource(LogResource)?.error(error)
      if (reload) {
        // Keep the last good object; the error is logged and shown by asset.get.
        entry.error = error
        return
      }
      entry.state = 'failed'
      entry.error = error
      this.emit(entry, 'failed')
      throw error
    }
  }

  private unknownType(entry: AssetEntry): ShardError {
    return new ShardError('assets/unknown-type', `No asset type "${entry.type}" is registered`, {
      path: entry.path,
      hint: 'Add the plugin that defines it (e.g. render/forward for Mesh and Material).',
    })
  }

  private assetRecord(entry: AssetEntry): AssetRecord | undefined {
    const record = entry.source === undefined ? undefined : this.sources.get(entry.source)
    return record?.assets.find((a) => a.label === entry.label)
  }

  /** An asset's artifact (bytes and/or JSON) straight from the cache, e.g. for previews. */
  async artifact(ref: AssetRef | string): Promise<Artifact> {
    const entry = this.entry(ref)
    const asset = entry && this.assetRecord(entry)
    if (!asset) {
      throw new ShardError('assets/not-found', `No artifact for ${JSON.stringify(ref)}`, {
        hint: 'Only imported assets have artifacts; run `shard import`.',
      })
    }
    return this.readArtifact(asset.artifact)
  }

  private async readArtifact(files: ArtifactFiles): Promise<Artifact> {
    const read = async (file: string): Promise<Uint8Array> => {
      const mem = this.memory.get(file)
      if (mem !== undefined) return typeof mem === 'string' ? encoder.encode(mem) : mem
      if (!this.platform) throw new ShardError('assets/not-found', `Missing artifact ${file}`)
      return this.platform.fs.readBytes(`${this.cacheDir}/${file}`)
    }
    const out: { bytes?: Uint8Array; json?: JsonValue } = {}
    if (files.bytes) out.bytes = await read(files.bytes)
    if (files.json) out.json = JSON.parse(decoder.decode(await read(files.json)))
    return out
  }

  // --- pins and collection ----------------------------------------------------

  /** Keeps an asset loaded even when no component references it. */
  pin(ref: AssetRef | string, owner: string): void {
    const entry = this.entry(ref)
    if (!entry) return
    let set = this.pins.get(owner)
    if (!set) {
      set = new Set()
      this.pins.set(owner, set)
    }
    set.add(entry.guid)
  }

  unpin(owner: string): void {
    this.pins.delete(owner)
  }

  /**
   * Unloads file-backed assets nothing reaches: not referenced by any component field in the world,
   * not pinned, and not a dependency of something reachable. Returns the unloaded paths.
   */
  collect(): string[] {
    const reachable = new Set<string>()
    for (const set of this.pins.values()) for (const g of set) reachable.add(g)
    const visit = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      if (Array.isArray(value)) {
        for (const v of value) visit(v)
        return
      }
      if (ArrayBuffer.isView(value)) return
      const guid = (value as { guid?: unknown }).guid
      if (typeof guid === 'string') reachable.add(guid)
      for (const v of Object.values(value)) if (typeof v === 'object') visit(v)
    }
    for (const def of allComponents()) {
      const objectFields = def.layout.filter((c) => c.storage === 'object')
      if (objectFields.length === 0) continue
      const q = this.world.query({ with: [def] })
      for (const table of q.tables) {
        for (const { name } of objectFields) {
          const column = table.column(def, name as never) as unknown as unknown[]
          for (let i = 0; i < table.count; i++) visit(column[i])
        }
      }
    }
    // Dependencies of reachable assets are reachable.
    const stack = [...reachable]
    while (stack.length > 0) {
      const entry = this.entries.get(stack.pop()!)
      const asset = entry && this.assetRecord(entry)
      if (!asset) continue
      for (const dep of asset.dependencies) {
        const d = this.entry(dep)
        if (d && !reachable.has(d.guid)) {
          reachable.add(d.guid)
          stack.push(d.guid)
        }
      }
    }
    const unloaded: string[] = []
    for (const entry of this.entries.values()) {
      if (entry.state !== 'loaded' || entry.source === undefined || reachable.has(entry.guid)) {
        continue
      }
      this.unloadEntry(entry)
      unloaded.push(entry.path)
    }
    return unloaded
  }

  private unloadEntry(entry: AssetEntry): void {
    const type = findAssetType(entry.type)
    if (type) {
      const store = this.world.initResource(type.store)
      const item = store.byGuid(entry.guid)
      if (item !== undefined) type.unload?.(item)
      store.delete(entry.guid)
    }
    entry.state = 'unloaded'
    this.emit(entry, 'unloaded')
  }

  // --- events ------------------------------------------------------------------

  onEvent(listener: (event: AssetEventData) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(entry: AssetEntry, kind: AssetEventKind): void {
    const event = { guid: entry.guid, path: entry.path, kind }
    this.world.send(AssetEvent, event)
    for (const l of this.listeners) l(event)
  }

  // --- info ----------------------------------------------------------------------

  /** Everything known about an asset, for `asset.get`. */
  info(ref: AssetRef | string): AssetInfo {
    const entry = this.entry(ref)
    const bare = typeof ref === 'string' && !entry ? this.sources.get(ref) : undefined
    if (bare) {
      // A source with no main asset (a .glb holds only sub-assets), or whose first import failed.
      const subAssets = bare.assets
        .filter((a) => a.label !== '')
        .map((a) => ({ label: a.label, type: a.type, path: subPath(bare.path, a.label) }))
      return {
        guid: bare.guid,
        path: bare.path,
        type: 'Source',
        state: bare.error && bare.assets.length === 0 ? 'failed' : 'unloaded',
        version: 0,
        source: bare.path,
        importer: bare.importer,
        settings: bare.settings,
        ...(bare.key ? { key: bare.key } : {}),
        dependencies: [],
        importDependencies: bare.deps.map((d) => d.path),
        dependents: [],
        ...(subAssets.length ? { subAssets } : {}),
        warnings: bare.warnings,
        ...(bare.error ? { error: bare.error } : {}),
      }
    }
    if (!entry) {
      throw new ShardError('assets/not-found', `No asset ${JSON.stringify(ref)} in the catalog`, {
        hint: 'asset.list shows every asset.',
      })
    }
    const record = entry.source === undefined ? undefined : this.sources.get(entry.source)
    const asset = record?.assets.find((a) => a.label === entry.label)
    const dependents = new Set<string>()
    for (const r of this.sources.values()) {
      if (record && entry.label === '' && r.deps.some((d) => d.path === record.path)) {
        dependents.add(r.path)
      }
      for (const a of r.assets) {
        if (a.dependencies.some((d) => d === entry.path || this.entry(d)?.guid === entry.guid)) {
          dependents.add(subPath(r.path, a.label))
        }
      }
    }
    const out: AssetInfo = {
      guid: entry.guid,
      path: entry.path,
      type: entry.type,
      state: entry.state,
      version: entry.version,
      dependencies: asset?.dependencies ?? [],
      importDependencies: record?.deps.map((d) => d.path) ?? [],
      dependents: [...dependents].sort(),
      warnings: record?.warnings ?? [],
    }
    if (record) {
      out.source = record.path
      out.importer = record.importer
      out.settings = record.settings
      if (record.key) out.key = record.key
      if (entry.label === '' && record.assets.length > 1) {
        out.subAssets = record.assets
          .filter((a) => a.label !== '')
          .map((a) => ({ label: a.label, type: a.type, path: subPath(record.path, a.label) }))
      }
    }
    if (asset) out.artifact = asset.artifact
    if (asset?.info) out.info = asset.info
    const error = entry.error ? errorJson(entry.error) : record?.error
    if (error) out.error = error
    return out
  }

  /** The importer that handles a source, honoring an explicit `importer` in its `.meta`. */
  importerOf(path: string): ImporterDef | undefined {
    const record = this.sources.get(path)
    return (record && findImporter(record.importer)) ?? importerFor(path)
  }

  // --- scanning and importing --------------------------------------------------

  /**
   * Imports what changed under the asset roots. Unchanged sources (same size and mtime for the
   * source, its `.meta`, and its import dependencies) are only stat'ed. Hosts that can't list files
   * read the prebuilt catalog instead. Scans are serialized.
   */
  scan(options: { force?: boolean | readonly string[] } = {}): Promise<ScanReport> {
    const run = this.queue.catch(() => {}).then(() => this.doScan(options))
    this.queue = run
    return run
  }

  private async doScan(options: { force?: boolean | readonly string[] }): Promise<ScanReport> {
    const start = performance.now()
    const report: ScanReport = {
      imported: [],
      unchanged: 0,
      failed: [],
      removed: [],
      moved: [],
      orphanedMetas: [],
      ms: 0,
    }
    const fs = this.platform?.fs
    if (!fs) return report
    if (!fs.list || !fs.stat) {
      await this.refreshCatalog(report)
      report.ms = performance.now() - start
      return report
    }
    await this.loadIndex()

    const files = await this.walk(this.roots)
    const fileSet = new Set(files)
    const sourcePaths = files.filter((f) => !f.endsWith('.meta') && importerFor(f))
    const present = new Set(sourcePaths)
    for (const f of files) {
      if (f.endsWith('.meta') && !fileSet.has(f.slice(0, -'.meta'.length))) {
        report.orphanedMetas.push(f)
      }
    }
    const removed = [...this.sources.values()].filter((r) => !present.has(r.path))
    const removedByHash = new Map<string, SourceRecord>()
    for (const r of removed) if (r.sourceHash) removedByHash.set(r.sourceHash, r)

    const force = options.force
    const isForced = (path: string) =>
      force === true || (Array.isArray(force) && force.includes(path))

    // What each loaded asset was built from, to reload only the ones whose artifacts changed.
    const before = new Map<string, string>()
    for (const r of this.sources.values()) {
      for (const a of r.assets) {
        before.set(subGuid(r.guid, a.label), JSON.stringify([a.artifact, a.dependencies]))
      }
    }
    const changed: SourceRecord[] = []
    await Promise.all(
      sourcePaths.map(async (path) => {
        const result = await this.scanSource(path, isForced(path), removedByHash, report)
        if (result) changed.push(result)
      }),
    )

    // Removed sources that weren't moved. A moved record is no longer in removedByHash.
    const claimed = this.claimedMoves
    this.claimedMoves = new Set()
    for (const r of removed) {
      if (claimed.has(r)) continue
      this.sources.delete(r.path)
      for (const a of r.assets) {
        const entry = this.entries.get(subGuid(r.guid, a.label))
        if (!entry) continue
        if (entry.state === 'loaded') this.unloadEntry(entry)
        this.removeEntry(entry)
        this.emit(entry, 'removed')
      }
      report.removed.push(r.path)
    }

    // Reload what changed and is loaded.
    const reloads: Promise<void>[] = []
    for (const record of changed) {
      for (const a of record.assets) {
        const guid = subGuid(record.guid, a.label)
        const entry = this.entries.get(guid)
        if (entry?.state !== 'loaded') continue
        if (before.get(guid) === JSON.stringify([a.artifact, a.dependencies])) continue
        reloads.push(this.loadEntry(entry, true).catch(() => {}))
      }
    }
    await Promise.all(reloads)

    if (fs.writable && (changed.length > 0 || report.removed.length > 0 || report.moved.length > 0))
      await this.saveIndex()
    else if (fs.writable && !(await fs.exists(this.catalogPath))) await this.saveIndex()
    report.imported.sort()
    report.ms = performance.now() - start
    return report
  }

  /** Scans one source. Returns its record when it was (re)imported, undefined when unchanged. */
  private async scanSource(
    path: string,
    forced: boolean,
    removedByHash: Map<string, SourceRecord>,
    report: ScanReport,
  ): Promise<SourceRecord | undefined> {
    const fs = this.platform!.fs
    const metaPath = `${path}.meta`
    const [st, metaSt] = await Promise.all([fs.stat!(path), fs.stat!(metaPath)])
    if (!st) return undefined
    const previous = this.sources.get(path)

    if (!forced && previous && metaSt && previous.error === undefined) {
      const importer = findImporter(previous.importer)
      if (
        importer &&
        importer.version === previous.importerVersion &&
        previous.size === st.size &&
        previous.mtime === st.mtime &&
        previous.metaSize === metaSt.size &&
        previous.metaMtime === metaSt.mtime &&
        (await this.depsUnchanged(previous))
      ) {
        report.unchanged++
        return undefined
      }
    }

    let bytes: Uint8Array | undefined
    let sourceHash: string | undefined
    let meta: MetaFile
    let metaStat = metaSt
    try {
      if (metaSt) {
        meta = this.parseMeta(await fs.readText(metaPath), metaPath)
      } else {
        bytes = await fs.readBytes(path)
        sourceHash = await sha256Hex(bytes)
        const importer = importerFor(path)!
        const movedFrom = removedByHash.get(sourceHash)
        if (movedFrom) {
          removedByHash.delete(sourceHash)
          this.claimedMoves.add(movedFrom)
          meta = {
            guid: movedFrom.guid,
            importer: movedFrom.importer,
            settings: movedFrom.settings,
          }
          report.moved.push({ from: movedFrom.path, to: path })
          this.world
            .tryResource(LogResource)
            ?.warn(`${movedFrom.path} moved to ${path} without its .meta; kept its guid`, {
              code: 'assets/moved-without-meta',
              hint: `Move .meta files with their sources (or use \`shard mv\`). References to "${movedFrom.path}" need updating.`,
            })
          this.rekeySource(movedFrom, path)
        } else {
          const settings = importer.settings.serialize(importer.settings.defaults())
          meta = {
            guid: randomGuid(),
            importer: importer.name,
            settings: { ...settings, ...(importer.defaults?.(path) ?? {}) },
          }
        }
        if (fs.writable) {
          await fs.writeText(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
          metaStat = await fs.stat!(metaPath)
        }
      }
    } catch (err) {
      return this.fail(path, previous, err, report, st, metaSt)
    }

    const importer = (meta.importer && findImporter(meta.importer)) || importerFor(path)
    if (!importer) {
      return this.fail(
        path,
        previous,
        new ShardError('assets/unknown-importer', `No importer "${meta.importer}"`, {
          path: `${metaPath}/importer`,
          hint: 'Remove "importer" from the .meta to pick one by file extension.',
        }),
        report,
        st,
        metaStat,
        meta.guid,
      )
    }
    const settingsErrors = importer.settings.validate(meta.settings ?? {})
    if (settingsErrors.length > 0) {
      const first = settingsErrors[0]!
      return this.fail(
        path,
        previous,
        new ShardError('assets/invalid-meta', `${metaPath}: ${first.message}`, {
          path: `/settings${first.path ?? ''}`,
          hint:
            first.hint ??
            `The ${importer.name} settings schema is at shard://schemas/importers/${importer.name}.`,
          details: settingsErrors,
        }),
        report,
        st,
        metaStat,
        meta.guid,
      )
    }
    const settings = importer.settings.serialize(
      importer.settings.deserialize(meta.settings ?? {}),
    ) as Record<string, JsonValue>

    bytes ??= await fs.readBytes(path)
    sourceHash ??= await sha256Hex(bytes)

    // Same inputs as last time: refresh the stats and skip the import.
    if (
      !forced &&
      previous &&
      previous.error === undefined &&
      previous.guid === meta.guid &&
      previous.importer === importer.name &&
      previous.importerVersion === importer.version &&
      previous.sourceHash === sourceHash &&
      JSON.stringify(previous.settings) === JSON.stringify(settings) &&
      (await this.depsUnchanged(previous, true))
    ) {
      previous.size = st.size
      previous.mtime = st.mtime
      previous.metaSize = metaStat?.size ?? 0
      previous.metaMtime = metaStat?.mtime ?? 0
      report.unchanged++
      return undefined
    }

    const deps: DepRecord[] = []
    const warnings: { message: string; path?: string }[] = []
    const ctx: ImportContext = {
      settings: importer.settings.deserialize(settings) as Record<string, unknown>,
      resolve: (p) => this.resolveFrom(path, p),
      read: async (p) => {
        const full = this.resolveFrom(path, p)
        const data = await fs.readBytes(full)
        const s = await fs.stat!(full)
        deps.push({
          path: full,
          hash: await sha256Hex(data),
          size: s?.size ?? 0,
          mtime: s?.mtime ?? 0,
        })
        return data
      },
      list: async (p) => {
        const dir = this.resolveFrom(path, p).replace(/\/$/, '')
        const files = await this.listFiles(dir)
        deps.push({
          path: dir,
          hash: await sha256Hex(encoder.encode(files.join('\n'))),
          size: 0,
          mtime: 0,
          listing: true,
        })
        return files
      },
      warn: (message, p) => warnings.push(p === undefined ? { message } : { message, path: p }),
    }
    let assets: ImportedAsset[]
    try {
      const source = { path, bytes, text: () => decoder.decode(bytes) }
      assets = (await importer.import(source, ctx)).assets
    } catch (err) {
      return this.fail(path, previous, err, report, st, metaStat, meta.guid)
    }

    const key = await sha256Hex(
      encoder.encode(
        JSON.stringify([
          importer.name,
          importer.version,
          settings,
          sourceHash,
          deps.map((d) => d.hash),
        ]),
      ),
    )
    const records: AssetRecord[] = []
    for (const a of assets) {
      // Artifacts are named by their own content, so an import that changes one sub-asset leaves
      // the others' artifacts (and loaded objects) untouched.
      const artifact: ArtifactFiles = {}
      if (a.bytes) artifact.bytes = await this.writeArtifact(a.bytes, 'bin')
      if (a.json !== undefined)
        artifact.json = await this.writeArtifact(JSON.stringify(a.json), 'json')
      const rec: AssetRecord = {
        label: a.label,
        type: a.type,
        artifact,
        dependencies: (a.dependencies ?? []).map((d) => this.resolveFrom(path, d)),
      }
      if (a.info) rec.info = a.info
      records.push(rec)
    }
    const record: SourceRecord = {
      path,
      guid: meta.guid,
      importer: importer.name,
      importerVersion: importer.version,
      settings,
      key,
      sourceHash,
      size: st.size,
      mtime: st.mtime,
      metaSize: metaStat?.size ?? 0,
      metaMtime: metaStat?.mtime ?? 0,
      deps,
      assets: records,
      error: undefined,
      warnings,
    }
    this.setSource(record, previous)
    report.imported.push(path)
    return record
  }

  /** Records a failed import. The last good artifacts (if any) stay loaded and loadable. */
  private fail(
    path: string,
    previous: SourceRecord | undefined,
    err: unknown,
    report: ScanReport,
    st: { size: number; mtime: number },
    metaSt: { size: number; mtime: number } | undefined,
    guid?: string,
  ): undefined {
    const error = errorJson(err, path)
    report.failed.push({ path, error })
    this.world.tryResource(LogResource)?.error(
      new ShardError(error.code, `${path}: ${error.message}`, {
        path: error.path,
        hint: error.hint,
      }),
    )
    const record: SourceRecord = previous
      ? { ...previous }
      : {
          path,
          guid: guid ?? randomGuid(),
          importer: importerFor(path)?.name ?? 'unknown',
          importerVersion: 0,
          settings: {},
          key: undefined,
          sourceHash: undefined,
          size: 0,
          mtime: 0,
          metaSize: 0,
          metaMtime: 0,
          deps: [],
          assets: [],
          error: undefined,
          warnings: [],
        }
    record.error = error
    record.size = st.size
    record.mtime = st.mtime
    record.metaSize = metaSt?.size ?? 0
    record.metaMtime = metaSt?.mtime ?? 0
    this.sources.set(path, record)
    for (const a of record.assets) {
      const entry = this.entries.get(subGuid(record.guid, a.label))
      if (entry) entry.error = toShardError(error)
    }
    return undefined
  }

  private async depsUnchanged(record: SourceRecord, byHash = false): Promise<boolean> {
    const fs = this.platform!.fs
    for (const dep of record.deps) {
      if (dep.listing) {
        const files = await this.listFiles(dep.path)
        if ((await sha256Hex(encoder.encode(files.join('\n')))) !== dep.hash) return false
        continue
      }
      const s = await fs.stat!(dep.path)
      if (!s) return false
      if (s.size === dep.size && s.mtime === dep.mtime) continue
      if (!byHash) return false
      if ((await sha256Hex(await fs.readBytes(dep.path))) !== dep.hash) return false
      dep.size = s.size
      dep.mtime = s.mtime
    }
    return true
  }

  /** Files (not directories or .meta files) directly inside a project directory, sorted. */
  private async listFiles(dir: string): Promise<string[]> {
    const fs = this.platform!.fs
    if (!fs.list) {
      throw new ShardError('assets/no-listing', "This platform can't list directories", {
        hint: 'Import on a host with file listing (the CLI, the dev server, Studio).',
      })
    }
    const entries = await fs.list(dir)
    return entries
      .filter((e) => e.kind === 'file' && !e.name.endsWith('.meta'))
      .map((e) => (dir ? `${dir}/${e.name}` : e.name))
      .sort()
  }

  private parseMeta(text: string, metaPath: string): MetaFile {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (cause) {
      throw new ShardError('assets/invalid-meta', `${metaPath} isn't valid JSON`, {
        path: metaPath,
        cause,
      })
    }
    if (!isPlainObject(json) || typeof json.guid !== 'string' || json.guid === '') {
      throw new ShardError('assets/invalid-meta', `${metaPath} has no "guid"`, {
        path: '/guid',
        hint: 'Delete the .meta to get a new guid (references by guid will break), or restore it.',
      })
    }
    if (json.settings !== undefined && !isPlainObject(json.settings)) {
      throw new ShardError('assets/invalid-meta', `${metaPath}: "settings" must be an object`, {
        path: '/settings',
      })
    }
    return json as unknown as MetaFile
  }

  private resolveFrom(sourcePath: string, path: string): string {
    if (path.startsWith('/')) return normalizePath(path)
    const hash = path.indexOf('#')
    const file = hash === -1 ? path : path.slice(0, hash)
    const label = hash === -1 ? '' : path.slice(hash)
    // Paths that already start at an asset root are project paths.
    if (this.roots.some((r) => file.startsWith(`${r}/`))) return normalizePath(file) + label
    const resolved = file === '' ? sourcePath : normalizePath(`${dirnameOf(sourcePath)}/${file}`)
    return resolved + label
  }

  /** Writes an artifact under its content hash; returns its cache-relative path. */
  private async writeArtifact(data: Uint8Array | string, ext: 'bin' | 'json'): Promise<string> {
    const bytes = typeof data === 'string' ? encoder.encode(data) : data
    const hash = await sha256Hex(bytes)
    const file = `artifacts/${hash.slice(0, 2)}/${hash}.${ext}`
    const fs = this.platform?.fs
    if (fs?.writable) {
      const path = `${this.cacheDir}/${file}`
      if (!(await fs.exists(path))) await fs.writeBytes(path, bytes)
    } else {
      this.memory.set(file, data)
    }
    return file
  }

  private async walk(roots: readonly string[]): Promise<string[]> {
    const fs = this.platform!.fs
    const out: string[] = []
    const visit = async (dir: string): Promise<void> => {
      const entries = await fs.list!(dir)
      await Promise.all(
        entries.map(async (e) => {
          if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) return
          const path = dir === '' ? e.name : `${dir}/${e.name}`
          if (e.kind === 'dir') await visit(path)
          else out.push(path)
        }),
      )
    }
    await Promise.all(roots.map((r) => visit(r)))
    return out.sort()
  }

  // --- records and entries -------------------------------------------------------

  private setSource(record: SourceRecord, previous: SourceRecord | undefined): void {
    this.sources.set(record.path, record)
    const labels = new Set(record.assets.map((a) => a.label))
    if (previous) {
      for (const a of previous.assets) {
        if (labels.has(a.label) && previous.guid === record.guid) continue
        const entry = this.entries.get(subGuid(previous.guid, a.label))
        if (!entry) continue
        if (entry.state === 'loaded') this.unloadEntry(entry)
        this.removeEntry(entry)
        this.emit(entry, 'removed')
      }
    }
    for (const a of record.assets) {
      const guid = subGuid(record.guid, a.label)
      const existing = this.entries.get(guid)
      if (existing) {
        existing.error = undefined
        continue
      }
      this.addEntry({
        guid,
        path: subPath(record.path, a.label),
        type: a.type,
        label: a.label,
        source: record.path,
        state: 'unloaded',
        error: undefined,
        version: 0,
      })
    }
  }

  private rekeySource(record: SourceRecord, to: string): void {
    const from = record.path
    // Runtime dependencies on the moved source (its own sub-assets, or other assets') follow it.
    for (const r of this.sources.values()) {
      for (const a of r.assets) {
        a.dependencies = a.dependencies.map((d) =>
          d === from || d.startsWith(`${from}#`) ? to + d.slice(from.length) : d,
        )
      }
    }
    this.sources.delete(record.path)
    record.path = to
    this.sources.set(to, record)
    for (const a of record.assets) {
      const entry = this.entries.get(subGuid(record.guid, a.label))
      if (!entry) continue
      this.byPath.delete(entry.path)
      entry.path = subPath(to, a.label)
      entry.source = to
      this.byPath.set(entry.path, entry)
    }
  }

  private addEntry(entry: AssetEntry): void {
    this.entries.set(entry.guid, entry)
    this.byPath.set(entry.path, entry)
  }

  private removeEntry(entry: AssetEntry): void {
    this.entries.delete(entry.guid)
    if (this.byPath.get(entry.path) === entry) this.byPath.delete(entry.path)
  }

  private async loadIndex(): Promise<void> {
    if (this.indexLoaded) return
    this.indexLoaded = true
    const fs = this.platform!.fs
    const path = `${this.cacheDir}/index.json`
    if (!(await fs.exists(path))) return
    try {
      const json = JSON.parse(await fs.readText(path)) as {
        version: number
        sources: SourceRecord[]
      }
      if (json.version !== INDEX_VERSION) return
      for (const r of json.sources) this.setSource(r, this.sources.get(r.path))
    } catch {
      // A corrupt index only costs a re-import.
    }
  }

  /**
   * Hosts that can't list files read the catalog a writable host wrote. Each call re-reads it and
   * reloads assets whose import key changed, so a dev server's re-imports reach the page.
   */
  private async refreshCatalog(report: ScanReport): Promise<void> {
    const fs = this.platform!.fs
    if (!(await fs.exists(this.catalogPath))) return
    const json = JSON.parse(await fs.readText(this.catalogPath)) as {
      version: number
      cacheDir?: string
      sources: SourceRecord[]
    }
    if (json.cacheDir) this.cacheDir = json.cacheDir
    const seen = new Set<string>()
    const changed: SourceRecord[] = []
    for (const r of json.sources) {
      seen.add(r.path)
      const previous = this.sources.get(r.path)
      if (
        previous &&
        previous.key === r.key &&
        JSON.stringify(previous.error) === JSON.stringify(r.error)
      ) {
        report.unchanged++
        continue
      }
      this.setSource(r, previous)
      if (previous) {
        changed.push(r)
        report.imported.push(r.path)
      }
      if (r.error) report.failed.push({ path: r.path, error: r.error })
    }
    for (const r of [...this.sources.values()]) {
      if (seen.has(r.path)) continue
      this.sources.delete(r.path)
      for (const a of r.assets) {
        const entry = this.entries.get(subGuid(r.guid, a.label))
        if (!entry) continue
        if (entry.state === 'loaded') this.unloadEntry(entry)
        this.removeEntry(entry)
        this.emit(entry, 'removed')
      }
      report.removed.push(r.path)
    }
    await Promise.all(
      changed.flatMap((record) =>
        record.assets.map((a) => {
          const entry = this.entries.get(subGuid(record.guid, a.label))
          return entry?.state === 'loaded' ? this.loadEntry(entry, true).catch(() => {}) : undefined
        }),
      ),
    )
  }

  private async saveIndex(): Promise<void> {
    const fs = this.platform!.fs
    const sources = [...this.sources.values()].sort((a, b) => a.path.localeCompare(b.path))
    const body = JSON.stringify({ version: INDEX_VERSION, sources }, null, 1)
    await fs.writeText(`${this.cacheDir}/index.json`, body)
    const catalog = {
      version: INDEX_VERSION,
      cacheDir: this.cacheDir,
      sources: sources.map(({ deps: _d, ...rest }) => ({ ...rest, deps: [] })),
    }
    await fs.writeText(this.catalogPath, JSON.stringify(catalog))
  }

  // --- editing -------------------------------------------------------------------

  /**
   * Changes import settings (merged into the `.meta`) and re-imports. Resolves with the scan
   * report; the asset reloads in place if it was loaded.
   */
  async reimport(
    ref: AssetRef | string,
    options: { settings?: Record<string, JsonValue> } = {},
  ): Promise<ScanReport> {
    const entry = this.entry(ref)
    const source = entry?.source ?? (typeof ref === 'string' ? ref : undefined)
    const record = source === undefined ? undefined : this.sources.get(source)
    if (!record) {
      throw new ShardError('assets/not-found', `No imported source for ${JSON.stringify(ref)}`, {
        hint: 'Pass a source path like "assets/ship.glb" or one of its sub-assets.',
      })
    }
    const fs = this.requireWritable()
    if (options.settings) {
      const metaPath = `${record.path}.meta`
      const meta = (await fs.exists(metaPath))
        ? this.parseMeta(await fs.readText(metaPath), metaPath)
        : { guid: record.guid, importer: record.importer, settings: record.settings }
      const importer = findImporter(meta.importer ?? record.importer) ?? importerFor(record.path)!
      const merged = { ...(meta.settings ?? {}), ...options.settings }
      const errors = importer.settings.validate(merged)
      if (errors.length > 0) {
        throw new ShardError('assets/invalid-meta', errors[0]!.message, {
          path: `/settings${errors[0]!.path ?? ''}`,
          hint: errors[0]!.hint,
          details: errors,
        })
      }
      meta.settings = merged
      await fs.writeText(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    }
    return this.scan({ force: [record.path] })
  }

  /**
   * Moves a source and its `.meta`, then rewrites references to it in scene files and JSON data
   * assets. The guid is unchanged, so loaded assets stay loaded.
   */
  async move(from: string, to: string): Promise<{ from: string; to: string; rewritten: string[] }> {
    const fs = this.requireWritable()
    from = normalizePath(from)
    to = normalizePath(to)
    const record = this.sources.get(from)
    if (!record) {
      throw new ShardError('assets/not-found', `No imported source at "${from}"`, {
        hint: 'Pass the source file path, e.g. "assets/ship.glb".',
      })
    }
    if (await fs.exists(to)) {
      throw new ShardError('assets/move-target-exists', `"${to}" already exists`)
    }
    if (!this.roots.some((r) => to.startsWith(`${r}/`))) {
      throw new ShardError('assets/outside-roots', `"${to}" isn't under an asset root`, {
        hint: `Asset roots: ${this.roots.join(', ')}.`,
      })
    }
    await fs.move!(from, to)
    if (await fs.exists(`${from}.meta`)) await fs.move!(`${from}.meta`, `${to}.meta`)
    this.rekeySource(record, to)
    const st = await fs.stat!(to)
    const metaSt = await fs.stat!(`${to}.meta`)
    if (st) {
      record.size = st.size
      record.mtime = st.mtime
    }
    if (metaSt) {
      record.metaSize = metaSt.size
      record.metaMtime = metaSt.mtime
    }
    const rewritten = await this.rewriteReferences(from, to)
    await this.saveIndex()
    return { from, to, rewritten }
  }

  private async rewriteReferences(from: string, to: string): Promise<string[]> {
    const fs = this.platform!.fs
    const files = (await this.walkProject()).filter(
      (f) => f.endsWith('.json') && !f.endsWith('.meta'),
    )
    const rewritten: string[] = []
    const rewrite = (value: unknown): boolean => {
      if (value === null || typeof value !== 'object') return false
      let changed = false
      if (Array.isArray(value)) {
        for (const v of value) changed = rewrite(v) || changed
        return changed
      }
      const obj = value as Record<string, unknown>
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'path' && typeof v === 'string' && (v === from || v.startsWith(`${from}#`))) {
          obj[k] = to + v.slice(from.length)
          changed = true
        } else if (typeof v === 'object') {
          changed = rewrite(v) || changed
        }
      }
      return changed
    }
    for (const file of files) {
      const text = await fs.readText(file)
      if (!text.includes(from)) continue
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        continue
      }
      if (rewrite(json)) {
        await fs.writeText(file, `${JSON.stringify(json, null, 2)}\n`)
        rewritten.push(file)
      }
    }
    return rewritten.sort()
  }

  private async walkProject(): Promise<string[]> {
    const fs = this.platform!.fs
    const out: string[] = []
    const visit = async (dir: string): Promise<void> => {
      for (const e of await fs.list!(dir)) {
        if (e.name.startsWith('.') || IGNORED_DIRS.has(e.name)) continue
        const path = dir === '' ? e.name : `${dir}/${e.name}`
        if (e.kind === 'dir') await visit(path)
        else out.push(path)
      }
    }
    await visit('')
    return out
  }

  private requireWritable() {
    const fs = this.platform?.fs
    if (!fs?.writable || !fs.move || !fs.list || !fs.stat) {
      throw new ShardError('assets/read-only', 'This host can’t change asset files', {
        hint: 'Use the CLI or Studio, which can write to the project folder.',
      })
    }
    return fs
  }

  // --- watching ------------------------------------------------------------------

  /** Re-scans (debounced) when files under the asset roots change. Returns a stop function. */
  async watch(options: { debounceMs?: number; onScan?: (report: ScanReport) => void } = {}) {
    const fs = this.platform?.fs
    if (!fs?.watch) return () => {}
    const debounce = options.debounceMs ?? 50
    let timer: ReturnType<typeof setTimeout> | undefined
    const trigger = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        void this.scan().then((r) => options.onScan?.(r))
      }, debounce)
    }
    const stops: (() => void)[] = []
    for (const root of this.roots) {
      if (!(await fs.exists(root))) continue
      stops.push(await fs.watch(root, trigger))
    }
    return () => {
      if (timer) clearTimeout(timer)
      for (const s of stops) s()
    }
  }
}

export const AssetServerResource = defineResource<AssetServer>('assets/Server', {
  description: 'The asset database: catalog, imports, loading, hot reload.',
})

/** The world's asset server, created (memory only, no files) on first use. */
export function assetServer(world: World): AssetServer {
  let server = world.tryResource(AssetServerResource)
  if (!server) {
    server = new AssetServer(world)
    world.insertResource(AssetServerResource, server)
  }
  return server
}
