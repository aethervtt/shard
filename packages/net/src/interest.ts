import {
  ChildOf,
  type ComponentDef,
  type Entity,
  entityIndex,
  type Fields,
  type Query,
  type QueryDescriptor,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { Replicated } from './components'
import type { PeerId } from './transport'
import { NumberList } from './vec'

/** The largest send interval `RelevanceSet.add` takes, in network ticks. */
export const MAX_SEND_INTERVAL = 0xffff

/**
 * A set of entities with a stable iteration order. Membership is a stamp per entity index, so
 * `clear` is O(1) and refilling it every tick allocates nothing once it has grown.
 *
 * Each entity also has a send interval (0113): the network ticks between its unreliable state
 * sends. When several policies add one entity, the smallest interval wins.
 */
export class RelevanceSet {
  private readonly list = new NumberList()
  private stamp = 1
  private marks = new Uint32Array(64)
  private ids = new Float64Array(64)
  private intervals = new Uint16Array(64)

  private grow(index: number): void {
    let size = this.marks.length
    while (size <= index) size *= 2
    const marks = new Uint32Array(size)
    marks.set(this.marks)
    const ids = new Float64Array(size)
    ids.set(this.ids)
    const intervals = new Uint16Array(size)
    intervals.set(this.intervals)
    this.marks = marks
    this.ids = ids
    this.intervals = intervals
  }

  /**
   * Adds `entity`, sent every `every` network ticks (1: every tick). Adding it again keeps the
   * smaller interval.
   */
  add(entity: Entity, every = 1): void {
    if (every !== 1 && ((every | 0) !== every || every < 1 || every > MAX_SEND_INTERVAL)) {
      throw new ShardError('net/bad-interval', `Send interval ${every} isn't a whole number ≥ 1`, {
        hint: `Pass a whole number of network ticks from 1 to ${MAX_SEND_INTERVAL}.`,
      })
    }
    const i = entityIndex(entity)
    if (i >= this.marks.length) this.grow(i)
    if (this.marks[i] === this.stamp && this.ids[i] === entity) {
      if (every < this.intervals[i]!) this.intervals[i] = every
      return
    }
    this.marks[i] = this.stamp
    this.ids[i] = entity
    this.intervals[i] = every
    this.list.push(entity)
  }

  has(entity: Entity): boolean {
    const i = entityIndex(entity)
    return i < this.marks.length && this.marks[i] === this.stamp && this.ids[i] === entity
  }

  /** The entity's send interval in network ticks: 1 when it isn't in the set. */
  everyOf(entity: Entity): number {
    const i = entityIndex(entity)
    if (i >= this.marks.length || this.marks[i] !== this.stamp || this.ids[i] !== entity) return 1
    return this.intervals[i]!
  }

  get size(): number {
    return this.list.length
  }

  /** The entity at `i`, in the order they were added. */
  at(i: number): Entity {
    return this.list.data[i]!
  }

  /** A copy, for tools. */
  get entities(): Entity[] {
    return this.list.toArray()
  }

  clear(): void {
    this.list.clear()
    if (++this.stamp === 0xffffffff) {
      this.marks.fill(0)
      this.stamp = 1
    }
  }

  /** Keeps the entities `keep` returns true for. Kept entities keep their intervals. */
  retain(keep: (entity: Entity) => boolean): void {
    const data = this.list.data
    let n = 0
    for (let i = 0; i < this.list.length; i++) {
      const e = data[i]!
      if (keep(e)) data[n++] = e
      else this.marks[entityIndex(e)] = 0
    }
    this.list.length = n
  }

  /**
   * Keeps the entities `other` has too. Each keeps the larger of its two intervals: an entity
   * every policy wants is sent as often as the least eager of them asks.
   */
  intersect(other: RelevanceSet): void {
    const data = this.list.data
    let n = 0
    for (let k = 0; k < this.list.length; k++) {
      const e = data[k]!
      const i = entityIndex(e)
      if (other.has(e)) {
        data[n++] = e
        const theirs = other.intervals[i]!
        if (theirs > this.intervals[i]!) this.intervals[i] = theirs
      } else this.marks[i] = 0
    }
    this.list.length = n
  }
}

/** What a policy knows about the peer it decides for. */
export interface InterestPeer {
  readonly id: PeerId
  /** The entities the peer owns and its `Focus` entities, this tick. */
  readonly focus: readonly Entity[]
  /** Whether the peer has the entity now: policies keep known entities a little longer. */
  knows(entity: Entity): boolean
}

/**
 * Decides which replicated entities a peer receives (0087). The server runs it every network
 * tick; anything it leaves out is never encoded for that peer, and despawns on its side.
 */
export interface InterestPolicy {
  readonly name: string
  /** Once per network tick, before any peer: rebuild shared indexes. */
  prepare?(world: World): void
  update(world: World, peer: InterestPeer, out: RelevanceSet): void
}

/** A query made once per world: `world.query` builds a key string on every call. */
function cachedQuery(desc: () => QueryDescriptor): (world: World) => Query {
  let world: World | undefined
  let query: Query | undefined
  return (w) => {
    if (w !== world || !query) {
      world = w
      query = w.query(desc())
    }
    return query
  }
}

/** Every replicated entity (with all of `filter`, if given): turn order, scores, the board. */
export function alwaysInterest(filter: readonly ComponentDef[] = []): InterestPolicy {
  const query = cachedQuery(() => ({ with: [Replicated, ...filter] }))
  return {
    name: 'always',
    update(world, _peer, out) {
      const q = query(world)
      for (const table of q.tables) {
        for (let row = 0; row < table.count; row++) out.add(table.entities[row]!)
      }
    },
  }
}

/** Entities the peer owns, and their children (through `ChildOf`). */
export function ownerInterest(): InterestPolicy {
  const query = cachedQuery(() => ({ with: [Replicated] }))
  const children = cachedQuery(() => ({ with: [Replicated, ChildOf] }))
  return {
    name: 'owner',
    update(world, peer, out) {
      const q = query(world)
      for (const table of q.tables) {
        const owner = table.column(Replicated, 'owner')
        for (let row = 0; row < table.count; row++) {
          if (owner[row] === peer.id) out.add(table.entities[row]!)
        }
      }
      addChildren(children(world), out)
    },
  }
}

/** Adds replicated children of entities already in `out`, a level per pass. */
function addChildren(q: Query, out: RelevanceSet): void {
  for (let depth = 0; depth < 8; depth++) {
    const before = out.size
    for (const table of q.tables) {
      const parent = table.column(ChildOf, 'parent')
      for (let row = 0; row < table.count; row++) {
        if (parent[row]! >= 0 && out.has(parent[row]!)) out.add(table.entities[row]!)
      }
    }
    if (out.size === before) return
  }
}

export interface GridInterestOptions {
  /** Cell edge in metres. */
  cellSize: number
  /** Cells around each focus cell a peer receives (Chebyshev distance). */
  range: number
  /** Cells on Y too (space, tall worlds). Default false: cells are columns on X and Z. */
  vertical?: boolean
}

const BIAS = 65536
const SPAN = 131072

/**
 * Entities within `range` cells of the peer's focus (0087), by world position. A known entity
 * stays relevant one cell further, so one at the edge doesn't flicker in and out.
 */
export function gridInterest(options: GridInterestOptions): InterestPolicy {
  const { cellSize, range } = options
  const vertical = options.vertical ?? false
  const buckets = new Map<number, Entity[]>()
  const cellOf = new Map<Entity, number>()
  let lastTick = 0
  const p: [number, number, number] = [0, 0, 0]

  const key = (x: number, y: number, z: number): number =>
    ((x + BIAS) * SPAN + (vertical ? y + BIAS : 0)) * SPAN + (z + BIAS)

  // Roots read Transform (their world position, and set even where nothing propagates);
  // children read the propagated GlobalTransform.
  function position(table: Table, row: number, out: [number, number, number]): void {
    if (table.has(ChildOf) && table.has(GlobalTransform)) {
      const m = table.column(GlobalTransform, 'matrix')
      out[0] = m[row * 12 + 3]!
      out[1] = m[row * 12 + 7]!
      out[2] = m[row * 12 + 11]!
    } else {
      const t = table.column(Transform, 'translation')
      out[0] = t[row * 3]!
      out[1] = t[row * 3 + 1]!
      out[2] = t[row * 3 + 2]!
    }
  }

  function cellKey(pos: [number, number, number]): number {
    return key(
      Math.floor(pos[0] / cellSize),
      Math.floor(pos[1] / cellSize),
      Math.floor(pos[2] / cellSize),
    )
  }

  function move(entity: Entity, next: number): void {
    const prev = cellOf.get(entity)
    if (prev === next) return
    if (prev !== undefined) {
      const list = buckets.get(prev)!
      const i = list.indexOf(entity)
      if (i !== -1) list.splice(i, 1)
    }
    cellOf.set(entity, next)
    let list = buckets.get(next)
    if (!list) {
      list = []
      buckets.set(next, list)
    }
    list.push(entity)
  }

  function focusCell(world: World, entity: Entity): number | undefined {
    if (!world.isAlive(entity) || !world.has(entity, Transform)) return undefined
    position(world.entityTable(entity), world.entityRow(entity), p)
    return cellKey(p)
  }

  const query = cachedQuery(() => ({ with: [Replicated, Transform] }))
  return {
    name: 'grid',
    prepare(world) {
      const q = query(world)
      for (const table of q.tables) {
        const moved =
          table.lastStructural > lastTick ||
          table.lastChanged(Transform) > lastTick ||
          (table.has(ChildOf) && table.lastChanged(GlobalTransform) > lastTick)
        if (!moved) continue
        for (let row = 0; row < table.count; row++) {
          const e = table.entities[row]!
          position(table, row, p)
          move(e, cellKey(p))
        }
      }
      lastTick = world.tick
    },
    update(world, peer, out) {
      const reach = range + 1
      for (const f of peer.focus) {
        const center = focusCell(world, f)
        if (center === undefined) continue
        const cz = (center % SPAN) - BIAS
        const rest = Math.floor(center / SPAN)
        const cy = vertical ? (rest % SPAN) - BIAS : 0
        const cx = Math.floor(rest / SPAN) - BIAS
        const yr = vertical ? reach : 0
        for (let dx = -reach; dx <= reach; dx++) {
          for (let dy = -yr; dy <= yr; dy++) {
            for (let dz = -reach; dz <= reach; dz++) {
              const list = buckets.get(key(cx + dx, cy + dy, cz + dz))
              if (!list) continue
              const edge =
                Math.abs(dx) === reach || Math.abs(dy) === reach || Math.abs(dz) === reach
              for (let i = list.length - 1; i >= 0; i--) {
                const e = list[i]!
                if (!world.isAlive(e)) {
                  list.splice(i, 1)
                  cellOf.delete(e)
                  continue
                }
                if (!edge || peer.knows(e)) out.add(e)
              }
            }
          }
        }
      }
    },
  }
}

/**
 * Entities whose `field` of `component` equals that of the peer's first focus entity having it:
 * teammates see each other wherever they are.
 */
export function teamInterest<F extends Fields>(
  component: ComponentDef<F>,
  field: keyof F & string,
): InterestPolicy {
  const query = cachedQuery(() => ({ with: [Replicated, component as ComponentDef] }))
  return {
    name: 'team',
    update(world, peer, out) {
      let team: unknown
      for (const f of peer.focus) {
        if (world.isAlive(f) && world.has(f, component)) {
          team = world.entityTable(f).column(component, field)[world.entityRow(f)]
          break
        }
      }
      if (team === undefined) return
      const q = query(world)
      for (const table of q.tables) {
        const column = table.column(component, field)
        for (let row = 0; row < table.count; row++) {
          if (column[row] === team) out.add(table.entities[row]!)
        }
      }
    },
  }
}

/** Everything any of the policies includes, each entity at the smallest interval given. */
export function anyOf(...policies: InterestPolicy[]): InterestPolicy {
  return {
    name: `anyOf(${policies.map((p) => p.name).join(', ')})`,
    prepare(world) {
      for (const p of policies) p.prepare?.(world)
    },
    update(world, peer, out) {
      for (const p of policies) p.update(world, peer, out)
    },
  }
}

/** What every policy includes, each entity at the largest interval any of them gave it. */
export function allOf(...policies: InterestPolicy[]): InterestPolicy {
  const scratch = new RelevanceSet()
  return {
    name: `allOf(${policies.map((p) => p.name).join(', ')})`,
    prepare(world) {
      for (const p of policies) p.prepare?.(world)
    },
    update(world, peer, out) {
      const [first, ...rest] = policies
      if (!first) return
      first.update(world, peer, out)
      for (const p of rest) {
        scratch.clear()
        p.update(world, peer, scratch)
        out.intersect(scratch)
      }
    },
  }
}
