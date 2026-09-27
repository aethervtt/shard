import type { Entity } from '@aethervtt/shard-core'
import { TriangleSoup } from './geometry'
import { areaFlags, type BakeSettings, type Recast, voxelSettings } from './recast'

type RNavMesh = InstanceType<Recast['NavMesh']>
type RQuery = InstanceType<Recast['NavMeshQuery']>
type RCrowd = InstanceType<Recast['Crowd']>
type RFilter = InstanceType<Recast['QueryFilter']>

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
  /** Framed bakes: the world soup moved into navmesh space, with its hash lanes. */
  readonly local = new TriangleSoup()
  localHashes = new Uint32Array(0)

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

  /** Applies area costs (0 excludes an area) to queries and the crowd. */
  applyAreas(areas: Record<number, number>): void {
    let exclude = 0
    const filters = [this.filter]
    if (this.crowd) filters.push(this.crowd.getFilter(0))
    for (const f of filters) {
      for (let a = 0; a < 63; a++) f.setAreaCost(a, 1)
      for (const key of Object.keys(areas)) {
        const area = Number(key)
        const cost = areas[area]!
        if (!(area >= 0 && area < 63)) continue
        if (cost <= 0) exclude |= area < 15 ? areaFlags(area) : 0
        else f.setAreaCost(area, cost)
      }
      f.includeFlags = 0xffff & ~exclude
      f.excludeFlags = 0
    }
  }

  destroyCrowd(): void {
    this.crowd?.destroy()
    this.crowd = null
    this.crowdCapacity = 0
  }

  destroy(): void {
    this.destroyCrowd()
    this.query.destroy()
    this.navMesh.destroy()
  }
}
