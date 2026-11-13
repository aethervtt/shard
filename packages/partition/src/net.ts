// Multiplayer streaming (0113): the server streams around every player and simulates; clients
// generate their own cells, report them, and receive only deltas and dynamic entities. Nothing
// registers on import: add partitionNetPlugin() and spread partitionNet() into the net options.

import {
  ChildOf,
  defineSystem,
  type Entity,
  First,
  findComponent,
  type InferFields,
  type JsonObject,
  type JsonValue,
  Last,
  onAdd,
  type Query,
  ShardError,
  type Table,
  t,
  type World,
} from '@aethervtt/shard-core'
import {
  commands,
  defineNetCommand,
  defineNetEvent,
  type InterestPolicy,
  type NetOptions,
  NetRole,
  NetSystems,
  netSession,
  onClient,
  onServer,
  PeerJoined,
  PeerLeft,
  Replicated,
  replicate,
  sendCommand,
  sendEvent,
} from '@aethervtt/shard-net'
import { codeHashOf, findGenerator } from '@aethervtt/shard-procgen'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { InstancePart } from '@aethervtt/shard-scene'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { PartitionInstance, StreamedCell, StreamingBudget, StreamingSource } from './components'
import { addComponents, DeltaState, pathOfKey, publicValue, type SavedCellEntity } from './delta'
import { cellHashOf } from './methods'
import { cellDistance, cellKey, type ResolvedGrid } from './partition'
import { keepDeltas, streamCells } from './plugin'
import {
  type Cell,
  cellResolver,
  generatorInfo,
  type InstanceRuntime,
  PartitionState,
  storedDelta,
} from './runtime'

// --- messages -----------------------------------------------------------------------------------

/** Client → server: cells it loaded (with the hash of the level it generated), changed, dropped. */
export const CellsCommand = defineNetCommand('partition/Cells', {
  add: t.json({ description: '[grid, x, z, level, hash, agent][]' }),
  update: t.json({ description: '[grid, x, z, level, hash, agent][]' }),
  remove: t.json({ description: '[grid, x, z][]' }),
  loaded: t.json({ description: '[grid, x, z][]: committed, so its entities can be bound' }),
})

/** Server → a joining client: what to stream, and the generators it must have. */
export const WorldEvent = defineNetEvent('partition/World', {
  partition: t.string(),
  seed: t.u32(),
  generators: t.json({ description: '{ name, version, codeHash }[]' }),
})

/**
 * Server → client: a cell's delta, less secret components. `full` replaces what the client has;
 * otherwise `entries` are the keys changed since its last rev and `drop` the keys that left, with
 * the baseline values to put back.
 */
export const CellDeltaEvent = defineNetEvent('partition/CellDelta', {
  grid: t.u8(),
  x: t.i32(),
  z: t.i32(),
  rev: t.u32(),
  full: t.bool(),
  entries: t.json(),
  drop: t.json({ description: '[key, restore][]' }),
})

export interface PartitionNetOptions {
  /** Client: the version and code hash it compares the server's generators against (tests). */
  generators?: (name: string) => { version: number; codeHash: string } | undefined
}

type NetConfig = Pick<NetOptions, 'replicate' | 'commands' | 'events' | 'bind' | 'interest'>

/**
 * Net options with the partition's added: its command and events, StreamingSource replicated (so a
 * client finds its own player), and the bind hook that resolves secret-holding cell entities.
 */
export function partitionNet<T extends Partial<NetConfig>>(options: T = {} as T): T & NetConfig {
  return {
    ...options,
    replicate: [replicate(StreamingSource), ...(options.replicate ?? [])],
    commands: [CellsCommand, ...(options.commands ?? [])],
    events: [WorldEvent, CellDeltaEvent, ...(options.events ?? [])],
    bind: bindCellEntity,
  }
}

