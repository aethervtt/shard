import {
  defineSystem,
  type Entity,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { NavBudget, NavFlowField } from './components'
import { NavFlows } from './flow-state'
import type { NavMeshRuntime } from './navmesh'
import { areaFlags, type Recast } from './recast'
import { Nav, type NavState, navWarn } from './state'
import { nearestPoly, surf } from './surface'

// Flow fields (0115): a Dijkstra over navmesh polygons from a goal out to a range, priced by a
// filter. Costs are measured along the shortest way through the portals (a visibility cone per
// polygon, see FlowData), not between portal midpoints: midpoints, or each portal's nearest point,
// overprice diagonal ways across a grid of square tiles by up to 40%. Each polygon reached stores the next polygon toward the goal and the portal between
// them, so any number of agents follow one field without a path each. The polygon graph is
// snapshotted per Detour tile into TypedArrays, so builds don't read Detour; a tile is read again
// only when its salt changes (it was rebuilt). Builds run in slices of NavBudget.flowMs.

type RFilter = InstanceType<Recast['QueryFilter']>

const DT_NULL_LINK = 0xffffffff
/** Detour refs (32-bit): salt above 22 bits of tile and polygon index. */
const SALT = 2 ** 22
const POLY_OFFMESH = 1
/** The goal moving this far rebuilds the field. */
const REGOAL = 2

/**
 * The plan filter fields price and exclude polygons with: for a breaching filter (0114), its query
 * variant, which prices shut breach gates at their breach cost and skips `exclude` states.
 */
export function planFilter(rt: NavMeshRuntime, name: string): RFilter {
  return rt.queryFilter(name && rt.named.has(name) ? name : '')
}

/** A navmesh's polygons and portals, snapshotted per Detour tile (0115). */
export class NavGraph {
  readonly rt: NavMeshRuntime
  /** rt.generation when made: a navmesh that grew changed every ref, so the graph starts over. */
  readonly generation: number
  /** Per Detour tile index: its polygon 0's node, salt when read, and polygon count. */
  readonly tileBase: Int32Array
  readonly tileSalt: Float64Array
  readonly tilePolys: Int32Array
  nodes = 0
  ref = new Float64Array(0)
  area = new Uint8Array(0)
  flags = new Uint16Array(0)
  type = new Uint8Array(0)
  /** The gate owning the polygon (0112), or -1: its flags change at runtime. */
  gate = new Float64Array(0)
  linkStart = new Int32Array(0)
  linkCount = new Uint16Array(0)
  links = 0
  /** Each link's neighbour polygon ref, and its portal (x, y, z twice). */
  linkRef = new Float64Array(0)
  portal = new Float32Array(0)
  /** Nodes left behind by tiles read again. */
  garbage = 0
  /** Tiles read, and ms spent reading them, since made. */
  reads = 0
  readMs = 0

  constructor(rt: NavMeshRuntime) {
    this.rt = rt
    this.generation = rt.generation
    const tiles = rt.tileMask + 1
    this.tileBase = new Int32Array(tiles).fill(-1)
    this.tileSalt = new Float64Array(tiles).fill(-1)
    this.tilePolys = new Int32Array(tiles)
  }

  /** The Detour tile index in a ref. */
  tileOf(ref: number): number {
    return Math.floor(ref / this.rt.polyScale) & this.rt.tileMask
  }

  /** A polygon ref's node, or -1 when its tile isn't read (or was rebuilt since). */
  node(ref: number): number {
    const t = this.tileOf(ref)
    const base = this.tileBase[t]!
    if (base < 0 || this.tileSalt[t] !== Math.floor(ref / SALT)) return -1
    const p = ref % this.rt.polyScale
    return p < this.tilePolys[t]! ? base + p : -1
  }

  /** A polygon ref's node, reading its tile when it isn't read yet or changed. -1: no such polygon. */
  resolve(ref: number): number {
    const n = this.node(ref)
    if (n >= 0) return n
    this.read(this.tileOf(ref))
    return this.node(ref)
  }

  /** Reads Detour tile `t`'s polygons and links. */
  read(t: number): void {
    const t0 = performance.now()
    const rt = this.rt
    const R = rt.R
    const nm = rt.navMesh.raw
    const tile = nm.getTile(t)
    if (this.tileBase[t]! >= 0) this.garbage += this.tilePolys[t]!
    this.tileBase[t] = -1
    this.tileSalt[t] = -1
    this.tilePolys[t] = 0
    if (R.Raw.isNull(tile)) return
    const header = tile.get_header()
    if (R.Raw.isNull(header)) return
    const n = header.get_polyCount()
    const base = nm.getPolyRefBase(tile)
    this.growNodes(this.nodes + n)
    const start = this.nodes
    for (let i = 0; i < n; i++) {
      const poly = tile.get_polys(i)
      const node = start + i
      const at = poly.get_areaAndtype()
      const ref = base + i
      this.ref[node] = ref
      this.area[node] = at & 0x3f
      this.type[node] = at >> 6
      this.flags[node] = poly.get_flags()
      this.gate[node] = rt.refGate.get(ref) ?? -1
      this.linkStart[node] = this.links
      let count = 0
      const nv = poly.get_vertCount()
      if (this.type[node] !== POLY_OFFMESH) {
        // The bindings return links as signed: DT_NULL_LINK reads as -1.
        for (let l = poly.get_firstLink(); l >>> 0 !== DT_NULL_LINK; ) {
          const link = tile.get_links(l)
          const edge = link.get_edge()
          if (edge < nv) {
            const v0 = poly.get_verts(edge) * 3
            const v1 = poly.get_verts((edge + 1) % nv) * 3
            let ax = tile.get_verts(v0)
            let ay = tile.get_verts(v0 + 1)
            let az = tile.get_verts(v0 + 2)
            let bx = tile.get_verts(v1)
            let by = tile.get_verts(v1 + 1)
            let bz = tile.get_verts(v1 + 2)
            // A link across a tile border covers part of the edge (Detour's getPortalPoints).
            const bmin = link.get_bmin()
            const bmax = link.get_bmax()
            if (link.get_side() !== 0xff && (bmin !== 0 || bmax !== 255)) {
              const t0 = bmin / 255
              const t1 = bmax / 255
              const x0 = ax + (bx - ax) * t0
              const y0 = ay + (by - ay) * t0
              const z0 = az + (bz - az) * t0
              bx = ax + (bx - ax) * t1
              by = ay + (by - ay) * t1
              bz = az + (bz - az) * t1
              ax = x0
              ay = y0
              az = z0
            }
            const k = this.links
            this.growLinks(k + 1)
            this.linkRef[k] = link.get_ref()
            const o = k * 6
            this.portal[o] = ax
            this.portal[o + 1] = ay
            this.portal[o + 2] = az
            this.portal[o + 3] = bx
            this.portal[o + 4] = by
            this.portal[o + 5] = bz
            this.links++
            count++
          }
          l = link.get_next()
        }
      }
      this.linkCount[node] = count
    }
    this.nodes += n
    this.tileBase[t] = start
    this.tileSalt[t] = tile.get_salt()
    this.tilePolys[t] = n
    this.reads++
    this.readMs += performance.now() - t0
  }

  private growNodes(n: number): void {
    if (n <= this.ref.length) return
    const cap = Math.max(1024, this.ref.length * 2, n)
    this.ref = grow(this.ref, new Float64Array(cap))
    this.area = grow(this.area, new Uint8Array(cap))
    this.flags = grow(this.flags, new Uint16Array(cap))
    this.type = grow(this.type, new Uint8Array(cap))
    this.gate = grow(this.gate, new Float64Array(cap))
    this.linkStart = grow(this.linkStart, new Int32Array(cap))
    this.linkCount = grow(this.linkCount, new Uint16Array(cap))
  }

  private growLinks(n: number): void {
    if (n <= this.linkRef.length) return
    const cap = Math.max(4096, this.linkRef.length * 2, n)
    this.linkRef = grow(this.linkRef, new Float64Array(cap))
    this.portal = grow(this.portal, new Float32Array(cap * 6))
  }
}

function grow<
  T extends Float64Array | Float32Array | Int32Array | Uint32Array | Uint16Array | Uint8Array,
>(from: T, to: T): T {
  ;(to as Float64Array).set(from as Float64Array)
  return to
}

/**
 * One build of a field: per graph node, its cost to the goal and its way there. Each node keeps a
 * visibility cone: the part of its exit portal (its window) seen from an apex further on, where
 * the way to the goal turns (a corner, or the goal). The cost is the apex's plus the straight
 * distance to it, so costs follow the shortest way rather than portal midpoints.
 */
export class FlowData {
  /** This build's stamp: a node is reached when `seen` holds it, final when `closed` does. */
  mark = 0
  cap = 0
  seen = new Uint32Array(0)
  closed = new Uint32Array(0)
  /** Cost to the goal from the nearest point of the node's window. */
  dist = new Float64Array(0)
  /** The apex (x, y, z) and its cost to the goal. */
  ax = new Float32Array(0)
  ay = new Float32Array(0)
  az = new Float32Array(0)
  ac = new Float64Array(0)
  /** The node whose data goes on from the apex (the goal's own node at the goal). */
  an = new Int32Array(0)
  /** Area cost of the polygons between the window and the apex. */
  cc = new Float32Array(0)
  /** The window: the part of the exit portal seen from the apex (x, y, z at each end). */
  lx = new Float32Array(0)
  ly = new Float32Array(0)
  lz = new Float32Array(0)
  rx = new Float32Array(0)
  ry = new Float32Array(0)
  rz = new Float32Array(0)
  /** The next node toward the goal (-1 at the goal's polygon), and the graph link to it. */
  next = new Int32Array(0)
  link = new Int32Array(0)
  /** Detour tile indexes the build reached (a change there rebuilds the field). */
  tiles: Uint8Array
  readonly goal = new Float64Array(3)
  goalNode = -1
  /** Polygons reached and finalized. */
  reached = 0

  constructor(tiles: number) {
    this.tiles = new Uint8Array(tiles)
  }

  ensure(n: number): void {
    if (n <= this.cap) return
    const cap = Math.max(1024, this.cap * 2, n)
    this.seen = grow(this.seen, new Uint32Array(cap))
    this.closed = grow(this.closed, new Uint32Array(cap))
    this.dist = grow(this.dist, new Float64Array(cap))
    this.ax = grow(this.ax, new Float32Array(cap))
    this.ay = grow(this.ay, new Float32Array(cap))
    this.az = grow(this.az, new Float32Array(cap))
    this.ac = grow(this.ac, new Float64Array(cap))
    this.an = grow(this.an, new Int32Array(cap))
    this.cc = grow(this.cc, new Float32Array(cap))
    this.lx = grow(this.lx, new Float32Array(cap))
    this.ly = grow(this.ly, new Float32Array(cap))
    this.lz = grow(this.lz, new Float32Array(cap))
    this.rx = grow(this.rx, new Float32Array(cap))
    this.ry = grow(this.ry, new Float32Array(cap))
    this.rz = grow(this.rz, new Float32Array(cap))
    this.next = grow(this.next, new Int32Array(cap))
    this.link = grow(this.link, new Int32Array(cap))
    this.cap = cap
  }

  /** Whether node `n` is in this field (reached, with a way to the goal). */
  has(n: number): boolean {
    return n >= 0 && n < this.cap && this.closed[n] === this.mark
  }

  /**
   * The cost to the goal from (x, z) in node `n`: straight to its apex when the line passes
   * through its window, else by the window's end that's shorter.
   */
  costAt(n: number, x: number, z: number): number {
    const cc = this.cc[n]!
    if (this.next[n]! < 0)
      return Math.sqrt((x - this.goal[0]!) ** 2 + (z - this.goal[2]!) ** 2) * cc
    const ax = this.ax[n]!
    const az = this.az[n]!
    const lx = this.lx[n]!
    const lz = this.lz[n]!
    const rx = this.rx[n]!
    const rz = this.rz[n]!
    if (crosses(x, z, ax, az, lx, lz, rx, rz))
      return this.ac[n]! + Math.sqrt((x - ax) ** 2 + (z - az) ** 2) * cc
    const l = Math.sqrt((x - lx) ** 2 + (z - lz) ** 2) + Math.sqrt((lx - ax) ** 2 + (lz - az) ** 2)
    const r = Math.sqrt((x - rx) ** 2 + (z - rz) ** 2) + Math.sqrt((rx - ax) ** 2 + (rz - az) ** 2)
    return this.ac[n]! + (l < r ? l : r) * cc
  }
}

/** `nearestOn`'s result (x, z) and its parameter along the segment. */
const near = new Float64Array(3)

/** The point of segment (ax, az)–(bx, bz) nearest (x, z), into `near`. */
function nearestOn(ax: number, az: number, bx: number, bz: number, x: number, z: number): void {
  const ex = bx - ax
  const ez = bz - az
  const ll = ex * ex + ez * ez
  let t = ll > 1e-12 ? ((x - ax) * ex + (z - az) * ez) / ll : 0
  if (t < 0) t = 0
  else if (t > 1) t = 1
  near[0] = ax + ex * t
  near[1] = az + ez * t
  near[2] = t
}

/** Whether segment (px, pz)–(qx, qz) meets segment (ax, az)–(bx, bz) (ends included). */
function crosses(
  px: number,
  pz: number,
  qx: number,
  qz: number,
  ax: number,
  az: number,
  bx: number,
  bz: number,
): boolean {
  const dx = qx - px
  const dz = qz - pz
  const ex = bx - ax
  const ez = bz - az
  const den = dx * ez - dz * ex
  const fx = ax - px
  const fz = az - pz
  if (Math.abs(den) < 1e-12) {
    // Parallel: only when collinear and overlapping (a point on the window's line).
    if (Math.abs(fx * dz - fz * dx) > 1e-9) return false
    nearestOn(ax, az, bx, bz, px, pz)
    return (near[0]! - px) ** 2 + (near[1]! - pz) ** 2 < 1e-8
  }
  const t = (fx * ez - fz * ex) / den
  const u = (fx * dz - fz * dx) / den
  return t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6
}

/** A NavFlowField entity's runtime: the field agents follow, and the one building. */
export class FlowField {
  readonly entity: Entity
  rt: NavMeshRuntime | null = null
  graph: NavGraph | null = null
  /** The field agents follow (null until the first build lands), and the next one. */
  cur: FlowData | null = null
  spare: FlowData | null = null
  building: FlowData | null = null
  /** Where it should lead (the goal, or the target's position), its filter and range. */
  readonly want = new Float64Array(3)
  filter = ''
  range = 300
  /** Something changed: build again when the budget allows. */
  dirty = true
  /** Builds landed, and the last one's main-thread ms (summed over its slices) and slices. */
  builds = 0
  lastMs = 0
  lastSlices = 0
  ms = 0
  slices = 0
  /** Agents following it (counted by nav/steer each step). */
  agents = 0
  /** findPath calls nav/steer made for its agents outside it. */
  fallbacks = 0
  warned = false
  // The filter as the build reads it: area costs, included and excluded flags.
  readonly costs = new Float32Array(64)
  include = 0
  exclude = 0
  // The build's open set: a binary heap of (cost, node).
  heapKey = new Float64Array(256)
  heapNode = new Int32Array(256)
  heapSize = 0

  constructor(entity: Entity) {
    this.entity = entity
  }

  /** Whether agents should wait rather than fall back: a build is pending or under way. */
  pending(): boolean {
    return this.dirty || this.building !== null
  }

  private push(key: number, node: number): void {
    if (this.heapSize === this.heapKey.length) {
      this.heapKey = grow(this.heapKey, new Float64Array(this.heapKey.length * 2))
      this.heapNode = grow(this.heapNode, new Int32Array(this.heapNode.length * 2))
    }
    const k = this.heapKey
    const v = this.heapNode
    let i = this.heapSize++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (k[p]! <= key) break
      k[i] = k[p]!
      v[i] = v[p]!
      i = p
    }
    k[i] = key
    v[i] = node
  }

  /** Pops the cheapest node (its cost in `popped`). */
  private pop(): number {
    const k = this.heapKey
    const v = this.heapNode
    const top = v[0]!
    popped = k[0]!
    const n = --this.heapSize
    if (n > 0) {
      const key = k[n]!
      const node = v[n]!
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && k[c + 1]! < k[c]!) c++
        if (k[c]! >= key) break
        k[i] = k[c]!
        v[i] = v[c]!
        i = c
      }
      k[i] = key
      v[i] = node
    }
    return top
  }

  /** Starts a build toward `want`. False when the goal has no polygon the filter passes. */
  start(world: World): boolean {
    const rt = this.rt!
    const g = this.graph!
    const filter = planFilter(rt, this.filter)
    for (let a = 0; a < 63; a++) this.costs[a] = filter.getAreaCost(a)
    this.include = filter.includeFlags
    this.exclude = filter.excludeFlags
    const hy = Math.max(2, rt.settings.agentHeight * 1.5)
    if (
      !nearestPoly(rt, filter, this.want[0]!, this.want[1]!, this.want[2]!, 4, hy) ||
      g.resolve(surf.ref) < 0
    ) {
      if (!this.warned) {
        this.warned = true
        navWarn(
          world,
          new ShardError(
            'nav/flow-unreachable',
            `NavFlowField ${this.entity} has no navmesh polygon its filter passes near its goal`,
            { hint: 'Move the goal onto the navmesh, or check the field’s filter and nav.' },
          ),
        )
      }
      return false
    }
    this.warned = false
    const d = this.spare ?? new FlowData(rt.tileMask + 1)
    this.spare = null
    if (d.tiles.length !== rt.tileMask + 1) d.tiles = new Uint8Array(rt.tileMask + 1)
    else d.tiles.fill(0)
    d.ensure(g.ref.length)
    d.mark = ++marks
    d.reached = 0
    d.goal[0] = surf.x
    d.goal[1] = surf.y
    d.goal[2] = surf.z
    const n = g.resolve(surf.ref)
    d.goalNode = n
    d.ensure(g.ref.length)
    d.seen[n] = d.mark
    d.dist[n] = 0
    d.ax[n] = surf.x
    d.ay[n] = surf.y
    d.az[n] = surf.z
    d.ac[n] = 0
    d.an[n] = n
    d.cc[n] = this.costs[g.area[n]!]!
    d.next[n] = -1
    d.link[n] = -1
    d.tiles[g.tileOf(g.ref[n]!)] = 1
    this.heapSize = 0
    this.push(0, n)
    this.building = d
    this.ms = 0
    this.slices = 0
    return true
  }

  /** Runs the build until `deadline` (performance.now()). True when it landed. */
  step(nav: NavState, deadline: number): boolean {
    const d = this.building!
    const g = this.graph!
    const mark = d.mark
    const range2 = this.range * this.range
    const gx = d.goal[0]!
    const gz = d.goal[2]!
    let n = 0
    while (this.heapSize > 0) {
      // Every 8 polygons: reading a tile the first time costs about 10 µs.
      if ((++n & 7) === 0 && performance.now() > deadline) return false
      const u = this.pop()
      if (d.closed[u] === mark || popped > d.dist[u]! + 1e-9) continue
      d.closed[u] = mark
      d.reached++
      // The cone the neighbours extend: u's apex seen through u's window.
      let ax = d.ax[u]!
      let ay = d.ay[u]!
      let az = d.az[u]!
      let ac = d.ac[u]!
      let an = d.an[u]!
      let cc = d.cc[u]!
      // 0114: a shut gate's polygons take their twin area (area + 31) and price at its cost.
      const cu = this.costs[g.area[u]!]!
      const goal = d.next[u]! < 0
      const lx = d.lx[u]!
      const lz = d.lz[u]!
      const rx = d.rx[u]!
      const rz = d.rz[u]!
      let open = goal
      if (!goal && cu !== cc) {
        // Crossing u costs differently from the cone beyond it: a new apex where the way leaves u.
        nearestOn(lx, lz, rx, rz, ax, az)
        const t = near[2]!
        const nx = near[0]!
        const nz = near[1]!
        ac += Math.sqrt((nx - ax) ** 2 + (nz - az) ** 2) * cc
        ax = nx
        az = nz
        ay = d.ly[u]! + (d.ry[u]! - d.ly[u]!) * t
        an = u
        cc = cu
        open = true
      }
      // Which side of the cone is which (and whether it has any width).
      let sign = 0
      if (!open) {
        const cr = (lx - ax) * (rz - az) - (lz - az) * (rx - ax)
        if (Math.abs(cr) < 1e-9) open = true
        else sign = cr > 0 ? 1 : -1
      }
      const l0 = g.linkStart[u]!
      const l1 = l0 + g.linkCount[u]!
      for (let k = l0; k < l1; k++) {
        const v = g.resolve(g.linkRef[k]!)
        if (v < 0) continue
        if (v >= d.cap) d.ensure(g.ref.length)
        if (d.closed[v] === mark || g.type[v] === POLY_OFFMESH) continue
        let flags = g.flags[v]!
        const gate = g.gate[v]!
        if (gate >= 0) flags = areaFlags(g.area[v]!) | (nav.gates.byOwner.get(gate)?.flags ?? 0)
        if ((flags & this.include) === 0 || (flags & this.exclude) !== 0) continue
        const o = k * 6
        const qx = g.portal[o]!
        const qy = g.portal[o + 1]!
        const qz = g.portal[o + 2]!
        const ex = g.portal[o + 3]! - qx
        const ey = g.portal[o + 4]! - qy
        const ez = g.portal[o + 5]! - qz
        // The portal's part inside the cone, t0..t1; none: the way turns at the cone's edge.
        let t0 = 0
        let t1 = 1
        let vx = ax
        let vy = ay
        let vz = az
        let vc = ac
        let vn = an
        if (!open) {
          // f ≥ 0: on R's side of the ray to L. h ≥ 0: on L's side of the ray to R.
          const f0 = ((lx - ax) * (qz - az) - (lz - az) * (qx - ax)) * sign
          const f1 = ((lx - ax) * (qz + ez - az) - (lz - az) * (qx + ex - ax)) * sign
          const h0 = ((qx - ax) * (rz - az) - (qz - az) * (rx - ax)) * sign
          const h1 = ((qx + ex - ax) * (rz - az) - (qz + ez - az) * (rx - ax)) * sign
          if (f0 < 0 || f1 < 0) {
            if (f0 < 0 && f1 < 0) t0 = 2
            else if (f0 < 0) t0 = Math.max(t0, f0 / (f0 - f1))
            else t1 = Math.min(t1, f0 / (f0 - f1))
          }
          if (h0 < 0 || h1 < 0) {
            if (h0 < 0 && h1 < 0) t0 = 2
            else if (h0 < 0) t0 = Math.max(t0, h0 / (h0 - h1))
            else t1 = Math.min(t1, h0 / (h0 - h1))
          }
          if (t0 > t1) {
            // Outside the cone: the way turns at the window's end on the portal's side.
            const left = f0 + f1 < h0 + h1
            vx = left ? lx : rx
            vz = left ? lz : rz
            vy = left ? d.ly[u]! : d.ry[u]!
            vc = ac + Math.sqrt((vx - ax) ** 2 + (vz - az) ** 2) * cc
            vn = u
            t0 = 0
            t1 = 1
          }
        }
        const wlx = qx + ex * t0
        const wlz = qz + ez * t0
        const wrx = qx + ex * t1
        const wrz = qz + ez * t1
        nearestOn(wlx, wlz, wrx, wrz, vx, vz)
        const mx = near[0]!
        const mz = near[1]!
        if ((mx - gx) * (mx - gx) + (mz - gz) * (mz - gz) > range2) continue
        const c = vc + Math.sqrt((mx - vx) ** 2 + (mz - vz) ** 2) * cc
        if (d.seen[v] === mark && c >= d.dist[v]!) continue
        d.seen[v] = mark
        d.dist[v] = c
        d.ax[v] = vx
        d.ay[v] = vy
        d.az[v] = vz
        d.ac[v] = vc
        d.an[v] = vn
        d.cc[v] = cc
        d.lx[v] = wlx
        d.ly[v] = qy + ey * t0
        d.lz[v] = wlz
        d.rx[v] = wrx
        d.ry[v] = qy + ey * t1
        d.rz[v] = wrz
        d.next[v] = u
        d.link[v] = k
        d.tiles[g.tileOf(g.ref[v]!)] = 1
        this.push(c, v)
      }
    }
    // Landed: agents follow it from now on, and the old one is reused for the next build.
    this.spare = this.cur
    this.cur = d
    this.building = null
    this.builds++
    return true
  }
}

