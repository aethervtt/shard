import {
  affine64,
  ChildOf,
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type Entity,
  quat,
  ShardError,
  type Table,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Transform } from './components'

/**
 * Large-world coordinates (spec 0040). A position in a grid is `GridCell × cellSize + translation`:
 * the cell is an exact integer, and the f32 translation stays small. `GlobalTransform` is relative
 * to the `FloatingOrigin` entity's cell, so everything near the camera is precise.
 */
export const Grid = defineComponent(
  'transform/Grid',
  {
    cellSize: t.f64({
      default: 2000,
      min: 1,
      unit: 'm',
      description:
        'Edge length of one cell. Children store their position as a cell plus an offset.',
    }),
    hysteresis: t.f32({
      default: 100,
      min: 0,
      unit: 'm',
      description:
        'How far past the half-cell an entity may go before it moves to the next cell, so it does not flip back and forth.',
    }),
  },
  {
    description:
      'A frame for large worlds. Direct children carry GridCell; a nested grid is a Grid with a GridCell in its parent grid.',
    requires: [Transform],
  },
)

export const GridCell = defineComponent(
  'transform/GridCell',
  {
    cell: t.ivec3({
      description:
        'Integer cell in the parent grid. Position = cell × Grid.cellSize + Transform.translation.',
    }),
  },
  {
    description:
      'The cell of a direct child of a Grid. Moved automatically when the translation leaves the cell.',
    requires: [Transform],
  },
)

export const FloatingOrigin = defineTag('transform/FloatingOrigin', {
  description:
    'At most one per world, usually the camera. GlobalTransform is relative to its grid cell, so everything near it is precise.',
})

export interface OriginShiftData {
  /** The origin grid after the shift (null for the root frame). */
  grid: Entity | null
  /** oldCell − newCell, when the origin stayed in the same grid; zero when it changed grids. */
  delta: [number, number, number]
  /** Metres to add to a position in the old origin frame to get it in the new one. */
  offset: [number, number, number]
}

/**
 * Sent (and triggered for observers) when the origin frame moves: the origin entity changed cells or
 * grids. Anything that keeps positions from `GlobalTransform` across frames adds `offset` to them.
 */
export const OriginShift = defineEvent<OriginShiftData>('transform/OriginShift', {
  description:
    'The floating origin moved to another cell or grid. Add offset to positions cached from GlobalTransform.',
})

// --- frames ----------------------------------------------------------------------

const ROOT = -1 as Entity

/**
 * Each grid's frame relative to the origin: `origin = A · ((cell − ref) × cellSize + p)` for a point
 * `p` in cell `cell`. `ref` is a cell near the origin, so the cell difference is exact integer math
 * and `A`'s translation stays small. Slot 0 is the root frame (entities with no grid ancestor).
 */
export class GridFrames {
  /** Grid entity per slot (ROOT for slot 0). */
  entity: Entity[] = [ROOT]
  /** f64 affine per slot (12 each). */
  a = new Float64Array(12 * 16)
  /** Reference cell per slot (3 each). */
  ref = new Int32Array(3 * 16)
  cellSize = new Float64Array(16)
  /** The grid's own frame → origin, rounded to f32 (its GlobalTransform). */
  frame32 = new Float32Array(12 * 16)
  /** 1 when the slot's A or ref changed this frame: everything under it re-propagates. */
  moved = new Uint8Array(16)
  /** Solve stamp per slot; a slot is current when it equals `stamp`. */
  solved = new Uint32Array(16)
  /** Seen stamp per slot, to drop slots of despawned grids. */
  seen = new Uint32Array(16)
  count = 1
  stamp = 1
  readonly slotOf = new Map<Entity, number>()
  /** Origin grid slot and cell. */
  originSlot = 0
  originCell = new Int32Array(3)
  originEntity: Entity = ROOT
  /** Whether any grid or origin is active; false means the root frame is the identity. */
  active = false
  /** True when slot 0 (root frame) is exactly the identity. */
  rootIdentity = true
  /**
   * Some grid sits under an ordinary entity, whose transform change detection can't see cheaply,
   * so every frame solves in full.
   */
  indirect = false