/** `cell:<grid>/<x>,<z>/<path>` → the client's generated entity, if that cell is loaded. */
function bindCellEntity(world: World, ref: string): Entity | undefined {
  if (!ref.startsWith('cell:')) return undefined
  const slash = ref.indexOf('/', 5)
  const second = ref.indexOf('/', slash + 1)
  if (slash < 0 || second < 0) return undefined
  const gridName = ref.slice(5, slash)
  const [x, z] = ref
    .slice(slash + 1, second)
    .split(',')
    .map(Number)
  const path = ref.slice(second + 1)
  for (const rt of world.tryResource(PartitionState)?.instances.values() ?? []) {
    const grid = rt.partition.grids.find((g) => g.name === gridName)
    const cell = grid && rt.cells.get(cellKey(grid.index, x!, z!))
    const e = cell && cell.level >= 0 ? cell.entities.get(path) : undefined
    if (e !== undefined && world.isAlive(e)) return e
  }
  return undefined
}

// --- server -------------------------------------------------------------------------------------

interface Reported {
  level: number
  rev: number
  /** The client committed it: its generated entities exist and can be bound. */
  loaded: boolean
}

interface ServerNet {
  /** Per peer: the cells it reported (by key), with the delta rev it has. */
  readonly peers: Map<number, Map<string, Reported>>
  readonly diverged: { peer: number; cell: string; level: number }[]
  refused: number
}

const servers = new WeakMap<World, ServerNet>()

function serverNet(world: World): ServerNet {
  let s = servers.get(world)
  if (!s) {
    s = { peers: new Map(), diverged: [], refused: 0 }
    servers.set(world, s)
  }
  return s
}

/** Server: what each peer reported, for tests and describe. */
export function reportedCells(world: World, peer: number): ReadonlyMap<string, Reported> {
  return serverNet(world).peers.get(peer) ?? new Map()
}

/** Server: the divergences logged so far. */
export function divergences(
  world: World,
): readonly { peer: number; cell: string; level: number }[] {
  return serverNet(world).diverged
}

const pos = new Float64Array(3)

function positionOf(world: World, e: Entity, out: Float64Array): boolean {
  if (!world.isAlive(e)) return false
  const table = world.entityTable(e)
  const row = world.entityRow(e)
  if (table.has(GlobalTransform)) {
    const m = table.column(GlobalTransform, 'matrix')
    out[0] = m[row * 12 + 3]!
    out[1] = m[row * 12 + 7]!
    out[2] = m[row * 12 + 11]!
    return true
  }
  if (!table.has(Transform)) return false
  const tr = table.column(Transform, 'translation')
  out[0] = tr[row * 3]!
  out[1] = tr[row * 3 + 1]!
  out[2] = tr[row * 3 + 2]!
  return true
}

/** The peer's sources as (x, z, scale) triples. */
function peerSources(world: World, sources: Query, peer: number): number[] {
  const out: number[] = []
  for (const table of sources.tables) {
    const owner = table.column(StreamingSource, 'peer')
    const scale = table.column(StreamingSource, 'rangeScale')
    for (let row = 0; row < table.count; row++) {
      if (owner[row] !== peer || !positionOf(world, table.entities[row]!, pos)) continue
      out.push(pos[0]!, pos[2]!, scale[row]! || 1)
    }
  }
  return out
}

function inReach(grid: ResolvedGrid, x: number, z: number, sources: readonly number[]): boolean {
  const reach = 1.25 * grid.levels[grid.levels.length - 1]!.range
  for (let i = 0; i < sources.length; i += 3) {
    if (cellDistance(grid.cellSize, x, z, sources[i]!, sources[i + 1]!) <= reach * sources[i + 2]!)
      return true
  }
  return false
}

function secretsOf(grid: ResolvedGrid): ReadonlySet<string> {
  return grid.secrets?.components ?? EMPTY
}

const EMPTY: ReadonlySet<string> = new Set()

/** A delta's entries with secret components left out. */
function publicEntries(delta: DeltaState, secret: ReadonlySet<string>, since: number): JsonObject {
  const out: JsonObject = {}
  for (const [key, value] of delta.entries) {
    if ((delta.revs.get(key) ?? 0) <= since) continue
    const v = publicValue(key, value, secret)
    if (v !== undefined) out[key] = v
  }
  return out
}

