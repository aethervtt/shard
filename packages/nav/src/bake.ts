import { assetServer } from '@shard/assets'
import {
  type AssetRef,
  Children,
  defineSystem,
  type Entity,
  type Query,
  ShardError,
  type Table,
  type World,
} from '@shard/core'
import { BODY_KINDS, Collider, Physics } from '@shard/physics'
import { Mesh3d, Meshes } from '@shard/render'
import { LogResource } from '@shard/runtime'
import { Tilemap, TilemapDatas } from '@shard/sprite'
import { GlobalTransform } from '@shard/transform'
import { NavCache } from './cache'
import { NavAreas, NavGrid, NavGridDatas, NavMesh, NavSource, OffMeshLink } from './components'
import {
  boxTriangles,
  capsuleProfile,
  heightfieldTriangles,
  latheTriangles,
  pushMesh,
  pushTransformed,
  sphereProfile,
} from './geometry'
import { DIAGONAL_MODES, NavGridData } from './grid'
import { Hash64 } from './hash'
import { NavMeshRuntime, packTile } from './navmesh'
import { type BakeSettings, buildTile, type OffMeshLinkParams, voxelSettings } from './recast'
import { type GridRecord, Nav, type NavState } from './state'

/** Bumped when tile building changes in a way that makes old cached tiles wrong. */
const BAKE_FORMAT = 'recast-navigation@0.43.1/shard-1'

interface BakeQueries {
  grids: Query
  meshes: Query
  sources: Query
  links: Query
  colliders: Query
}

function queries(world: World): BakeQueries {
  return {
    grids: world.query({ with: [NavGrid, GlobalTransform] }),
    meshes: world.query({ with: [NavMesh] }),
    sources: world.query({ with: [NavSource] }),
    links: world.query({ with: [OffMeshLink] }),
    colliders: world.query({ with: [Collider] }),
  }
}

/**
 * Brings grids and navmeshes up to date with everything changed since tick `since`. The bake
 * system runs it every frame; `nav.bake` runs it on demand.
 */
export function updateNavigation(world: World, since: number, s = queries(world)): void {
  const nav = world.tryResource(Nav)
  if (!nav) return
  // Colliders changed since the last run (for grids rasterized from them).
  let count = 0
  for (let t = 0; t < s.colliders.tables.length; t++) {
    const table = s.colliders.tables[t]!
    count += table.count
    if (table.lastChanged(Collider) > since) nav.colliderTick = world.tick
  }
  if (count !== nav.colliderCount) {
    nav.colliderCount = count
    nav.colliderTick = world.tick
  }
  updateGrids(s, world, nav, since, nav.colliderTick)
  updateMeshes(s, world, nav, since)
}

/**
 * Keeps grids and navmeshes current (spec 0037): builds NavGrids from their data, tilemap, or
 * colliders, and rebakes the NavMesh tiles whose geometry changed, from the tile cache when it
 * has them.
 */
export const navBake = defineSystem({
  name: 'nav/bake',
  description:
    'Builds NavGrids from data, tilemaps, or colliders, and rebakes NavMesh tiles whose NavSource geometry or OffMeshLinks changed (cached tiles load without Recast).',
  setup: queries,
  run: (s, world, ctx) => updateNavigation(world, ctx.lastRunTick, s),
})

// --- grids ------------------------------------------------------------------------

function newGridRecord(entity: Entity): GridRecord {
  return {
    entity,
    source: 'data',
    grid: null,
    ox: 0,
    oy: 0,
    csx: 1,
    csy: 1,
    z: 0,
    diagonal: 0,
    problem: null,
    stamp: '',
    layer: null,
    editBase: -1,
    editCursor: 0,
    tilemapVersion: -1,
    blocking: null,
    colliderStamp: '',
    version: 0,
    seen: -1,
  }
}