  constructor() {
    affine64.identityAt(this.a, 0)
    identity32(this.frame32, 0)
  }

  slot(grid: Entity): number {
    let s = this.slotOf.get(grid)
    if (s !== undefined) return s
    s = this.count++
    if (s >= this.cellSize.length) this.grow()
    this.slotOf.set(grid, s)
    this.entity[s] = grid
    this.solved[s] = 0
    this.moved[s] = 1
    // A new slot has no previous frame to compare against; NaN guarantees it reads as moved.
    this.a[s * 12] = Number.NaN
    return s
  }

  private grow(): void {
    const n = this.cellSize.length * 2
    const a = new Float64Array(n * 12)
    a.set(this.a)
    this.a = a
    const ref = new Int32Array(n * 3)
    ref.set(this.ref)
    this.ref = ref
    const cs = new Float64Array(n)
    cs.set(this.cellSize)
    this.cellSize = cs
    const f = new Float32Array(n * 12)
    f.set(this.frame32)
    this.frame32 = f
    const moved = new Uint8Array(n)
    moved.set(this.moved)
    this.moved = moved
    const solved = new Uint32Array(n)
    solved.set(this.solved)
    this.solved = solved
    const seen = new Uint32Array(n)
    seen.set(this.seen)
    this.seen = seen
  }

  /** Drops slots whose grid no longer exists. Rare: only when grids despawn. */
  compact(): void {
    let w = 1
    this.slotOf.clear()
    for (let s = 1; s < this.count; s++) {
      if (this.seen[s] !== this.stamp) continue
      if (w !== s) {
        this.entity[w] = this.entity[s]!
        this.a.copyWithin(w * 12, s * 12, s * 12 + 12)
        this.ref.copyWithin(w * 3, s * 3, s * 3 + 3)
        this.cellSize[w] = this.cellSize[s]!
        this.frame32.copyWithin(w * 12, s * 12, s * 12 + 12)
        this.moved[w] = 1
        this.solved[w] = this.solved[s]!
        this.seen[w] = this.seen[s]!
      }
      this.slotOf.set(this.entity[w]!, w)
      w++
    }
    this.count = w
    this.entity.length = w
  }
}

/** The grid frames the propagation system solved this frame. Read by physics and the renderer. */
export const GridFramesResource = defineResource<GridFrames>('transform/GridFrames', {
  description: 'Grid frames relative to the floating origin, solved during transform propagation.',
  init: () => new GridFrames(),
})

function identity32(out: Float32Array, o: number): void {
  for (let i = 0; i < 12; i++) out[o + i] = 0
  out[o] = 1
  out[o + 5] = 1
  out[o + 10] = 1
}

// --- placement ----------------------------------------------------------------

/** Where an entity sits: the grid it's in (ROOT for none), its cell there, and the f64 affine
 * from the entity's frame to `cell × cellSize` in that grid. */
export interface Placement {
  grid: Entity
  cell: Int32Array
  m: Float64Array
  /** How many entities' transforms were composed (1 for a direct child of the grid). */
  depth: number
}

export const createPlacement = (): Placement => ({
  grid: ROOT,
  cell: new Int32Array(3),
  m: affine64.create(),
  depth: 0,
})

const trs64 = new Float64Array(12)

function parentOf(world: World, e: Entity): Entity {
  const table = world.entityTableUnchecked(e)
  if (!table.has(ChildOf)) return ROOT
  const p = table.column(ChildOf, 'parent')[world.entityRowUnchecked(e)]!
  return p >= 0 && world.isAlive(p as Entity) ? (p as Entity) : ROOT
}