function publicDrops(delta: DeltaState, secret: ReadonlySet<string>, since: number): JsonValue[] {
  const out: JsonValue[] = []
  for (const [key, tomb] of delta.dropped) {
    if (tomb.rev <= since) continue
    const restore =
      tomb.restore === undefined
        ? null
        : (publicValue(pathOfKey(key), tomb.restore, secret) ?? null)
    out.push([key, restore])
  }
  return out
}

function instance(world: World): InstanceRuntime | undefined {
  return world.tryResource(PartitionState)?.instances.values().next().value
}

function verify(
  world: World,
  rt: InstanceRuntime,
  peer: number,
  grid: ResolvedGrid,
  entry: JsonValue[],
): void {
  const [, x, z, level, hash, agent] = entry as [number, number, number, number, string, string]
  const budget = world.resource(StreamingBudget)
  if (level !== 0 && budget.verifyLevels !== 'all') return
  void cellHashOf(world, rt.partition.name, rt.seed, grid.index, x, z, level).then((mine) => {
    if (mine === hash) return
    serverNet(world).diverged.push({ peer, cell: cellKey(grid.index, x, z), level })
    world
      .tryResource(LogResource)
      ?.log(
        'warn',
        `Cell ${grid.name} ${x},${z} at ${grid.levels[level]?.name} diverged on peer ${peer} (${agent}): ${grid.generator.name} made different bits`,
        { code: 'partition/cell-diverged' },
      )
  })
}

function serverSystem() {
  return defineSystem({
    name: 'partition/net-server',
    description:
      "Server: sends a joining client the world, answers cell reports with deltas (less secrets), sends each peer its cells' delta changes, and checks reported cell hashes.",
    setup: (world) => ({
      sources: world.query({ with: [StreamingSource] }),
      owned: world.query({ with: [StreamingSource, Replicated] }),
    }),
    run: (q, world, ctx) => {
      const net = serverNet(world)
      // A player's source streams for that player: its peer is the entity's owner.
      for (const table of q.owned.tables) {
        const owner = table.column(Replicated, 'owner')
        const peer = table.column(StreamingSource, 'peer')
        for (let row = 0; row < table.count; row++) {
          if (peer[row] !== owner[row]) {
            world.add(table.entities[row]!, StreamingSource, {
              ...world.get(table.entities[row]!, StreamingSource),
              peer: owner[row]!,
            })
          }
        }
      }
      for (const e of ctx.reader(PeerLeft).read()) net.peers.delete(e.peer)
      const rt = instance(world)
      if (!rt) return
      for (const e of ctx.reader(PeerJoined).read()) {
        net.peers.set(e.peer, new Map())
        sendEvent(
          world,
          WorldEvent,
          {
            partition: rt.partition.name,
            seed: rt.seed,
            generators: rt.partition.grids.map(generatorInfo) as unknown as JsonValue,
          },
          { to: e.peer },
        )
      }
      for (const cmd of commands(world, CellsCommand)) {
        let cells = net.peers.get(cmd.peer)
        if (!cells) {
          cells = new Map()
          net.peers.set(cmd.peer, cells)
        }
        const sources = peerSources(world, q.sources, cmd.peer)
        let refused = 0
        for (const entry of (cmd.data.add as JsonValue[] | null) ?? []) {
          const [g, x, z, level] = entry as number[]
          const grid = rt.partition.grids[g!]
          if (!grid) continue
          if (!inReach(grid, x!, z!, sources)) {
            refused++
            continue
          }
          const key = cellKey(grid.index, x!, z!)
          const delta = storedDelta(world, rt.partition.name, key)
          cells.set(key, { level: level!, rev: delta?.rev ?? 0, loaded: false })
          sendEvent(
            world,
            CellDeltaEvent,
            {
              grid: grid.index,
              x: x!,
              z: z!,
              rev: delta?.rev ?? 0,
              full: true,
              entries: delta ? publicEntries(delta, secretsOf(grid), -1) : {},
              drop: [],
            },
            { to: cmd.peer },
          )
          verify(world, rt, cmd.peer, grid, entry as JsonValue[])
        }
        for (const entry of (cmd.data.update as JsonValue[] | null) ?? []) {
          const [g, x, z, level] = entry as number[]
          const grid = rt.partition.grids[g!]
          const known = grid && cells.get(cellKey(grid.index, x!, z!))
          if (!grid || !known) continue
          known.level = level!
          verify(world, rt, cmd.peer, grid, entry as JsonValue[])
        }
        for (const entry of (cmd.data.loaded as JsonValue[] | null) ?? []) {
          const [g, x, z] = entry as number[]
          const known = cells.get(cellKey(g!, x!, z!))
          if (known) known.loaded = true
        }
        for (const entry of (cmd.data.remove as JsonValue[] | null) ?? []) {
          const [g, x, z] = entry as number[]
          cells.delete(cellKey(g!, x!, z!))
        }
        if (refused > 0) {
          net.refused += refused
          cmd.reject(
            'partition/cell-out-of-range',
            `${refused} cells are beyond this peer's reach`,
            "A client streams around its own player; cells past 1.25 × the last level's range aren't sent.",
          )
        } else cmd.accept()
      }
      // Delta changes, per peer and reported cell.
      for (const [peer, cells] of net.peers) {
        for (const [key, known] of cells) {
          const delta = storedDelta(world, rt.partition.name, key)
          if (!delta || delta.rev <= known.rev) continue
          const [g, rest] = key.split(':') as [string, string]
          const [x, z] = rest.split(',').map(Number) as [number, number]
          const grid = rt.partition.grids[Number(g)]!
          const secret = secretsOf(grid)
          const entries = publicEntries(delta, secret, known.rev)
          const drop = publicDrops(delta, secret, known.rev)
          known.rev = delta.rev
          if (Object.keys(entries).length === 0 && drop.length === 0) continue
          sendEvent(
            world,
            CellDeltaEvent,
            { grid: grid.index, x, z, rev: delta.rev, full: false, entries, drop },
            { to: peer },
          )
        }
      }
    },
  })
}

