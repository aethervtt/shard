// The client side of hordes past replication (0115): a pooled far-tier proxy per member of every
// horde cell it receives, except members it has as live replicated entities. Proxies glide to each
// update's positions over the update interval; a live zombie arriving starts at its proxy's drawn
// position and converges on its replicated one over 0.5 s.

import { AnimationPlayer, animationLayer } from '@aethervtt/shard-animation'
import {
  defineResource,
  defineSystem,
  type Entity,
  type Query,
  type World,
} from '@aethervtt/shard-core'
import { PartitionState } from '@aethervtt/shard-partition'
import { Visibility } from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { spawnLook } from '../compose'
import { lookOf } from '../looks'
import type { CharacterRig } from '../rig'
import { CharacterRigs } from '../rig'
import { HordeProxy } from '../tiers'
import {
  ACTIVITIES,
  HordeCell,
  HordeMember,
  HordeMembers,
  type MemberPose,
  unpackMember,
} from './components'

/** Seconds a live zombie takes to converge from its proxy's position. */
export const HANDOFF_SECONDS = 0.5
/** Seconds a proxy no cell lists keeps drawing (a member crossing cells, a live one leaving). */
const ORPHAN_GRACE = 2.5
/** A glide never takes longer than this, whatever the gap between two updates. */
const MAX_GLIDE = 3

interface Proxy {
  id: number
  look: number
  entity: Entity
  /** Index in `active`, or -1 when pooled. */
  slot: number
  /** The HordeCell that lists it, or -1 (orphaned since `orphanAt`). */
  cell: Entity
  orphanAt: number
  seen: number
  from: Float64Array
  to: Float64Array
  /** Drawn: x, y, z, yaw. */
  at: Float64Array
  t0: number
  dur: number
  activity: number
}

interface Live {
  id: number
  look: number
  entity: Entity
  stamp: number
  /** Replicated position (without our offset), and what we last wrote. */
  base: Float64Array
  written: Float64Array
  wrote: boolean
  /** Hand-off offset at its start, and when it started (-1: none). */
  offset: Float64Array
  offsetAt: number
  /** Drawn position last frame (offset included), for a proxy resuming from it. */
  at: Float64Array
  yaw: number
}

interface CellRec {
  entity: Entity
  lastUpdate: number
  count: number
  ids: Uint32Array
  /** Decoded x, y, z, yaw per member. */
  pose: Float64Array
}

export interface HordeClientStats {
  cells: number
  /** Proxies drawn, and pooled. */
  proxies: number
  pooled: number
  /** Live horde members (replicated). */
  live: number
  handoffs: number
  resumed: number
}

export interface HordeClientState {
  readonly proxies: Map<number, Proxy>
  readonly active: Proxy[]
  readonly pools: Proxy[][]
  readonly live: Map<number, Live>
  readonly livePool: Live[]
  readonly cells: Map<Entity, CellRec>
  stats: HordeClientStats
}

export const HordeClient = defineResource<HordeClientState>('characters/HordeClient', {
  description: 'Client: horde proxies, live members and hand-offs (0115). Internal.',
  init: () => ({
    proxies: new Map(),
    active: [],
    pools: [],
    live: new Map(),
    livePool: [],
    cells: new Map(),
    stats: { cells: 0, proxies: 0, pooled: 0, live: 0, handoffs: 0, resumed: 0 },
  }),
})

/** Client: cells, proxies drawn and pooled, live members, hand-offs and resumes. */
export function hordeClientStats(world: World): HordeClientStats | undefined {
  return world.tryResource(HordeClient)?.stats
}

/** The proxy drawn for member `id` (entity, and x, y, z, yaw), if there is one. */
export function hordeProxyOf(
  world: World,
  id: number,
): { entity: Entity; at: Float64Array } | undefined {
  const p = world.tryResource(HordeClient)?.proxies.get(id)
  return p && p.slot >= 0 ? { entity: p.entity, at: p.at } : undefined
}