let marks = 0
let popped = 0

/** Flow fields and the polygon graphs they read, by entity (0115). */
export class NavFlowState {
  readonly fields = new Map<Entity, FlowField>()
  /** `fields` as an array, for per-frame loops. */
  list: FlowField[] = []
  readonly graphs = new Map<Entity, NavGraph>()

  /** The graph of a navmesh, made again when the navmesh grew (every ref changed). */
  graph(rt: NavMeshRuntime): NavGraph {
    let g = this.graphs.get(rt.entity)
    if (!g || g.rt !== rt || g.generation !== rt.generation) {
      g = new NavGraph(rt)
      this.graphs.set(rt.entity, g)
    }
    return g
  }

  drop(entity: Entity): void {
    if (!this.fields.delete(entity)) return
    this.list = [...this.fields.values()]
  }
}

interface FlowColumns {
  goal: Float32Array
  target: Float64Array
  filter: string[]
  range: Float32Array
  nav: Float64Array
}

const cols = {} as FlowColumns

function columns(table: Table): void {
  cols.goal = table.column(NavFlowField, 'goal') as Float32Array
  cols.target = table.column(NavFlowField, 'target') as Float64Array
  cols.filter = table.column(NavFlowField, 'filter') as unknown as string[]
  cols.range = table.column(NavFlowField, 'range') as Float32Array
  cols.nav = table.column(NavFlowField, 'nav') as Float64Array
}