// --- interest -----------------------------------------------------------------------------------

const BIAS = 1 << 20
const SPAN = 1 << 21

/**
 * Replicated entities in cells the peer reported, within the grid's replication range of its
 * nearest focus (1.1 × for ones it has), each at its band's interval (0113). Uses the first grid.
 */
export function streamInterest(): InterestPolicy {
  const buckets = new Map<number, Entity[]>()
  const cellOf = new Map<Entity, number>()
  let lastTick = 0
  let query: Query | undefined
  let queryWorld: World | undefined
  const focus: number[] = []
  const p = new Float64Array(3)

  function bucketKey(x: number, z: number): number {
    return (x + BIAS) * SPAN + (z + BIAS)
  }

  function place(e: Entity, key: number): void {
    const prev = cellOf.get(e)
    if (prev === key) return
    if (prev !== undefined) {
      const list = buckets.get(prev)
      const i = list ? list.indexOf(e) : -1
      if (i >= 0) list!.splice(i, 1)
    }
    cellOf.set(e, key)
    let list = buckets.get(key)
    if (!list) {
      list = []
      buckets.set(key, list)
    }
    list.push(e)
  }

  function rowPosition(table: Table, row: number, out: Float64Array): void {
    if (table.has(GlobalTransform)) {
      const m = table.column(GlobalTransform, 'matrix')
      out[0] = m[row * 12 + 3]!
      out[2] = m[row * 12 + 11]!
    } else {
      const tr = table.column(Transform, 'translation')
      out[0] = tr[row * 3]!
      out[2] = tr[row * 3 + 2]!
    }
  }

  return {
    name: 'partition/stream',
    prepare(world) {
      if (queryWorld !== world || !query) {
        queryWorld = world
        query = world.query({ with: [Replicated, Transform] })
      }
      const grid = instance(world)?.partition.grids[0]
      if (!grid) return
      for (const table of query.tables) {
        const moved =
          table.lastStructural > lastTick ||
          table.lastChanged(Transform) > lastTick ||
          (table.has(GlobalTransform) && table.lastChanged(GlobalTransform) > lastTick)
        if (!moved) continue
        for (let row = 0; row < table.count; row++) {
          rowPosition(table, row, p)
          place(
            table.entities[row]!,
            bucketKey(Math.floor(p[0]! / grid.cellSize), Math.floor(p[2]! / grid.cellSize)),
          )
        }
      }
      lastTick = world.tick
    },
    update(world, peer, out) {
      const rt = instance(world)
      const grid = rt?.partition.grids[0]
      const cells = servers.get(world)?.peers.get(peer.id)
      if (!grid || !cells) return
      focus.length = 0
      for (const f of peer.focus) {
        if (positionOf(world, f, pos)) focus.push(pos[0]!, pos[2]!)
      }
      if (focus.length === 0) return
      const range = grid.replicateRange
      for (const [key, reported] of cells) {
        const colon = key.indexOf(':')
        if (Number(key.slice(0, colon)) !== grid.index) continue
        const comma = key.indexOf(',', colon)
        const x = Number(key.slice(colon + 1, comma))
        const z = Number(key.slice(comma + 1))
        let near = Number.POSITIVE_INFINITY
        for (let i = 0; i < focus.length; i += 2) {
          near = Math.min(near, cellDistance(grid.cellSize, x, z, focus[i]!, focus[i + 1]!))
        }
        if (near > range * 1.1) continue
        const list = buckets.get(bucketKey(x, z))
        if (!list) continue
        for (let i = list.length - 1; i >= 0; i--) {
          const e = list[i]!
          if (!world.isAlive(e)) {
            list.splice(i, 1)
            cellOf.delete(e)
            continue
          }
          positionOf(world, e, p)
          let d = Number.POSITIVE_INFINITY
          for (let k = 0; k < focus.length; k += 2) {
            const dx = p[0]! - focus[k]!
            const dz = p[2]! - focus[k + 1]!
            d = Math.min(d, Math.sqrt(dx * dx + dz * dz))
          }
          if (d > (peer.knows(e) ? range * 1.1 : range)) continue
          // A bound entity is the client's own generated one: only once its cell is committed.
          if (!reported.loaded && world.get(e, Replicated).bound) continue
          out.add(e, bandOf(grid, d))
        }
      }
    },
  }
}

