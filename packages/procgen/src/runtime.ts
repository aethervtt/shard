import {
  type Artifact,
  type AssetEntry,
  type AssetServer,
  AssetStore,
  assetServer,
  defineAssetType,
  findAssetType,
  sha256Hex,
} from '@aethervtt/shard-assets'
import {
  type AnyField,
  type AssetRef,
  defineResource,
  type Fields,
  isPlainObject,
  type JsonValue,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import type { KeyValueStorage, PlatformFileSystem, Workers } from '@aethervtt/shard-platform'
import { LogResource } from '@aethervtt/shard-runtime'
import {
  codeHashOf,
  findGenerator,
  type Generator,
  type GenParams,
  type GenRequest,
  guidOf,
  identityOf,
  type OutputAsset,
  type OutputSpec,
  proceduralPath,
  requestOf,
  requireGenerator,
} from './generator'
import { executeJob, type GenJob, type GenResult, type JobDependency } from './job'
import { checkFragment, type GenOutputAsset } from './outputs'
import { decodeRecord, encodeRecord, type OutputRecord, recordBytes } from './record'

const encoder = new TextEncoder()

// --- asset types -------------------------------------------------------------------------------

/**
 * What a `Generator` asset names: a generator, plus defaults for its seed and params (a
 * `*.gen.json` file's `#Generator` sub-asset). Generators by name (`star-explorer/Rock`) are
 * `Generator` assets with just the name.
 */
export interface GeneratorBinding {
  generator: string
  seed?: number
  params?: Record<string, JsonValue>
}

export const GeneratorBindings = defineResource<AssetStore<GeneratorBinding, 'Generator'>>(
  'procgen/Generators',
  {
    description: 'Generator assets (a generator and default params) by guid.',
    init: () => new AssetStore('Generator'),
  },
)

export const GeneratorAssetType = defineAssetType<GeneratorBinding>('Generator', {
  store: GeneratorBindings as never,
  load: (artifact) => artifact.json as unknown as GeneratorBinding,
})

/** Untyped `data` outputs, by guid. */
export const GeneratedData = defineResource<AssetStore<JsonValue, 'Data'>>('procgen/Data', {
  description: 'Values of generators whose output is untyped data.',
  init: () => new AssetStore('Data'),
})

export const DataAssetType = defineAssetType<JsonValue>('Data', {
  store: GeneratedData as never,
  load: (artifact) => artifact.json ?? null,
})

// --- host --------------------------------------------------------------------------------------

export interface ProcgenHost {
  /** The worker pool generators run on. */
  workers?: Workers
  /**
   * URL of a module exporting `runGeneratorJob` with every generator defined (the project bundle
   * plus `@aethervtt/shard-procgen/worker`, built self-contained by the host). Without it, jobs run inline.
   */
  workerModule?: string | Promise<string>
}

let host: ProcgenHost = {}

/** Tells procgen where jobs run (workers and the worker bundle). Hosts call it at startup. */
export function configureProcgenHost(options: ProcgenHost): void {
  host = { ...host, ...options }
}

export function procgenHost(): Readonly<ProcgenHost> {
  return host
}

/**
 * Starts every worker and loads the worker module in it, so the first jobs don't pay for thread
 * startup. Resolves once all are ready; hosts can call it without waiting.
 */
export async function warmGeneratorWorkers(): Promise<void> {
  const { workers } = host
  const workerModule = await host.workerModule
  if (!workers || workers.size === 0 || !workerModule) return
  const jobs: Promise<unknown>[] = []
  for (let i = 0; i < workers.size; i++) jobs.push(workers.run(workerModule, 'warmUp', []))
  await Promise.all(jobs)
}

// --- main-thread slices ------------------------------------------------------------------------

/** Main-thread procgen work (posting jobs, turning results into assets) per slice, in ms. */
const SLICE_MS = 0.25
const waiting: (() => void)[] = []
let sliceStart = -1
let pumping = false
let stepStart = -1
let mainThreadMs = 0

const nextTask: (run: () => void) => void =
  typeof setImmediate === 'function'
    ? (run) => void setImmediate(run)
    : (run) => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => run()
        channel.port2.postMessage(0)
      }

