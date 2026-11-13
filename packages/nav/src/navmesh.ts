import { type Entity, ShardError } from '@aethervtt/shard-core'
import type { SlotSet } from './breach'
import type { NavFiltersValue, NavFilterValue } from './components'
import { MAX_NAV_FILTERS } from './components'
import {
  areaFlags,
  type BakeSettings,
  EXACT_AREAS,
  GATE_BITS,
  gatePolyArea,
  gatePolyFlags,
  MAX_GATE_AREA,
  type Recast,
  SHUT_AREA,
  voxelSettings,
} from './recast'
import { insideConvex, type NavContribution, type NavGate } from './sources'

type RNavMesh = InstanceType<Recast['NavMesh']>
type RQuery = InstanceType<Recast['NavMeshQuery']>
type RCrowd = InstanceType<Recast['Crowd']>
type RFilter = InstanceType<Recast['QueryFilter']>

const AREA_MASK = (1 << (EXACT_AREAS + 1)) - 1

/** What a breach costs when a filter doesn't say, in metres of walking (0114). */
export const DEFAULT_BREACH_COST = 20

/** A filter's breach cost for gates of `area`, in metres of walking. */
export function breachCostOf(def: NavFilterValue | undefined, area: number): number {
  const c = def?.breachCost
  if (typeof c === 'number') return c
  return c?.[area] ?? DEFAULT_BREACH_COST
}

/** The gate state bits a filter names. */
export function stateBits(names: readonly string[] | undefined): number {
  let bits = 0
  for (const name of names ?? []) bits |= GATE_BITS[name as keyof typeof GATE_BITS] ?? 0
  return bits
}

/** Why a named filter can't be used (`nav/invalid-filter`), or null. */
export function filterProblem(name: string, def: NavFilterValue): string | null {
  const both = (def.breach ?? []).filter((b) => def.exclude?.includes(b))
  if (both.length > 0)
    return `Filter "${name}" both excludes and breaches ${both.join(', ')}: a state is one or the other`
  const costs =
    typeof def.breachCost === 'number' ? [def.breachCost] : Object.values(def.breachCost ?? {})
  if (costs.some((c) => !(c >= 0 && Number.isFinite(c))))
    return `Filter "${name}" has a breach cost that isn't a number of metres ≥ 0`
  return null
}

/**
 * Sets a filter from area costs and, for a named filter, its own costs and excluded gate states
 * (0112). A polygon passes when it shares an included area bit and has no excluded state bit, so
 * `includeFlags` holds area bits only (an excluded area 0–11 left out) and `excludeFlags` the
 * gate states.
 *
 * Shut gates' areas (0114) cost what their open areas do. A filter that breaches gets two Detour
 * filters: `plan` passes its breach states and adds each breach's cost over the deepest gate of
 * that area (`depths`); `walk`, its crowd slot, excludes them, so no agent walks through one.
 */
export function configureFilter(
  f: RFilter,
  areas: Record<number, number>,
  def?: NavFilterValue,
  mode: 'plan' | 'walk' = 'plan',
  depths?: ArrayLike<number>,
): void {
  for (let a = 0; a < 63; a++) f.setAreaCost(a, 1)
  let exclude = 0
  for (const costs of def?.areas ? [areas, def.areas] : [areas]) {
    for (const key of Object.keys(costs)) {
      const area = Number(key)
      const cost = costs[area]!
      if (!(area >= 0 && area < 63)) continue
      if (cost <= 0) {
        if (area < EXACT_AREAS) exclude |= areaFlags(area)
      } else {
        f.setAreaCost(area, cost)
        if (area < EXACT_AREAS) exclude &= ~areaFlags(area)
      }
    }
  }
  const breach = stateBits(def?.breach)
  for (let a = 1; a <= MAX_GATE_AREA; a++) {
    let cost = f.getAreaCost(a)
    if (breach !== 0 && mode === 'plan') cost += breachCostOf(def, a) / (depths?.[a] ?? 1)
    f.setAreaCost(a + SHUT_AREA, cost)
  }
  const states = stateBits(def?.exclude)
  f.includeFlags = AREA_MASK & ~exclude
  f.excludeFlags = mode === 'walk' ? states | breach : states
}

