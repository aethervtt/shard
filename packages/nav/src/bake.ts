import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  affine64,
  Children,
  defineSystem,
  type Entity,
  type Query,
  ShardError,
  type Table,
  type World,
} from '@aethervtt/shard-core'
import { BODY_KINDS, Collider, Physics } from '@aethervtt/shard-physics'
import type { Workers } from '@aethervtt/shard-platform'
import { Mesh3d, Meshes } from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { Tilemap, TilemapDatas } from '@aethervtt/shard-sprite'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { NavCache } from './cache'
import {
  MAX_NAV_FILTERS,
  NavAreas,
  NavBudget,
  NavFilters,
  NavGrid,
  NavGridDatas,
  NavMesh,
  NavSource,
  NavWorkers,
  OffMeshLink,
} from './components'
import {
  boxTriangles,
  capsuleProfile,
  heightfieldTriangles,
  latheTriangles,
  pushMesh,
  pushTransformed,
  sphereProfile,
  TriangleSoup,
} from './geometry'
import { DIAGONAL_MODES, NavGridData } from './grid'
import { Hash64 } from './hash'
import { filterProblem, NavMeshRuntime, packTile } from './navmesh'
import {
  type BakeSettings,
  buildTile,
  EXACT_AREAS,
  type OffMeshLinkParams,
  SHUT_AREA,
  toShardError,
  voxelSettings,
} from './recast'
import { type NavContribution, type NavGate, triangleLanes } from './sources'
import { type GridRecord, LINKS, Nav, type NavState, navWarn } from './state'

/**
 * Bumped when tile building changes in a way that makes old cached tiles wrong. shard-2 (0112):
 * the poly flag layout changed (areas 0–11 exact, bit 12 shared, gate bits 13–15).
 */
const BAKE_FORMAT = 'recast-navigation@0.43.1/shard-2'

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
 * system runs it every frame; `nav.bake` runs it on demand. `flush` takes no frame limits
 * (NavBudget): every dirty tile is keyed now, and built or sent to the pool.
 */
export function updateNavigation(
  world: World,
  since: number,
  s = queries(world),
  flush = false,
): void {
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
  updateMeshes(s, world, nav, since, flush)
  if (nav.readyWaiters.length > 0 && navReady(world)) {
    const waiters = nav.readyWaiters
    nav.readyWaiters = []
    for (const resolve of waiters) resolve()
  }
}

/**
 * Whether every navmesh is baked: its sources placed, no tile left dirty or building on the
 * pool, no source mesh still loading.
 */
export function navReady(world: World): boolean {
  const nav = world.tryResource(Nav)
  if (!nav?.R) return false
  if (
    nav.dirty ||
    nav.dirtyRoots.size > 0 ||
    nav.shapes.changed.size > 0 ||
    nav.gates.changed.size > 0
  )
    return false
  for (const rt of nav.meshes.values()) {
    if (!rt.indexed || rt.dirty.size > 0 || rt.jobs.length > 0 || rt.pending > 0) return false
  }
  return nav.meshes.size === world.query({ with: [NavMesh] }).count()
}

/**
 * Whether every navmesh's tiles over a world-space XZ rectangle are built (0113): a streamed cell
 * that just loaded is walkable once this is true, while tiles elsewhere may still be building.
 * Source changes not yet placed in the tile index count as not ready anywhere.
 */
export function navReadyIn(
  world: World,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  const nav = world.tryResource(Nav)
  if (!nav?.R) return false
  if (
    nav.dirty ||
    nav.dirtyRoots.size > 0 ||
    nav.shapes.changed.size > 0 ||
    nav.gates.changed.size > 0
  )
    return false
  if (nav.meshes.size !== world.query({ with: [NavMesh] }).count()) return false
  for (const rt of nav.meshes.values()) {
    if (!rt.indexed || rt.pending > 0) return false
    // In navmesh space (a framed navmesh); with the tile border, as the index bins sources.
    rt.pointIn(minX, 0, minZ, readyA)
    rt.pointIn(maxX, 0, maxZ, readyB)
    const tw = rt.tileWorld
    const border = voxelSettings(rt.settings).borderSize * rt.settings.cellSize
    const x0 = Math.floor((Math.min(readyA[0]!, readyB[0]!) - border) / tw)
    const x1 = Math.floor((Math.max(readyA[0]!, readyB[0]!) + border) / tw)
    const z0 = Math.floor((Math.min(readyA[2]!, readyB[2]!) - border) / tw)
    const z1 = Math.floor((Math.max(readyA[2]!, readyB[2]!) + border) / tw)
    for (let tz = z0; tz <= z1; tz++) {
      for (let tx = x0; tx <= x1; tx++) {
        const k = packTile(tx, tz)
        if (rt.dirty.has(k) || rt.inflight.has(k)) return false
      }
    }
    // Built on the pool but not yet in the navmesh.
    for (const job of rt.jobs) {
      if (job.tx >= x0 && job.tx <= x1 && job.tz >= z0 && job.tz <= z1) return false
    }
  }
  return true
}

const readyA = new Float64Array(3)
const readyB = new Float64Array(3)

/**
 * Resolves once every navmesh is baked (`navReady`), as the bake system finds it: frames must keep
 * running. A server awaits it before it takes players; `bakeNavigation` bakes without frames.
 */