const pose: MemberPose = { x: 0, y: 0, z: 0, yaw: 0, activity: 0 }

/** The first grid's cell size, as the server packed it. */
function cellSizeOf(world: World): number {
  const rt = world.tryResource(PartitionState)?.instances.values().next().value
  return rt?.partition.grids[0]?.cellSize ?? 64
}

function rigOf(world: World, rig: string | CharacterRig): CharacterRig | undefined {
  return typeof rig === 'string' ? world.tryResource(CharacterRigs)?.get(rig) : rig
}

function setPose(world: World, e: Entity, x: number, y: number, z: number, yaw: number): void {
  const table = world.entityTableUnchecked(e)
  const row = world.entityRowUnchecked(e)
  const t = table.column(Transform, 'translation')
  t[row * 3] = x
  t[row * 3 + 1] = y
  t[row * 3 + 2] = z
  const r = table.column(Transform, 'rotation')
  r[row * 4] = 0
  r[row * 4 + 1] = Math.sin(yaw / 2)
  r[row * 4 + 2] = 0
  r[row * 4 + 3] = Math.cos(yaw / 2)
  table.markChanged(Transform, row)
}

function setShown(world: World, e: Entity, shown: boolean): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(Visibility)) {
    world.add(e, Visibility, { mode: shown ? 'inherit' : 'hidden' })
    return
  }
  const row = world.entityRowUnchecked(e)
  const mode = table.column(Visibility, 'mode')
  const want = shown ? 0 : 2
  if (mode[row] !== want) {
    mode[row] = want
    table.markChanged(Visibility, row)
  }
}

function playActivity(world: World, p: Proxy, activity: number): void {
  if (p.activity === activity) return
  p.activity = activity
  const look = lookOf(world, p.look)
  if (!look || !world.has(p.entity, AnimationPlayer)) return
  const name = (look.clips ?? ACTIVITIES)[activity]
  const rig = rigOf(world, look.rig)
  const clip = name === undefined ? undefined : rig?.options.clips?.[name]
  // Members of one look don't step in time: each starts its loop at its own phase.
  world.set(p.entity, AnimationPlayer, {
    layers: clip ? [animationLayer(clip, { loop: 'loop', time: (p.id % 16) * 0.0625 })] : [],
  })
}

function acquire(
  world: World,
  s: HordeClientState,
  id: number,
  look: number,
  x: number,
  y: number,
  z: number,
  yaw: number,
): Proxy | undefined {
  const pool = s.pools[look]
  let p = pool?.pop()
  if (!p) {
    if (!lookOf(world, look)) return undefined
    const entity = spawnLook(world, look, { transform: { translation: [x, y, z] } })
    world.add(entity, HordeProxy)
    p = {
      id,
      look,
      entity,
      slot: -1,
      cell: -1,
      orphanAt: 0,
      seen: 0,
      from: new Float64Array(4),
      to: new Float64Array(4),
      at: new Float64Array(4),
      t0: 0,
      dur: 0,
      activity: -1,
    }
  }
  p.id = id
  p.cell = -1
  p.seen = 0
  p.dur = 0
  p.at[0] = p.from[0] = p.to[0] = x
  p.at[1] = p.from[1] = p.to[1] = y
  p.at[2] = p.from[2] = p.to[2] = z
  p.at[3] = p.from[3] = p.to[3] = yaw
  p.slot = s.active.length
  s.active.push(p)
  s.proxies.set(id, p)
  setShown(world, p.entity, true)
  setPose(world, p.entity, x, y, z, yaw)
  return p
}

function release(world: World, s: HordeClientState, p: Proxy): void {
  if (p.slot < 0) return
  const last = s.active.pop()!
  if (last !== p) {
    s.active[p.slot] = last
    last.slot = p.slot
  }
  p.slot = -1
  s.proxies.delete(p.id)
  if (world.isAlive(p.entity)) {
    setShown(world, p.entity, false)
    playActivity(world, p, -1)
    let pool = s.pools[p.look]
    if (!pool) {
      pool = []
      s.pools[p.look] = pool
    }
    pool.push(p)
  }
}

