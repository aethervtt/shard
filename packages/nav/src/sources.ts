import { type Entity, ShardError } from '@aethervtt/shard-core'
import { Hash64 } from './hash'

// Navmesh sources without entities (0112): shapes (world triangles a plugin pushes, such as
// structure's walls and floors) and gates (regions whose polygons get flags at runtime, such as
// doors). Both are keyed by an owner entity. The bake reads what changed from `changed`.

/** World-space triangles with an area code: a source the bake indexes per tile. */
export interface NavContribution {
  /** 0: an entity NavSource subtree; 1: a shape. With `owner`, it orders a tile's sources. */
  kind: 0 | 1
  owner: Entity
  /** 9 floats per triangle. */
  positions: Float32Array
  areas: Uint8Array
  /** Two hash lanes per triangle (0037's per-triangle hash), summed into tile keys. */
  lanes: Uint32Array
  count: number
}

/** An area gate's footprint (a convex polygon in x, z) and height range, or a link gate's link. */
export interface NavGateSpec {
  /** Area gates: the footprint, as [x, z] points of a convex polygon. */
  points?: readonly (readonly number[])[]
  yMin?: number
  yMax?: number
  /** Link gates: an off-mesh link between two points. */
  link?: {
    start: readonly number[]
    end: readonly number[]
    radius: number
    bidirectional?: boolean
  }
  /** The area its polygons get (costs in nav/Areas and filters). */
  area: number
  /** Gate state bits (GATE_CLOSED, GATE_LOCKED, GATE_CUSTOM). */
  flags?: number
}

export interface NavGate {
  owner: Entity
  /** Area gates: flat (x, z) pairs; null for a link gate. */
  points: Float64Array | null
  yMin: number
  yMax: number
  link: {
    start: [number, number, number]
    end: [number, number, number]
    radius: number
    bidirectional: boolean
  } | null
  area: number
  flags: number
  /** Bounds in x, z (a link's are its start: links live in the tile they start in). */
  minX: number
  minZ: number
  maxX: number
  maxZ: number
  /** Hash of everything but `flags`, in the keys of the tiles it covers. */
  key: [number, number]
  /** Its centre (a link's start), for agents nearing it. */
  cx: number
  cz: number
}

const hash = new Hash64()
const lanes = new Uint32Array(2)

export function triangleLanes(c: NavContribution): void {
  if (c.lanes.length < c.count * 2) c.lanes = new Uint32Array(c.count * 2)
  const p = c.positions
  for (let t = 0; t < c.count; t++) {
    hash.reset()
    for (let k = 0; k < 9; k++) hash.f32word(p[t * 9 + k]!)
    hash.u32word(c.areas[t]!)
    hash.lanes(c.lanes, t * 2)
  }
}

/** Triangles pushed by plugins, by owner. */
export class NavShapes {
  readonly byOwner = new Map<Entity, NavContribution>()
  /** Owners set or deleted since the bake last read them. */
  readonly changed = new Set<Entity>()

  /**
   * Sets `owner`'s triangles: `positions` holds 9 floats per triangle (world space), all of area
   * `area` (or one area per triangle). Replaces what it had.
   */
  set(owner: Entity, positions: Float32Array, area: number | Uint8Array = 0): void {
    const count = Math.floor(positions.length / 9)
    if (count === 0) {
      this.delete(owner)
      return
    }
    const areas = typeof area === 'number' ? new Uint8Array(count).fill(area) : area
    const c: NavContribution = {
      kind: 1,
      owner,
      positions,
      areas,
      lanes: new Uint32Array(count * 2),
      count,
    }
    triangleLanes(c)
    this.byOwner.set(owner, c)
    this.changed.add(owner)
  }

  delete(owner: Entity): void {
    if (this.byOwner.delete(owner)) this.changed.add(owner)
  }

  get size(): number {
    return this.byOwner.size
  }
}