function updateGrids(
  s: BakeQueries,
  world: World,
  nav: NavState,
  since: number,
  colliderTick: number,
): void {
  for (let t = 0; t < s.grids.tables.length; t++) {
    const table = s.grids.tables[t]!
    const ticks = table.changedTicks(NavGrid)
    const matrix = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      let rec = nav.grids.get(entity)
      if (!rec) {
        rec = newGridRecord(entity)
        nav.grids.set(entity, rec)
        nav.gridList = [...nav.grids.values()]
      }
      const x = matrix[row * 12 + 3]!
      const y = matrix[row * 12 + 7]!
      rec.z = matrix[row * 12 + 11]!
      if (ticks[row]! > since || rec.stamp === '') refreshGrid(world, rec, x, y, colliderTick)
      else followGrid(world, rec, x, y, colliderTick)
    }
  }
  if (nav.grids.size > 0 && nav.grids.size !== s.grids.count()) {
    for (const entity of nav.grids.keys()) {
      if (!world.has(entity, NavGrid)) nav.grids.delete(entity)
    }
    nav.gridList = [...nav.grids.values()]
  }
}

/** The grid's component changed: rebuild from scratch if anything that shapes it did. */
function refreshGrid(world: World, rec: GridRecord, x: number, y: number, colliderTick: number) {
  const v = world.get(rec.entity, NavGrid)
  const stamp = JSON.stringify([
    v.source,
    v.width,
    v.height,
    v.cellSize,
    v.origin,
    v.tilemap,
    v.layer,
    v.blockingTiles,
    v.data?.guid ?? v.data?.path ?? null,
    v.mask,
  ])
  rec.diagonal = DIAGONAL_MODES.indexOf(v.diagonal)
  if (stamp !== rec.stamp) {
    rec.stamp = stamp
    rec.source = v.source
    rec.layer = null
    rec.editBase = -1
    rec.tilemapVersion = -1
    rec.colliderStamp = ''
    rec.seen = -1
    rec.blocking = null
    if (v.source === 'tilemap' && v.blockingTiles.length > 0) {
      rec.blocking = new Uint8Array(65536)
      for (const tile of v.blockingTiles) rec.blocking[tile] = 1
    }
  }
  followGrid(world, rec, x, y, colliderTick)
}

/** Keeps a grid in step with what it's built from: position, tile edits, colliders, data. */
function followGrid(world: World, rec: GridRecord, x: number, y: number, colliderTick: number) {
  const entity = rec.entity
  if (rec.source === 'data') {
    const v = world.get(entity, NavGrid)
    rec.ox = x + v.origin[0]
    rec.oy = y + v.origin[1]
    rec.csx = v.cellSize[0]
    rec.csy = v.cellSize[1]
    const grid = v.data ? world.tryResource(NavGridDatas)?.get(v.data) : undefined
    if (!grid) {
      rec.grid = null
      rec.problem = v.data ? `waiting for ${v.data.path ?? v.data.guid}` : 'no data asset'
      if (v.data) requestAsset(world, v.data)
      return
    }
    rec.problem = null
    if (rec.grid !== grid || rec.seen !== grid.version) {
      rec.grid = grid
      rec.seen = grid.version
      rec.version++
    }
    return
  }
  if (rec.source === 'tilemap') {
    followTilemap(world, rec)
    return
  }
  // colliders
  const v = world.get(entity, NavGrid)
  rec.ox = x + v.origin[0]
  rec.oy = y + v.origin[1]
  rec.csx = v.cellSize[0]
  rec.csy = v.cellSize[1]
  const physics = world.tryResource(Physics)
  if (!physics) {
    rec.problem = 'no physics: add physics2d (or physics3d) to rasterize colliders'
    return
  }
  const stamp = `${colliderTick}:${x}:${y}`
  if (stamp === rec.colliderStamp && rec.grid) return
  rec.colliderStamp = stamp
  rec.problem = null
  const grid =
    rec.grid && rec.grid.width === v.width && rec.grid.height === v.height
      ? rec.grid
      : new NavGridData(v.width, v.height)
  const costs = grid.costs
  const shape = {
    shape: 'cuboid' as const,
    halfExtents: [rec.csx * 0.49, rec.csy * 0.49, 0.5],
  }
  const at = [0, 0, rec.z]
  const rotation = [0, 0, 0, 1]
  let blocked = false
  const visit = (e: Entity) => {
    const owner = physics.colliderOwner.get(e)
    const body = owner === undefined ? undefined : physics.bodies.get(owner)
    if (body === undefined || BODY_KINDS[body.kind] === 'fixed') {
      blocked = true
      return false
    }
    return true
  }
  for (let cy = 0; cy < v.height; cy++) {
    for (let cx = 0; cx < v.width; cx++) {
      at[0] = rec.ox + (cx + 0.5) * rec.csx
      at[1] = rec.oy + (cy + 0.5) * rec.csy
      blocked = false
      physics.overlapShape(shape, at, rotation, { mask: v.mask }, visit)
      costs[cy * v.width + cx] = blocked ? 0 : 1
    }
  }
  grid.version++
  rec.grid = grid
  rec.version++
}