/** The navmesh containing a world point (unframed ones; flow fields don't run on framed). */
function meshAt(nav: NavState, x: number, y: number, z: number): NavMeshRuntime | null {
  for (let i = 0; i < nav.meshList.length; i++) {
    const m = nav.meshList[i]!
    if (m.frame !== null) continue
    const pad = m.settings.agentRadius + m.settings.cellSize * 2
    if (
      x >= m.min[0]! - pad &&
      x <= m.max[0]! + pad &&
      z >= m.min[2]! - pad &&
      z <= m.max[2]! + pad &&
      y >= m.min[1]! - m.settings.agentHeight &&
      y <= m.max[1]! + m.settings.agentHeight
    )
      return m
  }
  return null
}

/**
 * Keeps flow fields current (0115): reads each NavFlowField, marks fields whose goal moved more
 * than 2 m, or whose tiles or gates changed (0112's change tracking, read before nav/agents
 * clears it), and builds them in slices of NavBudget.flowMs. Agents follow the old field until
 * the new one lands.
 */
export const navFlow = defineSystem({
  name: 'nav/flow',
  description:
    'Builds NavFlowFields: a Dijkstra over navmesh polygons from the goal out to range, priced by the filter, in slices of NavBudget.flowMs a step. Rebuilds when the goal moves more than 2 m, or a tile or gate in range changes.',
  setup: (world) => ({ query: world.query({ with: [NavFlowField] }) }),
  run: (s, world) => {
    const nav = world.tryResource(Nav)
    if (!nav?.R) return
    const flows = world.resource(NavFlows)
    // What changed on each navmesh since nav/agents last cleared it.
    for (let i = 0; i < nav.meshList.length; i++) {
      const rt = nav.meshList[i]!
      if (rt.changedTiles.size === 0 && rt.changedGates.size === 0 && !rt.tileAdded) continue
      for (let j = 0; j < flows.list.length; j++) {
        const f = flows.list[j]!
        if (f.rt === rt) changed(nav, rt, f)
      }
    }
    // Each field's goal, filter and navmesh.
    for (let t = 0; t < s.query.tables.length; t++) {
      const table = s.query.tables[t]!
      columns(table)
      for (let row = 0; row < table.count; row++) {
        const e = table.entities[row]!
        let f = flows.fields.get(e)
        if (!f) {
          f = new FlowField(e)
          flows.fields.set(e, f)
          flows.list = [...flows.fields.values()]
        }
        read(world, nav, flows, f, row)
      }
    }
    // Builds, in order, within the budget.
    const budget = world.tryResource(NavBudget)?.flowMs ?? 1
    const t0 = performance.now()
    const deadline = t0 + budget
    for (let i = 0; i < flows.list.length; i++) {
      const f = flows.list[i]!
      if (!f.rt || !f.graph) continue
      const now = performance.now()
      if (now > deadline) break
      if (f.dirty) {
        f.dirty = false
        if (!f.start(world)) continue
      }
      if (!f.building) continue
      const done = f.step(nav, deadline)
      f.ms += performance.now() - now
      f.slices++
      if (done) {
        f.lastMs = f.ms
        f.lastSlices = f.slices
      }
    }
  },
})