function pump(): void {
  if (stepStart >= 0) {
    mainThreadMs += performance.now() - stepStart
    stepStart = -1
  }
  if (waiting.length === 0) {
    sliceStart = -1
    pumping = false
    return
  }
  if (sliceStart < 0) sliceStart = performance.now()
  else if (performance.now() - sliceStart > SLICE_MS) {
    // Over budget: let a frame (and everything else) run first.
    sliceStart = -1
    nextTask(pump)
    return
  }
  stepStart = performance.now()
  waiting.shift()!()
  // Runs after the step's synchronous part, which is queued first.
  queueMicrotask(pump)
}

/**
 * Milliseconds of main-thread procgen work so far (the steps `mainThreadTurn` ran): sample it
 * each frame to see what generation costs the frame.
 */
export function procgenMainThreadMs(): number {
  return mainThreadMs
}

/**
 * Waits for a turn on the main thread: steps run back to back until about a quarter of a millisecond has
 * passed, then yield to the event loop, so a burst of finished jobs spreads over frames.
 */
export function mainThreadTurn(): Promise<void> {
  return new Promise((resolve) => {
    waiting.push(resolve)
    if (!pumping) {
      pumping = true
      nextTask(pump)
    }
  })
}

// --- jobs --------------------------------------------------------------------------------------

let running = 0
const queued: (() => void)[] = []

/**
 * Runs a job: on the worker pool when the host gave a worker module and every dependency travels
 * as an artifact, otherwise inline (after an await, so callers never block on it). At most two
 * jobs per worker are posted at once; the rest wait their turn.
 */
export async function runJob(job: GenJob): Promise<GenResult & { packed?: Uint8Array }> {
  const pool = host.workers
  // A module still building (after a hot reload) is waited for: the old one runs old code.
  const workerModule = await host.workerModule
  if (pool && pool.size > 0 && workerModule && job.deps.every((d) => d.artifact)) {
    const kernel = await loadNoiseKernel()
    if (running >= pool.size * 2) await new Promise<void>((resolve) => queued.push(resolve))
    running++
    try {
      await mainThreadTurn()
      const posted: GenJob = {
        ...job,
        // The worker bundle can be older than this thread's component schemas.
        checkComponents: false,
        deps: job.deps.map(({ object: _o, ...d }) => d),
        noise: kernel.module,
        noiseSimd: kernel.simd,
      }
      const { packed } = await pool.run<{ packed: Uint8Array }>(workerModule, 'runGeneratorJob', [
        posted,
      ])
      const record = decodeRecord(packed)
      if (!record) {
        throw new ShardError(
          'procgen/generator-failed',
          `${job.generator}: a worker sent back no record`,
        )
      }
      const gen = requireGenerator(job.generator)
      if (gen.output === 'entities') {
        await mainThreadTurn()
        for (const a of record.assets) if (a.type === 'Prefab') checkFragment(gen, a)
      }
      return {
        assets: record.assets,
        children: record.children,
        warnings: record.warnings,
        ms: record.ms,
        packed,
      }
    } finally {
      running--
      queued.shift()?.()
    }
  }
  await Promise.resolve()
  return executeJob(job)
}

function artifactOf(asset: GenOutputAsset): Artifact {
  const out: { bytes?: Uint8Array; json?: JsonValue } = {}
  if (asset.bytes) out.bytes = asset.bytes
  if (asset.json !== undefined) out.json = asset.json
  return out
}

// --- per-world runtime -------------------------------------------------------------------------

export interface ProcgenOptions {
  /** Project files: records are written to `<cacheDir>/generated/` when it's writable. */
  fs?: PlatformFileSystem
  /** Where records go on hosts that can't write files (browsers: IndexedDB). */
  storage?: KeyValueStorage
  /** Default `.shard/cache`. */
  cacheDir?: string
  /** Bytes of records kept in memory, and in `storage`. Default 256 MB. */
  cacheSize?: number
}

/** What happened to one output the last time it was made. */
export type CacheResult = 'memory' | 'disk' | 'run' | 'shared'

interface Live {
  request: GenRequest
  label: string
  /** The content key the object was made from, and what it depended on. */
  key: string | undefined
  codeHash: string
  deps: Map<string, number>
  hit: CacheResult | undefined
  ms: number
}

export interface ProcgenStats {
  runs: number
  memoryHits: number
  diskHits: number
  failures: number
  /** Main-thread ms spent turning finished jobs into assets (bench: per frame). */
  mainMs: number
}