function followTilemap(world: World, rec: GridRecord): void {
  const v = world.get(rec.entity, NavGrid)
  const tilemapEntity = v.tilemap ?? rec.entity
  const tilemap = world.isAlive(tilemapEntity) ? world.tryGet(tilemapEntity, Tilemap) : undefined
  if (!tilemap) {
    rec.grid = null
    rec.problem = `entity ${tilemapEntity} has no sprite/Tilemap`
    return
  }
  const data = tilemap.data ? world.tryResource(TilemapDatas)?.get(tilemap.data) : undefined
  if (!data) {
    rec.grid = null
    rec.problem = 'waiting for the tilemap data'
    if (tilemap.data) requestAsset(world, tilemap.data)
    return
  }
  const layer = v.layer ? data.layers.find((l) => l.name === v.layer) : data.layers[0]
  if (!layer) {
    rec.grid = null
    rec.problem = `the tilemap has no layer ${JSON.stringify(v.layer)}`
    return
  }
  rec.problem = null
  // Tile (x, y) covers [x, x + 1] × [−y − 1, −y] tile sizes: cell (x, H − 1 − y).
  const m = world.get(tilemapEntity, GlobalTransform).matrix
  const sx = Math.sqrt(m[0]! * m[0]! + m[4]! * m[4]! + m[8]! * m[8]!)
  const sy = Math.sqrt(m[1]! * m[1]! + m[5]! * m[5]! + m[9]! * m[9]!)
  rec.csx = tilemap.tileSize[0] * sx
  rec.csy = tilemap.tileSize[1] * sy
  rec.ox = m[3]!
  rec.oy = m[7]! - layer.height * rec.csy
  const W = layer.width
  const H = layer.height
  const blocking = rec.blocking
  const blocks = (tile: number) => (blocking ? blocking[tile] === 1 : tile !== 0)
  const full =
    rec.layer !== layer ||
    rec.editBase !== layer.editBase ||
    rec.tilemapVersion !== data.version ||
    !rec.grid ||
    rec.grid.width !== W ||
    rec.grid.height !== H
  if (full) {
    const grid =
      rec.grid && rec.grid.width === W && rec.grid.height === H ? rec.grid : new NavGridData(W, H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++)
        grid.costs[(H - 1 - y) * W + x] = blocks(layer.tiles[y * W + x]!) ? 0 : 1
    }
    grid.version++
    rec.grid = grid
    rec.layer = layer
    rec.editBase = layer.editBase
    rec.editCursor = layer.edits.length
    rec.tilemapVersion = data.version
    rec.version++
    return
  }
  if (rec.editCursor < layer.edits.length) {
    const grid = rec.grid!
    for (let k = rec.editCursor; k < layer.edits.length; k++) {
      const i = layer.edits[k]!
      const x = i % W
      const y = (i - x) / W
      grid.costs[(H - 1 - y) * W + x] = blocks(layer.tiles[i]!) ? 0 : 1
    }
    rec.editCursor = layer.edits.length
    grid.version++
    rec.version++
  }
}

function requestAsset(world: World, ref: AssetRef): void {
  try {
    const server = assetServer(world)
    const entry = server.entry(ref)
    if (entry && entry.state === 'unloaded') void server.request(entry.guid).catch(() => {})
  } catch {
    // No asset server (a bare test app): the asset is set directly or never arrives.
  }
}