const goalScratch = new Float64Array(3)

function read(world: World, nav: NavState, flows: NavFlowState, f: FlowField, row: number): void {
  const target = cols.target[row]!
  const g = goalScratch
  if (
    target >= 0 &&
    world.isAlive(target as Entity) &&
    world.has(target as Entity, GlobalTransform)
  ) {
    const tm = world.entityTable(target as Entity).column(GlobalTransform, 'matrix') as Float32Array
    const r = world.entityRow(target as Entity) * 12
    g[0] = tm[r + 3]!
    g[1] = tm[r + 7]!
    g[2] = tm[r + 11]!
  } else {
    g[0] = cols.goal[row * 3]!
    g[1] = cols.goal[row * 3 + 1]!
    g[2] = cols.goal[row * 3 + 2]!
  }
  const filter = cols.filter[row] ?? ''
  const range = cols.range[row]!
  const preferred = cols.nav[row]!
  const rt =
    preferred >= 0 ? (nav.meshes.get(preferred as Entity) ?? null) : meshAt(nav, g[0], g[1], g[2])
  if (rt !== f.rt || (rt && f.graph && f.graph !== flows.graph(rt))) {
    f.rt = rt
    f.graph = rt ? flows.graph(rt) : null
    // Node ids belong to a graph: a field from another one means nothing here.
    f.cur = null
    f.spare = null
    f.building = null
    f.dirty = true
  }
  if (filter !== f.filter || range !== f.range) {
    f.filter = filter
    f.range = range
    f.dirty = true
  }
  // The goal moved more than 2 m from the one built (or building).
  const built = f.building ?? f.cur
  const dx = g[0] - (built ? built.goal[0]! : f.want[0]!)
  const dz = g[2] - (built ? built.goal[2]! : f.want[2]!)
  const dy = g[1] - (built ? built.goal[1]! : f.want[1]!)
  if (dx * dx + dy * dy + dz * dz > REGOAL * REGOAL) f.dirty = true
  f.want[0] = g[0]
  f.want[1] = g[1]
  f.want[2] = g[2]
}

