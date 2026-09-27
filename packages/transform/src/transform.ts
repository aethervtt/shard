import {
  affine,
  ChildOf,
  Children,
  defineSystem,
  defineSystemSet,
  type Entity,
  onAdd,
  onRemove,
  onSet,
  PostUpdate,
  quat,
  type Table,
  vec3,
  type World,
} from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform, type TransformValue } from './components'
import {
  FloatingOrigin,
  Grid,
  GridCell,
  type GridFrames,
  GridFramesResource,
  OriginShift,
  type OriginShiftData,
  resetGrids,
  solveGrids,
} from './grid'

export { GlobalTransform, Transform, type TransformValue }

/** Transform propagation runs in this set, in PostUpdate. Order systems that read world matrices after it. */
export const TransformSystems = defineSystemSet('core/TransformSystems')

/** A `Transform` value for 2D: position, angle in radians around Z, uniform or per-axis scale. */
export function transform2d(
  options: {
    x?: number
    y?: number
    z?: number
    angle?: number
    scale?: number | [number, number]
  } = {},
): TransformValue {
  const { x = 0, y = 0, z = 0, angle = 0, scale = 1 } = options
  const [sx, sy] = typeof scale === 'number' ? [scale, scale] : scale
  return {
    translation: [x, y, z],
    rotation: [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)],
    scale: [sx, sy, 1],
  }
}

/** A rotation that makes something at `from` face `target` (its -Z toward the target). */
export function lookAt(
  from: ArrayLike<number>,
  target: ArrayLike<number>,
  up: ArrayLike<number> = [0, 1, 0],
): [number, number, number, number] {
  const forward = vec3.sub([0, 0, 0], target, from)
  return quat.lookRotation([0, 0, 0, 1], forward, up) as [number, number, number, number]
}

/** World-space position from `GlobalTransform`. Cold path. */
export function worldPosition(world: World, entity: Entity): [number, number, number] {
  const table = world.entityTable(entity)
  const matrix = table.column(GlobalTransform, 'matrix')
  return affine.getTranslationAt([0, 0, 0], matrix, world.entityRow(entity) * 12) as [
    number,
    number,
    number,
  ]
}

const scratch = affine.create()

/** Columns of one table, looked up once per propagation run instead of once per entity. */
interface TableColumns {
  stamp: number
  hasTransform: boolean
  hasGlobal: boolean
  translation: Float32Array | undefined
  rotation: Float32Array | undefined
  scale: Float32Array | undefined
  changed: Uint32Array | undefined
  global: Float32Array | undefined
  globalChanged: Uint32Array | undefined
  children: ((Entity | null)[] | undefined)[] | undefined
  isGrid: boolean
  cell: Int32Array | undefined
  cellChanged: Uint32Array | undefined
}

interface Walk {
  world: World
  since: number
  tick: number
  cache: (TableColumns | undefined)[]
  frames: GridFrames
}

function columnsOf(walk: Walk, table: Table): TableColumns {
  let c = walk.cache[table.id]
  if (!c) {
    c = {
      stamp: -1,
      hasTransform: false,
      hasGlobal: false,
      translation: undefined,
      rotation: undefined,
      scale: undefined,
      changed: undefined,
      global: undefined,
      globalChanged: undefined,
      children: undefined,
      isGrid: false,
      cell: undefined,
      cellChanged: undefined,
    }
    walk.cache[table.id] = c
  }
  if (c.stamp !== walk.tick) {
    // Column arrays can be replaced when a table grows, so refresh once per run.
    c.stamp = walk.tick
    c.hasTransform = table.has(Transform)
    c.hasGlobal = table.has(GlobalTransform)
    c.translation = c.hasTransform ? table.column(Transform, 'translation') : undefined
    c.rotation = c.hasTransform ? table.column(Transform, 'rotation') : undefined
    c.scale = c.hasTransform ? table.column(Transform, 'scale') : undefined
    c.changed = c.hasTransform ? table.changedTicks(Transform) : undefined
    c.global = c.hasGlobal ? table.column(GlobalTransform, 'matrix') : undefined
    c.globalChanged = c.hasGlobal ? table.changedTicks(GlobalTransform) : undefined
    c.children = table.has(Children) ? table.column(Children, 'entities') : undefined
    c.isGrid = table.has(Grid)
    const hasCell = table.has(GridCell)
    c.cell = hasCell ? table.column(GridCell, 'cell') : undefined
    c.cellChanged = hasCell ? table.changedTicks(GridCell) : undefined
  }
  return c
}