function glideTo(p: Proxy, now: number, dur: number, x: number, y: number, z: number, yaw: number) {
  p.from[0] = p.at[0]!
  p.from[1] = p.at[1]!
  p.from[2] = p.at[2]!
  p.from[3] = p.at[3]!
  p.to[0] = x
  p.to[1] = y
  p.to[2] = z
  p.to[3] = yaw
  p.t0 = now
  p.dur = dur
}

/** Binary search of a cell's sorted ids. */
function indexOf(ids: Uint32Array, n: number, id: number): number {
  let lo = 0
  let hi = n - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const v = ids[mid]!
    if (v === id) return mid
    if (v < id) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

interface Scratch {
  liveQuery: Query
  cellQuery: Query
  stamp: number
  seen: number
  lastTick: number
  world: World | undefined
  now: number
  departed: (rec: Live, id: number) => void
  gone: (rec: CellRec, e: Entity) => void
}

/** The client's horde proxies system (Update, after the net plugin applied this frame's state). */
export const hordeProxies = defineSystem({
  name: 'characters/horde-proxies',
  description:
    'Client: a pooled far-tier proxy per horde member it has no live replicated entity for, gliding to each update; hand-off to live zombies that arrive, and back when they leave.',
  setup: (world): Scratch => {
    const sc: Scratch = {
      liveQuery: world.query({ with: [HordeMember, Transform] }),
      cellQuery: world.query({ with: [HordeCell, HordeMembers] }),
      stamp: 0,
      seen: 0,
      lastTick: 0,
      world: undefined,
      now: 0,
      departed: (rec, id) => {
        if (rec.stamp === sc.stamp) return
        const w = sc.world!
        const s = w.resource(HordeClient)
        s.live.delete(id)
        s.livePool.push(rec)
        // It left interest: its proxy resumes from where it was drawn, toward its cell's position.
        const p = acquire(w, s, id, rec.look, rec.at[0]!, rec.at[1]!, rec.at[2]!, rec.yaw)
        if (!p) return
        s.stats.resumed++
        p.orphanAt = sc.now
        for (const c of s.cells.values()) {
          const k = indexOf(c.ids, c.count, id)
          if (k < 0) continue
          p.cell = c.entity
          glideTo(
            p,
            sc.now,
            1,
            c.pose[k * 4]!,
            c.pose[k * 4 + 1]!,
            c.pose[k * 4 + 2]!,
            c.pose[k * 4 + 3]!,
          )
          break
        }
      },
      gone: (rec, e) => {
        const w = sc.world!
        if (w.isAlive(e) && w.has(e, HordeCell)) return
        const s = w.resource(HordeClient)
        for (let i = 0; i < rec.count; i++) {
          const p = s.proxies.get(rec.ids[i]!)
          if (p && p.cell === e) {
            p.cell = -1
            p.orphanAt = sc.now
          }
        }
        s.cells.delete(e)
      },
    }
    return sc
  },
  run: (sc, world) => {
    const s = world.initResource(HordeClient)
    const now = world.resource(Time).elapsed
    sc.world = world
    sc.now = now
    const stamp = ++sc.stamp
    // 1. Live members: arrivals take over from their proxies; offsets decay.
    for (let t = 0; t < sc.liveQuery.tables.length; t++) {
      const table = sc.liveQuery.tables[t]!
      if (table.has(HordeProxy)) continue
      const ids = table.column(HordeMember, 'id')
      const looks = table.column(HordeMember, 'look')
      const tr = table.column(Transform, 'translation')
      const rot = table.column(Transform, 'rotation')
      for (let row = 0; row < table.count; row++) {
        const id = ids[row]!
        const e = table.entities[row]!
        let rec = s.live.get(id)
        const o = row * 3
        if (!rec || rec.entity !== e) {
          if (!rec) {
            rec = s.livePool.pop() ?? {
              id,
              look: 0,
              entity: e,
              stamp: 0,
              base: new Float64Array(3),
              written: new Float64Array(3),
              wrote: false,
              offset: new Float64Array(3),
              offsetAt: -1,
              at: new Float64Array(3),
              yaw: 0,
            }
            s.live.set(id, rec)
          }
          rec.id = id
          rec.entity = e
          rec.wrote = false
          rec.offsetAt = -1
          const p = s.proxies.get(id)
          if (p && p.slot >= 0) {
            // Hand-off: start where the proxy is drawn, converge on the replicated position.
            rec.offset[0] = p.at[0]! - tr[o]!
            rec.offset[1] = p.at[1]! - tr[o + 1]!
            rec.offset[2] = p.at[2]! - tr[o + 2]!
            rec.offsetAt = now
            release(world, s, p)
            s.stats.handoffs++
          }
        }
        rec.look = looks[row]!
        rec.stamp = stamp
        const q = row * 4
        rec.yaw = Math.atan2(
          2 * (rot[q + 3]! * rot[q + 1]! + rot[q]! * rot[q + 2]!),
          1 - 2 * (rot[q + 1]! * rot[q + 1]! + rot[q]! * rot[q]!),
        )
        // Our last write still there: the replicated position is the one under it.
        if (
          !rec.wrote ||
          tr[o] !== rec.written[0] ||
          tr[o + 1] !== rec.written[1] ||
          tr[o + 2] !== rec.written[2]
        ) {
          rec.base[0] = tr[o]!
          rec.base[1] = tr[o + 1]!
          rec.base[2] = tr[o + 2]!
        }
        let k = 0
        if (rec.offsetAt >= 0) {
          k = 1 - (now - rec.offsetAt) / HANDOFF_SECONDS
          if (k <= 0) {
            k = 0
            rec.offsetAt = -1
          }
        }
        rec.at[0] = rec.base[0]! + rec.offset[0]! * k
        rec.at[1] = rec.base[1]! + rec.offset[1]! * k
        rec.at[2] = rec.base[2]! + rec.offset[2]! * k
        if (rec.wrote || k > 0) {
          tr[o] = rec.at[0]!
          tr[o + 1] = rec.at[1]!
          tr[o + 2] = rec.at[2]!
          rec.written[0] = tr[o]!
          rec.written[1] = tr[o + 1]!
          rec.written[2] = tr[o + 2]!
          table.markChanged(Transform, row)
          // After the offset is gone, one last write puts the replicated position back.
          rec.wrote = k > 0
        }
      }
    }
    // 2. Live members gone: their proxies resume.
    s.live.forEach(sc.departed)
    // 3. Horde cells that changed this frame.
    for (let t = 0; t < sc.cellQuery.tables.length; t++) {
      const table = sc.cellQuery.tables[t]!
      if (
        table.lastStructural <= sc.lastTick &&
        table.lastChanged(HordeMembers) <= sc.lastTick &&
        table.lastChanged(HordeCell) <= sc.lastTick
      )
        continue
      const cellTicks = table.changedTicks(HordeCell)
      const memberTicks = table.changedTicks(HordeMembers)
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        let rec = s.cells.get(e)
        if (rec && cellTicks[row]! <= sc.lastTick && memberTicks[row]! <= sc.lastTick) continue
        if (table.column(HordeCell, 'rev')[row] !== table.column(HordeMembers, 'rev')[row]) continue
        if (!rec) {
          rec = {
            entity: e,
            lastUpdate: -1,
            count: 0,
            ids: new Uint32Array(16),
            pose: new Float64Array(64),
          }
          s.cells.set(e, rec)
        }
        updateCell(world, sc, s, rec, table, row, now)
      }
    }
    sc.lastTick = world.tick
    // 4. Cells gone: their proxies are orphans.
    s.cells.forEach(sc.gone)
    // 5. Glide, and drop orphans past their grace.
    for (let i = s.active.length - 1; i >= 0; i--) {
      const p = s.active[i]!
      if (p.cell === -1 && now - p.orphanAt > ORPHAN_GRACE) {
        release(world, s, p)
        continue
      }
      const u = p.dur > 0 ? Math.min(1, (now - p.t0) / p.dur) : 1
      p.at[0] = p.from[0]! + (p.to[0]! - p.from[0]!) * u
      p.at[1] = p.from[1]! + (p.to[1]! - p.from[1]!) * u
      p.at[2] = p.from[2]! + (p.to[2]! - p.from[2]!) * u
      let dyaw = p.to[3]! - p.from[3]!
      if (dyaw > Math.PI) dyaw -= 2 * Math.PI
      else if (dyaw < -Math.PI) dyaw += 2 * Math.PI
      p.at[3] = p.from[3]! + dyaw * u
      setPose(world, p.entity, p.at[0]!, p.at[1]!, p.at[2]!, p.at[3]!)
    }
    let pooled = 0
    for (let i = 0; i < s.pools.length; i++) pooled += s.pools[i]?.length ?? 0
    s.stats.cells = s.cells.size
    s.stats.proxies = s.active.length
    s.stats.pooled = pooled
    s.stats.live = s.live.size
  },
})

