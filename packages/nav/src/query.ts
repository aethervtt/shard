import { type Entity, ShardError, type World } from '@shard/core'
import { GlobalTransform } from '@shard/transform'
import { NavAgent } from './components'
import { type GridHit, nearestWalkable, smoothGridPath, traceSegment } from './grid'
import type { NavMeshRuntime } from './navmesh'
import type { Recast } from './recast'
import { type GridRecord, type NavState, navState } from './state'

export const PATH_STATUSES = ['complete', 'partial', 'none'] as const
export type PathStatus = (typeof PATH_STATUSES)[number]

/** A path's corners, reused across queries: pass it as `out` and nothing allocates. */
export interface NavPath {
  /** x, y, z per corner, start first. */
  corners: Float32Array
  count: number
  /** Length along the corners. */
  length: number
  /** complete: reaches `to`. partial: ends at the closest reachable point. none: no path. */
  status: PathStatus
  /** The NavGrid or NavMesh entity the path is on. */
  nav: Entity | null
}

export function createNavPath(capacity = 256): NavPath {
  return { corners: new Float32Array(capacity * 3), count: 0, length: 0, status: 'none', nav: null }
}

export interface FindPathOptions {
  /** Where to write the path (default: a new one). */
  out?: NavPath
  /** Walk on this NavGrid or NavMesh entity instead of the one containing `from`. */
  nav?: Entity | null
  /** Plan as this NavAgent: its `nav`, if set. */
  agent?: Entity | null
  /** Navmesh area costs for this query only, over nav/Areas (0 excludes an area). */
  areas?: Record<number, number>
}

/** Which grid or navmesh a point is in. */
export type NavTarget =
  | { kind: 'grid'; entity: Entity; grid: GridRecord }
  | { kind: 'mesh'; entity: Entity; mesh: NavMeshRuntime }

/** How far a grid query looks for a walkable cell around a blocked start or end. */
const SNAP_CELLS = 8

function inGrid(g: GridRecord, x: number, y: number): boolean {
  if (!g.grid) return false
  const cx = (x - g.ox) / g.csx
  const cy = (y - g.oy) / g.csy
  return cx >= 0 && cy >= 0 && cx < g.grid.width && cy < g.grid.height
}

function inMesh(m: NavMeshRuntime, x: number, y: number, z: number): boolean {
  const pad = m.settings.agentRadius + m.settings.cellSize * 2
  return (
    x >= m.min[0]! - pad &&
    x <= m.max[0]! + pad &&
    z >= m.min[2]! - pad &&
    z <= m.max[2]! + pad &&
    y >= m.min[1]! - m.settings.agentHeight &&
    y <= m.max[1]! + m.settings.agentHeight
  )
}

/** What `locate` found; module state so per-frame queries don't allocate a result. */
let foundGrid: GridRecord | null = null
let foundMesh: NavMeshRuntime | null = null
const inFrame = new Float64Array(3)

/** Finds the grid or navmesh (`nav`, else the one containing the point) into found*. */
function locate(state: NavState, point: ArrayLike<number>, nav: Entity | null): boolean {
  foundGrid = null
  foundMesh = null
  if (nav !== null) {
    foundGrid = state.grids.get(nav) ?? null
    if (foundGrid && !foundGrid.grid) foundGrid = null
    if (!foundGrid) foundMesh = state.meshes.get(nav) ?? null
    return foundGrid !== null || foundMesh !== null
  }
  const x = point[0]!
  const y = point[1]!
  const z = point[2] ?? 0
  for (let i = 0; i < state.gridList.length; i++) {
    const g = state.gridList[i]!
    if (inGrid(g, x, y)) {
      foundGrid = g
      return true
    }
  }
  for (let i = 0; i < state.meshList.length; i++) {
    const m = state.meshList[i]!
    if (m.frame !== null) {
      m.pointIn(x, y, z, inFrame)
      if (inMesh(m, inFrame[0]!, inFrame[1]!, inFrame[2]!)) {
        foundMesh = m
        return true
      }
    } else if (inMesh(m, x, y, z)) {
      foundMesh = m
      return true
    }
  }
  return false
}

/**
 * The grid or navmesh containing a point (grids first, then navmeshes), or undefined. `nav`
 * picks one explicitly.
 */
