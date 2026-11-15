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
import { Camera3d, viewCamera } from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { type HeightfieldRuntime, TerrainWorld } from '@aethervtt/shard-terrain'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { WaterBody, type WaterKind, WaterSpline } from './components'
import { resolveOptics, WATER_OPTICS_PRESETS, type WaterOpticsValue } from './optics'
import { blendMouth, buildRiver, RIVER_STRIDE, type RiverShape, resetMouths } from './rivers'

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
  /** null: an ocean with no outline, everywhere (or a river: see `river`). */
  shape: WaterShape | null
  /** A river's centre line, banks, heights and flow (spec 0123). */
  river: RiverShape | null
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

/** Whether a body covers everything (an ocean with no outline). */
export const unboundedBody = (r: WaterBodyRecord) => r.shape === null && r.river === null

/** A body's bounds (minX, minZ, maxX, maxZ), or undefined when it covers everything. */
export function bodyBounds(r: WaterBodyRecord): Float64Array | undefined {
  return r.shape?.bounds ?? r.river?.bounds
}

/** Metres per cell of the grid `waterAt` finds bodies in (spec 0123). */
export const BODY_CELL = 64
/** A body covering more cells than this is tested everywhere instead (bounds first). */
const MAX_BODY_CELLS = 4096
/** The camera moves this far (m) before the drawn bodies are chosen again. */
export const CHOOSE_DISTANCE = 32