function updateCell(
  world: World,
  sc: Scratch,
  s: HordeClientState,
  rec: CellRec,
  table: ReturnType<World['entityTableUnchecked']>,
  row: number,
  now: number,
): void {
  const e = rec.entity
  const cs = cellSizeOf(world)
  const cx = table.column(HordeCell, 'x')[row]!
  const cz = table.column(HordeCell, 'z')[row]!
  const baseY = table.column(HordeCell, 'y')[row]!
  const ids = (table.column(HordeCell, 'ids') as unknown as number[][])[row] ?? []
  const looks = (table.column(HordeCell, 'looks') as unknown as number[][])[row] ?? []
  const members = (table.column(HordeMembers, 'members') as unknown as number[][])[row] ?? []
  const n = Math.min(ids.length, members.length)
  // Glide over the gap since this cell's last update: that's when the next one is due.
  const dur = rec.lastUpdate < 0 ? 0 : Math.min(MAX_GLIDE, now - rec.lastUpdate)
  rec.lastUpdate = now
  const seen = ++sc.seen
  // Members no longer listed here are orphans (unless another cell claims them).
  for (let i = 0; i < rec.count; i++) {
    const id = rec.ids[i]!
    if (indexOf(ids as unknown as Uint32Array, ids.length, id) >= 0) continue
    const p = s.proxies.get(id)
    if (p && p.cell === e) {
      p.cell = -1
      p.orphanAt = now
    }
  }
  if (rec.ids.length < n) {
    rec.ids = new Uint32Array(n * 2)
    rec.pose = new Float64Array(n * 8)
  }
  for (let i = 0; i < n; i++) {
    const id = ids[i]!
    unpackMember(members[i]!, cs, cx, cz, baseY, pose)
    rec.ids[i] = id
    rec.pose[i * 4] = pose.x
    rec.pose[i * 4 + 1] = pose.y
    rec.pose[i * 4 + 2] = pose.z
    rec.pose[i * 4 + 3] = pose.yaw
    if (s.live.has(id)) continue
    let p = s.proxies.get(id)
    if (p && p.look !== looks[i]) {
      release(world, s, p)
      p = undefined
    }
    if (!p) {
      p = acquire(world, s, id, looks[i] ?? 0, pose.x, pose.y, pose.z, pose.yaw)
      if (!p) continue
    } else glideTo(p, now, dur, pose.x, pose.y, pose.z, pose.yaw)
    p.cell = e
    p.seen = seen
    playActivity(world, p, pose.activity)
  }
  rec.count = n
}