export function navAt(
  world: World,
  point: ArrayLike<number>,
  nav: Entity | null = null,
): NavTarget | undefined {
  if (!locate(navState(world), point, nav)) return undefined
  if (foundGrid) return { kind: 'grid', entity: foundGrid.entity, grid: foundGrid }
  return { kind: 'mesh', entity: foundMesh!.entity, mesh: foundMesh! }
}

/** `locate`, or a `nav/no-navmesh` / `nav/out-of-bounds` error explaining why there's none. */
function requireNav(world: World, point: ArrayLike<number>, nav: Entity | null): void {
  const state = navState(world)
  if (locate(state, point, nav)) return
  if (nav !== null) {
    throw new ShardError('nav/no-navmesh', `Entity ${nav} has no built NavGrid or NavMesh`, {
      hint: 'Check nav.describe: the grid may be waiting for data, or the navmesh for sources.',
    })
  }
  if (state.grids.size === 0 && state.meshes.size === 0) {
    throw new ShardError('nav/no-navmesh', 'There is no NavGrid or NavMesh to query', {
      hint: 'Add a nav/NavGrid (2D) or a nav/NavMesh and tag level geometry with nav/NavSource.',
    })
  }
  const p = [point[0], point[1], point[2] ?? 0].map((v) => Math.round((v ?? 0) * 100) / 100)
  throw new ShardError(
    'nav/out-of-bounds',
    `(${p.join(', ')}) is outside every NavGrid and NavMesh`,
    { hint: 'nav.describe lists each grid and navmesh with its bounds.' },
  )
}

// --- paths ------------------------------------------------------------------------

const ends = new Float64Array(4)
let cellScratch = new Float32Array(2 * 256)

/**
 * A path from `from` to `to` (world space), as corners, on the NavGrid or NavMesh containing
 * `from`. Grid paths are A* pulled straight; mesh paths are Detour's. A goal with no path gives
 * a partial path to the closest reachable point. Writes into `options.out` when given.
 */
export function findPath(
  world: World,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  options: FindPathOptions = {},
): NavPath {
  const out = options.out ?? createNavPath()
  let navEntity = options.nav ?? null
  if (navEntity === null && options.agent != null && world.has(options.agent, NavAgent)) {
    navEntity = world.get(options.agent, NavAgent).nav
  }
  requireNav(world, from, navEntity)
  if (foundGrid) {
    out.nav = foundGrid.entity
    gridPath(navState(world), foundGrid, from, to, out)
  } else {
    out.nav = foundMesh!.entity
    const m = foundMesh!
    if (m.frame === null) meshPath(m, from, to, out, options.areas)
    else {
      // In the navmesh's frame, then the corners back to world space.
      m.pointIn(from[0]!, from[1]!, from[2] ?? 0, fromLocal)
      m.pointIn(to[0]!, to[1]!, to[2] ?? 0, toLocal)
      meshPath(m, fromLocal, toLocal, out, options.areas)
      const c = out.corners
      for (let i = 0; i < out.count; i++) {
        m.pointOut(c[i * 3]!, c[i * 3 + 1]!, c[i * 3 + 2]!, inFrame)
        c[i * 3] = inFrame[0]!
        c[i * 3 + 1] = inFrame[1]!
        c[i * 3 + 2] = inFrame[2]!
      }
    }
  }
  return out
}

const fromLocal = new Float64Array(3)
const toLocal = new Float64Array(3)

/**
 * A path on a navmesh with every point in its own space (framed navmeshes: the frame's local
 * space). For agents, which steer in that space.
 */
export function meshPathLocal(
  m: NavMeshRuntime,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  out: NavPath,
  areas?: Record<number, number>,
): void {
  out.nav = m.entity
  meshPath(m, from, to, out, areas)
}