function bandOf(grid: ResolvedGrid, d: number): number {
  const bands = grid.bands
  for (let i = 0; i < bands.length; i++) if (d <= bands[i]!.within) return bands[i]!.every
  return bands[bands.length - 1]!.every
}

// --- client -------------------------------------------------------------------------------------

interface ClientNet {
  add: JsonValue[]
  update: JsonValue[]
  remove: JsonValue[]
  loaded: JsonValue[]
  /** Set when the server's generators differ from this client's (it disconnected). */
  mismatch: ShardError | undefined
}

const clients = new WeakMap<World, ClientNet>()

function clientNet(world: World): ClientNet {
  let c = clients.get(world)
  if (!c) {
    c = { add: [], update: [], remove: [], loaded: [], mismatch: undefined }
    clients.set(world, c)
  }
  return c
}

/** Client: why it left, when its generators didn't match the server's. */
export function generatorMismatch(world: World): ShardError | undefined {
  return clients.get(world)?.mismatch
}

function agent(): string {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator
  if (nav?.userAgent) return nav.userAgent
  const proc = (globalThis as { process?: { version?: string } }).process
  return proc?.version ? `node ${proc.version}` : 'unknown'
}

function applyEntry(
  world: World,
  rt: InstanceRuntime,
  cell: Cell,
  key: string,
  value: JsonValue | undefined,
  restore: JsonValue | undefined,
): void {
  const warn = (error: ShardError) =>
    world.tryResource(LogResource)?.log('warn', error.message, { code: error.code })
  const s = world.resource(PartitionState)
  if (key.startsWith('+')) {
    const old = cell.added.get(key)
    s.suppress++
    if (old !== undefined && world.isAlive(old)) world.despawn(old)
    cell.added.delete(key)
    s.suppress--
    if (value === undefined) return
    const saved = value as unknown as SavedCellEntity
    if (cell.level !== 0 && saved.components['partition/FarVisible'] === undefined) return
    const e = world.spawn()
    cell.added.set(key, e)
    addComponents(world, e, saved.components as Record<string, JsonValue>, warn, cellResolver(cell))
    if (saved.parent !== undefined) {
      const parent = cell.entities.get(saved.parent)
      if (parent !== undefined && world.isAlive(parent)) world.add(e, ChildOf, { parent })
    }
    return
  }
  const path = pathOfKey(key)
  const e = cell.entities.get(path)
  if (e === undefined || !world.isAlive(e)) return
  if (value === undefined) {
    if (restore && typeof restore === 'object')
      addComponents(world, e, restore as JsonObject, warn, cellResolver(cell))
    return
  }
  if (value === null) {
    s.suppress++
    if (path === key) {
      world.despawn(e)
      cell.entities.delete(path)
    } else {
      const def = findComponent(key.slice(path.length + 1))
      if (def) world.remove(e, def)
    }
    s.suppress--
    return
  }
  addComponents(world, e, value as JsonObject, warn, cellResolver(cell))
  void rt
}