export function isGrid(world: World, e: Entity): boolean {
  return e !== ROOT && world.entityTableUnchecked(e).has(Grid)
}

/** Local TRS of `e` into `out` (f64). Identity for entities without Transform. */
function localTRS(world: World, e: Entity, out: Float64Array): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(Transform)) {
    affine64.identity(out)
    return
  }
  const row = world.entityRowUnchecked(e)
  affine64.fromTRSAt(
    out,
    0,
    table.column(Transform, 'translation'),
    row * 3,
    table.column(Transform, 'rotation'),
    row * 4,
    table.column(Transform, 'scale'),
    row * 3,
  )
}

function readCell(world: World, e: Entity, out: Int32Array): void {
  const table = world.entityTableUnchecked(e)
  if (!table.has(GridCell)) {
    out[0] = out[1] = out[2] = 0
    return
  }
  const c = table.column(GridCell, 'cell')
  const o = world.entityRowUnchecked(e) * 3
  out[0] = c[o]!
  out[1] = c[o + 1]!
  out[2] = c[o + 2]!
}

/**
 * Walks up from `e` (including its own transform when `self` is true) to its nearest grid, composing
 * transforms in f64. The direct child of that grid contributes its cell.
 */
export function placementOf(world: World, e: Entity, out: Placement, self = true): Placement {
  affine64.identity(out.m)
  out.cell[0] = out.cell[1] = out.cell[2] = 0
  let cur = e
  let first = true
  out.depth = 0
  for (;;) {
    if (self || !first) {
      localTRS(world, cur, trs64)
      affine64.multiply(out.m, trs64, out.m)
      out.depth++
    }
    first = false
    const parent = parentOf(world, cur)
    if (parent === ROOT) {
      out.grid = ROOT
      return out
    }
    if (isGrid(world, parent)) {
      out.grid = parent
      readCell(world, cur, out.cell)
      return out
    }
    cur = parent
  }
}

// --- solving ------------------------------------------------------------------

const place = createPlacement()
const inv64 = new Float64Array(12)
const tmp64 = new Float64Array(12)
const chain: Entity[] = []

function cellSizeOf(world: World, grid: Entity): number {
  if (grid === ROOT) return 0
  const table = world.entityTableUnchecked(grid)
  return table.column(Grid, 'cellSize')[world.entityRowUnchecked(grid)]!
}

/**
 * Finds the origin: the grid holding the `FloatingOrigin` entity and its cell. Sets slot 0 or the
 * origin grid's slot to the identity with `ref` = the origin cell.
 */
function solveOrigin(world: World, frames: GridFrames, origin: Entity): void {
  if (origin === ROOT || !world.isAlive(origin)) {
    frames.originSlot = 0
    frames.originEntity = ROOT
    frames.originCell[0] = frames.originCell[1] = frames.originCell[2] = 0
    return
  }
  frames.originEntity = origin
  placementOf(world, origin, place, !isGrid(world, origin))
  if (isGrid(world, origin)) {
    // A grid carrying the tag: the origin is its own cell in its parent grid.
    const parent = parentOf(world, origin)
    place.grid = isGrid(world, parent) ? parent : ROOT
    readCell(world, origin, place.cell)
  }
  frames.originSlot = place.grid === ROOT ? 0 : frames.slot(place.grid)
  frames.originCell[0] = place.cell[0]!
  frames.originCell[1] = place.cell[1]!
  frames.originCell[2] = place.cell[2]!
}