function collectHandles(fields: Fields, value: JsonValue, out: { guid?: string; path?: string }[]) {
  if (!isPlainObject(value)) return
  for (const [key, field] of Object.entries(fields)) visitHandle(field, value[key], out)
}

function visitHandle(
  field: AnyField,
  value: JsonValue | undefined,
  out: { guid?: string; path?: string }[],
): void {
  if (value === null || value === undefined) return
  if (field.kind === 'handle' && isPlainObject(value)) {
    out.push(value as { guid?: string; path?: string })
  } else if (field.kind === 'struct' && field.fields) {
    collectHandles(field.fields, value, out)
  } else if (field.kind === 'list' && field.item && Array.isArray(value)) {
    for (const v of value) visitHandle(field.item, v, out)
  }
}

/** Handles in a request's params, in field order. */
export function paramHandles(
  gen: Generator,
  params: JsonValue,
): { guid?: string; path?: string }[] {
  const out: { guid?: string; path?: string }[] = []
  collectHandles(gen.params.fields, params, out)
  return out
}

/**
 * Generator outputs for one world: each request is a virtual asset `gen:<identity>` (with sub-assets
 * like `gen:<identity>/LOD1`), made from a content-addressed record that's looked up in memory,
 * then on disk (or platform storage), and generated on the pool when it's in neither.
 */
export class ProcgenRuntime {
  readonly world: World
  readonly server: AssetServer
  options: Required<Pick<ProcgenOptions, 'cacheDir' | 'cacheSize'>> & ProcgenOptions
  readonly stats: ProcgenStats = { runs: 0, memoryHits: 0, diskHits: 0, failures: 0, mainMs: 0 }
  private readonly memory = new Map<string, OutputRecord>()
  private memoryBytes = 0
  private readonly stored: { key: string; bytes: number }[] = []
  private storedBytes = 0
  private readonly inflight = new Map<
    string,
    { promise: Promise<OutputRecord>; generator: string; started: number }
  >()
  private readonly live = new Map<string, Live>()
  private readonly requests = new Map<string, GenRequest>()
  /** Imported dependencies' artifacts and hashes, by guid (valid while the version matches). */
  private readonly artifacts = new Map<
    string,
    { version: number; artifact: Artifact; hash: string }
  >()
  private pendingDeps = new Set<string>()
  /** Regenerations under way, by guid: the code hash and dependency versions each started for. */
  private readonly regenerating = new Map<string, Pick<Live, 'codeHash' | 'deps'>>()

  constructor(world: World, options: ProcgenOptions = {}) {
    this.world = world
    this.server = assetServer(world)
    this.options = { cacheDir: '.shard/cache', cacheSize: 256 * 1024 * 1024, ...options }
    this.server.onEvent((e) => {
      if (e.kind !== 'modified') return
      for (const live of this.live.values()) {
        if (live.deps.has(e.guid)) {
          this.pendingDeps.add(e.guid)
          queueMicrotask(() => this.regenerateForDeps())
          return
        }
      }
    })
  }

  configure(options: ProcgenOptions): this {
    this.options = { ...this.options, ...options }
    return this
  }

  /** The output entry of a request (label '' or a sub-asset like 'LOD1'), registered lazily. */
  entryFor(request: GenRequest, label = ''): AssetEntry {
    const gen = requireGenerator(request.generator)
    const base = guidOf(request)
    if (!this.requests.has(base)) this.requests.set(base, request)
    const guid = label === '' ? base : `${base}/${label}`
    const existing = this.server.entry(guid)
    if (existing) return existing
    const path = label === '' ? proceduralPath(request) : `${proceduralPath(request)}#${label}`
    const type = label === '' ? gen.outputType : 'Mesh'
    return this.server.virtual(guid, path, type, () => this.produceLogged(guid), {
      lazy: true,
      collectable: true,
    })
  }

  /** Generates (or finds cached) an output and resolves with its ref once it's loaded. */
  async generate<const P extends Fields, const O extends OutputSpec>(
    gen: Generator<P, O>,
    params: GenParams<P> = {},
    seed = 0,
  ): Promise<AssetRef<OutputAsset<O>>> {
    const request = requestOf(gen as unknown as Generator, params, seed)
    const entry = this.entryFor(request)
    await this.server.load(entry.guid)
    return { type: gen.outputType, guid: entry.guid, path: entry.path } as AssetRef<OutputAsset<O>>
  }

