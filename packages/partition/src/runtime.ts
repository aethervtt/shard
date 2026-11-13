import { type AssetEntry, assetServer } from '@aethervtt/shard-assets'
import {
  ChildOf,
  type ComponentDef,
  defineResource,
  type Entity,
  findComponent,
  isPlainObject,
  type JsonObject,
  type JsonValue,
  onRemove,
  type Query,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import {
  codeHashOf,
  GeneratedData,
  GeneratorInstance,
  outputHash,
  procgen,
  requestOf,
} from '@aethervtt/shard-procgen'
import { LogResource, StepMode, Time } from '@aethervtt/shard-runtime'
import { NoSave } from '@aethervtt/shard-save'
import {
  entityOverrides,
  InstancePart,
  instanceEntities,
  updateInstances,
} from '@aethervtt/shard-scene'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import {
  CellBound,
  CellLoaded,
  CellUnloading,
  Dynamic,
  EntityDormant,
  FarVisible,
  PartitionInstance,
  StreamedCell,
  StreamingBudget,
  StreamingSource,
} from './components'
import {
  addComponents,
  DeltaState,
  mergeOverrides,
  pathOfKey,
  type SavedCellEntity,
  serializeComponents,
  subtractPatch,
} from './delta'
import {
  cellDistance,
  cellKey,
  deltaMigration,
  type Partition,
  type ResolvedGrid,
  requirePartition,
} from './partition'

export type PartitionRole = 'local' | 'server' | 'client'

/**
 * How the partition meets the rest of the app. `partitionNetPlugin` fills these in; without it the
 * app is single-player (`local`).
 */
export interface PartitionHooks {
  role: PartitionRole
  /** Whether a StreamingSource counts here (a client: only its own). Default: all. */
  isSource?(world: World, entity: Entity): boolean
  /** Dynamic besides partition/Dynamic (the server: net/Replicated). */
  isDynamic?(world: World, entity: Entity): boolean
  /** Extra state a dormant entity keeps (net/Replicated, which saves skip). */
  captureExtra?(world: World, entity: Entity): JsonObject | undefined
  restoreExtra?(world: World, entity: Entity, extra: JsonObject): void
  /** Server: a generated entity holding secret components (net binds it). */
  bindSecret?(world: World, entity: Entity, ref: string): void
  /** Client: a cell's level is generated and hashed; ask the server for its delta. */
  requestDelta?(world: World, cell: Cell, level: number, hash: string): void
  /** Client: a loaded cell changed level. */
  levelChanged?(world: World, cell: Cell, level: number, hash: string): void
  /** Client: a cell committed (its entities exist, so the server may bind them). */
  cellCommitted?(world: World, cell: Cell): void
  /** Client: a cell unloaded (or was given up before it loaded). */
  cellDropped?(world: World, cell: Cell): void
  /** Server: per-peer streaming state for partition.describe. */
  describe?(world: World): unknown
}

/** What a generated level holds, read once from its fragment. */
interface FragmentInfo {
  paths: Set<string>
  count: number
  /** Paths whose entity carries a secret component (generator mistakes). */
  secret: string[]
}

export interface Cell {
  readonly key: string
  readonly grid: ResolvedGrid
  readonly x: number
  readonly z: number
  /** Committed level, or -1. */
  level: number
  /** Wanted level, or -1 to unload. */
  target: number
  /** The level being prepared, or -1. */
  pending: number
  entry: AssetEntry | undefined
  secretsEntry: AssetEntry | undefined
  /** In-flight generation, hashing or loading, for partitionSettled. */
  work: Promise<unknown> | undefined
  hash: string | undefined
  hashLevel: number
  /** Client: the server's full delta arrived. */
  deltaReady: boolean
  requested: boolean
  wantedFrame: number
  awaySince: number
  awayTarget: number
  root: Entity
  /** Generated entities by path, at the committed level. */
  entities: Map<string, Entity>
  /** Added entities (`+n`) spawned for this cell. */
  readonly added: Map<string, Entity>
  /** The secrets generator's overrides (server). */
  secrets: Record<string, JsonValue> | undefined
  commitTick: number
  distance: number
  priority: number
  failed: boolean
}

export class InstanceRuntime {
  readonly entity: Entity
  readonly partition: Partition
  readonly seed: number
  readonly secretSeed: number
  readonly cells = new Map<string, Cell>()
  readonly byRoot = new Map<Entity, Cell>()
  /** Source positions at the last check: x, z, scale, priority per source. */
  checked = new Float64Array(0)
  framesSinceCheck = 1e9
  frame = 0
  /** Main-thread milliseconds of the last frame's streaming, for describe and budgets. */
  ms = 0
  /** Entities the last frame committed (cells spawned and levels swapped), and the ms it took. */
  committed = 0
  commitMs = 0

  constructor(entity: Entity, partition: Partition, seed: number, secretSeed: number) {
    this.entity = entity
    this.partition = partition
    this.seed = seed
    this.secretSeed = secretSeed
  }
}

export interface PartitionStateData {
  hooks: PartitionHooks
  readonly instances: Map<Entity, InstanceRuntime>
  /** Deltas by partition name, then cell key. Unloaded and loaded cells alike. */
  readonly deltas: Map<string, Map<string, DeltaState>>
  /** Generated paths changed since the last upkeep, per cell. */
  readonly dirty: Map<Cell, Set<string>>
  /** Our own spawns and despawns: observers ignore them. */
  suppress: number
  lastScan: number
  readonly fragments: Map<string, FragmentInfo>
  readonly observed: Set<ComponentDef>
  readonly warned: Set<string>
}

export const PartitionState = defineResource<PartitionStateData>('partition/State', {
  description: 'Streaming state: instances, their cells, and every cell delta (0113).',
  init: () => ({
    hooks: { role: 'local' },
    instances: new Map(),
    deltas: new Map(),
    dirty: new Map(),
    suppress: 0,
    lastScan: 0,
    fragments: new Map(),
    observed: new Set(),
    warned: new Set(),
  }),
})

const KEEP = 1.2
const REHOME_MARGIN = 1

function state(world: World): PartitionStateData {
  return world.initResource(PartitionState)
}

function log(world: World) {
  return world.tryResource(LogResource)
}

function warnOnce(world: World, key: string, error: ShardError): void {
  const s = state(world)
  if (s.warned.has(key)) return
  s.warned.add(key)
  log(world)?.log('warn', error.message, { code: error.code, path: error.path, hint: error.hint })
}

// --- rings --------------------------------------------------------------------------------------

/** The range within which `level` loads in this role, or -1 if the role never loads it. */
function rangeOf(grid: ResolvedGrid, role: PartitionRole, level: number): number {
  if (role === 'server') return level === 0 ? grid.simulate : -1
  const r = grid.levels[level]!.range
  return role === 'local' && level === 0 ? Math.max(r, grid.simulate) : r
}

function levelCount(grid: ResolvedGrid, role: PartitionRole): number {
  return role === 'server' ? 1 : grid.levels.length
}

function desiredLevel(grid: ResolvedGrid, role: PartitionRole, d: number): number {
  const n = levelCount(grid, role)
  for (let i = 0; i < n; i++) if (d <= rangeOf(grid, role, i)) return i
  return -1
}

/** Whether a cell at `level` is simulated here (its dynamic entities live). */
export function simulated(role: PartitionRole, level: number): boolean {
  return role !== 'client' && level === 0
}

// --- sources ------------------------------------------------------------------------------------

const scratchPos = new Float64Array(3)

function positionOf(world: World, entity: Entity, out: Float64Array): boolean {
  if (!world.isAlive(entity)) return false
  const table = world.entityTable(entity)
  const row = world.entityRow(entity)
  if (table.has(GlobalTransform) && table.has(ChildOf)) {
    const m = table.column(GlobalTransform, 'matrix')
    out[0] = m[row * 12 + 3]!
    out[1] = m[row * 12 + 7]!
    out[2] = m[row * 12 + 11]!
    return true
  }
  if (!table.has(Transform)) return false
  const t = table.column(Transform, 'translation')
  out[0] = t[row * 3]!
  out[1] = t[row * 3 + 1]!
  out[2] = t[row * 3 + 2]!
  return true
}

/** Sources as (x, z, rangeScale, priority) quads. */
function gatherSources(world: World, sources: Query, cameras: Query | undefined): number[] {
  const s = state(world)
  const out: number[] = []
  for (const table of sources.tables) {
    const enabled = table.column(StreamingSource, 'enabled')
    const scale = table.column(StreamingSource, 'rangeScale')
    const priority = table.column(StreamingSource, 'priority')
    for (let row = 0; row < table.count; row++) {
      if (!enabled[row]) continue
      const e = table.entities[row]!
      if (s.hooks.isSource && !s.hooks.isSource(world, e)) continue
      if (!positionOf(world, e, scratchPos)) continue
      out.push(scratchPos[0]!, scratchPos[2]!, scale[row]!, priority[row]!)
    }
  }
  if (cameras && world.resource(StreamingBudget).camerasAreSources) {
    for (const table of cameras.tables) {
      for (let row = 0; row < table.count; row++) {
        if (!positionOf(world, table.entities[row]!, scratchPos)) continue
        out.push(scratchPos[0]!, scratchPos[2]!, 1, 0)
      }
    }
  }
  return out
}

function nearest(grid: ResolvedGrid, x: number, z: number, sources: readonly number[]) {
  let best = Number.POSITIVE_INFINITY
  let priority = 0
  for (let i = 0; i < sources.length; i += 4) {
    const scale = sources[i + 2]! || 1
    const d = cellDistance(grid.cellSize, x, z, sources[i]!, sources[i + 1]!) / scale
    if (d < best) {
      best = d
      priority = sources[i + 3]!
    }
  }
  return { distance: best, priority }
}

function moved(rt: InstanceRuntime, sources: readonly number[]): boolean {
  if (rt.checked.length !== sources.length) return true
  let minCell = Number.POSITIVE_INFINITY
  for (const g of rt.partition.grids) minCell = Math.min(minCell, g.cellSize)
  const limit = minCell / 8
  for (let i = 0; i < sources.length; i += 4) {
    const dx = sources[i]! - rt.checked[i]!
    const dz = sources[i + 1]! - rt.checked[i + 1]!
    if (dx * dx + dz * dz > limit * limit || sources[i + 2] !== rt.checked[i + 2]) return true
  }
  return false
}

// --- deltas -------------------------------------------------------------------------------------

/** The delta of a cell, made empty if it has none. Migrates one written by another version. */
export function deltaOf(world: World, rt: InstanceRuntime, cell: Cell): DeltaState {
  const s = state(world)
  let byCell = s.deltas.get(rt.partition.name)
  if (!byCell) {
    byCell = new Map()
    s.deltas.set(rt.partition.name, byCell)
  }
  const gen = cell.grid.generator
  let delta = byCell.get(cell.key)
  if (!delta) {
    delta = new DeltaState(gen.name, gen.version)
    byCell.set(cell.key, delta)
    return delta
  }
  if (delta.version !== gen.version && s.hooks.role !== 'client') {
    const migrate = deltaMigration(gen.name)
    if (migrate) {
      const migrated = migrate(delta.overrides() as never, delta.version, gen.version)
      for (const k of [...delta.entries.keys()]) if (!k.startsWith('+')) delta.entries.delete(k)
      delta.byPath.clear()
      for (const [k, v] of Object.entries(migrated)) {
        delta.entries.set(k, v as JsonValue)
        delta.revs.set(k, ++delta.rev)
        delta.index(k)
      }
    }
    delta.version = gen.version
  }
  return delta
}

/** The delta stored for a cell, without making one. */
export function storedDelta(world: World, partition: string, key: string): DeltaState | undefined {
  return state(world).deltas.get(partition)?.get(key)
}

function markDirty(world: World, cell: Cell, path: string): void {
  const dirty = state(world).dirty
  let paths = dirty.get(cell)
  if (!paths) {
    paths = new Set()
    dirty.set(cell, paths)
  }
  paths.add(path)
}

/** Brings one generated path's keys up to date in the cell's delta. */
function refreshPath(world: World, rt: InstanceRuntime, cell: Cell, path: string): void {
  const delta = deltaOf(world, rt, cell)
  const live = (world.isAlive(cell.root) && entityOverrides(world, cell.root, path)) || {}
  const next = new Map<string, JsonValue>()
  for (const [k, v] of Object.entries(live)) {
    let value = v as JsonValue
    const base = cell.secrets?.[k]
    if (base !== undefined && isPlainObject(value)) {
      const left = subtractPatch(
        value as JsonObject,
        isPlainObject(base) ? (base as JsonObject) : undefined,
      )
      if (left === null) continue
      value = left
    } else if (base !== undefined && JSON.stringify(base) === JSON.stringify(value)) continue
    next.set(k, value)
  }
  const old = delta.byPath.get(path)
  if (old) {
    for (const k of [...old]) {
      if (next.has(k)) continue
      delta.drop(k, restoreFor(world, cell, path, k, delta.entries.get(k)), path)
    }
  }
  for (const [k, v] of next) delta.set(k, v, path)
}

/** Baseline values for a key leaving the delta, read from the (now baseline) live entity. */
function restoreFor(
  world: World,
  cell: Cell,
  path: string,
  key: string,
  old: JsonValue | undefined,
): JsonValue | undefined {
  const e = cell.entities.get(path)
  if (e === undefined || !world.isAlive(e)) return undefined
  if (key === path && isPlainObject(old)) {
    const out: JsonObject = {}
    for (const [name, fields] of Object.entries(old as JsonObject)) {
      const def = findComponent(name)
      if (!def || !world.has(e, def) || !isPlainObject(fields)) continue
      const now = def.serialize(world.get(e, def) as never)
      const back: JsonObject = {}
      for (const f of Object.keys(fields as JsonObject)) back[f] = now[f] ?? null
      out[name] = back
    }
    return out
  }
  if (key !== path) {
    const name = key.slice(path.length + 1)
    const def = findComponent(name)
    if (def && world.has(e, def)) return { [name]: def.serialize(world.get(e, def) as never) }
  }
  return undefined
}

function isDynamic(world: World, entity: Entity): boolean {
  if (world.has(entity, Dynamic)) return true
  return state(world).hooks.isDynamic?.(world, entity) ?? false
}

function savedEntity(world: World, cell: Cell, entity: Entity): SavedCellEntity {
  const saved: SavedCellEntity = { components: serializeComponents(world, entity) }
  const parent = world.tryGet(entity, ChildOf)?.parent
  if (parent !== undefined && parent !== null && parent >= 0 && world.isAlive(parent)) {
    const part = world.tryGet(parent, InstancePart)
    if (part && part.instance === cell.root) saved.parent = part.path
  }
  const extra = state(world).hooks.captureExtra?.(world, entity)
  if (extra) saved.extra = extra
  return saved
}

/** Spawns a saved cell entity (an added one, or a dormant one coming back). */
function spawnSaved(
  world: World,
  rt: InstanceRuntime,
  cell: Cell,
  saved: SavedCellEntity,
  key: number,
): Entity {
  const e = world.spawn()
  const warn = (error: ShardError) => warnOnce(world, `${cell.key}:${error.message}`, error)
  addComponents(world, e, saved.components as Record<string, JsonValue>, warn)
  if (saved.parent !== undefined) {
    const parent = cell.entities.get(saved.parent)
    if (parent !== undefined && world.isAlive(parent)) world.add(e, ChildOf, { parent })
  }
  world.add(e, CellBound, { x: cell.x, z: cell.z, grid: cell.grid.index, key })
  if (saved.extra) state(world).hooks.restoreExtra?.(world, e, saved.extra)
  void rt
  return e
}

// --- generation ---------------------------------------------------------------------------------

function cellRequest(rt: InstanceRuntime, cell: Cell, level: number) {
  const grid = cell.grid
  return requestOf(
    grid.generator,
    { ...grid.params, x: cell.x, z: cell.z, level: grid.levels[level]!.name },
    rt.seed,
  )
}

function secretsRequest(rt: InstanceRuntime, cell: Cell) {
  const grid = cell.grid
  return requestOf(
    grid.secrets!.generator,
    { ...grid.params, x: cell.x, z: cell.z, level: grid.levels[0]!.name },
    rt.secretSeed,
  )
}

/** The entry of a cell's level, registered with procgen (not requested). */
export function cellEntry(
  world: World,
  rt: InstanceRuntime,
  cell: Cell,
  level: number,
): AssetEntry {
  return procgen(world).entryFor(cellRequest(rt, cell, level))
}

function fragmentInfo(world: World, entry: AssetEntry, cell: Cell): FragmentInfo | undefined {
  const s = state(world)
  const known = s.fragments.get(entry.guid)
  if (known) return known
  const record = procgen(world).recordOf(entry.guid)
  const json = record?.assets.find((a) => a.label === '')?.json as
    | { root?: { children?: JsonValue[] } }
    | undefined
  if (!json?.root) return undefined
  const info: FragmentInfo = { paths: new Set(), count: 0, secret: [] }
  const secret = cell.grid.secrets?.components
  const walk = (node: JsonValue, prefix: string) => {
    if (!isPlainObject(node)) return
    const n = node as { name?: string; components?: JsonObject; children?: JsonValue[] }
    const path = prefix === '' ? `${n.name}` : `${prefix}/${n.name}`
    info.paths.add(path)
    info.count++
    if (secret && n.components) {
      for (const name of Object.keys(n.components)) if (secret.has(name)) info.secret.push(path)
    }
    for (const c of n.children ?? []) walk(c, path)
  }
  for (const c of json.root.children ?? []) walk(c, '')
  s.fragments.set(entry.guid, info)
  if (info.secret.length > 0) {
    log(world)?.error(
      new ShardError(
        'partition/secret-in-fragment',
        `${cell.grid.generator.name} writes secret components (${info.secret.slice(0, 3).join(', ')}…)`,
        {
          hint: 'Clients generate this fragment: write secret components from the secrets generator instead.',
        },
      ),
    )
  }
  return info
}

function startWork(cell: Cell, promise: Promise<unknown>): void {
  const work = promise.catch(() => undefined)
  cell.work = work
  void work.then(() => {
    if (cell.work === work) cell.work = undefined
  })
}

function progress(world: World, rt: InstanceRuntime, cell: Cell, inFlight: { n: number }): void {
  const s = state(world)
  const role = s.hooks.role
  const level = cell.pending
  if (level < 0 || cell.failed) return
  const server = assetServer(world)
  if (!cell.entry) cell.entry = cellEntry(world, rt, cell, level)
  const entry = cell.entry
  if (entry.state === 'unloaded') {
    if (inFlight.n >= world.resource(StreamingBudget).jobsInFlight) return
    inFlight.n++
    startWork(cell, server.load(entry.guid))
    return
  }
  if (entry.state === 'failed') {
    cell.failed = true
    return
  }
  if (entry.state !== 'loaded') return
  if (level === 0 && role !== 'client' && cell.grid.secrets && !cell.secretsEntry) {
    cell.secretsEntry = procgen(world).entryFor(secretsRequest(rt, cell))
    startWork(cell, server.load(cell.secretsEntry.guid))
  }
  if (role === 'client' && cell.hashLevel !== level && !cell.work) {
    const ref = { type: entry.type, guid: entry.guid, path: entry.path }
    startWork(
      cell,
      outputHash(world, ref as never).then((hash) => {
        if (cell.pending !== level) return
        cell.hash = hash
        cell.hashLevel = level
        if (cell.level === -1) {
          cell.requested = true
          s.hooks.requestDelta?.(world, cell, level, hash)
        } else s.hooks.levelChanged?.(world, cell, level, hash)
      }),
    )
  }
}

function isReady(world: World, cell: Cell): boolean {
  const role = state(world).hooks.role
  if (cell.pending < 0 || cell.failed || cell.entry?.state !== 'loaded') return false
  if (cell.secretsEntry && cell.secretsEntry.state !== 'loaded') return false
  if (cell.pending === 0 && role !== 'client' && cell.grid.secrets && !cell.secretsEntry)
    return false
  if (role === 'client') {
    if (cell.hashLevel !== cell.pending) return false
    if (!cell.deltaReady) return false
  }
  return true
}

// --- commit, swap, unload -----------------------------------------------------------------------

/** Overrides for a level: the delta's (and the secrets', on the server) on paths the level has. */
function overridesFor(
  world: World,
  rt: InstanceRuntime,
  cell: Cell,
  level: number,
  info: FragmentInfo | undefined,
): Record<string, JsonValue> {
  const delta = deltaOf(world, rt, cell)
  const role = state(world).hooks.role
  let all = delta.overrides()
  if (level === 0 && role !== 'client' && cell.secretsEntry) {
    const value = world.resource(GeneratedData).byGuid(cell.secretsEntry.guid)
    cell.secrets = isPlainObject(value) ? (value as Record<string, JsonValue>) : {}
    all = mergeOverrides(cell.secrets, all)
  }
  if (!info) return all
  const out: Record<string, JsonValue> = {}
  const stale: string[] = []
  for (const [k, v] of Object.entries(all)) {
    if (info.paths.has(pathOfKey(k))) out[k] = v
    else if (level === 0) stale.push(k)
  }
  if (stale.length > 0) {
    log(world)?.log(
      'warn',
      `Cell ${cell.grid.name} ${cell.x},${cell.z}: ${stale.length} delta entries name paths ${cell.grid.generator.name} no longer makes (${stale.slice(0, 3).join(', ')})`,
      { code: 'partition/stale-delta' },
    )
  }
  return out
}

function visibleAt(level: number, saved: SavedCellEntity): boolean {
  return level === 0 || saved.components[FarVisible.name] !== undefined
}

function syncAdded(world: World, rt: InstanceRuntime, cell: Cell, level: number): void {
  const delta = deltaOf(world, rt, cell)
  const s = state(world)
  for (const [key, e] of [...cell.added]) {
    const saved = delta.entries.get(key) as unknown as SavedCellEntity | undefined
    if (saved && visibleAt(level, saved)) continue
    s.suppress++
    if (world.isAlive(e)) world.despawn(e)
    s.suppress--
    cell.added.delete(key)
  }
  for (const [key, value] of delta.entries) {
    if (!key.startsWith('+') || cell.added.has(key)) continue
    const saved = value as unknown as SavedCellEntity
    if (!visibleAt(level, saved)) continue
    s.suppress++
    cell.added.set(key, spawnSaved(world, rt, cell, saved, Number(key.slice(1))))
    s.suppress--
  }
}

function bindSecrets(world: World, cell: Cell): void {
  const s = state(world)
  const bind = s.hooks.bindSecret
  const secret = cell.grid.secrets?.components
  if (!bind || !secret) return
  for (const [path, e] of cell.entities) {
    for (const def of world.componentsOf(e)) {
      if (!secret.has(def.name)) continue
      bind(world, e, `cell:${cell.grid.name}/${cell.x},${cell.z}/${path}`)
      break
    }
  }
}

function event(rt: InstanceRuntime, cell: Cell) {
  return {
    partition: rt.partition.name,
    grid: cell.grid.name,
    x: cell.x,
    z: cell.z,
    root: cell.root,
  }
}

/**
 * Spawns a cell's root with its generator instance (children spawn in the frame's one
 * `updateInstances`, then `finish` runs). Returns the entities it costs.
 */
function commit(world: World, rt: InstanceRuntime, cell: Cell): number {
  const level = cell.pending
  const info = fragmentInfo(world, cell.entry!, cell)
  const overrides = overridesFor(world, rt, cell, level, info)
  const grid = cell.grid
  const s = state(world)
  s.suppress++
  cell.root = world.spawn(
    [StreamedCell, { x: cell.x, z: cell.z, grid: grid.index, level }],
    [Transform, {}],
    [
      GeneratorInstance,
      {
        generator: grid.generator,
        seed: rt.seed,
        params: { ...grid.params, x: cell.x, z: cell.z, level: grid.levels[level]!.name },
        overrides,
      },
    ],
  )
  s.suppress--
  rt.byRoot.set(cell.root, cell)
  cell.level = level
  cell.pending = -1
  cell.entry = undefined
  return info?.count ?? 1
}

/** After the frame's `updateInstances`: the cell's entities, added and dormant ones, events. */
function finish(world: World, rt: InstanceRuntime, cell: Cell, from: number): void {
  const s = state(world)
  const role = s.hooks.role
  cell.entities = instanceEntities(world, cell.root)
  cell.commitTick = world.tick
  syncAdded(world, rt, cell, cell.level)
  if (!simulated(role, from) && simulated(role, cell.level)) {
    wakeDormant(world, rt, cell)
    bindSecrets(world, cell)
  }
  if (from < 0) {
    world.send(CellLoaded, event(rt, cell))
    s.hooks.cellCommitted?.(world, cell)
  }
}

function wakeDormant(world: World, rt: InstanceRuntime, cell: Cell): void {
  const delta = deltaOf(world, rt, cell)
  if (delta.dormant.length === 0) return
  const s = state(world)
  const list = delta.dormant
  delta.dormant = []
  s.suppress++
  for (const saved of list) spawnSaved(world, rt, cell, saved, ++delta.next)
  s.suppress--
}

/** Changes a loaded cell's level (the respawn happens in the frame's `updateInstances`). */
function swap(world: World, rt: InstanceRuntime, cell: Cell): number {
  const s = state(world)
  const level = cell.pending
  if (simulated(s.hooks.role, cell.level) && !simulated(s.hooks.role, level)) {
    flushCell(world, rt, cell)
    sleepDynamic(world, rt, cell, false)
  }
  const info = fragmentInfo(world, cell.entry!, cell)
  const overrides = overridesFor(world, rt, cell, level, info)
  const value = world.get(cell.root, GeneratorInstance)
  const params = { ...(value.params as JsonObject), level: cell.grid.levels[level]!.name }
  s.suppress++
  world.add(cell.root, GeneratorInstance, { ...value, params, overrides })
  world.add(cell.root, StreamedCell, { x: cell.x, z: cell.z, grid: cell.grid.index, level })
  s.suppress--
  cell.level = level
  cell.pending = -1
  cell.entry = undefined
  return info?.count ?? 1
}

/** CellBound entities standing in a cell. */
function boundIn(world: World, cell: Cell): Entity[] {
  const out: Entity[] = []
  const q = world.query({ with: [CellBound] })
  for (const table of q.tables) {
    const x = table.column(CellBound, 'x')
    const z = table.column(CellBound, 'z')
    const g = table.column(CellBound, 'grid')
    const key = table.column(CellBound, 'key')
    for (let row = 0; row < table.count; row++) {
      if (key[row] === 0 || x[row] !== cell.x || z[row] !== cell.z || g[row] !== cell.grid.index)
        continue
      out.push(table.entities[row]!)
    }
  }
  return out
}

/**
 * Puts a simulated cell's dynamic entities to sleep in its delta. With `despawn` false it only
 * writes their snapshot (for saves); otherwise it despawns them, and the cell's static added
 * entities too (they're in the delta already).
 */
function sleepDynamic(
  world: World,
  rt: InstanceRuntime,
  cell: Cell,
  snapshot: boolean,
): SavedCellEntity[] {
  const s = state(world)
  const delta = deltaOf(world, rt, cell)
  const out: SavedCellEntity[] = []
  for (const e of boundIn(world, cell)) {
    if (!isDynamic(world, e)) continue
    if (world.has(e, NoSave)) {
      if (!snapshot) {
        s.suppress++
        world.despawn(e)
        s.suppress--
      }
      continue
    }
    const saved = savedEntity(world, cell, e)
    out.push(saved)
    if (snapshot) continue
    delta.dormant.push(saved)
    s.suppress++
    world.despawn(e)
    s.suppress--
  }
  return out
}

function unload(world: World, rt: InstanceRuntime, cell: Cell): void {
  const s = state(world)
  if (cell.root >= 0) {
    world.send(CellUnloading, event(rt, cell))
    if (simulated(s.hooks.role, cell.level)) {
      flushCell(world, rt, cell)
      sleepDynamic(world, rt, cell, false)
    }
    s.suppress++
    for (const e of boundIn(world, cell))
      if (world.isAlive(e) && !isDynamic(world, e)) world.despawn(e)
    for (const e of cell.added.values()) if (world.isAlive(e)) world.despawn(e)
    // Its instance state goes in the next updateInstances; the entities go now.
    if (world.isAlive(cell.root)) world.despawn(cell.root)
    s.suppress--
    rt.byRoot.delete(cell.root)
  }
  s.dirty.delete(cell)
  if (s.hooks.role === 'client') {
    s.deltas.get(rt.partition.name)?.delete(cell.key)
    if (cell.requested) s.hooks.cellDropped?.(world, cell)
  }
  rt.cells.delete(cell.key)
}

// --- the frame ----------------------------------------------------------------------------------

function newCell(grid: ResolvedGrid, x: number, z: number, frame: number): Cell {
  return {
    key: cellKey(grid.index, x, z),
    grid,
    x,
    z,
    level: -1,
    target: -1,
    pending: -1,
    entry: undefined,
    secretsEntry: undefined,
    work: undefined,
    hash: undefined,
    hashLevel: -1,
    deltaReady: false,
    requested: false,
    wantedFrame: frame,
    awaySince: -1,
    awayTarget: -1,
    root: -1,
    entities: new Map(),
    added: new Map(),
    secrets: undefined,
    commitTick: 0,
    distance: 0,
    priority: 0,
    failed: false,
  }
}

function setTarget(cell: Cell, target: number, frame: number): void {
  if (cell.target === target) return
  cell.target = target
  cell.wantedFrame = frame
  if (target >= 0 && target !== cell.level) {
    if (cell.pending !== target) {
      cell.pending = target
      cell.entry = undefined
      cell.secretsEntry = undefined
      cell.failed = false
    }
  } else cell.pending = -1
}

function check(world: World, rt: InstanceRuntime, sources: number[], now: number): void {
  const role = state(world).hooks.role
  const frame = rt.frame
  for (const grid of rt.partition.grids) {
    let reach = 0
    for (let i = 0; i < levelCount(grid, role); i++) reach = Math.max(reach, rangeOf(grid, role, i))
    const cs = grid.cellSize
    for (let i = 0; i < sources.length; i += 4) {
      const r = reach * (sources[i + 2]! || 1)
      const x0 = Math.floor((sources[i]! - r) / cs)
      const x1 = Math.floor((sources[i]! + r) / cs)
      const z0 = Math.floor((sources[i + 1]! - r) / cs)
      const z1 = Math.floor((sources[i + 1]! + r) / cs)
      for (let x = x0; x <= x1; x++) {
        for (let z = z0; z <= z1; z++) {
          const key = cellKey(grid.index, x, z)
          if (rt.cells.has(key)) continue
          const { distance, priority } = nearest(grid, x, z, sources)
          const want = desiredLevel(grid, role, distance)
          if (want < 0) continue
          const cell = newCell(grid, x, z, frame)
          cell.distance = distance
          cell.priority = priority
          setTarget(cell, want, frame)
          rt.cells.set(key, cell)
        }
      }
    }
  }
  for (const cell of rt.cells.values()) {
    const { distance, priority } = nearest(cell.grid, cell.x, cell.z, sources)
    cell.distance = distance
    cell.priority = priority
    const want = desiredLevel(cell.grid, role, distance)
    if (cell.level < 0) {
      setTarget(cell, want, frame)
      cell.awaySince = -1
      continue
    }
    if (want >= 0 && want < cell.level) {
      setTarget(cell, want, frame)
      cell.awaySince = -1
    } else if (distance <= KEEP * rangeOf(cell.grid, role, cell.level)) {
      setTarget(cell, cell.level, frame)
      cell.awaySince = -1
    } else {
      if (cell.awaySince < 0) cell.awaySince = now
      cell.awayTarget = want
    }
  }
}

/** Streams every PartitionInstance's cells: selection, generation, commits, swaps and unloads. */
export function stream(
  world: World,
  sources: Query,
  cameras: Query | undefined,
  instances: Query,
): void {
  const s = state(world)
  for (const [entity, rt] of [...s.instances]) {
    if (world.isAlive(entity) && world.has(entity, PartitionInstance)) continue
    for (const cell of [...rt.cells.values()]) unload(world, rt, cell)
    s.instances.delete(entity)
  }
  for (const table of instances.tables) {
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      if (s.instances.has(entity)) continue
      const value = world.get(entity, PartitionInstance)
      if (!value.enabled) continue
      try {
        const partition = requirePartition(value.partition)
        s.instances.set(
          entity,
          new InstanceRuntime(entity, partition, value.seed, value.secretSeed),
        )
      } catch (err) {
        warnOnce(world, `instance:${value.partition}`, err as ShardError)
      }
    }
  }
  if (s.instances.size === 0) return
  const list = gatherSources(world, sources, cameras)
  const now = world.tryResource(Time)?.elapsed ?? 0
  const budget = world.resource(StreamingBudget)
  const deterministic =
    budget.commit === 'deterministic' ||
    (budget.commit === 'auto' && world.tryResource(StepMode)?.deterministic === true)
  for (const rt of s.instances.values()) {
    const start = performance.now()
    rt.frame++
    rt.framesSinceCheck++
    if (rt.framesSinceCheck >= 30 || moved(rt, list)) {
      check(world, rt, list, now)
      rt.checked = Float64Array.from(list)
      rt.framesSinceCheck = 0
    }
    for (const cell of rt.cells.values()) {
      if (cell.awaySince >= 0 && now - cell.awaySince >= budget.unloadDelay) {
        cell.awaySince = -1
        setTarget(cell, cell.awayTarget, rt.frame)
      }
    }
    const inFlight = { n: 0 }
    for (const cell of rt.cells.values()) if (cell.entry?.state === 'loading') inFlight.n++
    const order = [...rt.cells.values()].sort(byPriority)
    for (const cell of order) progress(world, rt, cell, inFlight)
    for (const cell of order) {
      if (cell.target < 0) unload(world, rt, cell)
    }
    let spent = 0
    let committed = 0
    const done: Cell[] = []
    const from: number[] = []
    const commitStart = performance.now()
    for (const cell of order) {
      if (cell.pending < 0 || !rt.cells.has(cell.key)) continue
      if (deterministic && rt.frame < cell.wantedFrame + budget.commitDelay) continue
      if (!isReady(world, cell)) {
        if (deterministic && cell.level < 0 && state(world).hooks.role !== 'client')
          warnOnce(
            world,
            `late:${cell.key}:${cell.wantedFrame}`,
            new ShardError('partition/late-commit', `Cell ${cell.key} was due but not ready`, {
              hint: 'Await partitionSettled(world) before each step when commits are deterministic.',
            }),
          )
        continue
      }
      if (committed > 0 && spent >= budget.entitiesPerFrame) break
      from.push(cell.level)
      spent += cell.level < 0 ? commit(world, rt, cell) : swap(world, rt, cell)
      done.push(cell)
      committed++
    }
    if (done.length > 0) {
      // One pass over the world's instances for every cell this frame spawns or swaps.
      s.suppress++
      updateInstances(
        world,
        done.map((c) => c.root),
      )
      s.suppress--
      for (let i = 0; i < done.length; i++) finish(world, rt, done[i]!, from[i]!)
    }
    rt.commitMs = done.length > 0 ? performance.now() - commitStart : 0
    rt.committed = spent
    rt.ms = performance.now() - start
  }
}