export function whenNavReady(world: World): Promise<void> {
  if (navReady(world)) return Promise.resolve()
  return new Promise((resolve) => world.resource(Nav).readyWaiters.push(resolve))
}

/**
 * Bakes every navmesh to completion now, with no frame limits, waiting for the pool's tiles
 * (`nav.bake`, a cold start before the first frame).
 */
export async function bakeNavigation(world: World): Promise<void> {
  const nav = world.tryResource(Nav)
  if (!nav) return
  let since = 0
  for (let round = 0; round < 1000; round++) {
    updateNavigation(world, since, queries(world), true)
    since = world.tick
    const jobs: Promise<void>[] = []
    for (const rt of nav.meshes.values()) for (const job of rt.jobs) jobs.push(job.promise)
    if (jobs.length === 0 && navReady(world)) return
    await Promise.all(jobs)
    // Meshes still loading: give their requests a turn.
    if (jobs.length === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }
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

function sameBounds(b: Float64Array, min: number[], max: number[]): boolean {
  return (
    b[0] === min[0] &&
    b[1] === min[1] &&
    b[2] === min[2] &&
    b[3] === max[0] &&
    b[4] === max[1] &&
    b[5] === max[2]
  )
}

/** Why NavMesh entities have no navmesh when Recast isn't loaded. */
export const NO_RECAST =
  'nav/no-navmesh: Recast is not loaded; add the nav plugin (nav/grid only does grids)'

function updateMeshes(
  s: BakeQueries,
  world: World,
  nav: NavState,
  since: number,
  flush: boolean,
): void {
  const R = nav.R
  if (!R) return
  // Runtimes follow NavMesh components: settings changes start a fresh navmesh.
  for (let t = 0; t < s.meshes.tables.length; t++) {
    const table = s.meshes.tables[t]!
    const ticks = table.changedTicks(NavMesh)
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      const rt = nav.meshes.get(entity)
      if (rt && ticks[row]! <= since) continue
      const settings = settingsOf(table, row)
      const capacity = table.column(NavMesh, 'maxTiles')[row]!
      if (rt && sameSettings(rt.settings, settings)) {
        // New bounds place every source again; a larger capacity grows the navmesh once now.
        const nm = world.get(entity, NavMesh)
        if (!sameBounds(rt.bounds, nm.boundsMin, nm.boundsMax)) rt.indexed = false
        if (capacity > rt.maxTiles && rt.reserve(capacity)) {
          for (const a of nav.agents.values()) if (a.nav === entity) a.crowdIndex = -1
        }
        continue
      }
      if (rt) {
        rt.destroy()
        for (const a of nav.agents.values()) if (a.nav === entity) a.crowdIndex = -1
      }
      nav.meshes.set(entity, new NavMeshRuntime(R, entity, settings, capacity))
      nav.meshList = [...nav.meshes.values()]
      nav.areas = Number.NaN
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
  // Frames: a navmesh baked in an entity's space follows it; a moved frame places every source
  // again.
  for (let i = 0; i < nav.meshList.length; i++) {
    const rt = nav.meshList[i]!
    const frame = world.get(rt.entity, NavMesh).frame
    if (updateFrame(world, rt, frame)) rt.indexed = false
  }
  const areas = world.tryResource(NavAreas)
  const signature = areasSignature(areas)
  const filters = world.tryResource(NavFilters)
  // Breach costs convert by each gate area's depth (0114): a gate coming or going may change it.
  const depths = nav.gates.depthsDirty && nav.gates.updateDepths()
  if (nav.areas !== signature || world.resourceChanged(NavFilters, since) || depths) {
    nav.areas = signature
    for (const name of Object.keys(filters ?? {})) {
      const problem = filterProblem(name, filters![name]!)
      if (problem && !nav.badFilterNames.has(problem)) {
        nav.badFilterNames.add(problem)
        navWarn(
          world,
          new ShardError('nav/invalid-filter', problem, {
            hint: 'Fix it in nav/Filters: until then navmeshes leave it out, and agents naming it path with the default.',
          }),
        )
      }
    }
    if (filters && Object.keys(filters).length > MAX_NAV_FILTERS) {
      navWarn(
        world,
        new ShardError(
          'nav/too-many-filters',
          `nav/Filters has ${Object.keys(filters).length} filters; navmeshes keep the first ${MAX_NAV_FILTERS} by name`,
          { hint: "Detour's crowd has 16 filter slots, and the default filter takes one." },
        ),
      )
    }
    for (let i = 0; i < nav.meshList.length; i++)
      nav.meshList[i]!.applyFilters(areas ?? {}, filters ?? {}, nav.gates.depths)
  }
  // What changed: entity sources (by root), shapes, gates and links.
  findChanges(world, nav, since)
  const shapes = nav.shapes
  const gates = nav.gates
  let gathered = 0
  if (nav.dirty) {
    nav.dirty = false
    nav.linksDirty = true
    for (let t = 0; t < s.sources.tables.length; t++) {
      const table = s.sources.tables[t]!
      for (let row = 0; row < table.count; row++) nav.dirtyRoots.add(table.entities[row]!)
    }
    for (const root of nav.sources.keys()) nav.dirtyRoots.add(root)
  }
  let indexed = true
  for (let i = 0; i < nav.meshList.length; i++) if (!nav.meshList[i]!.indexed) indexed = false
  // A frame where nothing moved allocates nothing: the rest only runs on a change.
  if (
    !indexed ||
    nav.dirtyRoots.size > 0 ||
    nav.pendingRoots.size > 0 ||
    shapes.changed.size > 0 ||
    gates.changed.size > 0 ||
    nav.linksDirty
  ) {
    // The frame's budget counts from here: reading and placing what changed is part of it.
    nav.workStart = performance.now()
    gathered = applyChanges(world, nav)
  } else nav.workStart = 0
  nav.linksDirty = false
  // Gates whose state alone changed: their polygons' flags, no tile.
  if (gates.flagged.size > 0) {
    for (const [owner, before] of gates.flagged) {
      const gate = gates.byOwner.get(owner)
      if (!gate) continue
      for (let i = 0; i < nav.meshList.length; i++) nav.meshList[i]!.setGateFlags(gate, before)
    }
    gates.flagged.clear()
  }
  for (let i = 0; i < nav.meshList.length; i++) {
    const rt = nav.meshList[i]!
    if (rt.dirty.size === 0 && rt.jobs.length === 0) continue
    try {
      bakeDirty(world, nav, rt, gathered, flush)
      rt.problem = null
    } catch (err) {
      rt.problem = err instanceof Error ? err.message : String(err)
      world.tryResource(LogResource)?.error(err)
    }
  }
}

/**
 * The area a source or link bakes with: areas 32 to 62 are shut gates' (0114), so one there bakes
 * as 12 (priced, not excluded exactly, like the rest of 12–62), warned once per entity.
 */
function bakeArea(world: World, nav: NavState, area: number, owner: Entity): number {
  if (area <= SHUT_AREA || area > SHUT_AREA * 2) return area
  if (!nav.reservedWarned.has(owner)) {
    nav.reservedWarned.add(owner)
    navWarn(
      world,
      new ShardError(
        'nav/reserved-area',
        `Entity ${owner} bakes with area ${area}; areas ${SHUT_AREA + 1} to ${SHUT_AREA * 2} are shut gates' (0114), so it bakes as area ${EXACT_AREAS}`,
        { hint: 'Give NavSource and OffMeshLink areas 0 to 31.' },
      ),
    )
  }
  return EXACT_AREAS
}

/** Gathers what changed, and places it in every navmesh's tile index. Returns sources re-read. */
function applyChanges(world: World, nav: NavState): number {
  for (const root of nav.pendingRoots) nav.dirtyRoots.add(root)
  let gathered = 0
  const shapes = nav.shapes
  const gates = nav.gates
  const changes: [NavContribution | undefined, NavContribution | undefined][] = []
  if (nav.dirtyRoots.size > 0) {
    const roots = [...nav.dirtyRoots].sort((a, b) => a - b)
    nav.dirtyRoots.clear()
    for (const root of roots) {
      const old = nav.sources.get(root)
      const next = gatherRoot(world, nav, root) ?? undefined
      gathered++
      if (next) nav.sources.set(root, next)
      else nav.sources.delete(root)
      if (old || next) changes.push([old, next])
    }
    nav.watchedList = [...nav.watched]
    nav.skipped = [...nav.skippedBy.values()].flat()
  }
  if (shapes.changed.size > 0) {
    const owners = [...shapes.changed].sort((a, b) => a - b)
    shapes.changed.clear()
    for (const owner of owners) {
      const old = nav.shapeSources.get(owner)
      const next = shapes.byOwner.get(owner)
      gathered++
      if (next) nav.shapeSources.set(owner, next)
      else nav.shapeSources.delete(owner)
      if (old !== next) changes.push([old, next])
    }
  }
  let gateChanges: [NavGate | undefined, NavGate | undefined][] | undefined
  if (gates.changed.size > 0) {
    gateChanges = []
    const owners = [...gates.changed].sort((a, b) => a - b)
    gates.changed.clear()
    for (const owner of owners) {
      const old = nav.gateSources.get(owner)
      const next = gates.byOwner.get(owner)
      if (next) nav.gateSources.set(owner, next)
      else nav.gateSources.delete(owner)
      gateChanges.push([old, next])
      if (old?.link || next?.link) nav.linksDirty = true
    }
  }
  if (nav.linksDirty) gatherLinks(world, nav)
  for (let i = 0; i < nav.meshList.length; i++) {
    const rt = nav.meshList[i]!
    const nm = world.get(rt.entity, NavMesh)
    if (!rt.indexed) indexAll(nav, rt, nm)
    else {
      for (const [old, next] of changes) {
        if (old) unbin(rt, old)
        if (next) bin(rt, next, nm)
      }
      if (gateChanges)
        for (const [old, next] of gateChanges) {
          if (old) unbinGate(rt, old)
          if (next) binGate(rt, next)
        }
      if (nav.linksDirty) relink(nav, rt)
    }
    rt.pending = nav.pendingRoots.size
  }
  return gathered
}

/**
 * Takes a navmesh's frame from its entity's GlobalTransform. Returns whether it changed (so every
 * tile moves in the frame and rebakes).
 */
function updateFrame(world: World, rt: NavMeshRuntime, frame: Entity | null): boolean {
  const alive =
    frame !== null && frame >= 0 && world.isAlive(frame) && world.has(frame, GlobalTransform)
  if (!alive) {
    if (rt.frame === null) return false
    rt.frame = null
    rt.toLocal.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    rt.toWorld.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
    return true
  }
  const m = world.get(frame, GlobalTransform).matrix
  let same = rt.frame === frame
  for (let i = 0; i < 12 && same; i++) if (rt.toWorld[i] !== m[i]) same = false
  if (same) return false
  rt.frame = frame
  for (let i = 0; i < 12; i++) rt.toWorld[i] = m[i]!
  if (!affine64.invert(rt.toLocal, rt.toWorld)) rt.toLocal.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  return true
}

/** Marks the roots whose watched entities died or had their transform, shape, mesh or tags changed. */
function findChanges(world: World, nav: NavState, since: number): void {
  const list = nav.watchedList
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!
    let changed = !world.isAlive(e)
    if (!changed) {
      const table = world.entityTable(e)
      const row = world.entityRow(e)
      changed =
        (table.has(GlobalTransform) && table.changedTicks(GlobalTransform)[row]! > since) ||
        (table.has(Collider) && table.changedTicks(Collider)[row]! > since) ||
        (table.has(Mesh3d) && table.changedTicks(Mesh3d)[row]! > since) ||
        (table.has(NavSource) && table.changedTicks(NavSource)[row]! > since) ||
        (table.has(OffMeshLink) && table.changedTicks(OffMeshLink)[row]! > since)
    }
    if (!changed) continue
    const root = nav.rootOf.get(e)
    if (root === undefined || root === LINKS) nav.linksDirty = true
    if (root !== undefined && root !== LINKS) nav.dirtyRoots.add(root)
  }
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

/** Marks entities watched for a root (or `LINKS`), forgetting what it watched before. */
function watch(nav: NavState, owner: Entity, members: Entity[]): void {
  for (const e of nav.members.get(owner) ?? []) {
    if (nav.rootOf.get(e) === owner) {
      nav.rootOf.delete(e)
      nav.watched.delete(e)
    }
  }
  if (members.length === 0) nav.members.delete(owner)
  else nav.members.set(owner, members)
  for (const e of members) {
    nav.rootOf.set(e, owner)
    nav.watched.add(e)
  }
}

const rootSoup = new TriangleSoup()

/**
 * One NavSource subtree's world triangles: its root's collider (else render mesh), and its
 * descendants' that have no NavSource of their own, with the root's area. Null when the root is
 * gone or isn't a source any more.
 */
function gatherRoot(world: World, nav: NavState, root: Entity): NavContribution | null {
  nav.pendingRoots.delete(root)
  nav.skippedBy.delete(root)
  if (!world.isAlive(root) || !world.has(root, NavSource) || !world.has(root, GlobalTransform)) {
    watch(nav, root, [])
    return null
  }
  const soup = rootSoup
  soup.clear()
  const members: Entity[] = []
  const skipped: { entity: Entity; reason: string }[] = []
  let pending = 0
  const meshes = world.tryResource(Meshes)
  const area = bakeArea(world, nav, world.get(root, NavSource).area, root)
  const visit = (e: Entity) => {
    members.push(e)
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
            } else skipped.push({ entity: e, reason: `${c.shape} collider without a mesh` })
            break
          }
          default:
            skipped.push({ entity: e, reason: `${c.shape} colliders are 2D` })
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
        if (
          child !== null &&
          world.isAlive(child) &&
          !world.has(child, NavSource) &&
          world.has(child, GlobalTransform)
        )
          visit(child)
      }
    }
  }
  visit(root)
  watch(nav, root, members)
  if (pending > 0) nav.pendingRoots.add(root)
  if (skipped.length > 0) nav.skippedBy.set(root, skipped)
  const count = soup.count
  const c: NavContribution = {
    kind: 0,
    owner: root,
    positions: soup.positions.slice(0, count * 9),
    areas: soup.areas.slice(0, count),
    lanes: new Uint32Array(count * 2),
    count,
  }
  triangleLanes(c)
  return c
}