/** Gates by owner. A geometry change re-keys its tiles; a flags change only rewrites flags. */
export class NavGates {
  readonly byOwner = new Map<Entity, NavGate>()
  /** Owners whose footprint, link or area changed (or that went away) since the bake read them. */
  readonly changed = new Set<Entity>()
  /** Owners whose flags alone changed, with their flags before the change. */
  readonly flagged = new Map<Entity, number>()

  set(owner: Entity, spec: NavGateSpec): void {
    if (!(spec.area >= 1 && spec.area <= 62)) {
      throw new ShardError('nav/invalid-gate', `A gate's area must be 1 to 62, got ${spec.area}`, {
        hint: "Area 0 is the ground every source bakes with: a gate's polygons need an area of their own.",
      })
    }
    const gate = makeGate(owner, spec)
    const old = this.byOwner.get(owner)
    this.byOwner.set(owner, gate)
    if (old && old.key[0] === gate.key[0] && old.key[1] === gate.key[1]) {
      if (old.flags !== gate.flags && !this.flagged.has(owner)) this.flagged.set(owner, old.flags)
      return
    }
    this.changed.add(owner)
  }

  /** Sets a gate's state bits: its polygons' flags change, no tile rebuilds. */
  setFlags(owner: Entity, flags: number): void {
    const gate = this.byOwner.get(owner)
    if (!gate || gate.flags === flags) return
    if (!this.flagged.has(owner)) this.flagged.set(owner, gate.flags)
    gate.flags = flags
  }

  delete(owner: Entity): void {
    if (this.byOwner.delete(owner)) this.changed.add(owner)
  }

  get size(): number {
    return this.byOwner.size
  }
}

function makeGate(owner: Entity, spec: NavGateSpec): NavGate {
  hash.reset()
  let points: Float64Array | null = null
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  let link: NavGate['link'] = null
  if (spec.link) {
    const s = spec.link.start
    const e = spec.link.end
    link = {
      start: [s[0]!, s[1]!, s[2]!],
      end: [e[0]!, e[1]!, e[2]!],
      radius: spec.link.radius,
      bidirectional: spec.link.bidirectional ?? true,
    }
    for (const v of [...link.start, ...link.end, link.radius]) hash.f32word(v)
    hash.u32word(link.bidirectional ? 1 : 0)
    minX = maxX = link.start[0]
    minZ = maxZ = link.start[2]
  } else {
    const pts = spec.points ?? []
    points = new Float64Array(pts.length * 2)
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i]![0]!
      const z = pts[i]![1]!
      points[i * 2] = x
      points[i * 2 + 1] = z
      hash.f32word(x).f32word(z)
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (z < minZ) minZ = z
      if (z > maxZ) maxZ = z
    }
    hash.f32word(spec.yMin ?? 0).f32word(spec.yMax ?? 0)
  }
  hash.u32word(spec.area)
  hash.lanes(lanes, 0)
  return {
    owner,
    points,
    yMin: spec.yMin ?? 0,
    yMax: spec.yMax ?? 0,
    link,
    area: spec.area,
    flags: spec.flags ?? 0,
    minX,
    minZ,
    maxX,
    maxZ,
    key: [lanes[0]!, lanes[1]!],
    cx: link ? link.start[0] : (minX + maxX) / 2,
    cz: link ? link.start[2] : (minZ + maxZ) / 2,
  }
}

/** Whether (x, z) lies inside a convex polygon given as flat pairs, either winding. */
export function insideConvex(points: Float64Array, x: number, z: number): boolean {
  const n = points.length / 2
  let sign = 0
  for (let i = 0; i < n; i++) {
    const ax = points[i * 2]!
    const az = points[i * 2 + 1]!
    const bx = points[((i + 1) % n) * 2]!
    const bz = points[((i + 1) % n) * 2 + 1]!
    const cross = (bx - ax) * (z - az) - (bz - az) * (x - ax)
    if (cross === 0) continue
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}