function gridPath(
  state: NavState,
  g: GridRecord,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  out: NavPath,
): void {
  const grid = g.grid!
  const w = grid.width
  const fx = (from[0]! - g.ox) / g.csx
  const fy = (from[1]! - g.oy) / g.csy
  let tx = (to[0]! - g.ox) / g.csx
  let ty = (to[1]! - g.oy) / g.csy
  const z = from[2] ?? g.z
  out.count = 0
  out.length = 0
  out.status = 'none'
  const start = nearestWalkable(grid, fx, fy, SNAP_CELLS)
  if (start === -1) return
  const outside = tx < 0 || ty < 0 || tx >= grid.width || ty >= grid.height
  if (outside) {
    tx = tx < 0 ? 0.5 : tx >= grid.width ? grid.width - 0.5 : tx
    ty = ty < 0 ? 0.5 : ty >= grid.height ? grid.height - 0.5 : ty
  }
  let goal = nearestWalkable(grid, tx, ty, SNAP_CELLS)
  // Nothing walkable near the goal: no path, but stay put rather than fail.
  const noGoal = goal === -1
  if (noGoal) goal = start
  const search = state.search
  const sx = start % w
  const sy = (start - sx) / w
  const gx = goal % w
  const gy = (goal - gx) / w
  search.search(grid, sx, sy, gx, gy, g.diagonal, g.csx, g.csy)
  const reached = search.reached && !noGoal
  // Start and end points in cell units: exact where their cells are walkable, else the snapped
  // cell's center.
  const snappedStart = Math.floor(fx) !== sx || Math.floor(fy) !== sy
  ends[0] = snappedStart ? sx + 0.5 : fx
  ends[1] = snappedStart ? sy + 0.5 : fy
  const last = search.cells[search.count - 1]!
  const lx = last % w
  const ly = (last - lx) / w
  const exact = reached && Math.floor(tx) === lx && Math.floor(ty) === ly && !outside
  ends[2] = exact ? tx : lx + 0.5
  ends[3] = exact ? ty : ly + 0.5
  const capacity = Math.floor(out.corners.length / 3)
  if (cellScratch.length < capacity * 2) cellScratch = new Float32Array(capacity * 2)
  const n = smoothGridPath(
    grid,
    search.cells,
    search.count,
    ends,
    g.diagonal,
    cellScratch,
    2,
    capacity,
  )
  const c = out.corners
  let length = 0
  for (let i = 0; i < n; i++) {
    c[i * 3] = g.ox + cellScratch[i * 2]! * g.csx
    c[i * 3 + 1] = g.oy + cellScratch[i * 2 + 1]! * g.csy
    c[i * 3 + 2] = z
    if (i > 0) {
      const dx = c[i * 3]! - c[i * 3 - 3]!
      const dy = c[i * 3 + 1]! - c[i * 3 - 2]!
      length += Math.sqrt(dx * dx + dy * dy)
    }
  }
  out.count = n
  out.length = length
  out.status = exact ? 'complete' : 'partial'
}

const v3 = { x: 0, y: 0, z: 0 }
const v3b = { x: 0, y: 0, z: 0 }
const extents = { x: 0, y: 0, z: 0 }

function queryExtents(m: NavMeshRuntime) {
  extents.x = Math.max(1, m.settings.agentRadius * 4)
  extents.y = Math.max(2, m.settings.agentHeight * 1.5)
  extents.z = extents.x
  return extents
}

type RFilter = InstanceType<Recast['QueryFilter']>

/** A filter with `areas` applied over the navmesh's own costs. Destroy it after use. */
function areaFilter(m: NavMeshRuntime, areas: Record<number, number>): RFilter {
  const f = new m.R.QueryFilter()
  for (let a = 0; a < 63; a++) f.setAreaCost(a, m.filter.getAreaCost(a))
  let exclude = ~m.filter.includeFlags & 0xffff
  for (const key of Object.keys(areas)) {
    const area = Number(key)
    const cost = areas[area]!
    if (!(area >= 0 && area < 63)) continue
    if (cost <= 0) exclude |= area < 15 ? 1 << area : 1 << 15
    else f.setAreaCost(area, cost)
  }
  f.includeFlags = 0xffff & ~exclude
  return f
}

