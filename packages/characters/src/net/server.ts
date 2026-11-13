// The server side of hordes past replication (0115): one HordeCell entity per occupied cell near
// a player, from live HordeMember entities and 0113's dormant entities, refreshed at 2 Hz with
// cells staggered across frames.

import {
  defineResource,
  defineSystem,
  type Entity,
  entityIndex,
  type Query,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { Replicated } from '@aethervtt/shard-net'
import {
  cellDistance,
  cellKey,
  type DeltaState,
  PartitionState,
  type ResolvedGrid,
  StreamingSource,
} from '@aethervtt/shard-partition'
import { Time } from '@aethervtt/shard-runtime'
import { NoSave } from '@aethervtt/shard-save'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { HordeCell, HordeMember, HordeMembers, IDLE, packMember, WALK, yFits } from './components'

/** Seconds between two refreshes of one cell. */
export const HORDE_PERIOD = 0.5
/** Each period is split into this many slots; a cell refreshes in its own. */
const SLOTS = 16
const BIAS = 1 << 20
const SPAN = 1 << 21
const MAX_SOURCES = 64

export interface HordeServerOptions {
  /**
   * A live member's activity (0 idle, 1 walk, 2 attack, up to 7). Default: walk when it moved at
   * least one packing step since the cell's last refresh, else idle. Dormant members are idle.
   */
  activity?: (world: World, entity: Entity) => number
}

/** Per cell: this refresh's members, the dormant cache, and what was last written. */
interface CellState {
  x: number
  z: number
  slot: number
  /** 0113's cell key, for its delta. */
  deltaKey: string
  entity: Entity
  /** The run that refreshes it out of its slot (a member it gained that no cell lists yet). */
  extra: number
  liveStamp: number
  liveCount: number
  liveEntity: Float64Array
  liveId: Uint32Array
  liveLook: Uint16Array
  /** x, y, z, yaw per live member. */
  livePose: Float64Array
  delta: DeltaState | undefined
  dormantRev: number
  dormantCount: number
  dormantId: Uint32Array
  dormantLook: Uint16Array
  dormantPose: Float64Array
  /** Merged members, ascending by id (indices: < liveCount live, else dormant). */
  order: Int32Array
  count: number
  ids: Uint32Array
  looks: Uint16Array
  packed: Uint32Array
  /** The previous refresh's ids and packed words (activity by movement). */
  prevCount: number
  prevIds: Uint32Array
  prevPacked: Uint32Array
  y: number
  rev: number
}

export interface HordeServerStats {
  /** HordeCell entities. */
  cells: number
  /** Members in them. */
  members: number
  /** Cells whose ids and looks were rewritten, and whose positions were, since the start. */
  membershipWrites: number
  positionWrites: number
  /** Dormant lists re-read since the start. */
  dormantReads: number
  /** Last run's ms. */
  ms: number
}

export interface HordeServerState {
  readonly cells: Map<number, CellState>
  readonly bySlot: CellState[][]
  readonly byDeltaKey: Map<string, CellState>
  /** Per entity index: the numeric key + 1 of the cell it was last listed in. */
  listed: Float64Array
  nextId: number
  stats: HordeServerStats
}

export const HordeServer = defineResource<HordeServerState>('characters/HordeServer', {
  description: 'Server: horde cells, their members and dormant caches (0115). Internal.',
  init: () => ({
    cells: new Map(),
    bySlot: Array.from({ length: SLOTS }, () => []),
    byDeltaKey: new Map(),
    listed: new Float64Array(1024),
    nextId: 1,
    stats: {
      cells: 0,
      members: 0,
      membershipWrites: 0,
      positionWrites: 0,
      dormantReads: 0,
      ms: 0,
    },
  }),
})

/** Server: HordeCell entities, members, rewrites and last run's ms. */
export function hordeServerStats(world: World): HordeServerStats | undefined {
  return world.tryResource(HordeServer)?.stats
}

/** Assigns ids to members spawned with id 0, and keeps the next id past every id seen. */
export function noteMemberId(world: World, entity: Entity): void {
  const s = world.initResource(HordeServer)
  const table = world.entityTableUnchecked(entity)
  const row = world.entityRowUnchecked(entity)
  const ids = table.column(HordeMember, 'id')
  if (ids[row] === 0) {
    ids[row] = s.nextId++
    table.markChanged(HordeMember, row)
  } else if (ids[row]! >= s.nextId) s.nextId = ids[row]! + 1
}

function grow<T extends Float64Array | Uint32Array | Uint16Array | Int32Array>(a: T, n: number): T {
  if (a.length >= n) return a
  let size = Math.max(16, a.length)
  while (size < n) size *= 2
  const out = new (a.constructor as new (n: number) => T)(size)
  out.set(a as never)
  return out
}

function slotOf(x: number, z: number): number {
  return ((Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0) % SLOTS
}

function numericKey(x: number, z: number): number {
  return (x + BIAS) * SPAN + (z + BIAS)
}

function newCell(s: HordeServerState, x: number, z: number): CellState {
  const c: CellState = {
    x,
    z,
    slot: slotOf(x, z),
    deltaKey: cellKey(0, x, z),
    entity: -1,
    extra: -1,
    liveStamp: -1,
    liveCount: 0,
    liveEntity: new Float64Array(16),
    liveId: new Uint32Array(16),
    liveLook: new Uint16Array(16),
    livePose: new Float64Array(64),
    delta: undefined,
    dormantRev: -1,
    dormantCount: 0,
    dormantId: new Uint32Array(0),
    dormantLook: new Uint16Array(0),
    dormantPose: new Float64Array(0),
    order: new Int32Array(16),
    count: 0,
    ids: new Uint32Array(16),
    looks: new Uint16Array(16),
    packed: new Uint32Array(16),
    prevCount: 0,
    prevIds: new Uint32Array(16),
    prevPacked: new Uint32Array(16),
    y: 0,
    rev: 0,
  }
  s.cells.set(numericKey(x, z), c)
  s.bySlot[c.slot]!.push(c)
  s.byDeltaKey.set(c.deltaKey, c)
  return c
}

/** Yaw (radians about +Y) of a unit quaternion. */
function yawOf(qx: number, qy: number, qz: number, qw: number): number {
  return Math.atan2(2 * (qw * qy + qx * qz), 1 - 2 * (qy * qy + qx * qx))
}

/** Re-reads a cell's dormant members (its delta changed). Cold-ish: only on a dormant change. */
function readDormant(s: HordeServerState, c: CellState, delta: DeltaState | undefined): void {
  c.delta = delta
  c.dormantRev = delta?.dormantRev ?? -1
  c.dormantCount = 0
  s.stats.dormantReads++
  const list = delta?.dormant
  if (!list || list.length === 0) return
  c.dormantId = grow(c.dormantId, list.length)
  c.dormantLook = grow(c.dormantLook, list.length)
  c.dormantPose = grow(c.dormantPose, list.length * 4)
  for (let i = 0; i < list.length; i++) {
    const comps = list[i]!.components
    const m = comps['characters/HordeMember'] as { id?: number; look?: number } | undefined
    const tr = comps['core/Transform'] as
      | { translation?: number[]; rotation?: number[] }
      | undefined
    if (!m || !tr?.translation) continue
    const id = m.id ?? 0
    if (id === 0) continue
    if (id >= s.nextId) s.nextId = id + 1
    const k = c.dormantCount++
    c.dormantId[k] = id
    c.dormantLook[k] = m.look ?? 0
    const t = tr.translation
    const r = tr.rotation ?? [0, 0, 0, 1]
    c.dormantPose[k * 4] = t[0] ?? 0
    c.dormantPose[k * 4 + 1] = t[1] ?? 0
    c.dormantPose[k * 4 + 2] = t[2] ?? 0
    c.dormantPose[k * 4 + 3] = yawOf(r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1)
  }
}

interface Scratch {
  members: Query
  sources: Query
  src: Float64Array
  srcCount: number
  lastSlot: number
  due: Uint8Array
  stamp: number
  deltas: Map<string, DeltaState> | undefined
  state: HordeServerState | undefined
  world: World | undefined
  activity: ((world: World, entity: Entity) => number) | undefined
  discover: (delta: DeltaState, key: string) => void
  /** Cells refreshed out of their slot this run. */
  extra: CellState[]
}

/** The server's hordes system: build it with the plugin's options. */
export function hordesSystem(options: HordeServerOptions = {}) {
  return defineSystem({
    name: 'characters/hordes',
    description:
      'Server: a HordeCell per occupied cell within 1.25 × the far range of a player, from live HordeMember entities and dormant ones, refreshed at 2 Hz with cells staggered across frames.',
    setup: (world): Scratch => {
      const sc: Scratch = {
        members: world.query({ with: [HordeMember, Transform] }),
        sources: world.query({ with: [StreamingSource, Transform] }),
        src: new Float64Array(MAX_SOURCES * 2),
        srcCount: 0,
        lastSlot: -1,
        due: new Uint8Array(SLOTS),
        stamp: 0,
        deltas: undefined,
        state: undefined,
        world: undefined,
        activity: options.activity,
        extra: [],
        discover: (delta, key) => {
          const s = sc.state!
          if (delta.dormant.length === 0 || s.byDeltaKey.has(key)) return
          if (key.charCodeAt(0) !== 48 || key.charCodeAt(1) !== 58) return // "0:": the first grid
          const comma = key.indexOf(',')
          newCell(s, Number(key.slice(2, comma)), Number(key.slice(comma + 1)))
        },
      }
      return sc
    },
    run: (sc, world) => {
      const t0 = performance.now()
      const ps = world.tryResource(PartitionState)
      const rt = ps?.instances.values().next().value
      const grid = rt?.partition.grids[0]
      if (!ps || !rt || !grid) return
      const s = world.initResource(HordeServer)
      // Which slots came due since the last run (a long frame can cover several).
      const slotNow = Math.floor((world.resource(Time).elapsed / HORDE_PERIOD) * SLOTS)
      if (slotNow === sc.lastSlot) return
      const first =
        sc.lastSlot < 0 ? slotNow - SLOTS + 1 : Math.max(sc.lastSlot + 1, slotNow - SLOTS + 1)
      sc.due.fill(0)
      let periodStart = false
      for (let k = first; k <= slotNow; k++) {
        const slot = ((k % SLOTS) + SLOTS) % SLOTS
        sc.due[slot] = 1
        if (slot === 0) periodStart = true
      }
      sc.lastSlot = slotNow
      sc.state = s
      sc.world = world
      sc.deltas = ps.deltas.get(rt.partition.name)
      // Once a period: cells that have dormant members and no state yet.
      if (periodStart || sc.stamp === 0) sc.deltas?.forEach(sc.discover)
      gatherSources(world, sc)
      const stamp = ++sc.stamp
      // Live members of due cells.
      const cs = grid.cellSize
      sc.extra.length = 0
      for (let ti = 0; ti < sc.members.tables.length; ti++) {
        const table = sc.members.tables[ti]!
        if (table.count > 0) scanTable(world, sc, s, table, cs, stamp, false)
      }
      // Members no cell lists yet (new ones): their cells refresh now, so they show at once.
      if (sc.extra.length > 0) {
        for (let ti = 0; ti < sc.members.tables.length; ti++) {
          const table = sc.members.tables[ti]!
          if (table.count > 0) scanTable(world, sc, s, table, cs, stamp, true)
        }
      }
      // Refresh due cells.
      const reach = 1.25 * grid.levels[grid.levels.length - 1]!.range
      for (let slot = 0; slot < SLOTS; slot++) {
        if (sc.due[slot] === 0) continue
        const list = s.bySlot[slot]!
        for (let i = 0; i < list.length; i++) refresh(world, sc, s, list[i]!, grid, reach, stamp)
      }
      for (let i = 0; i < sc.extra.length; i++)
        refresh(world, sc, s, sc.extra[i]!, grid, reach, stamp)
      s.stats.ms = performance.now() - t0
    },
  })
}

function gatherSources(world: World, sc: Scratch): void {
  sc.srcCount = 0
  for (let ti = 0; ti < sc.sources.tables.length; ti++) {
    const table = sc.sources.tables[ti]!
    const enabled = table.column(StreamingSource, 'enabled')
    const g = table.has(GlobalTransform) ? table.column(GlobalTransform, 'matrix') : undefined
    const tr = table.column(Transform, 'translation')
    for (let row = 0; row < table.count && sc.srcCount < MAX_SOURCES; row++) {
      if (enabled[row] === 0) continue
      const k = sc.srcCount++
      sc.src[k * 2] = g ? g[row * 12 + 3]! : tr[row * 3]!
      sc.src[k * 2 + 1] = g ? g[row * 12 + 11]! : tr[row * 3 + 2]!
    }
  }
  void world
}

function scanTable(
  world: World,
  sc: Scratch,
  s: HordeServerState,
  table: Table,
  cs: number,
  stamp: number,
  extraPass: boolean,
): void {
  const ids = table.column(HordeMember, 'id')
  const looks = table.column(HordeMember, 'look')
  const global = table.has(GlobalTransform) ? table.column(GlobalTransform, 'matrix') : undefined
  const tr = table.column(Transform, 'translation')
  const rot = table.column(Transform, 'rotation')
  for (let row = 0; row < table.count; row++) {
    let x: number
    let y: number
    let z: number
    let yaw: number
    if (global) {
      const o = row * 12
      x = global[o + 3]!
      y = global[o + 7]!
      z = global[o + 11]!
      yaw = Math.atan2(global[o + 2]!, global[o]!)
    } else {
      x = tr[row * 3]!
      y = tr[row * 3 + 1]!
      z = tr[row * 3 + 2]!
      yaw = yawOf(rot[row * 4]!, rot[row * 4 + 1]!, rot[row * 4 + 2]!, rot[row * 4 + 3]!)
    }
    const cx = Math.floor(x / cs)
    const cz = Math.floor(z / cs)
    // A member stays listed in the cell it was last listed in until its new cell lists it, so
    // one crossing between two cells' slots is never left out of a period (it may be in both).
    const e = table.entities[row]!
    const index = entityIndex(e)
    if (index >= s.listed.length) s.listed = grow(s.listed, index + 1)
    let c: CellState | undefined
    if (extraPass) {
      c = s.cells.get(numericKey(cx, cz))
      if (!c || c.extra !== stamp) continue
    } else if (sc.due[slotOf(cx, cz)] !== 0) {
      c = s.cells.get(numericKey(cx, cz))
      if (!c) c = newCell(s, cx, cz)
    } else {
      const was = s.listed[index]! - 1
      if (was < 0) {
        c = s.cells.get(numericKey(cx, cz))
        if (!c) c = newCell(s, cx, cz)
        if (c.extra !== stamp) {
          c.extra = stamp
          sc.extra.push(c)
        }
        continue
      }
      if (was === numericKey(cx, cz)) continue
      c = s.cells.get(was)
      if (!c || sc.due[c.slot] === 0) continue
    }
    s.listed[index] = numericKey(c.x, c.z) + 1
    if (ids[row] === 0) noteMemberId(world, e)
    if (c.liveStamp !== stamp) {
      c.liveStamp = stamp
      c.liveCount = 0
    }
    const k = c.liveCount++
    if (k >= c.liveId.length) {
      c.liveEntity = grow(c.liveEntity, k + 1)
      c.liveId = grow(c.liveId, k + 1)
      c.liveLook = grow(c.liveLook, k + 1)
      c.livePose = grow(c.livePose, (k + 1) * 4)
    }
    c.liveEntity[k] = e
    c.liveId[k] = ids[row]!
    c.liveLook[k] = looks[row]!
    c.livePose[k * 4] = x
    c.livePose[k * 4 + 1] = y
    c.livePose[k * 4 + 2] = z
    c.livePose[k * 4 + 3] = yaw
  }
}

function inReach(sc: Scratch, cs: number, x: number, z: number, reach: number): boolean {
  for (let k = 0; k < sc.srcCount; k++) {
    if (cellDistance(cs, x, z, sc.src[k * 2]!, sc.src[k * 2 + 1]!) <= reach) return true
  }
  return false
}

function idAt(c: CellState, i: number): number {
  return i < c.liveCount ? c.liveId[i]! : c.dormantId[i - c.liveCount]!
}

function refresh(
  world: World,
  sc: Scratch,
  s: HordeServerState,
  c: CellState,
  grid: ResolvedGrid,
  reach: number,
  stamp: number,
): void {
  if (c.liveStamp !== stamp) c.liveCount = 0
  const delta = sc.deltas?.get(c.deltaKey)
  if (delta !== c.delta || (delta !== undefined && delta.dormantRev !== c.dormantRev))
    readDormant(s, c, delta)
  const n = c.liveCount + c.dormantCount
  if (n === 0 || !inReach(sc, grid.cellSize, c.x, c.z, reach)) {
    if (c.entity >= 0) {
      if (world.isAlive(c.entity)) world.despawn(c.entity)
      c.entity = -1
      s.stats.cells--
      s.stats.members -= c.count
    }
    c.count = 0
    c.prevCount = 0
    return
  }
  // Sort by id (insertion sort: the order barely changes between refreshes).
  c.order = grow(c.order, n)
  const order = c.order
  for (let i = 0; i < n; i++) {
    const id = idAt(c, i)
    let j = i - 1
    while (j >= 0 && idAt(c, order[j]!) > id) {
      order[j + 1] = order[j]!
      j--
    }
    order[j + 1] = i
  }
  // Swap in the previous refresh's arrays, then fill this one's.
  const pIds = c.prevIds
  const pPacked = c.prevPacked
  c.prevIds = c.ids
  c.prevPacked = c.packed
  c.prevCount = c.count
  c.ids = grow(pIds, n)
  c.packed = grow(pPacked, n)
  const prevLooks = c.looks
  let membership = c.entity < 0 || n !== c.prevCount
  c.looks = grow(c.looks, n)
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (let k = 0; k < n; k++) {
    const i = order[k]!
    const live = i < c.liveCount
    const id = live ? c.liveId[i]! : c.dormantId[i - c.liveCount]!
    const look = live ? c.liveLook[i]! : c.dormantLook[i - c.liveCount]!
    const y = live ? c.livePose[i * 4 + 1]! : c.dormantPose[(i - c.liveCount) * 4 + 1]!
    if (!membership && (c.prevIds[k] !== id || prevLooks[k] !== look)) membership = true
    c.ids[k] = id
    c.looks[k] = look
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  // y is rebased with the membership, or when a member no longer fits.
  let rebase = membership || !yFits(c.y, minY) || !yFits(c.y, maxY)
  if (rebase) {
    const y = Math.round((minY + maxY) / 2 / 0.25) * 0.25
    if (y !== c.y || membership) c.y = y
    else rebase = false
  }
  // Pack, walking the previous refresh's ids (ascending) for the default activity.
  const cs = grid.cellSize
  let changed = membership || rebase
  let p = 0
  for (let k = 0; k < n; k++) {
    const i = order[k]!
    const id = c.ids[k]!
    let pose: Float64Array
    let o: number
    let activity = IDLE
    if (i < c.liveCount) {
      pose = c.livePose
      o = i * 4
      while (p < c.prevCount && c.prevIds[p]! < id) p++
      if (sc.activity) activity = sc.activity(world, c.liveEntity[i]!)
      else if (p < c.prevCount && c.prevIds[p] === id) {
        const before = c.prevPacked[p]!
        const w = packMember(cs, c.x, c.z, c.y, pose[o]!, pose[o + 1]!, pose[o + 2]!, 0, 0)
        const dx = (w & 0xff) - (before & 0xff)
        const dz = ((w >>> 8) & 0xff) - ((before >>> 8) & 0xff)
        activity = dx * dx + dz * dz >= 1 ? WALK : IDLE
      }
    } else {
      pose = c.dormantPose
      o = (i - c.liveCount) * 4
    }
    const word = packMember(
      cs,
      c.x,
      c.z,
      c.y,
      pose[o]!,
      pose[o + 1]!,
      pose[o + 2]!,
      pose[o + 3]!,
      activity,
    )
    c.packed[k] = word
    if (!changed && (k >= c.prevCount || c.prevPacked[k] !== word)) changed = true
  }
  c.count = n
  if (c.entity < 0) {
    c.entity = world.spawn(
      [HordeCell, { grid: grid.index, x: c.x, z: c.z }],
      [HordeMembers, {}],
      [Replicated, { owner: 0 }],
      NoSave,
    )
    s.stats.cells++
    s.stats.members += n
  } else s.stats.members += n - c.prevCount
  const table = world.entityTableUnchecked(c.entity)
  const row = world.entityRowUnchecked(c.entity)
  if (membership || rebase) {
    c.rev = (c.rev + 1) & 0xffff
    table.column(HordeCell, 'y')[row] = c.y
    table.column(HordeCell, 'rev')[row] = c.rev
    writeList(table.column(HordeCell, 'ids') as unknown as number[][], row, c.ids, n)
    writeList(table.column(HordeCell, 'looks') as unknown as number[][], row, c.looks, n)
    table.markChanged(HordeCell, row)
    s.stats.membershipWrites++
  }
  if (changed) {
    table.column(HordeMembers, 'rev')[row] = c.rev
    writeList(table.column(HordeMembers, 'members') as unknown as number[][], row, c.packed, n)
    table.markChanged(HordeMembers, row)
    s.stats.positionWrites++
  }
}

function writeList(
  column: number[][],
  row: number,
  from: Uint32Array | Uint16Array,
  n: number,
): void {
  let list = column[row]
  if (!list) {
    list = []
    column[row] = list
  }
  list.length = n
  for (let i = 0; i < n; i++) list[i] = from[i]!
}