  /** What the last make of an output did: cache result, key, and time. */
  lastResult(
    guid: string,
  ): { hit: CacheResult | undefined; key: string | undefined; ms: number } | undefined {
    const live = this.live.get(guid)
    return live && { hit: live.hit, key: live.key, ms: live.ms }
  }

  /** The cached record behind a loaded output, if it's still in memory. */
  recordOf(guid: string): OutputRecord | undefined {
    const key = this.live.get(guid)?.key
    return key ? this.memory.get(key) : undefined
  }

  /** `produce`, with failures logged (a GeneratorInstance or scene waiting on it shows why). */
  private async produceLogged(guid: string): Promise<unknown> {
    try {
      return await this.produce(guid)
    } catch (err) {
      this.world.tryResource(LogResource)?.error(err)
      throw err
    }
  }

  /** Makes the object of `gen:<identity>[/label]`: the virtual asset's `create`. */
  private async produce(guid: string): Promise<unknown> {
    const slash = guid.indexOf('/')
    const base = slash === -1 ? guid : guid.slice(0, slash)
    const label = slash === -1 ? '' : guid.slice(slash + 1)
    const entry = this.server.entry(guid)!
    const request = this.requests.get(base) ?? this.requestOfPath(entry.path)
    // Hashing inputs and checking caches is main-thread work too: one request at a time.
    await mainThreadTurn()
    const { record, hit, deps, codeHash } = await this.recordFor(request)
    await mainThreadTurn()
    const start = performance.now()
    const asset = record.assets.find((a) => a.label === label)
    if (!asset) {
      throw new ShardError('assets/not-found', `${request.generator} made no "${label}"`, {
        path: entry.path,
        hint: `Its outputs: ${record.assets.map((a) => a.label || '(main)').join(', ')}.`,
      })
    }
    const type = findAssetType(asset.type)
    if (!type) {
      throw new ShardError('assets/unknown-type', `No asset type "${asset.type}" is registered`, {
        path: entry.path,
        hint: 'Add the plugin that defines it (render/forward for meshes, textures).',
      })
    }
    const self = label === '' ? guid : base
    const object = await type.load(artifactOf(asset), {
      guid,
      path: entry.path,
      resolve: (p) =>
        p.startsWith('#') ? this.server.resolve(`${self}/${p.slice(1)}`) : this.server.resolve(p),
    })
    this.live.set(guid, { request, label, key: record.key, codeHash, deps, hit, ms: record.ms })
    if (label === '') {
      // Sub-assets (levels of detail) and nested outputs resolve from now on.
      for (const a of record.assets) if (a.label !== '') this.entryFor(request, a.label)
      for (const child of record.children) {
        try {
          this.entryFor(child)
        } catch (err) {
          this.world.tryResource(LogResource)?.error(err)
        }
      }
      const log = this.world.tryResource(LogResource)
      for (const w of record.warnings)
        log?.warn(`${request.generator}: ${w.message}`, { code: 'procgen/warning', path: w.path })
    }
    this.stats.mainMs += performance.now() - start
    return object
  }

  private requestOfPath(path: string): GenRequest {
    const hash = path.indexOf('#')
    const spec = (hash === -1 ? path : path.slice(0, hash)).slice('procedural:'.length)
    // Lazily imported to keep generator.ts free of the runtime.
    return parseRef(spec)
  }

  /** The dependencies of a request: loaded, with their artifacts (for workers) and hashes. */
  private async dependencies(
    gen: Generator,
    request: GenRequest,
  ): Promise<{ deps: JobDependency[]; hashes: string[]; versions: Map<string, number> }> {
    const deps: JobDependency[] = []
    const hashes: string[] = []
    const versions = new Map<string, number>()
    for (const ref of paramHandles(gen, request.params)) {
      const entry = this.server.entry(ref)
      if (!entry) {
        throw new ShardError(
          'procgen/dependency-failed',
          `${gen.name} needs ${ref.path ?? ref.guid}, which isn't in the catalog`,
          { hint: 'Check the path, or run `shard import` for new files.' },
        )
      }
      await this.server.load(entry.guid)
      versions.set(entry.guid, entry.version)
      const type = findAssetType(entry.type)
      const object = type ? this.world.initResource(type.store).byGuid(entry.guid) : undefined
      const dep: JobDependency = {
        guid: ref.guid ?? entry.guid,
        path: ref.path ?? entry.path,
        type: entry.type,
        object,
      }
      if (entry.source !== undefined) {
        let cached = this.artifacts.get(entry.guid)
        if (cached?.version !== entry.version) {
          cached = {
            version: entry.version,
            artifact: await this.server.artifact(entry.guid),
            hash: JSON.stringify(this.server.info(entry.guid).artifact ?? entry.guid),
          }
          this.artifacts.set(entry.guid, cached)
        }
        dep.artifact = cached.artifact
        hashes.push(cached.hash)
      } else {
        const live = this.live.get(entry.guid)
        const record = live?.key ? this.memory.get(live.key) : undefined
        const asset = record?.assets.find((a) => a.label === live!.label)
        if (asset) dep.artifact = artifactOf(asset)
        hashes.push(live?.key ? `${live.key}#${live.label}` : `${entry.guid}@${entry.version}`)
      }
      deps.push(dep)
    }
    return { deps, hashes, versions }
  }