function meshPath(
  m: NavMeshRuntime,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  out: NavPath,
  areas: Record<number, number> | undefined,
): void {
  out.count = 0
  out.length = 0
  out.status = 'none'
  const filter = areas ? areaFilter(m, areas) : m.filter
  try {
    const q = m.query
    const halfExtents = queryExtents(m)
    v3.x = from[0]!
    v3.y = from[1]!
    v3.z = from[2]!
    const start = q.findNearestPoly(v3, { filter, halfExtents })
    v3b.x = to[0]!
    v3b.y = to[1]!
    v3b.z = to[2]!
    const end = q.findNearestPoly(v3b, { filter, halfExtents })
    if (!start.success || start.nearestRef === 0) return
    const startPos = start.nearestPoint
    let endRef = end.success ? end.nearestRef : 0
    let endPos = endRef ? end.nearestPoint : v3b
    const capacity = Math.floor(out.corners.length / 3)
    if (endRef === 0) {
      // No polygon near the goal: aim for the closest point the start's region reaches.
      endRef = start.nearestRef
      endPos = startPos
    }
    const path = q.findPath(start.nearestRef, endRef, startPos, endPos, {
      filter,
      maxPathPolys: 512,
    })
    const polys = path.polys
    try {
      if (!path.success || polys.size === 0) return
      // Detour's resize doesn't shrink `size`: count the polys it wrote.
      let n = 0
      while (n < polys.size && polys.get(n) !== 0) n++
      if (n === 0) return
      const lastPoly = polys.get(n - 1)
      let target = endPos
      const complete = lastPoly === end.nearestRef && end.success && end.nearestRef !== 0
      if (lastPoly !== endRef) {
        const closest = q.closestPointOnPoly(lastPoly, endPos)
        if (closest.success) target = closest.closestPoint
      }
      if (n < polys.size) polys.resize(n)
      const straight = q.findStraightPath(startPos, target, polys, {
        maxStraightPathPoints: capacity,
      })
      try {
        if (!straight.success) return
        const c = out.corners
        const count = straight.straightPathCount
        let length = 0
        for (let i = 0; i < count; i++) {
          c[i * 3] = straight.straightPath.get(i * 3)
          c[i * 3 + 1] = straight.straightPath.get(i * 3 + 1)
          c[i * 3 + 2] = straight.straightPath.get(i * 3 + 2)
          if (i > 0) {
            const dx = c[i * 3]! - c[i * 3 - 3]!
            const dy = c[i * 3 + 1]! - c[i * 3 - 2]!
            const dz = c[i * 3 + 2]! - c[i * 3 - 1]!
            length += Math.sqrt(dx * dx + dy * dy + dz * dz)
          }
        }
        out.count = count
        out.length = length
        // A goal off the mesh (beyond query reach) counts as complete when the path ends as
        // close as the navmesh gets to it horizontally.
        out.status = complete ? 'complete' : 'partial'
      } finally {
        straight.straightPath.destroy()
        straight.straightPathFlags.destroy()
        straight.straightPathRefs.destroy()
      }
    } finally {
      polys.destroy()
    }
  } finally {
    if (filter !== m.filter) m.R.Raw.destroy(filter.raw)
  }
}

// --- nearest point and raycast -------------------------------------------------

/**
 * The walkable point nearest to `point` on the grid or navmesh containing it, written into
 * `out` (xyz). Returns false when nothing walkable is near.
 */
export function nearestPoint(
  world: World,
  point: ArrayLike<number>,
  out: { [i: number]: number },
  options: { nav?: Entity | null } = {},
): boolean {
  requireNav(world, point, options.nav ?? null)
  if (foundGrid) {
    const g = foundGrid
    const grid = g.grid!
    const x = (point[0]! - g.ox) / g.csx
    const y = (point[1]! - g.oy) / g.csy
    const cell = nearestWalkable(grid, x, y, Math.max(grid.width, grid.height))
    if (cell === -1) return false
    const cx = cell % grid.width
    const cy = (cell - cx) / grid.width
    const inside = Math.floor(x) === cx && Math.floor(y) === cy
    out[0] = inside ? point[0]! : g.ox + (cx + 0.5) * g.csx
    out[1] = inside ? point[1]! : g.oy + (cy + 0.5) * g.csy
    out[2] = point[2] ?? g.z
    return true
  }
  const m = foundMesh!
  m.pointIn(point[0]!, point[1]!, point[2] ?? 0, inFrame)
  v3.x = inFrame[0]!
  v3.y = inFrame[1]!
  v3.z = inFrame[2]!
  const r = m.query.findClosestPoint(v3, { filter: m.filter, halfExtents: queryExtents(m) })
  if (!r.success || r.polyRef === 0) return false
  m.pointOut(r.point.x, r.point.y, r.point.z, inFrame)
  out[0] = inFrame[0]!
  out[1] = inFrame[1]!
  out[2] = inFrame[2]!
  return true
}