function unknownFilter(name: string, named: Map<string, unknown>): ShardError {
  return new ShardError('nav/unknown-filter', `No navmesh filter named "${name}"`, {
    hint: named.size
      ? `nav/Filters has: ${[...named.keys()].join(', ')}.`
      : 'Add it to the nav/Filters resource ({ name: { exclude: [...], areas: {...} } }).',
  })
}

/** A tile the navmesh holds: where, the key of the geometry that built it, and its Detour ref. */
export interface TileEntry {
  tx: number
  ty: number
  key: string
  /** Detour tile data, or null for a tile with nothing walkable (not added). */
  bytes: Uint8Array | null
  ref: number
  polys: number
}

export const packTile = (tx: number, ty: number) => (tx + 32768) * 65536 + (ty + 32768)

export interface BakeStats {
  /** Tiles Recast built in the last bake. */
  built: number
  /** Tiles loaded from the cache in the last bake. */
  cached: number
  /** Tiles kept because their geometry didn't change. */
  kept: number
  /** Tiles dropped (their geometry went away). */
  removed: number
  /** Milliseconds the last bake took. */
  ms: number
  /** Bakes since the navmesh appeared. */
  bakes: number
  /** Tiles whose key the last bake computed (dirty tiles), and sources it re-read (0112). */
  examined: number
  gathered: number
  /** Tiles Recast built since the navmesh appeared. */
  totalBuilt: number
  /** Tiles removed and tiles keyed since the navmesh appeared. */
  totalRemoved: number
  totalExamined: number
  /** Tiles taken from the cache since the navmesh appeared. */
  totalCached: number
}

/**
 * A NavMesh entity's Detour navmesh: tiles on a world-aligned grid (tile (0, 0) starts at the
 * origin, so moving geometry never shifts other tiles), a query object, and the crowd its agents
 * walk in.
 */
export class NavMeshRuntime {
  readonly R: Recast
  readonly entity: Entity
  readonly settings: BakeSettings
  readonly tileWorld: number
  navMesh: RNavMesh
  query: RQuery
  filter: RFilter
  crowd: RCrowd | null = null
  crowdCapacity = 0
  crowdRadius = 0
  maxTiles: number
  readonly tiles = new Map<number, TileEntry>()
  /** Bumps whenever tiles change: agents and cached paths revalidate. */
  version = 0
  readonly stats: BakeStats = {
    built: 0,
    cached: 0,
    kept: 0,
    removed: 0,
    ms: 0,
    examined: 0,
    gathered: 0,
    bakes: 0,
    totalBuilt: 0,
    totalRemoved: 0,
    totalExamined: 0,
    totalCached: 0,
  }
  /** Bounds of the walkable tiles, for "which navmesh contains this point". */
  readonly min = new Float64Array([Infinity, Infinity, Infinity])
  readonly max = new Float64Array([-Infinity, -Infinity, -Infinity])
  /** Why the last bake didn't finish, if it didn't. */
  problem: string | null = null
  /** Source meshes still loading; the bake reruns when they arrive. */
  pending = 0
  /** Bakes and queries happen in this entity's local space (null: world space). */
  frame: Entity | null = null
  /** World → navmesh space and back (affine 3×4, row by row). */
  readonly toLocal = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  readonly toWorld = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  /** For reading a ref's tile index without calling into Detour (`tileIndexOf`). */
  polyScale = 1
  tileMask = 0

  /** The Detour tile index in a polygon or tile ref. */
  tileIndexOf(ref: number): number {
    return Math.floor(ref / this.polyScale) & this.tileMask
  }