/** Every body this frame, in the order they draw: priority, then entity. */
export class WaterBodiesState {
  readonly records = new Map<Entity, WaterBodyRecord>()
  /** Every valid body (no problem), in priority order: what `waterAt` finds (spec 0123). */
  all: WaterBodyRecord[] = []
  /** Grid cell → indices into `all`, ascending; `wide` holds those everywhere (oceans, huge ones). */
  readonly grid = new Map<number, number[]>()
  wide: number[] = []
  /** Drawn bodies: at most MAX_WATER_BODIES of `all`, nearest the view camera, in priority order. */
  readonly sorted: WaterBodyRecord[] = []
  count = 0
  /** Valid bodies that don't draw: past MAX_WATER_BODIES, the farthest from the camera. */
  skipped = 0
  /** The camera position the drawn bodies were chosen at (NaN: none). */
  chosenX = Number.NaN
  chosenZ = Number.NaN
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
  record.river = null
  try {
    if (record.kind === 'river') {
      if (!spline || spline.closed) {
        throw badSpline(
          record.entity,
          spline ? 'a river’s spline is closed' : 'a river needs a water/WaterSpline',
          'Give it a water/WaterSpline with closed: false and points along its course (position, width, depth, flow).',
        )
      }
      record.river = buildRiver(record.entity, spline.points, m)
      let lowest = Infinity
      for (let i = 0; i < record.river.count; i++)
        lowest = Math.min(lowest, record.river.samples[i * RIVER_STRIDE + 2]!)
      record.level = lowest
    } else if (spline) {
      if (!spline.closed) {
        throw badSpline(
          record.entity,
          'its outline is open',
          'Lakes and bounded oceans need closed: true; a river is kind: river (0123).',
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
  river: null,
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
 * changed, sorts them by priority, chooses the ones that draw (nearest the view camera past
 * MAX_WATER_BODIES, 0123), and bumps `version` when what the info texture holds changes. Allocates
 * nothing while nothing changes.
 */
export const gatherWaterBodies = defineSystem({
  name: 'water/bodies',
  description:
    'Gathers WaterBody entities after transforms: outlines (tessellated, triangulated) on change, optics, priority order, and the terrains under them.',
  setup: (world): { bodies: Query; cameras: Query } => ({
    bodies: world.query({ with: [WaterBody, GlobalTransform] }),
    cameras: world.query({ with: [Camera3d, GlobalTransform] }),
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
    if (changed) sortBodies(state)
    // The drawn bodies: chosen again when the bodies change or the camera has moved (0123).
    const camera = viewCamera(s.cameras)
    let cx = Number.NaN
    let cz = Number.NaN
    if (camera !== undefined) {
      const m = world.entityTable(camera).column(GlobalTransform, 'matrix')
      const o = world.entityRow(camera) * 12
      cx = m[o + 3]!
      cz = m[o + 11]!
    }
    const dx = cx - state.chosenX
    const dz = cz - state.chosenZ
    const moved =
      Number.isNaN(cx) !== Number.isNaN(state.chosenX) ||
      dx * dx + dz * dz > CHOOSE_DISTANCE * CHOOSE_DISTANCE
    if (
      (changed || (moved && state.all.length > MAX_WATER_BODIES)) &&
      chooseBodies(state, cx, cz, changed)
    )
      changed = true
    if (changed) state.version++
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

/**
 * Sorts every valid body (no problem) into `all` by priority, eases rivers into the bodies they
 * run into, and grids them for `waterAt` (0123). On change only.
 */
function sortBodies(state: WaterBodiesState): void {
  const list: WaterBodyRecord[] = []
  for (const r of state.records.values()) if (!r.problem) list.push(r)
  list.sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0))
  state.all = list
  blendMouths(list)
  state.grid.clear()
  state.wide = []
  for (let i = 0; i < list.length; i++) {
    const b = bodyBounds(list[i]!)
    if (!b) {
      state.wide.push(i)
      continue
    }
    const c0 = Math.floor(b[0]! / BODY_CELL)
    const c1 = Math.floor(b[2]! / BODY_CELL)
    const r0 = Math.floor(b[1]! / BODY_CELL)
    const r1 = Math.floor(b[3]! / BODY_CELL)
    if ((c1 - c0 + 1) * (r1 - r0 + 1) > MAX_BODY_CELLS) {
      state.wide.push(i)
      continue
    }
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = cellKey(c, r)
        let cell = state.grid.get(key)
        if (!cell) {
          cell = []
          state.grid.set(key, cell)
        }
        cell.push(i)
      }
    }
  }
}

/** A grid cell's key: exact for cells within ±2^25 of the origin (2 000 000 km). */
export function cellKey(c: number, r: number): number {
  return (c + 2 ** 25) * 2 ** 26 + (r + 2 ** 25)
}

/** Each river's ends, eased into the highest-priority lake or ocean they lie in (0123). */
function blendMouths(all: WaterBodyRecord[]): void {
  for (const river of all) {
    const shape = river.river
    if (!shape) continue
    resetMouths(shape)
    for (const end of [0, 1] as const) {
      const o = (end === 0 ? 0 : shape.count - 1) * RIVER_STRIDE
      const x = shape.samples[o]!
      const z = shape.samples[o + 1]!
      for (let i = all.length - 1; i >= 0; i--) {
        const r = all[i]!
        if (r === river || r.river) continue
        if (r.shape === null || insideShape(r.shape, x, z)) {
          blendMouth(shape, end, r.level)
          break
        }
      }
    }
  }
}

const distances: number[] = []
const order: number[] = []

/**
 * Chooses the drawn bodies (0123): every valid body when MAX_WATER_BODIES hold them, else those
 * whose bounds are nearest the camera's (x, z) (unbounded ones at 0; without a camera, the highest
 * priorities), in priority order, and the summary fields. Returns whether the set changed.
 */
function chooseBodies(state: WaterBodiesState, cx: number, cz: number, force: boolean): boolean {
  state.chosenX = cx
  state.chosenZ = cz
  const all = state.all
  order.length = 0
  if (all.length <= MAX_WATER_BODIES) {
    for (let i = 0; i < all.length; i++) order.push(i)
  } else if (Number.isNaN(cx)) {
    for (let i = all.length - MAX_WATER_BODIES; i < all.length; i++) order.push(i)
  } else {
    distances.length = all.length
    for (let i = 0; i < all.length; i++) {
      const b = bodyBounds(all[i]!)
      if (!b) {
        distances[i] = 0
        continue
      }
      const dx = Math.max(b[0]! - cx, 0, cx - b[2]!)
      const dz = Math.max(b[1]! - cz, 0, cz - b[3]!)
      distances[i] = dx * dx + dz * dz
    }
    for (let i = 0; i < all.length; i++) order.push(i)
    order.sort((a, b) => distances[a]! - distances[b]! || b - a)
    order.length = MAX_WATER_BODIES
    order.sort((a, b) => a - b)
  }
  let same = order.length === state.count
  for (let i = 0; same && i < order.length; i++) same = state.sorted[i] === all[order[i]!]
  state.skipped = all.length - order.length
  if (same && !force) return false
  const drawn = order.map((i) => all[i]!)
  state.sorted.length = 0
  state.sorted.push(...drawn)
  state.count = drawn.length
  state.unbounded = false
  state.farLevel = 0
  state.lowest = Infinity
  state.bounds.set([Infinity, Infinity, -Infinity, -Infinity])
  for (const r of drawn) {
    state.lowest = Math.min(state.lowest, r.level)
    const b = bodyBounds(r)
    if (!b) {
      // The last unbounded body drawn is the one on top far away.
      state.unbounded = true
      state.farLevel = r.level
      continue
    }
    state.bounds[0] = Math.min(state.bounds[0]!, b[0]!)
    state.bounds[1] = Math.min(state.bounds[1]!, b[1]!)
    state.bounds[2] = Math.max(state.bounds[2]!, b[2]!)
    state.bounds[3] = Math.max(state.bounds[3]!, b[3]!)
  }
  if (state.count === 0) state.lowest = 0
  return true
}