/** Every OffMeshLink, and every link gate (0112), as link parameters. */
function gatherLinks(world: World, nav: NavState): void {
  const members: Entity[] = []
  const links: OffMeshLinkParams[] = []
  nav.skippedBy.delete(LINKS)
  const skipped: { entity: Entity; reason: string }[] = []
  for (const table of world.query({ with: [OffMeshLink] }).tables) {
    for (let row = 0; row < table.count; row++) {
      const e = table.entities[row]! as Entity
      members.push(e)
      const link = world.get(e, OffMeshLink)
      if (link.to === null || !world.isAlive(link.to) || !world.has(link.to, GlobalTransform)) {
        skipped.push({ entity: e, reason: 'off-mesh link without a `to` entity' })
        continue
      }
      if (!world.has(e, GlobalTransform)) continue
      members.push(link.to)
      const a = world.get(e, GlobalTransform).matrix
      const b = world.get(link.to, GlobalTransform).matrix
      links.push({
        start: [a[3]!, a[7]!, a[11]!],
        end: [b[3]!, b[7]!, b[11]!],
        radius: link.radius,
        bidirectional: link.bidirectional,
        area: bakeArea(world, nav, link.area, e),
      })
    }
  }
  for (const gate of [...nav.gateSources.values()].sort((a, b) => a.owner - b.owner)) {
    if (!gate.link) continue
    links.push({
      start: gate.link.start,
      end: gate.link.end,
      radius: gate.link.radius,
      bidirectional: gate.link.bidirectional,
      area: gate.area,
    })
  }
  if (skipped.length > 0) nav.skippedBy.set(LINKS, skipped)
  nav.skipped = [...nav.skippedBy.values()].flat()
  nav.links = links
  watch(nav, LINKS, members)
  nav.watchedList = [...nav.watched]
}

