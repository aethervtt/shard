import {
  type AssetRef,
  defineResource,
  defineSystem,
  type Entity,
  type Query,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'
import { LogResource } from '@aethervtt/shard-runtime'
import { type HeightfieldRuntime, TerrainWorld } from '@aethervtt/shard-terrain'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { WaterBody, type WaterKind, WaterSpline } from './components'
import { resolveOptics, WATER_OPTICS_PRESETS, type WaterOpticsValue } from './optics'

/** Bodies the water surface draws at once (and the info texture's body index holds). */
export const MAX_WATER_BODIES = 64

/** Points an outline is tessellated into, at most (the step grows past this). */
export const MAX_OUTLINE_POINTS = 2048

/** A lake's or bounded ocean's outline in world XZ, with what tests and draws it. */
export interface WaterShape {
  /** Outline points (x, z), counter-clockwise seen from above (+Y). */
  readonly outline: Float64Array
  readonly count: number
  /** minX, minZ, maxX, maxZ. */
  readonly bounds: Float64Array
  /** Triangles (x, z per corner), for the info texture's raster. */
  readonly triangles: Float32Array
  /** Edges by z band: band b's edges are `bandEdges[bandStart[b] .. bandStart[b + 1])`. */
  readonly bandStart: Int32Array
  readonly bandEdges: Int32Array
  readonly bandHeight: number
}

/** One body as the frame sees it: after transforms, its outline and optics resolved. */
export interface WaterBodyRecord {
  entity: Entity
  kind: WaterKind
  /** The surface's height: the entity's world y. */
  level: number
  priority: number
  /** null: an ocean with no outline, everywhere. */
  shape: WaterShape | null
  optics: WaterOpticsValue
  opticsRef: AssetRef | null
  /** No optics asset: `clear` is used (water/no-optics). */
  missingOptics: boolean
  /** The optics asset is still loading: drawn with `clear` meanwhile. */
  opticsLoading: boolean
  windOwn: boolean
  windSpeed: number
  windDirection: [number, number, number]
  /** GlobalTransform rows when the shape was built. */
  readonly matrix: Float64Array
  /** Whether it had a WaterSpline when last read. */
  hasSpline: boolean
  /** The frame it was last seen in. */
  seen: number
  problem: ShardError | null
}

/** Every body this frame, in the order they draw: priority, then entity. */
export class WaterBodiesState {
  readonly records = new Map<Entity, WaterBodyRecord>()
  /** Drawn bodies (no problem), sorted; `count` are valid. */
  readonly sorted: WaterBodyRecord[] = []
  count = 0
  /** Bodies past MAX_WATER_BODIES that don't draw (the lowest priorities). */
  skipped = 0
  /** Bumps when anything the info texture holds changes: bodies, levels, outlines, order. */
  version = 0
  /** Whether a body without an outline (an unbounded ocean) is present, and the highest one's level. */
  unbounded = false
  farLevel = 0
  /** Union of the bounded bodies' outlines (minX, minZ, maxX, maxZ). */
  readonly bounds = new Float64Array(4)
  /** The lowest surface: where dry parts of the surface mesh collapse below. */
  lowest = 0
  /** Heightfield terrains, ready for waterAt's ground (refreshed every frame). */
  readonly terrains: HeightfieldRuntime[] = []
  terrainCount = 0
  /** Sum of the terrains' versions: the ground in the info texture is refilled when it changes. */
  terrainVersion = 0
  /**
   * Terrain edits (0104) since the info texture last read them: world rectangles (x0, z0, x1, z1)
   * whose ground refills. `groundRefresh` when more came than this holds: refill everything.
   */
  readonly groundEdits: number[] = []
  groundRefresh = false
  /** Each terrain's edit log position, as far as groundEdits has it. */
  readonly editSeen = new WeakMap<HeightfieldRuntime, number>()
  frame = 0
  readonly reported = new Set<string>()
}

export const WaterBodies = defineResource<WaterBodiesState>('water/Bodies', {
  description:
    'Water bodies this frame (0097), sorted by priority: outlines, levels, optics, and the terrains under them.',
  init: () => new WaterBodiesState(),
})

/** Twice the signed area of an outline (x, z pairs): positive when counter-clockwise from above. */
function signedArea(p: Float64Array, n: number): number {
  let a = 0
  for (let i = 0, j = n - 1; i < n; j = i++)
    a += p[j * 2]! * p[i * 2 + 1]! - p[i * 2]! * p[j * 2 + 1]!
  // XZ seen from +Y: x right, z down the screen, so the usual sign flips.
  return -a
}

function segmentsCross(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): boolean {
  const d1 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx)
  const d2 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx)
  const d3 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax)
  const d4 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax)
  return d1 * d2 < 0 && d3 * d4 < 0
}