// --- navmeshes --------------------------------------------------------------------

const hash = new Hash64()

/**
 * A number that changes when area costs do. Scenes assign into the resource in place, so its
 * identity can't tell; `for…in` over a small object doesn't allocate.
 */
function areasSignature(areas: Record<number, number> | undefined): number {
  if (!areas) return -1
  let sig = 0
  for (const key in areas) {
    const code = Math.imul((Number(key) | 0) + 1, 0x9e3779b1)
    sig =
      (sig + Math.imul(code ^ Math.round(areas[key as unknown as number]! * 1000), 0x85ebca6b)) | 0
  }
  return sig
}

function settingsOf(table: Table, row: number): BakeSettings {
  return {
    agentRadius: table.column(NavMesh, 'agentRadius')[row]!,
    agentHeight: table.column(NavMesh, 'agentHeight')[row]!,
    maxClimb: table.column(NavMesh, 'maxClimb')[row]!,
    maxSlope: table.column(NavMesh, 'maxSlope')[row]!,
    cellSize: table.column(NavMesh, 'cellSize')[row]!,
    cellHeight: table.column(NavMesh, 'cellHeight')[row]!,
    tileSize: table.column(NavMesh, 'tileSize')[row]!,
  }
}

function sameSettings(a: BakeSettings, b: BakeSettings): boolean {
  return (
    a.agentRadius === b.agentRadius &&
    a.agentHeight === b.agentHeight &&
    a.maxClimb === b.maxClimb &&
    a.maxSlope === b.maxSlope &&
    a.cellSize === b.cellSize &&
    a.cellHeight === b.cellHeight &&
    a.tileSize === b.tileSize
  )
}

/** Why NavMesh entities have no navmesh when Recast isn't loaded. */
export const NO_RECAST =
  'nav/no-navmesh: Recast is not loaded; add the nav plugin (nav/grid only does grids)'

function updateMeshes(s: BakeQueries, world: World, nav: NavState, since: number): void {
  const R = nav.R
  if (!R) return
  let changed = false
  // Runtimes follow NavMesh components: settings changes start a fresh navmesh.
  for (let t = 0; t < s.meshes.tables.length; t++) {
    const table = s.meshes.tables[t]!
    const ticks = table.changedTicks(NavMesh)
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const rt = nav.meshes.get(entity)
      if (rt && ticks[row]! <= since) continue
      const settings = settingsOf(table, row)
      if (rt && sameSettings(rt.settings, settings)) {
        changed = true // bounds may have changed
        continue
      }
      if (rt) {
        rt.destroy()
        for (const a of nav.agents.values()) if (a.nav === entity) a.crowdIndex = -1
      }
      nav.meshes.set(entity, new NavMeshRuntime(R, entity, settings))
      nav.meshList = [...nav.meshes.values()]
      nav.areas = Number.NaN
      changed = true
    }
  }
  if (nav.meshes.size > 0 && nav.meshes.size !== s.meshes.count()) {
    for (const [entity, rt] of nav.meshes) {
      if (!world.has(entity, NavMesh)) {
        rt.destroy()
        nav.meshes.delete(entity)
      }
    }
    nav.meshList = [...nav.meshes.values()]
  }
  if (nav.meshes.size === 0) return
  const areas = world.tryResource(NavAreas)
  const signature = areasSignature(areas)
  if (nav.areas !== signature) {
    nav.areas = signature
    for (let i = 0; i < nav.meshList.length; i++) nav.meshList[i]!.applyAreas(areas ?? {})
  }
  let pending = false
  for (let i = 0; i < nav.meshList.length; i++) if (nav.meshList[i]!.pending > 0) pending = true
  if (!nav.dirty && !changed && !pending && !watchedChanged(world, nav, since)) return
  gather(s, world, nav)
  nav.dirty = false
  for (const rt of nav.meshes.values()) {
    try {
      bakeRuntime(world, nav, rt)
      rt.problem = null
    } catch (err) {
      rt.problem = err instanceof Error ? err.message : String(err)
      world.tryResource(LogResource)?.error(err)
    }
  }
}