/** Where `navRaycast` stopped. */
export interface NavRayHit {
  /** 0..1 along the segment; 1: clear to `to`. */
  t: number
  point: Float64Array
  /** Edge normal of the wall hit (xyz), zero when clear. */
  normal: Float64Array
}

export function createNavRayHit(): NavRayHit {
  return { t: 1, point: new Float64Array(3), normal: new Float64Array(3) }
}

const gridHit: GridHit = { t: 1, x: 0, y: 0 }
const seg = new Float64Array(4)

/**
 * Walks along the walkable surface from `from` toward `to` and stops at the first wall or
 * blocked cell. Returns true when it hit something (`hit.t` < 1); `hit.point` is where it stopped.
 */
export function navRaycast(
  world: World,
  from: ArrayLike<number>,
  to: ArrayLike<number>,
  hit: NavRayHit = createNavRayHit(),
  options: { nav?: Entity | null } = {},
): boolean {
  requireNav(world, from, options.nav ?? null)
  hit.normal.fill(0)
  if (foundGrid) {
    const g = foundGrid
    seg[0] = (from[0]! - g.ox) / g.csx
    seg[1] = (from[1]! - g.oy) / g.csy
    seg[2] = (to[0]! - g.ox) / g.csx
    seg[3] = (to[1]! - g.oy) / g.csy
    const clear = traceSegment(g.grid!, seg, g.diagonal, 255, gridHit)
    hit.t = gridHit.t
    hit.point[0] = g.ox + gridHit.x * g.csx
    hit.point[1] = g.oy + gridHit.y * g.csy
    hit.point[2] = from[2] ?? g.z
    if (!clear) {
      // Which side it entered the blocked cell from.
      const dx = seg[2] - seg[0]
      const dy = seg[3] - seg[1]
      const fx = gridHit.x - Math.floor(gridHit.x)
      const fy = gridHit.y - Math.floor(gridHit.y)
      const onX = Math.min(fx, 1 - fx) < Math.min(fy, 1 - fy)
      if (onX) hit.normal[0] = dx > 0 ? -1 : 1
      else hit.normal[1] = dy > 0 ? -1 : 1
    }
    return !clear
  }
  const m = foundMesh!
  m.pointIn(from[0]!, from[1]!, from[2] ?? 0, fromLocal)
  m.pointIn(to[0]!, to[1]!, to[2] ?? 0, toLocal)
  v3.x = fromLocal[0]!
  v3.y = fromLocal[1]!
  v3.z = fromLocal[2]!
  const start = m.query.findNearestPoly(v3, { filter: m.filter, halfExtents: queryExtents(m) })
  if (!start.success || start.nearestRef === 0) {
    hit.t = 0
    hit.point[0] = from[0]!
    hit.point[1] = from[1]!
    hit.point[2] = from[2]!
    return true
  }
  v3b.x = toLocal[0]!
  v3b.y = toLocal[1]!
  v3b.z = toLocal[2]!
  const r = m.query.raycast(start.nearestRef, start.nearestPoint, v3b, { filter: m.filter })
  const t = r.t > 1 ? 1 : r.t
  hit.t = t
  const sp = start.nearestPoint
  m.pointOut(
    sp.x + (toLocal[0]! - sp.x) * t,
    sp.y + (toLocal[1]! - sp.y) * t,
    sp.z + (toLocal[2]! - sp.z) * t,
    hit.point,
  )
  if (t < 1) m.vectorOut(r.hitNormal.x, r.hitNormal.y, r.hitNormal.z, hit.normal)
  return t < 1
}

/** An entity's world position (xyz) from its GlobalTransform. */
export function worldPos(world: World, e: Entity, out: { [i: number]: number }): void {
  const m = world.get(e, GlobalTransform).matrix
  out[0] = m[3]!
  out[1] = m[7]!
  out[2] = m[11]!
}