  /** Whether every source has been placed in the tile index (false: place them all again). */
  indexed = false
  /** Until its first bake completes, a navmesh bakes with no frame limits (0112). */
  cold = true
  /** The bounds it was indexed with (min xyz, max xyz). */
  readonly bounds = new Float64Array(6)
  /** A re-index dropped every gate's polygons: kept tiles find theirs again as they're keyed. */
  gateRefsLost = false
  /** A tile went: `min`/`max` may be too big until recomputed. */
  boundsStale = false
  /** Tiles building on the pool, in the order they were sent, and the one running per tile. */
  readonly jobs: import('./bake').TileJob[] = []
  readonly inflight = new Map<number, import('./bake').TileJob>()

  // The tile index (0112): which sources and gates overlap each tile (with its border), so an
  // edit re-keys only the tiles its old and new geometry touch.
  /** Sources by tile key, and the tiles each source is in. */
  readonly index = new Map<number, Set<NavContribution>>()
  readonly binned = new Map<NavContribution, number[]>()
  /** Framed navmeshes: each source moved into navmesh space. */
  readonly localOf = new Map<NavContribution, NavContribution>()
  readonly gateIndex = new Map<number, Set<NavGate>>()
  readonly gateTiles = new Map<Entity, number[]>()
  /** Each gate's polygons, by tile. */
  readonly gateRefs = new Map<Entity, Map<number, number[]>>()
  /** Tiles whose key must be computed again. */
  readonly dirty = new Set<number>()
  /** Tiles the links start in, at the last bake. */
  linkTiles: number[] = []
  /**
   * Named filters (0112): crowd slot 1–15 and the query filter. Slot 0 is `filter`. A filter that
   * breaches (0114) plans with `filter` and walks with `walk` (its crowd slot's); otherwise the
   * two are the same object. `breach` and `exclude` are its gate state bits.
   */
  readonly named = new Map<
    string,
    { index: number; filter: RFilter; walk: RFilter; breach: number; exclude: number }
  >()
  /** Each gate whose polygons are here, by owner, as last mapped or flagged (0114). */
  readonly gateOf = new Map<Entity, NavGate>()
  /** Slot sets at shut gates (0114), by gate owner × 2 + side, and gates whose tiles changed. */
  readonly slots = new Map<number, SlotSet>()
  readonly staleGates = new Set<Entity>()
  /** Gates whose tiles had no polygon of their area in their footprint (nav/gate-unmatched). */
  readonly unmatched = new Set<Entity>()
  /** Gate polygons' owners, by polygon ref. */
  readonly refGate = new Map<number, Entity>()
  // What agents replan for (0112): read and cleared by nav/agents.
  /** Bumps when every polygon ref changed (the navmesh grew): every agent replans. */
  generation = 0
  /** Tile slots replaced or removed (Detour tile indexes, as in polygon refs). */
  readonly changedTiles = new Set<number>()
  /** A tile appeared where there was none: paths that found no way may find one now. */
  tileAdded = false
  /** Gates whose flags changed, with the bits that changed. */
  readonly changedGates = new Map<Entity, number>()