function setSolved(
  frames: GridFrames,
  s: number,
  a: Float64Array,
  rx: number,
  ry: number,
  rz: number,
) {
  const o = s * 12
  const prev = frames.a
  let changed =
    frames.ref[s * 3] !== rx || frames.ref[s * 3 + 1] !== ry || frames.ref[s * 3 + 2] !== rz
  for (let i = 0; i < 12 && !changed; i++) if (prev[o + i] !== a[i]) changed = true
  if (changed) {
    for (let i = 0; i < 12; i++) prev[o + i] = a[i]!
    frames.ref[s * 3] = rx
    frames.ref[s * 3 + 1] = ry
    frames.ref[s * 3 + 2] = rz
    // The grid's own frame: A · translate(−ref × cellSize).
    const cs = frames.cellSize[s]!
    affine64.translateAt(tmp64, 0, a, 0, -rx * cs, -ry * cs, -rz * cs)
    for (let i = 0; i < 12; i++) frames.frame32[o + i] = tmp64[i]!
  }
  frames.moved[s] = changed ? 1 : 0
  frames.solved[s] = frames.stamp
}

const solveA = new Float64Array(12)

/**
 * Solves slot `s` (grid `grid`), recursively solving what it depends on. Grids above the origin grid
 * solve upward from it; every other grid solves down from its parent grid.
 */
function solveSlot(world: World, frames: GridFrames, s: number, depth: number): void {
  if (frames.solved[s] === frames.stamp) return
  if (depth > 64) {
    throw new ShardError('transform/grid-cycle', 'Grids nest more than 64 deep, or form a cycle', {
      hint: 'Check the ChildOf chain of your Grid entities.',
    })
  }
  const grid = frames.entity[s]!
  frames.cellSize[s] = cellSizeOf(world, grid)
  // Is this grid an ancestor of the origin grid? Then its frame comes from the child below it.
  const below = childTowardOrigin(world, frames, grid)
  if (below !== undefined) {
    const bs = frames.slot(below)
    solveSlot(world, frames, bs, depth + 1)
    // A_P = A_G · T(−ref_G · cs_G) · M_G⁻¹, ref_P = g
    placementOf(world, below, place, true)
    const bcs = frames.cellSize[bs]!
    const bo = bs * 3
    affine64.translateAt(
      solveA,
      0,
      frames.a,
      bs * 12,
      -frames.ref[bo]! * bcs,
      -frames.ref[bo + 1]! * bcs,
      -frames.ref[bo + 2]! * bcs,
    )
    if (!affine64.invert(inv64, place.m)) affine64.identity(inv64)
    affine64.multiply(solveA, solveA, inv64)
    setSolved(frames, s, solveA, place.cell[0]!, place.cell[1]!, place.cell[2]!)
    return
  }
  if (s === frames.originSlot) {
    affine64.identity(solveA)
    setSolved(
      frames,
      s,
      solveA,
      frames.originCell[0]!,
      frames.originCell[1]!,
      frames.originCell[2]!,
    )
    return
  }
  // Down from the parent grid: A_C = A_P · T((g − ref_P) · cs_P) · M_C, ref_C = 0.
  placementOf(world, grid, place, true)
  if (place.depth > 1) frames.indirect = true
  const ps = place.grid === ROOT ? 0 : frames.slot(place.grid)
  solveSlot(world, frames, ps, depth + 1)
  // The recursion reused `place`.
  placementOf(world, grid, place, true)
  const pcs = frames.cellSize[ps]!
  const po = ps * 3
  affine64.translateAt(
    solveA,
    0,
    frames.a,
    ps * 12,
    (place.cell[0]! - frames.ref[po]!) * pcs,
    (place.cell[1]! - frames.ref[po + 1]!) * pcs,
    (place.cell[2]! - frames.ref[po + 2]!) * pcs,
  )
  affine64.multiply(solveA, solveA, place.m)
  setSolved(frames, s, solveA, 0, 0, 0)
}

/**
 * If `grid` (ROOT for the root frame) is a strict ancestor frame of the origin grid, the grid (one
 * level down, toward the origin) that sits directly in it. Otherwise undefined.
 */
function childTowardOrigin(world: World, frames: GridFrames, grid: Entity): Entity | undefined {
  if (frames.originSlot === 0) return undefined
  // chain = origin grid, its parent grid, ... (built once per solve in solveGrids)
  for (let i = 0; i < chain.length; i++) {
    const parent = i + 1 < chain.length ? chain[i + 1]! : ROOT
    if (parent === grid) return chain[i]!
  }
  void world
  return undefined
}