export type CellDeltaData = InferFields<(typeof CellDeltaEvent)['schema']['fields']>

/**
 * Client: applies one `partition/CellDelta` to its stored delta, and to the cell in place when it's
 * loaded (no respawn: entities are patched, removed or spawned one by one).
 */
export function applyCellDelta(world: World, data: CellDeltaData): void {
  const s = world.resource(PartitionState)
  const rt = instance(world)
  if (!rt) return
  const key = cellKey(data.grid, data.x, data.z)
  const grid = rt.partition.grids[data.grid]
  if (!grid) return
  let byCell = s.deltas.get(rt.partition.name)
  if (!byCell) {
    byCell = new Map()
    s.deltas.set(rt.partition.name, byCell)
  }
  const cell = rt.cells.get(key)
  if (data.full) {
    const delta = new DeltaState(grid.generator.name, grid.generator.version)
    for (const [k, v] of Object.entries(data.entries as JsonObject)) delta.set(k, v)
    delta.rev = data.rev
    byCell.set(key, delta)
    if (cell) cell.deltaReady = true
    return
  }
  const delta = byCell.get(key)
  if (!delta) return
  for (const [k, v] of Object.entries(data.entries as JsonObject)) {
    delta.set(k, v)
    if (cell && cell.level >= 0) applyEntry(world, rt, cell, k, v, undefined)
  }
  for (const pair of (data.drop as JsonValue[]) ?? []) {
    const [k, restore] = pair as [string, JsonValue]
    delta.drop(k)
    if (cell && cell.level >= 0) applyEntry(world, rt, cell, k, undefined, restore ?? undefined)
  }
  delta.rev = data.rev
}

function clientSystem(options: PartitionNetOptions) {
  return defineSystem({
    name: 'partition/net-client',
    description:
      "Client: starts streaming the server's partition, checks generators match, applies cell deltas, and reports cells.",
    run: (_, world, ctx) => {
      const c = clientNet(world)
      for (const { data } of ctx.reader(WorldEvent.event).read()) {
        const list =
          (data.generators as { name: string; version: number; codeHash: string }[]) ?? []
        const bad = list.filter((g) => {
          const local = options.generators?.(g.name) ?? localGenerator(g.name)
          return !local || local.version !== g.version || local.codeHash !== g.codeHash
        })
        if (bad.length > 0) {
          const error = new ShardError(
            'partition/generator-mismatch',
            `This client's ${bad.map((g) => g.name).join(', ')} differ from the server's`,
            { hint: 'Clients and the server must run the same generator version and code.' },
          )
          world.tryResource(LogResource)?.error(error)
          c.mismatch = error
          netSession(world).client?.dispose()
          continue
        }
        const q = world.query({ with: [PartitionInstance] })
        let has = false
        for (const table of q.tables) has ||= table.count > 0
        if (!has) world.spawn([PartitionInstance, { partition: data.partition, seed: data.seed }])
      }
      for (const { data } of ctx.reader(CellDeltaEvent.event).read()) applyCellDelta(world, data)
      const queued = c.add.length + c.update.length + c.remove.length + c.loaded.length
      if (queued > 0 && world.resource(NetRole).connected) {
        // Hashes finish in the order crypto's thread pool returns them: sort, so the server sees
        // the same report, and builds the same interest order, on every run.
        for (const list of [c.add, c.update, c.remove, c.loaded]) list.sort(byCell)
        sendCommand(world, CellsCommand, {
          add: c.add,
          update: c.update,
          remove: c.remove,
          loaded: c.loaded,
        })
        c.add = []
        c.update = []
        c.remove = []
        c.loaded = []
      }
    },
  })
}