  private async recordFor(request: GenRequest): Promise<{
    record: OutputRecord
    hit: CacheResult
    deps: Map<string, number>
    codeHash: string
  }> {
    const gen = requireGenerator(request.generator)
    const { deps, hashes, versions } = await this.dependencies(gen, request)
    const codeHash = codeHashOf(gen)
    const key = await sha256Hex(
      encoder.encode(
        JSON.stringify([gen.name, gen.version, codeHash, request.params, request.seed, hashes]),
      ),
    )
    const cached = this.memory.get(key)
    if (cached) {
      // Most recently used goes last.
      this.memory.delete(key)
      this.memory.set(key, cached)
      this.stats.memoryHits++
      return { record: cached, hit: 'memory', deps: versions, codeHash }
    }
    const running = this.inflight.get(key)
    if (running) return { record: await running.promise, hit: 'shared', deps: versions, codeHash }
    let hit: CacheResult = 'run'
    const promise = (async () => {
      const stored = await this.readStored(key)
      if (stored) {
        hit = 'disk'
        this.stats.diskHits++
        return stored
      }
      let result: GenResult & { packed?: Uint8Array }
      try {
        result = await runJob({ ...request, deps, chain: [] })
      } catch (err) {
        this.stats.failures++
        throw err
      }
      this.stats.runs++
      const record: OutputRecord = {
        key,
        assets: result.assets,
        children: result.children,
        warnings: result.warnings,
        ms: result.ms,
        bytes: recordBytes(result.assets),
      }
      void this.writeStored(record, result.packed).catch((err) =>
        this.world.tryResource(LogResource)?.error(err),
      )
      return record
    })()
    this.inflight.set(key, { promise, generator: gen.name, started: performance.now() })
    try {
      const record = await promise
      this.remember(record)
      return { record, hit, deps: versions, codeHash }
    } finally {
      this.inflight.delete(key)
    }
  }

  private remember(record: OutputRecord): void {
    if (this.memory.has(record.key)) return
    this.memory.set(record.key, record)
    this.memoryBytes += record.bytes
    for (const [key, r] of this.memory) {
      if (this.memoryBytes <= this.options.cacheSize || key === record.key) break
      this.memory.delete(key)
      this.memoryBytes -= r.bytes
    }
  }

  private storedPath(key: string): string {
    return `${this.options.cacheDir}/generated/${key.slice(0, 2)}/${key}`
  }

  private async readStored(key: string): Promise<OutputRecord | undefined> {
    const fs = this.options.fs
    try {
      let record: OutputRecord | undefined
      if (fs && (await fs.exists(this.storedPath(key))))
        record = decodeRecord(await fs.readBytes(this.storedPath(key)))
      else {
        const bytes = await this.options.storage?.read(`procgen/${key}`)
        record = bytes ? decodeRecord(bytes) : undefined
      }
      // Packed on a worker before the key was known: the file name is the key.
      if (record) record.key = key
      return record
    } catch {
      return undefined // a damaged record only costs a re-run
    }
  }

  private async writeStored(record: OutputRecord, packed?: Uint8Array): Promise<void> {
    const fs = this.options.fs
    if (fs?.writable) {
      await fs.writeBytes(this.storedPath(record.key), packed ?? encodeRecord(record))
      return
    }
    const storage = this.options.storage
    if (!storage) return
    await storage.write(`procgen/${record.key}`, packed ?? encodeRecord(record))
    this.stored.push({ key: record.key, bytes: record.bytes })
    this.storedBytes += record.bytes
    while (this.storedBytes > this.options.cacheSize && this.stored.length > 1) {
      const old = this.stored.shift()!
      this.storedBytes -= old.bytes
      await storage.delete(`procgen/${old.key}`)
    }
  }