/**
 * Computes `GlobalTransform` from `Transform` and the `ChildOf` hierarchy. Roots are a hot loop over
 * columns; children are walked depth-first. Only entities whose transform (or an ancestor's)
 * changed since the last run are recomputed, so untouched subtrees keep their change ticks.
 */
export const propagateTransforms = defineSystem({
  name: 'core/transform-propagate',
  description:
    'Solves grid frames against the floating origin, then computes GlobalTransform from Transform and the parent hierarchy.',
  setup: (world) => ({
    roots: world.query({ with: [Transform, GlobalTransform], without: [ChildOf] }),
    grids: world.query({ with: [Grid] }),
    origins: world.query({ with: [FloatingOrigin] }),
    walk: {
      world,
      since: 0,
      tick: 0,
      cache: [],
      frames: world.initResource(GridFramesResource),
    } as Walk,
    shift: { grid: null, delta: [0, 0, 0], offset: [0, 0, 0] } as OriginShiftData,
  }),
  run: ({ roots, grids, origins, walk, shift }, world, ctx) => {
    walk.since = ctx.lastRunTick
    walk.tick = world.tick
    const since = walk.since
    const tick = walk.tick
    const frames = walk.frames
    // Grid frames: skipped entirely (one count per grid table) when there are no grids.
    let gridCount = 0
    for (let t = 0; t < grids.tables.length; t++) gridCount += grids.tables[t]!.count
    if (gridCount > 0) {
      let origin = -1 as Entity
      for (let t = 0; t < origins.tables.length && origin < 0; t++) {
        const table = origins.tables[t]!
        if (table.count > 0) origin = table.entities[0]! as Entity
      }
      if (solveGrids(world, frames, grids.tables, origin, shift, since)) {
        const data: OriginShiftData = {
          grid: shift.grid,
          delta: [shift.delta[0], shift.delta[1], shift.delta[2]],
          offset: [shift.offset[0], shift.offset[1], shift.offset[2]],
        }
        world.send(OriginShift, data)
        world.trigger(OriginShift, data)
      }
    } else resetGrids(frames)
    const rootIdentity = frames.rootIdentity
    const rootMoved = frames.moved[0] === 1
    const rootFrame = frames.frame32

    const tables = roots.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const n = table.count
      if (n === 0) continue
      const c = columnsOf(walk, table)
      if (c.isGrid) {
        propagateGridRows(walk, table, c)
        continue
      }
      const tr = c.translation!
      const ro = c.rotation!
      const sc = c.scale!
      const g = c.global!
      const changed = c.changed!
      const globalChanged = c.globalChanged!
      const children = c.children
      let moved = false
      if (!rootIdentity) {
        // The origin is in a grid, so the root frame is offset: compose with its matrix.
        for (let i = 0; i < n; i++) {
          const dirty = rootMoved || changed[i]! > since
          if (dirty) {
            affine.fromTRSAt(scratch, 0, tr, i * 3, ro, i * 4, sc, i * 3)
            affine.multiplyAt(g, i * 12, rootFrame, 0, scratch, 0)
            globalChanged[i] = tick
            moved = true
          }
          if (children !== undefined) {
            const list = children[i]
            if (list) propagateChildren(walk, list, g, i * 12, dirty)
          }
        }
        if (moved) table.touch(GlobalTransform)
        continue
      }
      for (let i = 0; i < n; i++) {
        const dirty = rootMoved || changed[i]! > since
        if (dirty) {
          // affine.fromTRSAt, inlined: this loop runs for every root that moved.
          const i3 = i * 3
          const i4 = i * 4
          const o = i * 12
          const x = ro[i4]!
          const y = ro[i4 + 1]!
          const z = ro[i4 + 2]!
          const w = ro[i4 + 3]!
          const sx = sc[i3]!
          const sy = sc[i3 + 1]!
          const sz = sc[i3 + 2]!
          const x2 = x + x
          const y2 = y + y
          const z2 = z + z
          const xx = x * x2
          const yy = y * y2
          const zz = z * z2
          const xy = x * y2
          const xz = x * z2
          const yz = y * z2
          const wx = w * x2
          const wy = w * y2
          const wz = w * z2
          g[o] = (1 - yy - zz) * sx
          g[o + 1] = (xy - wz) * sy
          g[o + 2] = (xz + wy) * sz
          g[o + 3] = tr[i3]!
          g[o + 4] = (xy + wz) * sx
          g[o + 5] = (1 - xx - zz) * sy
          g[o + 6] = (yz - wx) * sz
          g[o + 7] = tr[i3 + 1]!
          g[o + 8] = (xz - wy) * sx
          g[o + 9] = (yz + wx) * sy
          g[o + 10] = (1 - xx - yy) * sz
          g[o + 11] = tr[i3 + 2]!
          globalChanged[i] = tick
          moved = true
        }
        if (children !== undefined) {
          const list = children[i]
          if (list) propagateChildren(walk, list, g, i * 12, dirty)
        }
      }
      if (moved) table.touch(GlobalTransform)
    }
  },
})