function byCell(a: JsonValue, b: JsonValue): number {
  const p = a as number[]
  const q = b as number[]
  return p[0]! - q[0]! || p[1]! - q[1]! || p[2]! - q[2]!
}

function localGenerator(name: string): { version: number; codeHash: string } | undefined {
  const gen = findGenerator(name)
  return gen && { version: gen.version, codeHash: codeHashOf(gen) }
}

/**
 * Streaming over the network (0113). On the server: the world for joining clients, deltas, cell
 * checks and `streamInterest`'s data; on a client: its own player as the source, cell reports,
 * deltas applied in place. Without the net plugin (a single-player build of the same project) it
 * does nothing.
 */
export function partitionNetPlugin(options: PartitionNetOptions = {}): Plugin {
  return definePlugin({
    name: 'partition/net',
    dependencies: ['partition'],
    build(app) {
      if (!app.hasPlugin('net')) return
      app.addSystems(Last, serverSystem().runIf(onServer).after(keepDeltas).before(NetSystems.send))
      app.addSystems(
        First,
        clientSystem(options).runIf(onClient).after(NetSystems.receive).before(streamCells),
      )
    },
    // Every plugin has built by now, so the net role is known.
    ready(app) {
      const world = app.world
      const role = world.tryResource(NetRole)?.role
      if (!role) return
      const s = world.initResource(PartitionState)
      if (role === 'server') {
        s.hooks = {
          role: 'server',
          isDynamic: (w, e) => {
            const r = w.tryGet(e, Replicated)
            return r !== undefined && !r.bound
          },
          captureExtra: (w, e) => {
            const r = w.tryGet(e, Replicated)
            return r ? { prefab: r.prefab, owner: r.owner } : undefined
          },
          restoreExtra: (w, e, extra) => {
            w.add(e, Replicated, {
              prefab: String(extra.prefab ?? ''),
              owner: Number(extra.owner ?? 0),
            })
          },
          bindSecret: (w, e, ref) => {
            w.add(e, Replicated, { prefab: ref, owner: 0, bound: true })
          },
          describe: (w) =>
            [...serverNet(w).peers].map(([peer, cells]) => {
              let loaded = 0
              for (const c of cells.values()) if (c.loaded) loaded++
              return { peer, reported: cells.size, loaded }
            }),
        }
        // Clients generate these entities themselves: replicating one would send generated content.
        world.observe(onAdd(Replicated), ({ entity, world }) => {
          const part = world.tryGet(entity, InstancePart)
          if (!part || part.instance === null || !world.has(part.instance, StreamedCell)) return
          if (world.get(entity, Replicated).bound) return
          world.tryResource(LogResource)?.error(
            new ShardError(
              'partition/generated-replicated',
              `A generated cell entity (${part.path}) was given net/Replicated`,
              {
                hint: "Change generated entities on the server and let the cell's delta carry it; put secrets in the grid's secrets components.",
              },
            ),
          )
        })
        return
      }
      const c = clientNet(world)
      s.hooks = {
        role: 'client',
        isSource: (w, e) =>
          w.get(e, StreamingSource).peer === w.resource(NetRole).peer &&
          w.resource(NetRole).peer !== 0,
        requestDelta: (_w, cell, level, hash) => {
          c.add.push([cell.grid.index, cell.x, cell.z, level, hash, agent()])
        },
        levelChanged: (_w, cell, level, hash) => {
          c.update.push([cell.grid.index, cell.x, cell.z, level, hash, agent()])
        },
        cellCommitted: (_w, cell) => {
          c.loaded.push([cell.grid.index, cell.x, cell.z])
        },
        cellDropped: (_w, cell) => {
          c.remove.push([cell.grid.index, cell.x, cell.z])
        },
      }
    },
  })
}