function buildChain(world: World, frames: GridFrames): void {
  chain.length = 0
  if (frames.originSlot === 0) return
  let g = frames.entity[frames.originSlot]!
  for (let i = 0; i < 64 && g !== ROOT; i++) {
    chain.push(g)
    placementOf(world, g, place, true)
    if (place.depth > 1) frames.indirect = true
    g = place.grid
  }
}

/** Whether no grid was added, removed, moved, resized, or reparented since `since`. */
function gridsUnchanged(gridTables: readonly Table[], since: number): boolean {
  for (let t = 0; t < gridTables.length; t++) {
    const table = gridTables[t]!
    if (table.lastStructural > since) return false
    if (table.count === 0) continue
    if (table.lastChanged(Transform) > since || table.lastChanged(Grid) > since) return false
    if (table.has(GridCell) && table.lastChanged(GridCell) > since) return false
  }
  return true
}

/**
 * Solves every grid's frame for this frame. `gridTables` are the tables holding grids (from the
 * propagation system's query); `origin` is the FloatingOrigin entity or ROOT. Returns whether the
 * origin frame shifted, with the shift written into `shift`. When nothing that affects the frames
 * changed since `since` (pass -1 to force), it only checks the origin's cell.
 */
export function solveGrids(
  world: World,
  frames: GridFrames,
  gridTables: readonly Table[],
  origin: Entity,
  shift: OriginShiftData,
  since = -1,
): boolean {
  frames.stamp++
  const prevSlot = frames.originSlot
  const prevGrid = prevSlot === 0 ? ROOT : frames.entity[prevSlot]!
  const px = frames.originCell[0]!
  const py = frames.originCell[1]!
  const pz = frames.originCell[2]!
  const prevCs = frames.cellSize[prevSlot]!
  const wasActive = frames.active

  if (
    since >= 0 &&
    wasActive &&
    !frames.indirect &&
    origin === frames.originEntity &&
    gridsUnchanged(gridTables, since)
  ) {
    solveOrigin(world, frames, origin)
    if (
      frames.originSlot === prevSlot &&
      frames.originCell[0] === px &&
      frames.originCell[1] === py &&
      frames.originCell[2] === pz
    ) {
      frames.moved.fill(0, 0, frames.count)
      return false
    }
  }
  frames.indirect = false

  frames.seen[0] = frames.stamp
  for (let t = 0; t < gridTables.length; t++) {
    const table = gridTables[t]!
    const list = table.entities
    for (let i = 0; i < table.count; i++)
      frames.seen[frames.slot(list[i]! as Entity)] = frames.stamp
  }
  solveOrigin(world, frames, origin)
  if (frames.originSlot !== 0) frames.seen[frames.originSlot] = frames.stamp
  let stale = false
  for (let s = 1; s < frames.count; s++) if (frames.seen[s] !== frames.stamp) stale = true
  if (stale) {
    const originGrid = frames.originSlot === 0 ? ROOT : frames.entity[frames.originSlot]!
    frames.compact()
    frames.originSlot = originGrid === ROOT ? 0 : frames.slot(originGrid)
  }
  buildChain(world, frames)

  // Root frame first (slot 0 has cell size 0), then every grid.
  frames.cellSize[0] = 0
  solveSlot(world, frames, 0, 0)
  for (let s = 1; s < frames.count; s++) solveSlot(world, frames, s, 0)
  frames.active = true
  const a = frames.a
  frames.rootIdentity =
    a[0] === 1 &&
    a[1] === 0 &&
    a[2] === 0 &&
    a[3] === 0 &&
    a[4] === 0 &&
    a[5] === 1 &&
    a[6] === 0 &&
    a[7] === 0 &&
    a[8] === 0 &&
    a[9] === 0 &&
    a[10] === 1 &&
    a[11] === 0

  // Did the origin frame move?
  const nextGrid = frames.originSlot === 0 ? ROOT : frames.entity[frames.originSlot]!
  const nx = frames.originCell[0]!
  const ny = frames.originCell[1]!
  const nz = frames.originCell[2]!
  if (!wasActive) return false
  if (nextGrid === prevGrid) {
    if (nx === px && ny === py && nz === pz) return false
    shift.grid = nextGrid === ROOT ? null : nextGrid
    shift.delta[0] = px - nx
    shift.delta[1] = py - ny
    shift.delta[2] = pz - nz
    shift.offset[0] = shift.delta[0] * prevCs
    shift.offset[1] = shift.delta[1] * prevCs
    shift.offset[2] = shift.delta[2] * prevCs
    return true
  }
  // Changed grids: where the old origin point lands in the new frame.
  shift.grid = nextGrid === ROOT ? null : nextGrid
  shift.delta[0] = shift.delta[1] = shift.delta[2] = 0
  const os = prevGrid === ROOT ? 0 : frames.slotOf.get(prevGrid)
  if (os === undefined || (prevGrid !== ROOT && !world.isAlive(prevGrid))) {
    shift.offset[0] = shift.offset[1] = shift.offset[2] = 0
    return true
  }
  const cs = frames.cellSize[os]!
  const r = os * 3
  const ao = os * 12
  // origin_new = A_old · ((prevCell − ref) · cs)
  const x = (px - frames.ref[r]!) * cs
  const y = (py - frames.ref[r + 1]!) * cs
  const z = (pz - frames.ref[r + 2]!) * cs
  shift.offset[0] = a[ao]! * x + a[ao + 1]! * y + a[ao + 2]! * z + a[ao + 3]!
  shift.offset[1] = a[ao + 4]! * x + a[ao + 5]! * y + a[ao + 6]! * z + a[ao + 7]!
  shift.offset[2] = a[ao + 8]! * x + a[ao + 9]! * y + a[ao + 10]! * z + a[ao + 11]!
  return true
}