/** Rows of a grid table reached as roots: each grid's GlobalTransform is its solved frame. */
function propagateGridRows(walk: Walk, table: Table, c: TableColumns): void {
  const frames = walk.frames
  const g = c.global!
  const globalChanged = c.globalChanged!
  const children = c.children
  let moved = false
  for (let i = 0; i < table.count; i++) {
    const slot = frames.slotOf.get(table.entities[i]! as Entity)
    if (slot === undefined) continue
    const dirty = frames.moved[slot] === 1
    if (dirty) {
      affine.copyAt(g, i * 12, frames.frame32, slot * 12)
      globalChanged[i] = walk.tick
      moved = true
    }
    if (children !== undefined) {
      const list = children[i]
      if (list) propagateGridChildren(walk, list, slot, dirty)
    }
  }
  if (moved) table.touch(GlobalTransform)
}

/**
 * Direct children of a grid: `GlobalTransform = A · ((cell − ref) × cellSize + TRS)`, with the cell
 * difference taken in integers and the product in f64, then rounded to f32. Deeper descendants go
 * through the ordinary f32 path.
 */
function propagateGridChildren(
  walk: Walk,
  list: readonly (Entity | null)[],
  slot: number,
  gridDirty: boolean,
): void {
  const world = walk.world
  const frames = walk.frames
  for (let k = 0; k < list.length; k++) {
    const child = list[k]
    if (child === null || child === undefined) continue
    const table = world.entityTableUnchecked(child)
    const row = world.entityRowUnchecked(child)
    const c = columnsOf(walk, table)
    if (c.isGrid) {
      // A nested grid: its frame was solved with the others.
      const s = frames.slotOf.get(child)
      if (s === undefined) continue
      const dirty = frames.moved[s] === 1
      if (dirty && c.hasGlobal) {
        affine.copyAt(c.global!, row * 12, frames.frame32, s * 12)
        c.globalChanged![row] = walk.tick
        table.touch(GlobalTransform)
      }
      const grandchildren = c.children?.[row]
      if (grandchildren) propagateGridChildren(walk, grandchildren, s, dirty)
      continue
    }
    if (!c.hasGlobal) {
      const grandchildren = c.children?.[row]
      if (grandchildren) {
        propagateChildren(walk, grandchildren, frames.frame32, slot * 12, gridDirty)
      }
      continue
    }
    let dirty = gridDirty
    if (c.hasTransform) dirty ||= c.changed![row]! > walk.since
    if (c.cellChanged !== undefined) dirty ||= c.cellChanged[row]! > walk.since
    if (dirty) {
      writeGridChild(frames, slot, c, row)
      c.globalChanged![row] = walk.tick
      table.touch(GlobalTransform)
    }
    const grandchildren = c.children?.[row]
    if (grandchildren) propagateChildren(walk, grandchildren, c.global!, row * 12, dirty)
  }
}