// --- the tile index (0112) --------------------------------------------------------

const scratch3 = new Float64Array(3)

/** A source in a framed navmesh's space (the same object when the navmesh has no frame). */
function inSpace(rt: NavMeshRuntime, c: NavContribution): NavContribution {
  if (rt.frame === null) return c
  let local = rt.localOf.get(c)
  if (local) return local
  const p = c.positions
  const out = new Float32Array(c.count * 9)
  for (let v = 0; v < c.count * 3; v++) {
    rt.pointIn(p[v * 3]!, p[v * 3 + 1]!, p[v * 3 + 2]!, scratch3)
    out[v * 3] = scratch3[0]!
    out[v * 3 + 1] = scratch3[1]!
    out[v * 3 + 2] = scratch3[2]!
  }
  local = { ...c, positions: out, lanes: new Uint32Array(c.count * 2) }
  triangleLanes(local)
  rt.localOf.set(c, local)
  return local
}

/** The tile range a navmesh's bounds allow, and its border in world units. */
function extent(rt: NavMeshRuntime, nm: { boundsMin: number[]; boundsMax: number[] }) {
  const tw = rt.tileWorld
  const v = voxelSettings(rt.settings)
  const bounded =
    nm.boundsMin[0]! < nm.boundsMax[0]! ||
    nm.boundsMin[1]! < nm.boundsMax[1]! ||
    nm.boundsMin[2]! < nm.boundsMax[2]!
  return {
    tw,
    border: v.borderSize * rt.settings.cellSize,
    bounded,
    min: nm.boundsMin,
    max: nm.boundsMax,
    tMinX: bounded ? Math.floor(nm.boundsMin[0]! / tw) : -Infinity,
    tMaxX: bounded ? Math.floor(nm.boundsMax[0]! / tw) : Infinity,
    tMinZ: bounded ? Math.floor(nm.boundsMin[2]! / tw) : -Infinity,
    tMaxZ: bounded ? Math.floor(nm.boundsMax[2]! / tw) : Infinity,
  }
}