/** Back to "no grids": the root frame is the identity. Returns whether anything changed. */
export function resetGrids(frames: GridFrames): boolean {
  if (!frames.active) {
    frames.moved[0] = 0
    return false
  }
  frames.active = false
  frames.count = 1
  frames.entity.length = 1
  frames.slotOf.clear()
  frames.originSlot = 0
  frames.originEntity = ROOT
  frames.originCell.fill(0)
  const wasIdentity = frames.rootIdentity
  affine64.identityAt(frames.a, 0)
  identity32(frames.frame32, 0)
  frames.rootIdentity = true
  frames.moved[0] = wasIdentity ? 0 : 1
  return !wasIdentity
}

// --- f64 helpers (cold paths) -------------------------------------------------

/** Frames solved fresh for helpers, so they're right even between propagations. */
const helperFrames = new GridFrames()
const helperPlace = createPlacement()
const helperShift: OriginShiftData = { grid: null, delta: [0, 0, 0], offset: [0, 0, 0] }

function findOrigin(world: World): Entity {
  const q = world.query({ with: [FloatingOrigin] })
  for (let t = 0; t < q.tables.length; t++) {
    const table = q.tables[t]!
    if (table.count > 0) return table.entities[0]! as Entity
  }
  return ROOT
}

function solveHelper(world: World): GridFrames {
  helperFrames.active = false
  solveGrids(
    world,
    helperFrames,
    world.query({ with: [Grid] }).tables,
    findOrigin(world),
    helperShift,
  )
  return helperFrames
}

/** Slot of `grid` in `frames` (0 for ROOT). */
function slotIn(frames: GridFrames, grid: Entity): number {
  return grid === ROOT ? 0 : frames.slot(grid)
}