/** Writes one grid child's GlobalTransform from its grid's f64 frame. Allocation-free. */
function writeGridChild(frames: GridFrames, slot: number, c: TableColumns, row: number): void {
  const a = frames.a
  const ao = slot * 12
  const cs = frames.cellSize[slot]!
  const ref = frames.ref
  const r3 = slot * 3
  const cell = c.cell
  const o3 = row * 3
  let px = cell === undefined ? -ref[r3]! * cs : (cell[o3]! - ref[r3]!) * cs
  let py = cell === undefined ? -ref[r3 + 1]! * cs : (cell[o3 + 1]! - ref[r3 + 1]!) * cs
  let pz = cell === undefined ? -ref[r3 + 2]! * cs : (cell[o3 + 2]! - ref[r3 + 2]!) * cs
  let l00 = 1
  let l01 = 0
  let l02 = 0
  let l10 = 0
  let l11 = 1
  let l12 = 0
  let l20 = 0
  let l21 = 0
  let l22 = 1
  if (c.hasTransform) {
    const tr = c.translation!
    const ro = c.rotation!
    const sc = c.scale!
    const o4 = row * 4
    px += tr[o3]!
    py += tr[o3 + 1]!
    pz += tr[o3 + 2]!
    const x = ro[o4]!
    const y = ro[o4 + 1]!
    const z = ro[o4 + 2]!
    const w = ro[o4 + 3]!
    const sx = sc[o3]!
    const sy = sc[o3 + 1]!
    const sz = sc[o3 + 2]!
    const x2 = x + x
    const y2 = y + y
    const z2 = z + z
    const xx = x * x2
    const yy = y * y2
    const zz = z * z2
    const xy = x * y2
    const xz = x * z2
    const yz = y * z2
    const wx = w * x2
    const wy = w * y2
    const wz = w * z2
    l00 = (1 - yy - zz) * sx
    l01 = (xy - wz) * sy
    l02 = (xz + wy) * sz
    l10 = (xy + wz) * sx
    l11 = (1 - xx - zz) * sy
    l12 = (yz - wx) * sz
    l20 = (xz - wy) * sx
    l21 = (yz + wx) * sy
    l22 = (1 - xx - yy) * sz
  }
  const g = c.global!
  const o = row * 12
  for (let r = 0; r < 3; r++) {
    const a0 = a[ao + r * 4]!
    const a1 = a[ao + r * 4 + 1]!
    const a2 = a[ao + r * 4 + 2]!
    g[o + r * 4] = a0 * l00 + a1 * l10 + a2 * l20
    g[o + r * 4 + 1] = a0 * l01 + a1 * l11 + a2 * l21
    g[o + r * 4 + 2] = a0 * l02 + a1 * l12 + a2 * l22
    g[o + r * 4 + 3] = a0 * px + a1 * py + a2 * pz + a[ao + r * 4 + 3]!
  }
}

function propagateChildren(
  walk: Walk,
  list: readonly (Entity | null)[],
  parent: Float32Array,
  parentOffset: number,
  parentDirty: boolean,
): void {
  const world = walk.world
  for (let k = 0; k < list.length; k++) {
    const child = list[k]
    // Children lists only hold live entities (despawn removes them), so skip the liveness check.
    if (child === null || child === undefined) continue
    const table = world.entityTableUnchecked(child)
    const row = world.entityRowUnchecked(child)
    const c = columnsOf(walk, table)
    if (c.isGrid) {
      // A grid under an ordinary entity: its frame was solved with the others.
      const frames = walk.frames
      const s = frames.slotOf.get(child)
      if (s === undefined) continue
      const moved = frames.moved[s] === 1
      if (moved) {
        affine.copyAt(c.global!, row * 12, frames.frame32, s * 12)
        c.globalChanged![row] = walk.tick
        table.touch(GlobalTransform)
      }
      const inside = c.children?.[row]
      if (inside) propagateGridChildren(walk, inside, s, moved)
      continue
    }
    let dirty = parentDirty
    let matrix = parent
    let offset = parentOffset
    if (c.hasGlobal) {
      matrix = c.global!
      offset = row * 12
      if (c.hasTransform) {
        dirty ||= c.changed![row]! > walk.since
        if (dirty) {
          affine.fromTRSAt(
            scratch,
            0,
            c.translation!,
            row * 3,
            c.rotation!,
            row * 4,
            c.scale!,
            row * 3,
          )
          affine.multiplyAt(matrix, offset, parent, parentOffset, scratch, 0)
        }
      } else if (dirty) {
        // No local transform: inherit the parent's world matrix unchanged.
        affine.copyAt(matrix, offset, parent, parentOffset)
      }
      if (dirty) {
        c.globalChanged![row] = walk.tick
        table.touch(GlobalTransform)
      }
    }
    const grandchildren = c.children?.[row]
    if (grandchildren) propagateChildren(walk, grandchildren, matrix, offset, dirty)
  }
}