type Extent = ReturnType<typeof extent>

/** Places a source in the tiles its triangles (with the tile border) overlap, marking them. */
function bin(
  rt: NavMeshRuntime,
  source: NavContribution,
  nm: { boundsMin: number[]; boundsMax: number[] },
  ex: Extent = extent(rt, nm),
): void {
  const c = inSpace(rt, source)
  const p = c.positions
  const keys = new Set<number>()
  for (let t = 0; t < c.count; t++) {
    const o = t * 9
    const minX = Math.min(p[o]!, p[o + 3]!, p[o + 6]!)
    const maxX = Math.max(p[o]!, p[o + 3]!, p[o + 6]!)
    const minY = Math.min(p[o + 1]!, p[o + 4]!, p[o + 7]!)
    const maxY = Math.max(p[o + 1]!, p[o + 4]!, p[o + 7]!)
    const minZ = Math.min(p[o + 2]!, p[o + 5]!, p[o + 8]!)
    const maxZ = Math.max(p[o + 2]!, p[o + 5]!, p[o + 8]!)
    if (
      ex.bounded &&
      (maxX < ex.min[0]! ||
        minX > ex.max[0]! ||
        maxY < ex.min[1]! ||
        minY > ex.max[1]! ||
        maxZ < ex.min[2]! ||
        minZ > ex.max[2]!)
    )
      continue
    const x0 = Math.max(ex.tMinX, Math.floor((minX - ex.border) / ex.tw))
    const x1 = Math.min(ex.tMaxX, Math.floor((maxX + ex.border) / ex.tw))
    const z0 = Math.max(ex.tMinZ, Math.floor((minZ - ex.border) / ex.tw))
    const z1 = Math.min(ex.tMaxZ, Math.floor((maxZ + ex.border) / ex.tw))
    for (let tz = z0; tz <= z1; tz++) for (let tx = x0; tx <= x1; tx++) keys.add(packTile(tx, tz))
  }
  const list = [...keys]
  rt.binned.set(source, list)
  for (const k of list) {
    let set = rt.index.get(k)
    if (!set) {
      set = new Set()
      rt.index.set(k, set)
    }
    set.add(source)
    rt.dirty.add(k)
  }
}

function unbin(rt: NavMeshRuntime, source: NavContribution): void {
  for (const k of rt.binned.get(source) ?? []) {
    const set = rt.index.get(k)
    set?.delete(source)
    if (set?.size === 0) rt.index.delete(k)
    rt.dirty.add(k)
  }
  rt.binned.delete(source)
  rt.localOf.delete(source)
}

