import {
  affine,
  ChildOf,
  Children,
  defineComponent,
  defineSystem,
  defineSystemSet,
  type Entity,
  type Infer,
  onAdd,
  onRemove,
  onSet,
  PostUpdate,
  quat,
  type Table,
  t,
  vec3,
  type World,
} from '@shard/core'
import { definePlugin } from '@shard/runtime'

export const GlobalTransform = defineComponent(
  'core/GlobalTransform',
  {
    matrix: t.affine3x4({
      readonly: true,
      description: 'World matrix (top three rows, row by row). Computed from Transform each frame.',
    }),
  },
  {
    description: 'World-space transform. Computed by core/transform-propagate; do not write.',
    serialize: false,
  },
)

export const Transform = defineComponent(
  'core/Transform',
  {
    translation: t.vec3({ unit: 'm', description: 'Position relative to the parent (or world).' }),
    rotation: t.quat({ description: 'Rotation relative to the parent, as a unit quaternion.' }),
    scale: t.vec3({ default: [1, 1, 1], description: 'Scale along local axes.' }),
  },
  {
    description:
      'Local transform. Y is up, -Z is forward. In 2D, translation.z orders layers and rotation is around Z.',
    requires: [GlobalTransform],
  },
)

export type TransformValue = Infer<typeof Transform>

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
}

interface Walk {
  world: World
  since: number
  tick: number
  cache: (TableColumns | undefined)[]
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
  description: 'Computes GlobalTransform from Transform and the parent hierarchy.',
  setup: (world) => ({
    roots: world.query({ with: [Transform, GlobalTransform], without: [ChildOf] }),
    walk: { world, since: 0, tick: 0, cache: [] } as Walk,
  }),
  run: ({ roots, walk }, world, ctx) => {
    walk.since = ctx.lastRunTick
    walk.tick = world.tick
    const since = walk.since
    const tick = walk.tick
    const tables = roots.tables
    for (let ti = 0; ti < tables.length; ti++) {
      const table = tables[ti]!
      const n = table.count
      if (n === 0) continue
      const c = columnsOf(walk, table)
      const tr = c.translation!
      const ro = c.rotation!
      const sc = c.scale!
      const g = c.global!
      const changed = c.changed!
      const globalChanged = c.globalChanged!
      const children = c.children
      for (let i = 0; i < n; i++) {
        const dirty = changed[i]! > since
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
        }
        if (children !== undefined) {
          const list = children[i]
          if (list) propagateChildren(walk, list, g, i * 12, dirty)
        }
      }
    }
  },
})

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
      if (dirty) c.globalChanged![row] = walk.tick
    }
    const grandchildren = c.children?.[row]
    if (grandchildren) propagateChildren(walk, grandchildren, matrix, offset, dirty)
  }
}

/** Reparenting changes what a local transform means, so treat it as a transform change. */
function markTransformChanged({ entity, world }: { entity: Entity; world: World }): void {
  if (!world.has(entity, Transform)) return
  world.entityTable(entity).markChanged(Transform, world.entityRow(entity))
}

export const TransformPlugin = definePlugin({
  name: 'core/transform',
  build(app) {
    app.addSystems(PostUpdate, propagateTransforms.inSet(TransformSystems))
    app.world.observe(onAdd(ChildOf), markTransformChanged)
    app.world.observe(onSet(ChildOf), markTransformChanged)
    app.world.observe(onRemove(ChildOf), markTransformChanged)
  },
})