/**
 * The f64 affine from `e`'s own frame to the origin frame (its exact GlobalTransform). Solves grids
 * fresh, so it's valid right after spawning or moving things. Cold path.
 */
export function originMatrix64(world: World, e: Entity, out: Float64Array): Float64Array {
  const frames = solveHelper(world)
  placementOf(world, e, helperPlace, true)
  const s = slotIn(frames, helperPlace.grid)
  const cs = frames.cellSize[s]!
  const r = s * 3
  affine64.translateAt(
    out,
    0,
    frames.a,
    s * 12,
    (helperPlace.cell[0]! - frames.ref[r]!) * cs,
    (helperPlace.cell[1]! - frames.ref[r + 1]!) * cs,
    (helperPlace.cell[2]! - frames.ref[r + 2]!) * cs,
  )
  affine64.multiply(out, out, helperPlace.m)
  return out
}

const m64 = new Float64Array(12)
const frameInv = new Float64Array(12)
const p3 = new Float64Array(3)

/**
 * Position of `e` in `frame`'s coordinates (default: the origin frame), exact to f64. With a grid
 * as `frame`, the result is `cell × cellSize + offset` in that grid.
 */
export function worldPosition64(
  world: World,
  e: Entity,
  out: Float64Array,
  frame?: Entity,
): Float64Array {
  if (frame === undefined) {
    originMatrix64(world, e, m64)
    out[0] = m64[3]!
    out[1] = m64[7]!
    out[2] = m64[11]!
    return out
  }
  placementOf(world, e, helperPlace, true)
  if (helperPlace.grid === frame) {
    const cs = cellSizeOf(world, frame)
    out[0] = helperPlace.cell[0]! * cs + helperPlace.m[3]!
    out[1] = helperPlace.cell[1]! * cs + helperPlace.m[7]!
    out[2] = helperPlace.cell[2]! * cs + helperPlace.m[11]!
    return out
  }
  originMatrix64(world, e, m64)
  p3[0] = m64[3]!
  p3[1] = m64[7]!
  p3[2] = m64[11]!
  // Into the frame: x = ref·cs + A⁻¹·origin (or the frame entity's local frame if it isn't a grid).
  if (isGrid(world, frame)) {
    const s = slotIn(helperFrames, frame)
    const cs = helperFrames.cellSize[s]!
    affine64.copyAt(frameInv, 0, helperFrames.a, s * 12)
    if (!affine64.invert(frameInv, frameInv)) affine64.identity(frameInv)
    affine64.transformPoint(out, frameInv, p3)
    out[0] = out[0]! + helperFrames.ref[s * 3]! * cs
    out[1] = out[1]! + helperFrames.ref[s * 3 + 1]! * cs
    out[2] = out[2]! + helperFrames.ref[s * 3 + 2]! * cs
    return out
  }
  originMatrix64(world, frame, frameInv)
  if (!affine64.invert(frameInv, frameInv)) affine64.identity(frameInv)
  affine64.transformPoint(out, frameInv, p3)
  return out
}

const pa = createPlacement()
const pb = createPlacement()
const va = new Float64Array(3)
const vb = new Float64Array(3)

/**
 * Distance between two entities, exact at any distance from the origin: entities in the same grid
 * subtract cells as integers first.
 */