  /** A world point into navmesh space (identity without a frame). */
  pointIn(x: number, y: number, z: number, out: { [i: number]: number }): void {
    const m = this.toLocal
    out[0] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    out[1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    out[2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
  }

  /** A navmesh-space point into world space. */
  pointOut(x: number, y: number, z: number, out: { [i: number]: number }): void {
    const m = this.toWorld
    out[0] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    out[1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    out[2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
  }

  /** A navmesh-space direction into world space. */
  vectorOut(x: number, y: number, z: number, out: { [i: number]: number }): void {
    const m = this.toWorld
    out[0] = m[0]! * x + m[1]! * y + m[2]! * z
    out[1] = m[4]! * x + m[5]! * y + m[6]! * z
    out[2] = m[8]! * x + m[9]! * y + m[10]! * z
  }

  constructor(R: Recast, entity: Entity, settings: BakeSettings, maxTiles = 256) {
    this.R = R
    this.entity = entity
    this.settings = { ...settings }
    this.tileWorld = voxelSettings(settings).tileWorld
    this.maxTiles = maxTiles
    this.navMesh = this.createNavMesh(maxTiles)
    this.query = new R.NavMeshQuery(this.navMesh, { maxNodes: 4096 })
    this.filter = this.query.defaultFilter
  }

  private createNavMesh(maxTiles: number): RNavMesh {
    const R = this.R
    const tileBits = Math.min(14, Math.max(1, Math.ceil(Math.log2(maxTiles))))
    // Detour's refs: salt | tile index (tileBits) | polygon index (22 − tileBits).
    this.polyScale = 2 ** (22 - tileBits)
    this.tileMask = (1 << tileBits) - 1
    const navMesh = new R.NavMesh()
    navMesh.initTiled(
      R.NavMeshParams.create({
        orig: { x: 0, y: 0, z: 0 },
        tileWidth: this.tileWorld,
        tileHeight: this.tileWorld,
        maxTiles: 1 << tileBits,
        maxPolys: 1 << (22 - tileBits),
      }),
    )
    return navMesh
  }

  /** Grows the tile capacity, moving every tile into a new Detour navmesh. */
  reserve(tiles: number): boolean {
    if (tiles <= this.maxTiles) return false
    let cap = this.maxTiles
    while (cap < tiles) cap *= 2
    const old = this.navMesh
    this.maxTiles = cap
    this.navMesh = this.createNavMesh(cap)
    this.query.destroy()
    this.query = new this.R.NavMeshQuery(this.navMesh, { maxNodes: 4096 })
    this.filter = this.query.defaultFilter
    for (const t of this.tiles.values()) {
      t.ref = 0
      if (t.bytes) this.add(t)
    }
    old.destroy()
    this.destroyCrowd()
    // Every polygon ref changed with the navmesh: find gates' polygons again.
    this.gateRefs.clear()
    this.refGate.clear()
    this.gateOf.clear()
    this.generation++
    for (const [k, gates] of this.gateIndex) this.mapGates(k, gates)
    this.version++
    return true
  }

  private add(t: TileEntry): void {
    const R = this.R
    const data = new R.UnsignedCharArray()
    data.copy(t.bytes!)
    // The navmesh owns the copy from here (DT_TILE_FREE_DATA) and frees it on removeTile.
    const res = this.navMesh.addTile(data, R.Detour.DT_TILE_FREE_DATA, 0)
    if (R.statusFailed(res.status)) {
      data.destroy()
      t.ref = 0
      t.polys = 0
      return
    }
    t.ref = res.tileRef
    const tile = this.navMesh.getTileByRef(res.tileRef)
    const header = tile?.header()
    t.polys = header?.polyCount() ?? 0
    // Bounds only grow as tiles come in; a removal recomputes them once the bake settles.
    if (header && t.polys > 0) {
      for (let i = 0; i < 3; i++) {
        this.min[i] = Math.min(this.min[i]!, header.bmin(i))
        this.max[i] = Math.max(this.max[i]!, header.bmax(i))
      }
    }
  }

  /** Puts a tile's data in (null: removes it). */
  setTile(tx: number, ty: number, key: string, bytes: Uint8Array | null): void {
    const k = packTile(tx, ty)
    const old = this.tiles.get(k)
    if (old?.ref) {
      this.changedTiles.add(this.tileIndexOf(old.ref))
      this.navMesh.removeTile(old.ref)
    } else this.tileAdded = true
    const t: TileEntry = { tx, ty, key, bytes, ref: 0, polys: 0 }
    this.tiles.set(k, t)
    if (bytes) this.add(t)
    this.version++
  }

  removeTile(tx: number, ty: number): void {
    const k = packTile(tx, ty)
    const old = this.tiles.get(k)
    if (!old) return
    if (old.ref) {
      this.changedTiles.add(this.tileIndexOf(old.ref))
      this.navMesh.removeTile(old.ref)
    }
    this.tiles.delete(k)
    this.boundsStale = true
    this.version++
  }

  /** Recomputes `min`/`max` from the tiles' headers. */
  updateBounds(): void {
    this.min.fill(Infinity)
    this.max.fill(-Infinity)
    for (const t of this.tiles.values()) {
      if (!t.ref) continue
      const header = this.navMesh.getTileByRef(t.ref)?.header()
      if (!header) continue
      for (let i = 0; i < 3; i++) {
        this.min[i] = Math.min(this.min[i]!, header.bmin(i))
        this.max[i] = Math.max(this.max[i]!, header.bmax(i))
      }
    }
  }

  polygons(): number {
    let n = 0
    for (const t of this.tiles.values()) n += t.polys
    return n
  }

  /**
   * Applies area costs (0 excludes an area 0–11) to the default filter, and the named filters
   * (0112) over them, to queries and the crowd. Names beyond the 15th, sorted, are left out.
   */
  applyFilters(
    areas: Record<number, number>,
    named: NavFiltersValue = {},
    depths?: ArrayLike<number>,
  ): void {
    configureFilter(this.filter, areas)
    if (this.crowd) configureFilter(this.crowd.getFilter(0), areas)
    // Invalid filters (nav/invalid-filter, warned by the bake) are left out.
    const names = Object.keys(named)
      .filter((name) => filterProblem(name, named[name]!) === null)
      .sort()
      .slice(0, MAX_NAV_FILTERS)
    for (const [name, slot] of this.named) {
      if (names.includes(name)) continue
      this.destroySlot(slot)
      this.named.delete(name)
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!
      const def = named[name]!
      const breach = stateBits(def.breach)
      let slot = this.named.get(name)
      if (!slot) {
        const filter = new this.R.QueryFilter()
        slot = { index: 0, filter, walk: filter, breach: 0, exclude: 0 }
        this.named.set(name, slot)
      }
      if (breach !== 0 && slot.walk === slot.filter) slot.walk = new this.R.QueryFilter()
      else if (breach === 0 && slot.walk !== slot.filter) {
        this.R.Raw.destroy(slot.walk.raw)
        slot.walk = slot.filter
      }
      slot.index = i + 1
      slot.breach = breach
      slot.exclude = stateBits(def.exclude)
      configureFilter(slot.filter, areas, def, 'plan', depths)
      if (slot.walk !== slot.filter) configureFilter(slot.walk, areas, def, 'walk', depths)
      if (this.crowd) configureFilter(this.crowd.getFilter(slot.index), areas, def, 'walk', depths)
    }
  }

  private destroySlot(slot: { filter: RFilter; walk: RFilter }): void {
    if (slot.walk !== slot.filter) this.R.Raw.destroy(slot.walk.raw)
    this.R.Raw.destroy(slot.filter.raw)
  }

  /** The query filter for a filter name ('' is the default). Throws `nav/unknown-filter`. */
  queryFilter(name: string | undefined): RFilter {
    if (!name) return this.filter
    const slot = this.named.get(name)
    if (!slot) throw unknownFilter(name, this.named)
    return slot.filter
  }

  /** The filter an agent walks with (0114): a breaching filter's walk variant, else its own. */
  walkFilter(name: string | undefined): RFilter {
    if (!name) return this.filter
    return this.named.get(name)?.walk ?? this.filter
  }

  /** The gate states a filter breaches (0114); 0 for the default and unknown names. */
  breachBits(name: string | undefined): number {
    return name ? (this.named.get(name)?.breach ?? 0) : 0
  }

  /** The crowd slot of a filter name ('' and unknown names: 0, the default). */
  crowdSlot(name: string): number {
    return name ? (this.named.get(name)?.index ?? 0) : 0
  }

  /**
   * Finds `gates`' polygons in tile `k` (it just landed, or went away) and gives them their flags:
   * an area gate's are the polygons of its area whose centre lies in its footprint, a link gate's
   * the off-mesh link starting at its start.
   */
  mapGates(k: number, gates: Iterable<NavGate>): void {
    const entry = this.tiles.get(k)
    const tile = entry?.ref ? this.navMesh.getTileByRef(entry.ref) : null
    const header = tile?.header()
    for (const gate of gates) {
      let byTile = this.gateRefs.get(gate.owner)
      if (!byTile) {
        byTile = new Map()
        this.gateRefs.set(gate.owner, byTile)
      }
      const refs: number[] = []
      if (tile && header) {
        const base = this.navMesh.getPolyRefBase(tile)
        if (gate.link) {
          for (let i = 0; i < header.offMeshConCount(); i++) {
            const con = tile.offMeshCons(i)
            const dx = con.pos(0) - gate.link.start[0]
            const dz = con.pos(2) - gate.link.start[2]
            if (dx * dx + dz * dz < 1e-4) refs.push(base | con.poly())
          }
        } else {
          const polys = header.polyCount()
          for (let i = 0; i < polys; i++) {
            const poly = tile.polys(i)
            // Its open area, or its shut one when it was shut before the tile was mapped again.
            const area = poly.areaAndType() & 0x3f
            if (poly.getType() !== 0 || (area !== gate.area && area !== gate.area + SHUT_AREA))
              continue
            const n = poly.vertCount()
            let cx = 0
            let cy = 0
            let cz = 0
            for (let j = 0; j < n; j++) {
              const v = poly.verts(j) * 3
              cx += tile.verts(v)
              cy += tile.verts(v + 1)
              cz += tile.verts(v + 2)
            }
            cx /= n
            cy /= n
            cz /= n
            if (cy < gate.yMin - 1 || cy > gate.yMax + 1) continue
            if (insideConvex(gate.points!, cx, cz)) refs.push(base | i)
          }
        }
      }
      for (const ref of byTile.get(k) ?? []) this.refGate.delete(ref)
      for (const ref of refs) this.refGate.set(ref, gate.owner)
      if (refs.length > 0) byTile.set(k, refs)
      else byTile.delete(k)
      if (byTile.size > 0) this.gateOf.set(gate.owner, gate)
      else this.gateOf.delete(gate.owner)
      // Slots at it were placed on polygons that may have gone (0114).
      if (this.slots.size > 0) this.staleGates.add(gate.owner)
      const flags = gatePolyFlags(gate.area, gate.flags)
      const area = gatePolyArea(gate.area, gate.flags)
      for (const ref of refs) {
        this.navMesh.setPolyFlags(ref, flags)
        this.navMesh.setPolyArea(ref, area)
      }
    }
  }

  /** Rewrites a gate's polygons' flags (its state changed from `before`): no tile is touched. */
  setGateFlags(gate: NavGate, before: number): number {
    const byTile = this.gateRefs.get(gate.owner)
    if (!byTile) return 0
    this.changedGates.set(
      gate.owner,
      (this.changedGates.get(gate.owner) ?? 0) | (before ^ gate.flags),
    )
    this.gateOf.set(gate.owner, gate)
    const flags = gatePolyFlags(gate.area, gate.flags)
    const area = gatePolyArea(gate.area, gate.flags)
    const shut = area !== gatePolyArea(gate.area, before)
    let n = 0
    for (const refs of byTile.values()) {
      for (const ref of refs) {
        this.navMesh.setPolyFlags(ref, flags)
        if (shut) this.navMesh.setPolyArea(ref, area)
      }
      n += refs.length
    }
    return n
  }

  /** How many polygons a gate has here. */
  gatePolygons(owner: Entity): number {
    let n = 0
    for (const refs of this.gateRefs.get(owner)?.values() ?? []) n += refs.length
    return n
  }

  destroyCrowd(): void {
    this.crowd?.destroy()
    this.crowd = null
    this.crowdCapacity = 0
  }

  destroy(): void {
    for (const slot of this.named.values()) this.destroySlot(slot)
    this.named.clear()
    this.destroyCrowd()
    this.query.destroy()
    this.navMesh.destroy()
  }
}