function byPriority(a: Cell, b: Cell): number {
  if (a.priority !== b.priority) return b.priority - a.priority
  if (a.distance !== b.distance) return a.distance - b.distance
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

/**
 * Resolves once every cell that deterministic commits will want in the next frame is ready (its
 * level generated, hashed and loaded). Hosts await it before each step; a client's deltas come
 * over the network and aren't waited for.
 */
export async function partitionSettled(world: World): Promise<void> {
  const s = world.tryResource(PartitionState)
  if (!s) return
  for (let round = 0; round < 64; round++) {
    const waits: Promise<unknown>[] = []
    for (const rt of s.instances.values()) {
      for (const cell of rt.cells.values()) {
        if (cell.pending < 0 || cell.failed) continue
        if (cell.work) waits.push(cell.work)
        else if (cell.entry?.state === 'unloaded' || cell.entry?.state === 'loading') {
          startWork(cell, assetServer(world).load(cell.entry.guid))
          waits.push(cell.work!)
        }
      }
    }
    if (waits.length === 0) return
    await Promise.all(waits)
    // Results land after a main-thread turn; let them, and let progress() start the next step.
    for (const rt of s.instances.values()) {
      const inFlight = { n: -1e9 }
      for (const cell of rt.cells.values()) progress(world, rt, cell, inFlight)
    }
  }
}

// --- upkeep: deltas and moving entities -----------------------------------------------------------

/** Recomputes the dirty paths of one cell. */
export function flushCell(world: World, rt: InstanceRuntime, cell: Cell): void {
  const s = state(world)
  const paths = s.dirty.get(cell)
  if (!paths) return
  s.dirty.delete(cell)
  for (const path of paths) refreshPath(world, rt, cell, path)
}

function cellOfInstance(
  world: World,
  instance: Entity,
): { rt: InstanceRuntime; cell: Cell } | undefined {
  for (const rt of state(world).instances.values()) {
    const cell = rt.byRoot.get(instance)
    if (cell) return { rt, cell }
  }
  return undefined
}

function observeRemovals(world: World, def: ComponentDef): void {
  const s = state(world)
  if (s.observed.has(def)) return
  s.observed.add(def)
  world.observe(onRemove(def), ({ entity, world }) => {
    const st = world.resource(PartitionState)
    if (st.suppress > 0 || st.hooks.role === 'client') return
    const part = world.tryGet(entity, InstancePart)
    if (!part) return
    const found = part.instance === null ? undefined : cellOfInstance(world, part.instance)
    if (found && simulated(st.hooks.role, found.cell.level)) markDirty(world, found.cell, part.path)
  })
}

/** Installs the observers upkeep needs (once per world). */
export function hookPartition(world: World): void {
  const s = state(world)
  observeRemovals(world, InstancePart)
  if (s.observed.has(CellBound)) return
  s.observed.add(CellBound)
  world.observe(onRemove(CellBound), ({ entity, world }) => {
    const st = world.resource(PartitionState)
    if (st.suppress > 0 || st.hooks.role === 'client') return
    const cb = world.get(entity, CellBound)
    if (cb.key === 0 || isDynamic(world, entity)) return
    for (const rt of st.instances.values()) {
      const grid = rt.partition.grids[cb.grid]
      if (!grid) continue
      const cell = rt.cells.get(cellKey(grid.index, cb.x, cb.z))
      if (!cell) continue
      deltaOf(world, rt, cell).drop(`+${cb.key}`)
      cell.added.delete(`+${cb.key}`)
    }
  })
}

/** Calls `visit(row, tick)` for rows whose saved components changed or were added after `since`. */
function scanTable(table: Table, since: number, visit: (row: number, tick: number) => void): void {
  const structural = table.lastStructural > since
  for (const def of table.components) {
    if (!def.saved) continue
    if (table.lastChanged(def) <= since && !structural) continue
    const ticks = table.changedTicks(def)
    const added = table.addedTicks(def)
    for (let row = 0; row < table.count; row++) {
      const tick = ticks[row]! > added[row]! ? ticks[row]! : added[row]!
      if (tick > since) visit(row, tick)
    }
  }
}

/**
 * Keeps loaded cells' deltas current and moves CellBound entities between cells (server and
 * single player). Runs once a frame, late, so a network send right after sees this frame's changes.
 */
export function upkeep(world: World, generated: Query, bound: Query): void {
  const s = state(world)
  const role = s.hooks.role
  if (role === 'client' || s.instances.size === 0) {
    s.lastScan = world.tick
    return
  }
  const since = s.lastScan
  for (const table of generated.tables) {
    for (const def of table.components) if (def.saved) observeRemovals(world, def)
    const parts = table.column(InstancePart, 'instance')
    const paths = table.column(InstancePart, 'path') as unknown as string[]
    scanTable(table, since, (row, tick) => {
      const found = cellOfInstance(world, parts[row]! as Entity)
      if (!found || !simulated(role, found.cell.level) || tick <= found.cell.commitTick) return
      markDirty(world, found.cell, paths[row]!)
    })
  }
  rehome(world, bound, since)
  for (const rt of s.instances.values()) {
    for (const [cell, paths] of [...s.dirty]) {
      if (!rt.cells.has(cell.key)) continue
      s.dirty.delete(cell)
      for (const path of paths) refreshPath(world, rt, cell, path)
    }
  }
  s.lastScan = world.tick
}

function rehome(world: World, bound: Query, since: number): void {
  const s = state(world)
  const rt = s.instances.values().next().value as InstanceRuntime | undefined
  if (!rt) return
  const moves: Entity[] = []
  for (const table of bound.tables) {
    const key = table.column(CellBound, 'key')
    const xs = table.column(CellBound, 'x')
    const zs = table.column(CellBound, 'z')
    const gs = table.column(CellBound, 'grid')
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]!
      const grid = rt.partition.grids[gs[row]!]
      if (!grid || !positionOf(world, e, scratchPos)) continue
      if (key[row] === 0) {
        moves.push(e)
        continue
      }
      const dist = cellDistance(grid.cellSize, xs[row]!, zs[row]!, scratchPos[0]!, scratchPos[2]!)
      if (dist > REHOME_MARGIN) moves.push(e)
    }
    // Static added entities that changed: their delta entries.
    scanTable(table, since, (row) => {
      if (key[row] === 0) return
      const e = table.entities[row]!
      if (isDynamic(world, e)) return
      const grid = rt.partition.grids[gs[row]!]
      const cell = grid && rt.cells.get(cellKey(grid.index, xs[row]!, zs[row]!))
      if (!cell || !simulated(s.hooks.role, cell.level)) return
      deltaOf(world, rt, cell).set(`+${key[row]}`, savedEntity(world, cell, e) as never)
    })
  }
  for (const e of moves) moveTo(world, rt, e)
}