/** Whether any watched entity died or had its transform, shape, mesh, or tags changed. */
function watchedChanged(world: World, nav: NavState, since: number): boolean {
  const list = nav.watchedList
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!
    if (!world.isAlive(e)) return true
    const table = world.entityTable(e)
    const row = world.entityRow(e)
    if (table.has(GlobalTransform) && table.changedTicks(GlobalTransform)[row]! > since) return true
    if (table.has(Collider) && table.changedTicks(Collider)[row]! > since) return true
    if (table.has(Mesh3d) && table.changedTicks(Mesh3d)[row]! > since) return true
    if (table.has(NavSource) && table.changedTicks(NavSource)[row]! > since) return true
    if (table.has(OffMeshLink) && table.changedTicks(OffMeshLink)[row]! > since) return true
  }
  return false
}

/** Local triangles for primitive collider shapes, by shape and size. */
const primitives = new Map<string, number[]>()

function primitive(key: string, make: () => number[]): number[] {
  let tris = primitives.get(key)
  if (!tris) {
    tris = make()
    if (primitives.size > 256) primitives.clear()
    primitives.set(key, tris)
  }
  return tris
}

/** Collects every source's world-space triangles and every link into the nav state. */
function gather(s: BakeQueries, world: World, nav: NavState): void {
  const soup = nav.soup
  soup.clear()
  nav.watched.clear()
  nav.skipped = []
  nav.links = []
  let pending = 0
  const meshes = world.tryResource(Meshes)
  const visit = (e: Entity, area: number) => {
    nav.watched.add(e)
    const m = world.get(e, GlobalTransform).matrix
    if (world.has(e, Collider)) {
      const c = world.get(e, Collider)
      if (!c.sensor) {
        const [hx, hy, hz] = c.halfExtents
        const r = c.radius
        const hh = c.halfHeight
        let tris: number[] | null = null
        switch (c.shape) {
          case 'ball':
            tris = primitive(`ball:${r}`, () => latheTriangles(sphereProfile(r)))
            break
          case 'cuboid':
            tris = primitive(`box:${hx},${hy},${hz}`, () => boxTriangles(hx, hy, hz))
            break
          case 'capsule':
            tris = primitive(`capsule:${r},${hh}`, () => latheTriangles(capsuleProfile(r, hh)))
            break
          case 'cylinder':
            tris = primitive(`cylinder:${r},${hh}`, () =>
              latheTriangles([
                [0, -hh],
                [r, -hh],
                [r, hh],
                [0, hh],
              ]),
            )
            break
          case 'cone':
            tris = primitive(`cone:${r},${hh}`, () =>
              latheTriangles([
                [0, -hh],
                [r, -hh],
                [0, hh],
              ]),
            )
            break
          case 'heightfield':
            tris = heightfieldTriangles(
              c.heightfield.rows,
              c.heightfield.cols,
              c.heightfield.heights,
              hx,
              hy,
              hz,
            )
            break
          case 'convex':
          case 'trimesh': {
            const mesh = c.mesh ? meshes?.get(c.mesh) : undefined
            if (mesh) pushMesh(soup, mesh, m, area)
            else if (c.mesh) {
              pending++
              requestAsset(world, c.mesh)
            } else nav.skipped.push({ entity: e, reason: `${c.shape} collider without a mesh` })
            break
          }
          default:
            nav.skipped.push({ entity: e, reason: `${c.shape} colliders are 2D` })
        }
        if (tris) pushTransformed(soup, tris, undefined, tris.length / 9, m, area)
      }
    } else if (world.has(e, Mesh3d)) {
      const ref = world.get(e, Mesh3d).mesh
      const mesh = ref ? meshes?.get(ref) : undefined
      if (mesh) pushMesh(soup, mesh, m, area)
      else if (ref) {
        pending++
        requestAsset(world, ref)
      }
    }
    const children = world.tryGet(e, Children)?.entities
    if (children) {
      for (const child of children) {
        if (child !== null && world.isAlive(child) && !world.has(child, NavSource))
          visit(child, area)
      }
    }
  }
  for (let t = 0; t < s.sources.tables.length; t++) {
    const table = s.sources.tables[t]!
    const area = table.column(NavSource, 'area') as Uint8Array
    if (!table.has(GlobalTransform)) continue
    for (let row = 0; row < table.count; row++) visit(table.entities[row]!, area[row]!)
  }
  for (let t = 0; t < s.links.tables.length; t++) {
    const table = s.links.tables[t]!
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]!
      nav.watched.add(e)
      const link = world.get(e, OffMeshLink)
      if (link.to === null || !world.isAlive(link.to) || !world.has(link.to, GlobalTransform)) {
        nav.skipped.push({ entity: e, reason: 'off-mesh link without a `to` entity' })
        continue
      }
      nav.watched.add(link.to)
      const a = world.get(e, GlobalTransform).matrix
      const b = world.get(link.to, GlobalTransform).matrix
      nav.links.push({
        start: [a[3]!, a[7]!, a[11]!],
        end: [b[3]!, b[7]!, b[11]!],
        radius: link.radius,
        bidirectional: link.bidirectional,
        area: link.area,
      })
    }
  }
  nav.watchedList = [...nav.watched]
  for (const rt of nav.meshes.values()) rt.pending = pending
  // Per-triangle hashes, combined per tile into its key.
  const n = soup.count
  if (nav.triHashes.length < n * 2) nav.triHashes = new Uint32Array(n * 2)
  const p = soup.positions
  for (let t = 0; t < n; t++) {
    hash.reset()
    for (let k = 0; k < 9; k++) hash.f32word(p[t * 9 + k]!)
    hash.u32word(soup.areas[t]!)
    hash.lanes(nav.triHashes, t * 2)
  }
}

