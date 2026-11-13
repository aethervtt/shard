import { type Entity, ShardError } from '@aethervtt/shard-core'
import type { NavFiltersValue, NavFilterValue } from './components'
import { MAX_NAV_FILTERS } from './components'
import {
  areaFlags,
  type BakeSettings,
  EXACT_AREAS,
  GATE_BITS,
  type Recast,
  voxelSettings,
} from './recast'
import { insideConvex, type NavContribution, type NavGate } from './sources'

type RNavMesh = InstanceType<Recast['NavMesh']>
type RQuery = InstanceType<Recast['NavMeshQuery']>
type RCrowd = InstanceType<Recast['Crowd']>
type RFilter = InstanceType<Recast['QueryFilter']>

const AREA_MASK = (1 << (EXACT_AREAS + 1)) - 1

/**
 * Sets a filter from area costs and, for a named filter, its own costs and excluded gate states
 * (0112). A polygon passes when it shares an included area bit and has no excluded state bit, so
 * `includeFlags` holds area bits only (an excluded area 0–11 left out) and `excludeFlags` the
 * gate states.
 */
export function configureFilter(
  f: RFilter,
  areas: Record<number, number>,
  def?: NavFilterValue,
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
  let states = 0
  for (const name of def?.exclude ?? []) states |= GATE_BITS[name] ?? 0
  f.includeFlags = AREA_MASK & ~exclude
  f.excludeFlags = states
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
  /** Whether every source has been placed in the tile index (false: place them all again). */
  indexed = false

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
  /** Named filters (0112): crowd slot 1–15 and the query filter. Slot 0 is `filter`. */
  readonly named = new Map<string, { index: number; filter: RFilter }>()
  /** Gates whose tiles had no polygon of their area in their footprint (nav/gate-unmatched). */
  readonly unmatched = new Set<Entity>()

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
    t.polys = tile ? (tile.header()?.polyCount() ?? 0) : 0
  }

  /** Puts a tile's data in (null: removes it). */
  setTile(tx: number, ty: number, key: string, bytes: Uint8Array | null): void {
    const k = packTile(tx, ty)
    const old = this.tiles.get(k)
    if (old?.ref) this.navMesh.removeTile(old.ref)
    const t: TileEntry = { tx, ty, key, bytes, ref: 0, polys: 0 }
    this.tiles.set(k, t)
    if (bytes) this.add(t)
    this.version++
  }

  removeTile(tx: number, ty: number): void {
    const k = packTile(tx, ty)
    const old = this.tiles.get(k)
    if (!old) return
    if (old.ref) this.navMesh.removeTile(old.ref)
    this.tiles.delete(k)
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
  applyFilters(areas: Record<number, number>, named: NavFiltersValue = {}): void {
    configureFilter(this.filter, areas)
    if (this.crowd) configureFilter(this.crowd.getFilter(0), areas)
    const names = Object.keys(named).sort().slice(0, MAX_NAV_FILTERS)
    for (const [name, slot] of this.named) {
      if (names.includes(name)) continue
      this.R.Raw.destroy(slot.filter.raw)
      this.named.delete(name)
    }
    for (let i = 0; i < names.length; i++) {
      const name = names[i]!
      let slot = this.named.get(name)
      if (!slot) {
        slot = { index: 0, filter: new this.R.QueryFilter() }
        this.named.set(name, slot)
      }
      slot.index = i + 1
      configureFilter(slot.filter, areas, named[name])
      if (this.crowd) configureFilter(this.crowd.getFilter(slot.index), areas, named[name])
    }
  }

  /** The query filter for a filter name ('' is the default). Throws `nav/unknown-filter`. */
  queryFilter(name: string | undefined): RFilter {
    if (!name) return this.filter
    const slot = this.named.get(name)
    if (!slot) throw unknownFilter(name, this.named)
    return slot.filter
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
            if (poly.getType() !== 0 || (poly.areaAndType() & 0x3f) !== gate.area) continue
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
      if (refs.length > 0) byTile.set(k, refs)
      else byTile.delete(k)
      const flags = areaFlags(gate.area) | gate.flags
      for (const ref of refs) this.navMesh.setPolyFlags(ref, flags)
    }
  }

  /** Rewrites a gate's polygons' flags (its state changed): no tile is touched. */
  setGateFlags(gate: NavGate): number {
    const byTile = this.gateRefs.get(gate.owner)
    if (!byTile) return 0
    const flags = areaFlags(gate.area) | gate.flags
    let n = 0
    for (const refs of byTile.values()) {
      for (const ref of refs) this.navMesh.setPolyFlags(ref, flags)
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
    for (const slot of this.named.values()) this.R.Raw.destroy(slot.filter.raw)
    this.named.clear()
    this.destroyCrowd()
    this.query.destroy()
    this.navMesh.destroy()
  }
}