/** A gate's tiles: an area gate's footprint with the border; a link gate's start tile. */
function binGate(rt: NavMeshRuntime, gate: NavGate): void {
  const tw = rt.tileWorld
  const keys: number[] = []
  if (gate.link) {
    rt.pointIn(gate.link.start[0], gate.link.start[1], gate.link.start[2], scratch3)
    keys.push(packTile(Math.floor(scratch3[0]! / tw), Math.floor(scratch3[2]! / tw)))
  } else {
    const border = voxelSettings(rt.settings).borderSize * rt.settings.cellSize
    for (
      let tz = Math.floor((gate.minZ - border) / tw);
      tz <= Math.floor((gate.maxZ + border) / tw);
      tz++
    )
      for (
        let tx = Math.floor((gate.minX - border) / tw);
        tx <= Math.floor((gate.maxX + border) / tw);
        tx++
      )
        keys.push(packTile(tx, tz))
  }
  rt.gateTiles.set(gate.owner, keys)
  for (const k of keys) {
    let set = rt.gateIndex.get(k)
    if (!set) {
      set = new Set()
      rt.gateIndex.set(k, set)
    }
    set.add(gate)
    rt.dirty.add(k)
  }
}

function unbinGate(rt: NavMeshRuntime, gate: NavGate): void {
  for (const k of rt.gateTiles.get(gate.owner) ?? []) {
    const set = rt.gateIndex.get(k)
    set?.delete(gate)
    if (set?.size === 0) rt.gateIndex.delete(k)
    rt.dirty.add(k)
  }
  rt.gateTiles.delete(gate.owner)
  rt.gateRefs.delete(gate.owner)
  rt.gateOf.delete(gate.owner)
  if (rt.slots.size > 0) rt.staleGates.add(gate.owner)
}

/** Links changed: the tiles they started in, and start in now, are keyed again. */
function relink(nav: NavState, rt: NavMeshRuntime): void {
  for (const k of rt.linkTiles) rt.dirty.add(k)
  const tw = rt.tileWorld
  const keys = new Set<number>()
  for (const l of nav.links) {
    rt.pointIn(l.start[0], l.start[1], l.start[2], scratch3)
    keys.add(packTile(Math.floor(scratch3[0]! / tw), Math.floor(scratch3[2]! / tw)))
  }
  rt.linkTiles = [...keys]
  for (const k of keys) rt.dirty.add(k)
}

/**
 * Places every source, gate and link again (a new navmesh, new bounds or a moved frame), and
 * marks every tile it has and will have.
 */
function indexAll(
  nav: NavState,
  rt: NavMeshRuntime,
  nm: { boundsMin: number[]; boundsMax: number[] },
): void {
  for (const k of rt.tiles.keys()) rt.dirty.add(k)
  for (const k of rt.index.keys()) rt.dirty.add(k)
  rt.index.clear()
  rt.binned.clear()
  rt.localOf.clear()
  rt.gateIndex.clear()
  rt.gateTiles.clear()
  rt.gateRefs.clear()
  rt.refGate.clear()
  rt.gateRefsLost = true
  rt.bounds.set([
    nm.boundsMin[0]!,
    nm.boundsMin[1]!,
    nm.boundsMin[2]!,
    nm.boundsMax[0]!,
    nm.boundsMax[1]!,
    nm.boundsMax[2]!,
  ])
  const ex = extent(rt, nm)
  const all = [...nav.sources.values(), ...nav.shapeSources.values()]
  all.sort((a, b) => a.kind - b.kind || a.owner - b.owner)
  for (const c of all) bin(rt, c, nm, ex)
  for (const gate of nav.gateSources.values()) binGate(rt, gate)
  rt.linkTiles = []
  relink(nav, rt)
  rt.indexed = true
}

const tileSoup = new TriangleSoup()
let tileIndices = new Int32Array(64)

/** A tile built on the pool (0112): applied in submission order once done, dropped if stale. */
export interface TileJob {
  k: number
  tx: number
  tz: number
  key: string
  done: boolean
  /** The tile was dirtied again, to a different key, while this ran. */
  stale: boolean
  bytes: Uint8Array | null
  error: { message: string; code?: string; hint?: string } | null
  /** The pool rejected the job (the worker couldn't load Recast), as opposed to a failed build. */
  rejected: boolean
  promise: Promise<void>
}

const WORKER = new URL('./nav-worker.js', import.meta.url).href

/** The pool tiles build on: the host's (NavWorkers), unless it has none or couldn't load Recast. */
function poolFor(world: World, nav: NavState): Workers | undefined {
  const budget = world.tryResource(NavBudget)
  const pool = world.tryResource(NavWorkers)
  if (!pool || pool.size === 0 || budget?.workers === false || nav.poolFailed) return undefined
  return pool
}

/**
 * Brings in pool jobs that finished, in the order they were sent, until `deadline` (at least one
 * a frame; the rest wait their turn).
 */
function applyJobs(world: World, nav: NavState, rt: NavMeshRuntime, deadline: number): void {
  const cache = world.initResource(NavCache)
  const stats = rt.stats
  let applied = 0
  while (rt.jobs.length > 0 && rt.jobs[0]!.done) {
    if (applied > 0 && performance.now() >= deadline) break
    applied++
    const job = rt.jobs.shift()!
    if (rt.inflight.get(job.k) === job) rt.inflight.delete(job.k)
    if (job.stale) continue
    if (job.rejected) {
      // The pool couldn't run the job (no Recast in its threads): build inline from now on.
      if (!nav.poolFailed) {
        nav.poolFailed = true
        navWarn(
          world,
          new ShardError(
            'nav/workers-unavailable',
            `Navmesh tiles can't build on the worker pool: ${job.error?.message}`,
            {
              hint: 'They build on the main thread instead. A bundled server needs recast-navigation where nav-worker.js can import it.',
            },
          ),
        )
      }
      rt.dirty.add(job.k)
      continue
    }
    if (job.error) {
      const err = toShardError(Object.assign(new Error(job.error.message), job.error))
      rt.problem = err instanceof Error ? err.message : String(err)
      world.tryResource(LogResource)?.error(err)
      continue
    }
    cache.tiles.set(job.key, job.bytes)
    rt.setTile(job.tx, job.tz, job.key, job.bytes)
    const gates = rt.gateIndex.get(job.k)
    if (gates) rt.mapGates(job.k, gates)
    stats.built++
  }
}