/** The first pair of non-adjacent edges that cross, or -1. */
function selfIntersection(p: Float64Array, n: number): number {
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n
    const ax = p[i * 2]!
    const az = p[i * 2 + 1]!
    const bx = p[i2 * 2]!
    const bz = p[i2 * 2 + 1]!
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const j2 = (j + 1) % n
      if (segmentsCross(ax, az, bx, bz, p[j * 2]!, p[j * 2 + 1]!, p[j2 * 2]!, p[j2 * 2 + 1]!))
        return i
    }
  }
  return -1
}

/** Ear clipping of a simple counter-clockwise polygon into triangles (x, z per corner). */
function triangulate(p: Float64Array, n: number): Float32Array {
  const out = new Float32Array((n - 2) * 6)
  const prev = new Int32Array(n)
  const next = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    prev[i] = (i + n - 1) % n
    next[i] = (i + 1) % n
  }
  // Counter-clockwise from above is clockwise in plain (x, z): an ear turns that way.
  const cross = (a: number, b: number, c: number) =>
    (p[b * 2]! - p[a * 2]!) * (p[c * 2 + 1]! - p[a * 2 + 1]!) -
    (p[b * 2 + 1]! - p[a * 2 + 1]!) * (p[c * 2]! - p[a * 2]!)
  const inside = (a: number, b: number, c: number, q: number) =>
    cross(a, b, q) <= 0 && cross(b, c, q) <= 0 && cross(c, a, q) <= 0
  let left = n
  let i = 0
  let t = 0
  let stuck = 0
  while (left > 3 && stuck <= left) {
    const a = prev[i]!
    const c = next[i]!
    let ear = cross(a, i, c) < 0
    if (ear) {
      for (let q = next[c]!; q !== a; q = next[q]!) {
        if (inside(a, i, c, q)) {
          ear = false
          break
        }
      }
    }
    if (ear) {
      out[t++] = p[a * 2]!
      out[t++] = p[a * 2 + 1]!
      out[t++] = p[i * 2]!
      out[t++] = p[i * 2 + 1]!
      out[t++] = p[c * 2]!
      out[t++] = p[c * 2 + 1]!
      next[a] = c
      prev[c] = a
      left--
      stuck = 0
      i = c
    } else {
      i = next[i]!
      stuck++
    }
  }
  if (left === 3) {
    const a = prev[i]!
    const c = next[i]!
    out[t++] = p[a * 2]!
    out[t++] = p[a * 2 + 1]!
    out[t++] = p[i * 2]!
    out[t++] = p[i * 2 + 1]!
    out[t++] = p[c * 2]!
    out[t++] = p[c * 2 + 1]!
  }
  return out.subarray(0, t)
}

function badSpline(entity: Entity, message: string, hint: string): ShardError {
  return new ShardError('water/bad-spline', `Water body ${entity}: ${message}`, {
    hint,
    path: `${entity}/water/WaterSpline`,
  })
}

/**
 * A closed outline from spline points in the entity's frame: tessellated as uniform Catmull-Rom
 * (shard-mesh, shared with terrain's splines), into world XZ through `m` (GlobalTransform rows),
 * counter-clockwise, triangulated, and bucketed for point tests. Throws `water/bad-spline` for
 * fewer than 3 points or an outline that crosses itself.
 */