export function distance64(world: World, a: Entity, b: Entity): number {
  placementOf(world, a, pa, true)
  placementOf(world, b, pb, true)
  if (pa.grid === pb.grid) {
    const cs = pa.grid === ROOT ? 0 : cellSizeOf(world, pa.grid)
    const dx = (pa.cell[0]! - pb.cell[0]!) * cs + (pa.m[3]! - pb.m[3]!)
    const dy = (pa.cell[1]! - pb.cell[1]!) * cs + (pa.m[7]! - pb.m[7]!)
    const dz = (pa.cell[2]! - pb.cell[2]!) * cs + (pa.m[11]! - pb.m[11]!)
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  worldPosition64(world, a, va)
  worldPosition64(world, b, vb)
  const dx = va[0]! - vb[0]!
  const dy = va[1]! - vb[1]!
  const dz = va[2]! - vb[2]!
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function assertGrid(world: World, grid: Entity): void {
  if (!world.isAlive(grid) || !world.has(grid, Grid)) {
    throw new ShardError('transform/not-a-grid', `Entity ${grid} is not a Grid`, {
      hint: 'Pass an entity that has the transform/Grid component.',
    })
  }
}

/**
 * Puts `e` at `position` (f64, in `grid`'s frame) as a direct child of `grid`: sets its cell,
 * translation, and parent.
 */
export function placeInGrid(world: World, e: Entity, grid: Entity, position: ArrayLike<number>) {
  assertGrid(world, grid)
  const cs = cellSizeOf(world, grid)
  const cx = Math.round(position[0]! / cs)
  const cy = Math.round(position[1]! / cs)
  const cz = Math.round(position[2]! / cs)
  const translation: [number, number, number] = [
    position[0]! - cx * cs,
    position[1]! - cy * cs,
    position[2]! - cz * cs,
  ]
  if (parentOf(world, e) !== grid) world.add(e, ChildOf, { parent: grid })
  if (world.has(e, Transform)) world.set(e, Transform, { translation })
  else world.add(e, Transform, { translation })
  world.add(e, GridCell, { cell: [cx, cy, cz] })
}

const pose64 = new Float64Array(12)
const local64 = new Float64Array(12)
const basis = [new Float64Array(3), new Float64Array(3), new Float64Array(3)] as const

/**
 * Moves `e` into `grid` (as a direct child) keeping its pose in the origin frame, e.g. a ship
 * entering a planet's rotating grid. Computes the new cell and transform in f64.
 */
export function reparentToGrid(world: World, e: Entity, grid: Entity): void {
  assertGrid(world, grid)
  originMatrix64(world, e, pose64)
  const frames = helperFrames // solved by originMatrix64
  const s = slotIn(frames, grid)
  const cs = frames.cellSize[s]!
  affine64.copyAt(frameInv, 0, frames.a, s * 12)
  if (!affine64.invert(frameInv, frameInv)) affine64.identity(frameInv)
  affine64.multiply(local64, frameInv, pose64)
  // local64 translation is relative to the grid's ref cell.
  const rx = frames.ref[s * 3]!
  const ry = frames.ref[s * 3 + 1]!
  const rz = frames.ref[s * 3 + 2]!
  const kx = Math.round(local64[3]! / cs)
  const ky = Math.round(local64[7]! / cs)
  const kz = Math.round(local64[11]! / cs)
  const translation: [number, number, number] = [
    local64[3]! - kx * cs,
    local64[7]! - ky * cs,
    local64[11]! - kz * cs,
  ]
  const scale: [number, number, number] = [0, 0, 0]
  for (let c = 0; c < 3; c++) {
    const x = local64[c]!
    const y = local64[4 + c]!
    const z = local64[8 + c]!
    const len = Math.sqrt(x * x + y * y + z * z) || 1
    scale[c] = len
    const axis = basis[c]!
    axis[0] = x / len
    axis[1] = y / len
    axis[2] = z / len
  }
  const rotation = quat.fromBasis([0, 0, 0, 1], basis[0], basis[1], basis[2]) as [
    number,
    number,
    number,
    number,
  ]
  if (parentOf(world, e) !== grid) world.add(e, ChildOf, { parent: grid })
  world.add(e, Transform, { translation, rotation, scale })
  world.add(e, GridCell, { cell: [rx + kx, ry + ky, rz + kz] })
}

/** The grid `e` is directly in (its parent, when that's a Grid), or undefined. */
export function gridOf(world: World, e: Entity): Entity | undefined {
  const p = parentOf(world, e)
  return p !== ROOT && isGrid(world, p) ? p : undefined
}