/** Marks a field dirty when a tile it reached changed, or a gate in range changed bits it cares about. */
function changed(nav: NavState, rt: NavMeshRuntime, f: FlowField): void {
  if (rt.tileAdded) {
    f.dirty = true
    return
  }
  const fields = f.building ? [f.cur, f.building] : [f.cur]
  for (const d of fields) {
    if (!d) continue
    for (const t of rt.changedTiles) {
      if (d.tiles[t] === 1) {
        f.dirty = true
        return
      }
    }
  }
  const reach = f.range + 10
  for (const [owner, bits] of rt.changedGates) {
    if ((bits & f.exclude) === 0) continue
    const gate = nav.gates.byOwner.get(owner)
    if (!gate) {
      f.dirty = true
      return
    }
    const dx = gate.cx - f.want[0]!
    const dz = gate.cz - f.want[2]!
    if (dx * dx + dz * dz <= reach * reach) {
      f.dirty = true
      return
    }
  }
}

/**
 * Where an agent at (x, z) in polygon node `n` of field data `d` heads: straight to the node's apex
 * when that line passes through its window shrunk by `radius` at each end, else the window's end
 * nearest that line. Writes `aim` (x, y, z) and returns the node to go on from once there: the
 * apex's node, the next node, or -1 at the goal.
 */