  // --- hot reload ------------------------------------------------------------------------------

  private regenerate(guid: string): void {
    const entry = this.server.entry(guid)
    if (entry?.state !== 'loaded') return
    // What it regenerates for: until it lands, `live` still describes the output it replaces.
    const live = this.live.get(guid)
    let target: Pick<Live, 'codeHash' | 'deps'> | undefined
    const gen = live && findGenerator(live.request.generator)
    if (live && gen) {
      const deps = new Map<string, number>()
      for (const dep of live.deps.keys()) deps.set(dep, this.server.entry(dep)?.version ?? -1)
      target = { codeHash: codeHashOf(gen), deps }
      this.regenerating.set(guid, target)
    }
    const produce = () =>
      this.produceLogged(guid).finally(() => {
        if (this.regenerating.get(guid) === target) this.regenerating.delete(guid)
      })
    this.server.updateVirtual(guid, entry.path, entry.type, produce, { collectable: true })
  }

  private regenerateForDeps(): void {
    const changed = this.pendingDeps
    if (changed.size === 0) return
    this.pendingDeps = new Set()
    for (const [guid, live] of this.live) {
      if ([...live.deps.keys()].some((g) => changed.has(g))) this.regenerate(guid)
    }
  }

  /**
   * Regenerates loaded outputs whose generator's code hash changed (or whose generator was
   * redefined) and those whose dependencies reloaded. They swap in place when ready; returns their
   * paths. One already regenerating for the current code and dependencies isn't stale.
   */
  regenerateStale(): string[] {
    const out: string[] = []
    for (const [guid, live] of this.live) {
      const entry = this.server.entry(guid)
      if (entry?.state !== 'loaded') continue
      const gen = findGenerator(live.request.generator)
      if (!gen) continue // the generator is gone; keep the last output
      const made = this.regenerating.get(guid) ?? live
      let stale = codeHashOf(gen) !== made.codeHash
      for (const [dep, version] of made.deps) {
        if (this.server.entry(dep)?.version !== version) stale = true
      }
      if (!stale) continue
      this.regenerate(guid)
      out.push(entry.path)
    }
    return out.sort()
  }

  /** Jobs running now, for procgen.describe. */
  inFlight(): { generator: string; key: string; ms: number }[] {
    const now = performance.now()
    return [...this.inflight].map(([key, j]) => ({
      generator: j.generator,
      key,
      ms: Math.round(now - j.started),
    }))
  }

  cacheStats(): { records: number; bytes: number; limit: number; live: number } {
    return {
      records: this.memory.size,
      bytes: this.memoryBytes,
      limit: this.options.cacheSize,
      live: this.live.size,
    }
  }
}

let parseRef: (spec: string) => GenRequest = () => {
  throw new ShardError('procgen/unknown-generator', 'procedural refs are not set up')
}

/** Set by the package index (keeps a module cycle out of the runtime). */
export function setRefParser(parse: (spec: string) => GenRequest): (spec: string) => GenRequest {
  parseRef = parse
  return parse
}

export const ProcgenResource = defineResource<ProcgenRuntime>('procgen/Runtime', {
  description: 'Generator outputs of this world: caches, in-flight jobs, stats.',
})

/** The world's procgen runtime, created (memory cache only) on first use. */
export function procgen(world: World): ProcgenRuntime {
  let runtime = world.tryResource(ProcgenResource)
  if (!runtime) {
    runtime = new ProcgenRuntime(world)
    world.insertResource(ProcgenResource, runtime)
  }
  return runtime
}

/**
 * Makes a generator's output at runtime (one planet per star) and resolves with a ref to it once
 * it's loaded: cached in memory and on disk by the hash of its inputs, generated on the worker pool.
 */
export function generate<const P extends Fields, const O extends OutputSpec>(
  world: World,
  gen: Generator<P, O>,
  params: GenParams<P> = {},
  seed = 0,
): Promise<AssetRef<OutputAsset<O>>> {
  return procgen(world).generate(gen, params, seed)
}

export { identityOf }