function moveTo(world: World, rt: InstanceRuntime, e: Entity): void {
  const s = state(world)
  const cb = world.get(e, CellBound)
  const grid = rt.partition.grids[cb.grid]!
  positionOf(world, e, scratchPos)
  const x = Math.floor(scratchPos[0]! / grid.cellSize)
  const z = Math.floor(scratchPos[2]! / grid.cellSize)
  const dynamic = isDynamic(world, e)
  if (cb.key !== 0 && !dynamic) {
    const old = rt.cells.get(cellKey(grid.index, cb.x, cb.z))
    if (old) {
      deltaOf(world, rt, old).drop(`+${cb.key}`)
      old.added.delete(`+${cb.key}`)
    }
  }
  let target = rt.cells.get(cellKey(grid.index, x, z))
  const live = target && target.root >= 0 && simulated(s.hooks.role, target.level)
  if (!live) {
    // Into a cell that isn't simulated: asleep in its delta until it loads.
    if (!target) target = newCell(grid, x, z, rt.frame)
    const delta = deltaOf(world, rt, target)
    const saved = savedEntity(world, target, e)
    delete saved.parent
    if (dynamic) delta.dormant.push(saved)
    else delta.set(`+${++delta.next}`, saved as never)
    s.suppress++
    world.despawn(e)
    s.suppress--
    if (dynamic) {
      world.send(EntityDormant, {
        partition: rt.partition.name,
        grid: grid.name,
        x,
        z,
        index: delta.dormant.length - 1,
      })
    }
    return
  }
  const delta = deltaOf(world, rt, target!)
  const key = ++delta.next
  s.suppress++
  world.add(e, CellBound, { x, z, grid: grid.index, key })
  s.suppress--
  if (!dynamic) {
    delta.set(`+${key}`, savedEntity(world, target!, e) as never)
    target!.added.set(`+${key}`, e)
  }
}