export function buildShape(
  entity: Entity,
  points: readonly { position: readonly number[] }[],
  m: ArrayLike<number>,
): WaterShape {
  if (points.length < 3) {
    throw badSpline(
      entity,
      `a closed outline needs at least 3 points, it has ${points.length}`,
      'Add points to its water/WaterSpline: a lake or bounded ocean is the area inside them.',
    )
  }
  const control = new Float64Array(points.length * 3)
  let perimeter = 0
  for (let i = 0; i < points.length; i++) {
    const q = points[i]!.position
    control[i * 3] = q[0]!
    control[i * 3 + 1] = 0
    control[i * 3 + 2] = q[2]!
    if (i > 0) perimeter += Math.hypot(q[0]! - control[i * 3 - 3]!, q[2]! - control[i * 3 - 1]!)
  }
  perimeter += Math.hypot(
    control[0]! - control[control.length - 3]!,
    control[2]! - control[control.length - 1]!,
  )
  const step = Math.max(1, perimeter / (MAX_OUTLINE_POINTS / 2))
  const sampled = sampleCatmullRom(control, true, step)
  const n = sampled.length / 3
  const outline = new Float64Array(n * 2)
  for (let i = 0; i < n; i++) {
    const x = sampled[i * 3]!
    const z = sampled[i * 3 + 2]!
    outline[i * 2] = m[0]! * x + m[2]! * z + m[3]!
    outline[i * 2 + 1] = m[8]! * x + m[10]! * z + m[11]!
  }
  const area = signedArea(outline, n)
  if (Math.abs(area) < 1e-9) {
    throw badSpline(entity, 'its outline encloses no area', 'Spread its points out in x and z.')
  }
  if (area < 0) {
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const x = outline[i * 2]!
      const z = outline[i * 2 + 1]!
      outline[i * 2] = outline[j * 2]!
      outline[i * 2 + 1] = outline[j * 2 + 1]!
      outline[j * 2] = x
      outline[j * 2 + 1] = z
    }
  }
  const crossing = selfIntersection(outline, n)
  if (crossing >= 0) {
    throw badSpline(
      entity,
      `its outline crosses itself near (${outline[crossing * 2]!.toFixed(1)}, ${outline[crossing * 2 + 1]!.toFixed(1)})`,
      'Reorder or move its points so the curve through them doesn’t loop over itself.',
    )
  }
  const bounds = new Float64Array([Infinity, Infinity, -Infinity, -Infinity])
  for (let i = 0; i < n; i++) {
    bounds[0] = Math.min(bounds[0]!, outline[i * 2]!)
    bounds[1] = Math.min(bounds[1]!, outline[i * 2 + 1]!)
    bounds[2] = Math.max(bounds[2]!, outline[i * 2]!)
    bounds[3] = Math.max(bounds[3]!, outline[i * 2 + 1]!)
  }
  const bands = Math.max(1, Math.min(256, n >> 2))
  const bandHeight = Math.max((bounds[3]! - bounds[1]!) / bands, 1e-9)
  const counts = new Int32Array(bands + 1)
  const range = (i: number, out: Int32Array) => {
    const j = (i + 1) % n
    const z0 = Math.min(outline[i * 2 + 1]!, outline[j * 2 + 1]!)
    const z1 = Math.max(outline[i * 2 + 1]!, outline[j * 2 + 1]!)
    out[0] = Math.max(0, Math.min(bands - 1, Math.floor((z0 - bounds[1]!) / bandHeight)))
    out[1] = Math.max(0, Math.min(bands - 1, Math.floor((z1 - bounds[1]!) / bandHeight)))
  }
  const r = new Int32Array(2)
  for (let i = 0; i < n; i++) {
    range(i, r)
    for (let b = r[0]!; b <= r[1]!; b++) counts[b + 1]!++
  }
  for (let b = 0; b < bands; b++) counts[b + 1]! += counts[b]!
  const bandEdges = new Int32Array(counts[bands]!)
  const fill = counts.slice(0, bands)
  for (let i = 0; i < n; i++) {
    range(i, r)
    for (let b = r[0]!; b <= r[1]!; b++) bandEdges[fill[b]!++] = i
  }
  return {
    outline,
    count: n,
    bounds,
    triangles: triangulate(outline, n),
    bandStart: counts,
    bandEdges,
    bandHeight,
  }
}

/** Whether world (x, z) is inside a shape's outline: crossings to +x, only the edges in its band. */
export function insideShape(s: WaterShape, x: number, z: number): boolean {
  const b = s.bounds
  if (x < b[0]! || z < b[1]! || x > b[2]! || z > b[3]!) return false
  const bands = s.bandStart.length - 1
  const band = Math.min(bands - 1, Math.floor((z - b[1]!) / s.bandHeight))
  const p = s.outline
  const n = s.count
  let inside = false
  for (let k = s.bandStart[band]!; k < s.bandStart[band + 1]!; k++) {
    const i = s.bandEdges[k]!
    const j = i + 1 === n ? 0 : i + 1
    const zi = p[i * 2 + 1]!
    const zj = p[j * 2 + 1]!
    if (zi > z !== zj > z) {
      const xi = p[i * 2]!
      const xc = xi + ((z - zi) / (zj - zi)) * (p[j * 2]! - xi)
      if (x < xc) inside = !inside
    }
  }
  return inside
}

function sameMatrix(a: Float64Array, b: Float32Array, o: number): boolean {
  for (let i = 0; i < 12; i++) if (a[i] !== b[o + i]) return false
  return true
}