const subtreeScratch = affine.create()

/**
 * Recomputes `GlobalTransform` for `entity` and everything under it from its parent's current
 * world matrix, for systems that change local transforms after propagation (IK). Marks the
 * matrices changed this tick. Allocation-free.
 */
export function propagateSubtree(world: World, entity: Entity): void {
  if (!world.isAlive(entity)) return
  const table = world.entityTableUnchecked(entity)
  if (!table.has(GlobalTransform)) return
  const row = world.entityRowUnchecked(entity)
  const g = table.column(GlobalTransform, 'matrix')
  let parent: Entity = -1 as Entity
  if (table.has(ChildOf)) parent = table.column(ChildOf, 'parent')[row]! as Entity
  const frames = world.tryResource(GridFramesResource)
  if (parent >= 0 && world.isAlive(parent)) {
    const pt = world.entityTableUnchecked(parent)
    const slot = frames?.active && pt.has(Grid) ? frames.slotOf.get(parent) : undefined
    if (slot !== undefined) {
      // A direct child of a grid: from the grid's f64 frame, like propagation does.
      writeGridChild(frames!, slot, subtreeColumns(table), row)
      table.changedTicks(GlobalTransform)[row] = world.tick
      table.touch(GlobalTransform)
      subtreeChildren(world, table, row, g, row * 12)
      return
    }
    if (pt.has(GlobalTransform)) {
      subtreeNode(
        world,
        table,
        row,
        pt.column(GlobalTransform, 'matrix'),
        world.entityRowUnchecked(parent) * 12,
      )
      return
    }
  }
  // A root: its world matrix is its local one, in the root frame.
  if (table.has(Transform)) {
    affine.fromTRSAt(
      g,
      row * 12,
      table.column(Transform, 'translation'),
      row * 3,
      table.column(Transform, 'rotation'),
      row * 4,
      table.column(Transform, 'scale'),
      row * 3,
    )
    if (frames && !frames.rootIdentity) {
      affine.copyAt(subtreeScratch, 0, g, row * 12)
      affine.multiplyAt(g, row * 12, frames.frame32, 0, subtreeScratch, 0)
    }
  }
  table.changedTicks(GlobalTransform)[row] = world.tick
  table.touch(GlobalTransform)
  subtreeChildren(world, table, row, g, row * 12)
}

/** Column view for writeGridChild outside a propagation run (cold). */
function subtreeColumns(table: Table): TableColumns {
  const hasTransform = table.has(Transform)
  const hasCell = table.has(GridCell)
  return {
    stamp: -1,
    hasTransform,
    hasGlobal: true,
    translation: hasTransform ? table.column(Transform, 'translation') : undefined,
    rotation: hasTransform ? table.column(Transform, 'rotation') : undefined,
    scale: hasTransform ? table.column(Transform, 'scale') : undefined,
    changed: undefined,
    global: table.column(GlobalTransform, 'matrix'),
    globalChanged: undefined,
    children: undefined,
    isGrid: false,
    cell: hasCell ? table.column(GridCell, 'cell') : undefined,
    cellChanged: undefined,
  }
}