/** Bakes the runtime's tiles: kept when unchanged, from the cache when known, else Recast. */
function bakeRuntime(world: World, nav: NavState, rt: NavMeshRuntime): void {
  const t0 = performance.now()
  const R = rt.R
  const soup = nav.soup
  const s = rt.settings
  const v = voxelSettings(s)
  const tw = rt.tileWorld
  const border = v.borderSize * s.cellSize
  const nm = world.get(rt.entity, NavMesh)
  const bounded =
    nm.boundsMin[0] < nm.boundsMax[0] ||
    nm.boundsMin[1] < nm.boundsMax[1] ||
    nm.boundsMin[2] < nm.boundsMax[2]
  const [bx0, by0, bz0] = nm.boundsMin
  const [bx1, by1, bz1] = nm.boundsMax
  // Tile range the bounds allow (tiles are world-aligned).
  const tMinX = bounded ? Math.floor(bx0 / tw) : -Infinity
  const tMaxX = bounded ? Math.floor(bx1 / tw) : Infinity
  const tMinZ = bounded ? Math.floor(bz0 / tw) : -Infinity
  const tMaxZ = bounded ? Math.floor(bz1 / tw) : Infinity

  const perTile = new Map<number, number[]>()
  const p = soup.positions
  for (let t = 0; t < soup.count; t++) {
    const o = t * 9
    const minX = Math.min(p[o]!, p[o + 3]!, p[o + 6]!)
    const maxX = Math.max(p[o]!, p[o + 3]!, p[o + 6]!)
    const minY = Math.min(p[o + 1]!, p[o + 4]!, p[o + 7]!)
    const maxY = Math.max(p[o + 1]!, p[o + 4]!, p[o + 7]!)
    const minZ = Math.min(p[o + 2]!, p[o + 5]!, p[o + 8]!)
    const maxZ = Math.max(p[o + 2]!, p[o + 5]!, p[o + 8]!)
    if (
      bounded &&
      (maxX < bx0 || minX > bx1 || maxY < by0 || minY > by1 || maxZ < bz0 || minZ > bz1)
    )
      continue
    const x0 = Math.max(tMinX, Math.floor((minX - border) / tw))
    const x1 = Math.min(tMaxX, Math.floor((maxX + border) / tw))
    const z0 = Math.max(tMinZ, Math.floor((minZ - border) / tw))
    const z1 = Math.min(tMaxZ, Math.floor((maxZ + border) / tw))
    for (let tz = z0; tz <= z1; tz++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = packTile(tx, tz)
        let list = perTile.get(k)
        if (!list) {
          list = []
          perTile.set(k, list)
        }
        list.push(t)
      }
    }
  }

  const cache = world.initResource(NavCache)
  rt.reserve(perTile.size)
  const stats = rt.stats
  stats.built = 0
  stats.cached = 0
  stats.kept = 0
  stats.removed = 0
  const lanes = nav.triHashes
  let indices = new Int32Array(64)
  for (const [k, list] of perTile) {
    const tx = Math.floor(k / 65536) - 32768
    const tz = (k % 65536) - 32768
    // Vertical range from this tile's own triangles, so a change elsewhere can't touch its key.
    let yMin = Infinity
    let yMax = -Infinity
    let sumA = 0
    let sumB = 0
    for (let i = 0; i < list.length; i++) {
      const t = list[i]!
      const o = t * 9
      yMin = Math.min(yMin, p[o + 1]!, p[o + 4]!, p[o + 7]!)
      yMax = Math.max(yMax, p[o + 1]!, p[o + 4]!, p[o + 7]!)
      sumA = (sumA + lanes[t * 2]!) >>> 0
      sumB = (sumB + lanes[t * 2 + 1]!) >>> 0
    }
    yMin = Math.floor(yMin) - 1
    yMax = Math.ceil(yMax) + 1
    const x0 = tx * tw
    const z0 = tz * tw
    const links = nav.links.filter(
      (l) => l.start[0] >= x0 && l.start[0] < x0 + tw && l.start[2] >= z0 && l.start[2] < z0 + tw,
    )
    hash.reset().string(BAKE_FORMAT)
    hash
      .f32word(s.agentRadius)
      .f32word(s.agentHeight)
      .f32word(s.maxClimb)
      .f32word(s.maxSlope)
      .f32word(s.cellSize)
      .f32word(s.cellHeight)
      .u32word(s.tileSize)
      .u32word(tx)
      .u32word(tz)
      .f32word(yMin)
      .f32word(yMax)
      .u32word(list.length)
      .u32word(sumA)
      .u32word(sumB)
    for (const l of links) {
      for (let i = 0; i < 3; i++) hash.f32word(l.start[i]!).f32word(l.end[i]!)
      hash
        .f32word(l.radius)
        .u32word(l.bidirectional ? 1 : 0)
        .u32word(l.area)
    }
    const key = hash.hex()
    const entry = rt.tiles.get(k)
    if (entry && entry.key === key) {
      stats.kept++
      continue
    }
    let bytes = cache.tiles.get(key)
    if (bytes !== undefined) stats.cached++
    else {
      if (indices.length < list.length) indices = new Int32Array(list.length * 2)
      for (let i = 0; i < list.length; i++) indices[i] = list[i]!
      bytes = buildTile(R, s, tx, tz, yMin, yMax, soup, indices, list.length, links)
      cache.tiles.set(key, bytes)
      stats.built++
    }
    rt.setTile(tx, tz, key, bytes)
  }
  for (const [k, entry] of rt.tiles) {
    if (!perTile.has(k)) {
      rt.removeTile(entry.tx, entry.ty)
      stats.removed++
    }
  }
  rt.updateBounds()
  stats.bakes++
  stats.totalBuilt += stats.built
  stats.totalCached += stats.cached
  stats.ms = performance.now() - t0
  if (rt.tiles.size > 0 && rt.polygons() === 0 && rt.problem === null) {
    throw new ShardError('nav/bake-failed', 'The navmesh baked without any walkable polygons', {
      hint: 'Check the NavSource geometry has upward faces flatter than maxSlope, wide enough for agentRadius.',
    })
  }
}

/** Keys of every tile any navmesh holds now (what `saveNavCache` keeps). */
export function liveTileKeys(nav: NavState): string[] {
  const keys: string[] = []
  for (const rt of nav.meshes.values()) for (const t of rt.tiles.values()) keys.push(t.key)
  return keys
}

export type { OffMeshLinkParams }