export function flowAim(
  d: FlowData,
  n: number,
  x: number,
  z: number,
  radius: number,
  aim: Float64Array,
): number {
  if (d.next[n]! < 0) {
    aim[0] = d.goal[0]!
    aim[1] = d.goal[1]!
    aim[2] = d.goal[2]!
    return -1
  }
  let lx = d.lx[n]!
  let ly = d.ly[n]!
  let lz = d.lz[n]!
  let rx = d.rx[n]!
  let ry = d.ry[n]!
  let rz = d.rz[n]!
  const ex = rx - lx
  const ez = rz - lz
  const len = Math.sqrt(ex * ex + ez * ez)
  if (len <= 2 * radius) {
    lx = rx = (lx + rx) * 0.5
    ly = ry = (ly + ry) * 0.5
    lz = rz = (lz + rz) * 0.5
  } else {
    const k = radius / len
    const sx = ex * k
    const sy = (ry - ly) * k
    const sz = ez * k
    lx += sx
    ly += sy
    lz += sz
    rx -= sx
    ry -= sy
    rz -= sz
  }
  const ax = d.ax[n]!
  const az = d.az[n]!
  if (crosses(x, z, ax, az, lx, lz, rx, rz)) {
    aim[0] = ax
    aim[1] = d.ay[n]!
    aim[2] = az
    return d.an[n]!
  }
  // The end of the window the line to the apex passes: the one nearer it.
  const dx = ax - x
  const dz = az - z
  const dd = dx * dx + dz * dz
  const sl = dd > 1e-12 ? Math.abs((lx - x) * dz - (lz - z) * dx) : (lx - x) ** 2 + (lz - z) ** 2
  const sr = dd > 1e-12 ? Math.abs((rx - x) * dz - (rz - z) * dx) : (rx - x) ** 2 + (rz - z) ** 2
  const left = sl <= sr
  aim[0] = left ? lx : rx
  aim[1] = left ? ly : ry
  aim[2] = left ? lz : rz
  return d.next[n]!
}

/** Whether node `n` passes the field's filter now (a gate may have shut since it was built). */
export function flowPasses(nav: NavState, f: FlowField, n: number): boolean {
  const g = f.graph!
  let flags = g.flags[n]!
  const gate = g.gate[n]!
  if (gate >= 0) flags = areaFlags(g.area[n]!) | (nav.gates.byOwner.get(gate)?.flags ?? 0)
  return (flags & f.include) !== 0 && (flags & f.exclude) === 0
}