function subtreeNode(
  world: World,
  table: Table,
  row: number,
  parent: Float32Array,
  parentOffset: number,
): void {
  if (!table.has(GlobalTransform)) return
  const g = table.column(GlobalTransform, 'matrix')
  const o = row * 12
  if (table.has(Transform)) {
    affine.fromTRSAt(
      subtreeScratch,
      0,
      table.column(Transform, 'translation'),
      row * 3,
      table.column(Transform, 'rotation'),
      row * 4,
      table.column(Transform, 'scale'),
      row * 3,
    )
    affine.multiplyAt(g, o, parent, parentOffset, subtreeScratch, 0)
  } else {
    affine.copyAt(g, o, parent, parentOffset)
  }
  table.changedTicks(GlobalTransform)[row] = world.tick
  table.touch(GlobalTransform)
  subtreeChildren(world, table, row, g, o)
}

function subtreeChildren(
  world: World,
  table: Table,
  row: number,
  matrix: Float32Array,
  offset: number,
): void {
  if (!table.has(Children)) return
  const list = table.column(Children, 'entities')[row] as (Entity | null)[] | undefined
  if (!list) return
  for (let k = 0; k < list.length; k++) {
    const child = list[k]
    if (child === null || child === undefined) continue
    subtreeNode(
      world,
      world.entityTableUnchecked(child),
      world.entityRowUnchecked(child),
      matrix,
      offset,
    )
  }
}

/** Reparenting changes what a local transform means, so treat it as a transform change. */
function markTransformChanged({ entity, world }: { entity: Entity; world: World }): void {
  if (!world.has(entity, Transform)) return
  world.entityTable(entity).markChanged(Transform, world.entityRow(entity))
}

/**
 * Moves grid children whose translation left their cell (past half a cell plus the grid's
 * hysteresis) by whole cells: `cell += k`, `translation -= k × cellSize`. The position doesn't
 * change, so nothing jumps. Only entities whose Transform changed are looked at.
 */
export const recenterGridCells = defineSystem({
  name: 'transform/recenter',
  description:
    'Moves grid children to the neighboring cell when their translation leaves the cell.',
  setup: (world) => ({ cells: world.query({ with: [GridCell, Transform, ChildOf] }) }),
  run: ({ cells }, world, ctx) => {
    const since = ctx.lastRunTick
    for (let t = 0; t < cells.tables.length; t++) {
      const table = cells.tables[t]!
      if (table.count === 0 || table.lastChanged(Transform) <= since) continue
      const ticks = table.changedTicks(Transform)
      const tr = table.column(Transform, 'translation')
      const cell = table.column(GridCell, 'cell')
      const parents = table.column(ChildOf, 'parent')
      for (let row = 0; row < table.count; row++) {
        if (ticks[row]! <= since) continue
        const parent = parents[row]! as Entity
        if (parent < 0 || !world.isAlive(parent)) continue
        const pt = world.entityTableUnchecked(parent)
        if (!pt.has(Grid)) continue
        const pr = world.entityRowUnchecked(parent)
        const cs = pt.column(Grid, 'cellSize')[pr]!
        const limit = cs / 2 + pt.column(Grid, 'hysteresis')[pr]!
        const o = row * 3
        let moved = false
        for (let axis = 0; axis < 3; axis++) {
          const v = tr[o + axis]!
          if (v <= limit && v >= -limit) continue
          const k = Math.round(v / cs)
          cell[o + axis] = cell[o + axis]! + k
          tr[o + axis] = v - k * cs
          moved = true
        }
        if (moved) {
          table.markChanged(Transform, row)
          table.markChanged(GridCell, row)
        }
      }
    }
  },
})

export const TransformPlugin = definePlugin({
  name: 'core/transform',
  provides: [
    // transforms and large-world grids
    GlobalTransform,
    Transform,
    FloatingOrigin,
    Grid,
    GridCell,
    GridFramesResource,
    OriginShift,
  ],
  build(app) {
    app.world.initResource(GridFramesResource)
    app.addSystems(
      PostUpdate,
      recenterGridCells.inSet(TransformSystems).before(propagateTransforms),
    )
    app.addSystems(PostUpdate, propagateTransforms.inSet(TransformSystems))
    app.world.observe(onAdd(ChildOf), markTransformChanged)
    app.world.observe(onSet(ChildOf), markTransformChanged)
    app.world.observe(onRemove(ChildOf), markTransformChanged)
  },
})