function report(state: WaterBodiesState, key: string, fn: () => void): void {
  if (state.reported.has(key)) return
  state.reported.add(key)
  fn()
}

/** Re-reads a body's component values and outline (on change only). */
function refresh(
  world: World,
  state: WaterBodiesState,
  record: WaterBodyRecord,
  matrix: Float32Array,
  row: number,
): void {
  const body = world.get(record.entity, WaterBody)
  const m = record.matrix
  for (let i = 0; i < 12; i++) m[i] = matrix[row * 12 + i]!
  record.kind = body.kind
  record.level = m[7]!
  record.priority = body.priority
  record.opticsRef = body.optics as AssetRef | null
  record.windOwn = body.wind === 'own'
  record.windSpeed = body.windSpeed
  record.windDirection = [...body.windDirection] as [number, number, number]
  record.problem = null
  record.shape = null
  const spline = world.tryGet(record.entity, WaterSpline)
  record.hasSpline = spline !== undefined
  try {
    if (spline) {
      if (!spline.closed) {
        throw badSpline(
          record.entity,
          'its outline is open',
          'Lakes and bounded oceans need closed: true (rivers come with 0097 part 2).',
        )
      }
      record.shape = buildShape(record.entity, spline.points, m)
    } else if (record.kind === 'lake') {
      throw badSpline(
        record.entity,
        'a lake needs a closed water/WaterSpline',
        'Add water/WaterSpline with at least 3 points around the lake.',
      )
    }
  } catch (error) {
    if (!(error instanceof ShardError)) throw error
    record.problem = error
    report(state, `${record.entity}:${error.message}`, () =>
      world.tryResource(LogResource)?.error(error),
    )
  }
}

/** Resolves a record's optics, warning once when it has none. */
function opticsOf(world: World, state: WaterBodiesState, record: WaterBodyRecord): void {
  const { value, missing } = resolveOptics(world, record.opticsRef)
  record.missingOptics = missing
  record.opticsLoading = value === undefined
  record.optics = value ?? WATER_OPTICS_PRESETS.clear
  if (missing) {
    report(state, `${record.entity}:no-optics`, () =>
      world
        .tryResource(LogResource)
        ?.log('warn', `Water body ${record.entity} has no optics; using clear`, {
          code: 'water/no-optics',
          hint: 'Set water/WaterBody.optics to a *.water.json asset, or a preset such as { "path": "water/ocean.water.json" }.',
        }),
    )
  }
}

const zero = (): WaterBodyRecord => ({
  entity: -1 as Entity,
  kind: 'ocean',
  level: 0,
  priority: 0,
  shape: null,
  optics: WATER_OPTICS_PRESETS.clear,
  opticsRef: null,
  missingOptics: false,
  opticsLoading: false,
  windOwn: false,
  windSpeed: 0,
  windDirection: [1, 0, 0],
  matrix: new Float64Array(12),
  hasSpline: false,
  seen: -1,
  problem: null,
})

/** Ground edits kept for the info texture before it refills everything instead. */
const MAX_GROUND_EDITS = 64
const corner = new Float64Array(3)
let editRt: HeightfieldRuntime | undefined

/** One terrain edit's rectangle (terrain frame) into terrainState's groundEdits, in the world. */
function addGroundEdit(x0: number, z0: number, x1: number, z1: number): void {
  const s = terrainState!
  if (s.groundEdits.length >= MAX_GROUND_EDITS * 4) {
    s.groundRefresh = true
    s.groundEdits.length = 0
  }
  if (s.groundRefresh) return
  let minX = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxZ = -Infinity
  for (let c = 0; c < 4; c++) {
    editRt!.frame.pointToOrigin(c & 1 ? x1 : x0, 0, c & 2 ? z1 : z0, corner)
    minX = Math.min(minX, corner[0]!)
    maxX = Math.max(maxX, corner[0]!)
    minZ = Math.min(minZ, corner[2]!)
    maxZ = Math.max(maxZ, corner[2]!)
  }
  s.groundEdits.push(minX, minZ, maxX, maxZ)
}

let terrainState: WaterBodiesState | undefined
function collectTerrain(rt: HeightfieldRuntime): void {
  const s = terrainState!
  // Streaming: its coarse levels are on the CPU, so every point on it has a height.
  if (!rt.ready || !rt.streaming || !rt.layout || !rt.pages) return
  if (s.terrainCount < s.terrains.length) s.terrains[s.terrainCount] = rt
  else s.terrains.push(rt)
  s.terrainCount++
  // Its rebakes, and its frame (a moved terrain, or the floating origin moving under it).
  const m = rt.frame.toOrigin
  s.terrainVersion += rt.version + 1 + m[3]! + m[7]! + m[11]!
  // Its edits since last frame (0104): only the ground under them refills.
  const seen = s.editSeen.get(rt)
  if (seen !== undefined && seen !== rt.editLog.seq) {
    editRt = rt
    if (!rt.editLog.since(seen, addGroundEdit)) s.groundRefresh = true
    editRt = undefined
  }
  s.editSeen.set(rt, rt.editLog.seq)
}