/**
 * Keys dirty tiles from the sources, gates and links in them, and brings them in: kept when the
 * key is unchanged, from the cache when known, else built by Recast, inline (at most
 * `NavBudget.tiles` a frame) or on the pool (main-thread work up to `NavBudget.ms` a frame). A
 * navmesh's first bake, and `flush`, take no limits. Tiles left over stay dirty for the next frame.
 */
function bakeDirty(
  world: World,
  nav: NavState,
  rt: NavMeshRuntime,
  gathered: number,
  flush: boolean,
): void {
  const t0 = nav.workStart || performance.now()
  const R = rt.R
  const s = rt.settings
  const nm = world.get(rt.entity, NavMesh)
  const ex = extent(rt, nm)
  const tw = ex.tw
  const cache = world.initResource(NavCache)
  const budget = world.tryResource(NavBudget)
  const pool = poolFor(world, nav)
  const unlimited = flush || rt.cold
  const stats = rt.stats
  stats.built = 0
  stats.cached = 0
  stats.removed = 0
  stats.examined = 0
  stats.gathered = gathered
  const maxMs = budget?.ms ?? 1.5
  applyJobs(world, nav, rt, unlimited ? Infinity : t0 + maxMs)
  // Row by row (z, then x), the order a gather of one source meets them: Detour links tiles as
  // they're added, and a path through a shared corner depends on it.
  const keys =
    rt.dirty.size > 0 ? [...rt.dirty].sort((a, b) => (a % 65536) - (b % 65536) || a - b) : []
  let tiles = rt.tiles.size
  for (const k of keys) if (!rt.tiles.has(k) && rt.index.has(k)) tiles++
  rt.reserve(tiles)
  const framedLinks =
    rt.frame === null || keys.length === 0
      ? nav.links
      : nav.links.map((l) => {
          rt.pointIn(l.start[0], l.start[1], l.start[2], scratch3)
          const start: [number, number, number] = [scratch3[0]!, scratch3[1]!, scratch3[2]!]
          rt.pointIn(l.end[0], l.end[1], l.end[2], scratch3)
          return {
            ...l,
            start,
            end: [scratch3[0]!, scratch3[1]!, scratch3[2]!] as [number, number, number],
          }
        })
  const maxTiles = budget?.tiles ?? 4
  let builtInline = 0
  for (const k of keys) {
    // The frame's share: a count inline (frame-exact), time with a pool. At least one tile goes.
    if (!unlimited && stats.examined > 0) {
      if (pool ? performance.now() - t0 >= maxMs : builtInline >= maxTiles) break
    }
    rt.dirty.delete(k)
    stats.examined++
    const tx = Math.floor(k / 65536) - 32768
    const tz = (k % 65536) - 32768
    const x0 = tx * tw
    const z0 = tz * tw
    // This tile's triangles, from the sources indexed in it, in source order.
    const soup = tileSoup
    soup.clear()
    let yMin = Infinity
    let yMax = -Infinity
    let sumA = 0
    let sumB = 0
    const sources = [...(rt.index.get(k) ?? [])].sort(
      (a, b) => a.kind - b.kind || a.owner - b.owner,
    )
    for (const source of sources) {
      const c = inSpace(rt, source)
      const p = c.positions
      for (let t = 0; t < c.count; t++) {
        const o = t * 9
        const minX = Math.min(p[o]!, p[o + 3]!, p[o + 6]!)
        const maxX = Math.max(p[o]!, p[o + 3]!, p[o + 6]!)
        const minY = Math.min(p[o + 1]!, p[o + 4]!, p[o + 7]!)
        const maxY = Math.max(p[o + 1]!, p[o + 4]!, p[o + 7]!)
        const minZ = Math.min(p[o + 2]!, p[o + 5]!, p[o + 8]!)
        const maxZ = Math.max(p[o + 2]!, p[o + 5]!, p[o + 8]!)
        if (
          ex.bounded &&
          (maxX < ex.min[0]! ||
            minX > ex.max[0]! ||
            maxY < ex.min[1]! ||
            minY > ex.max[1]! ||
            maxZ < ex.min[2]! ||
            minZ > ex.max[2]!)
        )
          continue
        // The same test as binning: the triangle's tile range covers this tile.
        if (
          Math.floor((minX - ex.border) / tw) > tx ||
          Math.floor((maxX + ex.border) / tw) < tx ||
          Math.floor((minZ - ex.border) / tw) > tz ||
          Math.floor((maxZ + ex.border) / tw) < tz
        )
          continue
        if (minY < yMin) yMin = minY
        if (maxY > yMax) yMax = maxY
        sumA = (sumA + c.lanes[t * 2]!) >>> 0
        sumB = (sumB + c.lanes[t * 2 + 1]!) >>> 0
        soup.push(
          p[o]!,
          p[o + 1]!,
          p[o + 2]!,
          p[o + 3]!,
          p[o + 4]!,
          p[o + 5]!,
          p[o + 6]!,
          p[o + 7]!,
          p[o + 8]!,
          c.areas[t]!,
        )
      }
    }
    const gates = [...(rt.gateIndex.get(k) ?? [])].sort((a, b) => a.owner - b.owner)
    const areaGates = gates.filter((g) => !g.link)
    const links = framedLinks.filter(
      (l) => l.start[0] >= x0 && l.start[0] < x0 + tw && l.start[2] >= z0 && l.start[2] < z0 + tw,
    )
    const entry = rt.tiles.get(k)
    const running = rt.inflight.get(k)
    if (soup.count === 0) {
      if (running) running.stale = true
      if (entry) {
        rt.removeTile(tx, tz)
        stats.removed++
      }
      if (gates.length > 0) rt.mapGates(k, gates)
      continue
    }
    yMin = Math.floor(yMin) - 1
    yMax = Math.ceil(yMax) + 1
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
      .u32word(soup.count)
      .u32word(sumA)
      .u32word(sumB)
    for (const l of links) {
      for (let i = 0; i < 3; i++) hash.f32word(l.start[i]!).f32word(l.end[i]!)
      hash
        .f32word(l.radius)
        .u32word(l.bidirectional ? 1 : 0)
        .u32word(l.area)
    }
    // Area gates' geometry (not their flags) is part of the key; tiles without gates key as 0037.
    for (const g of areaGates) hash.u32word(g.key[0]).u32word(g.key[1])
    const key = hash.hex()
    // A job already building this key keeps going; one building an older key is stale.
    if (running) {
      if (running.key === key) continue
      running.stale = true
      rt.inflight.delete(k)
    }
    if (entry && entry.key === key) {
      // Kept as it is; a re-index dropped its gates' polygons, so find them again.
      if (gates.length > 0 && rt.gateRefsLost) rt.mapGates(k, gates)
      continue
    }
    const known = cache.tiles.get(key)
    if (known !== undefined) {
      stats.cached++
      rt.setTile(tx, tz, key, known)
      if (gates.length > 0) rt.mapGates(k, gates)
      continue
    }
    if (pool) {
      const job: TileJob = {
        k,
        tx,
        tz,
        key,
        done: false,
        stale: false,
        bytes: null,
        error: null,
        rejected: false,
        promise: Promise.resolve(),
      }
      const positions = soup.positions.slice(0, soup.count * 9)
      const areas = soup.areas.slice(0, soup.count)
      const tileGates = areaGates.map((g) => ({
        points: g.points,
        yMin: g.yMin,
        yMax: g.yMax,
        area: g.area,
      }))
      job.promise = pool
        .run<{ bytes?: Uint8Array | null; error?: TileJob['error'] }>(
          WORKER,
          'buildNavTile',
          [{ ...s }, tx, tz, yMin, yMax, positions, areas, links, tileGates],
          { transfer: [positions.buffer, areas.buffer], kind: 'nav/tile' },
        )
        .then(
          (r) => {
            job.bytes = r.bytes ?? null
            job.error = r.error ?? null
            job.done = true
          },
          (err: unknown) => {
            job.error = { message: err instanceof Error ? err.message : String(err) }
            job.rejected = true
            job.done = true
          },
        )
      rt.jobs.push(job)
      rt.inflight.set(k, job)
      continue
    }
    if (tileIndices.length < soup.count) tileIndices = new Int32Array(soup.count * 2)
    for (let i = 0; i < soup.count; i++) tileIndices[i] = i
    const bytes = buildTile(
      R,
      s,
      tx,
      tz,
      yMin,
      yMax,
      soup,
      tileIndices,
      soup.count,
      links,
      areaGates,
    )
    cache.tiles.set(key, bytes)
    stats.built++
    builtInline++
    rt.setTile(tx, tz, key, bytes)
    if (gates.length > 0) rt.mapGates(k, gates)
  }
  const settled = rt.dirty.size === 0 && rt.jobs.length === 0
  if (settled) {
    rt.cold = false
    rt.gateRefsLost = false
    // Gates with no polygon of theirs anywhere (a door too narrow for the agent, say).
    for (const gate of nav.gateSources.values()) {
      if (gate.link || !rt.gateTiles.has(gate.owner)) continue
      if (rt.gatePolygons(gate.owner) > 0) rt.unmatched.delete(gate.owner)
      else if (!rt.unmatched.has(gate.owner)) {
        rt.unmatched.add(gate.owner)
        navWarn(
          world,
          new ShardError(
            'nav/gate-unmatched',
            `Gate ${gate.owner} has no polygon of area ${gate.area} on navmesh ${rt.entity}`,
            {
              hint: 'The opening may be too narrow for the agent radius and cell size, or off the walkable surface.',
            },
          ),
        )
      }
    }
  }
  if (settled && rt.boundsStale) {
    rt.updateBounds()
    rt.boundsStale = false
  }
  stats.kept = rt.tiles.size - stats.built - stats.cached
  stats.bakes++
  stats.totalBuilt += stats.built
  stats.totalCached += stats.cached
  stats.totalRemoved += stats.removed
  stats.totalExamined += stats.examined
  stats.ms = performance.now() - t0
  if (settled && rt.tiles.size > 0 && rt.polygons() === 0 && rt.problem === null) {
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