// --- the hordes hook ----------------------------------------------------------------------------

/** Dormant entities of a cell (its delta's), for a system that simulates unloaded cells. */
export function dormantEntities(
  world: World,
  partition: string,
  grid: number,
  x: number,
  z: number,
): readonly SavedCellEntity[] {
  return storedDelta(world, partition, cellKey(grid, x, z))?.dormant ?? []
}

/** Moves a dormant entity from one unloaded cell to another (a horde walking). */
export function moveDormant(
  world: World,
  partition: string,
  grid: number,
  from: { x: number; z: number },
  to: { x: number; z: number },
  index: number,
): void {
  const s = state(world)
  const rt = [...s.instances.values()].find((r) => r.partition.name === partition)
  const g = rt?.partition.grids[grid]
  if (!rt || !g) {
    throw new ShardError('partition/unknown-partition', `No streaming partition "${partition}"`)
  }
  const source = storedDelta(world, partition, cellKey(grid, from.x, from.z))
  const saved = source?.dormant[index]
  if (!source || !saved) {
    throw new ShardError(
      'partition/no-dormant',
      `Cell ${from.x},${from.z} has no dormant #${index}`,
    )
  }
  const dest = rt.cells.get(cellKey(grid, to.x, to.z))
  if (dest && dest.root >= 0 && simulated(s.hooks.role, dest.level)) {
    throw new ShardError('partition/cell-loaded', `Cell ${to.x},${to.z} is loaded`, {
      hint: 'Dormant entities move between unloaded cells; a loaded cell simulates its own.',
    })
  }
  source.dormant.splice(index, 1)
  deltaOf(world, rt, dest ?? newCell(g, to.x, to.z, rt.frame)).dormant.push(saved)
}

/** The generator a grid's cells are made with, as clients compare it at join. */
export function generatorInfo(grid: ResolvedGrid): {
  name: string
  version: number
  codeHash: string
} {
  return {
    name: grid.generator.name,
    version: grid.generator.version,
    codeHash: codeHashOf(grid.generator),
  }
}

/** Every partition entity a save writes through the partition section, not as spawned. */
export function ownedByPartition(world: World, entity: Entity): boolean {
  if (world.has(entity, StreamedCell) || world.has(entity, CellBound)) return true
  const part = world.tryGet(entity, InstancePart)
  return (
    part !== undefined &&
    part.instance !== null &&
    world.isAlive(part.instance) &&
    world.has(part.instance, StreamedCell)
  )
}

/** Snapshot of the dynamic entities live in a simulated cell (saves). */
export function snapshotDynamic(world: World, rt: InstanceRuntime, cell: Cell): SavedCellEntity[] {
  return sleepDynamic(world, rt, cell, true)
}