/** Whether `a` draws before `b`: lower priority first, then the lower entity. */
const before = (a: WaterBodyRecord, b: WaterBodyRecord) =>
  a.priority < b.priority || (a.priority === b.priority && a.entity < b.entity)

/**
 * Gathers WaterBody entities each frame (after transforms): re-reads a body when it or its outline
 * changed, sorts them by priority, and bumps `version` when what the info texture holds changes.
 * Allocates nothing while nothing changes.
 */
export const gatherWaterBodies = defineSystem({
  name: 'water/bodies',
  description:
    'Gathers WaterBody entities after transforms: outlines (tessellated, triangulated) on change, optics, priority order, and the terrains under them.',
  setup: (world): { bodies: Query } => ({
    bodies: world.query({ with: [WaterBody, GlobalTransform] }),
  }),
  run: (s, world, ctx) => {
    const state = world.resource(WaterBodies)
    const frame = ++state.frame
    let changed = false
    let seen = 0
    for (const table of s.bodies.tables) {
      if (table.count === 0) continue
      const matrix = table.column(GlobalTransform, 'matrix') as Float32Array
      const hasSpline = table.has(WaterSpline)
      for (let row = 0; row < table.count; row++) {
        const entity = table.entities[row]!
        let record = state.records.get(entity)
        const fresh = record === undefined
        if (!record) {
          record = zero()
          record.entity = entity
          state.records.set(entity, record)
        }
        if (
          fresh ||
          table.isChanged(WaterBody, row, ctx.lastRunTick) ||
          (hasSpline && table.isChanged(WaterSpline, row, ctx.lastRunTick)) ||
          hasSpline !== record.hasSpline ||
          !sameMatrix(record.matrix, matrix, row * 12)
        ) {
          refresh(world, state, record, matrix, row)
          opticsOf(world, state, record)
          changed = true
        } else if (record.opticsLoading) {
          opticsOf(world, state, record)
        }
        record.seen = frame
        seen++
      }
    }
    // Bodies that went away.
    if (state.records.size !== seen) {
      for (const [entity, record] of state.records) {
        if (record.seen !== frame) {
          state.records.delete(entity)
          changed = true
        }
      }
    }
    if (changed) {
      sortBodies(state)
      state.version++
    }
    // The terrains waterAt reads, and whether the ground under the water changed.
    const before = state.terrainVersion
    state.terrainCount = 0
    state.terrainVersion = 0
    const terrain = world.tryResource(TerrainWorld)
    if (terrain) {
      terrainState = state
      terrain.heightfields.forEach(collectTerrain)
      terrainState = undefined
    }
    if (before !== state.terrainVersion) state.version++
  },
})

/** Sorts drawn bodies (no problem) into `sorted`, and the summary fields. On change only. */
function sortBodies(state: WaterBodiesState): void {
  const list: WaterBodyRecord[] = []
  for (const r of state.records.values()) if (!r.problem) list.push(r)
  list.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))
  // Past MAX_WATER_BODIES, the highest priorities draw (describe reports how many didn't).
  const drawn = list.slice(Math.max(0, list.length - MAX_WATER_BODIES))
  state.skipped = list.length - drawn.length
  state.sorted.length = 0
  state.sorted.push(...drawn)
  state.count = drawn.length
  state.unbounded = false
  state.farLevel = 0
  state.lowest = Infinity
  state.bounds.set([Infinity, Infinity, -Infinity, -Infinity])
  for (const r of drawn) {
    state.lowest = Math.min(state.lowest, r.level)
    if (!r.shape) {
      // The last unbounded body drawn is the one on top far away.
      state.unbounded = true
      state.farLevel = r.level
      continue
    }
    const b = r.shape.bounds
    state.bounds[0] = Math.min(state.bounds[0]!, b[0]!)
    state.bounds[1] = Math.min(state.bounds[1]!, b[1]!)
    state.bounds[2] = Math.max(state.bounds[2]!, b[2]!)
    state.bounds[3] = Math.max(state.bounds[3]!, b[3]!)
  }
  if (state.count === 0) state.lowest = 0
}
