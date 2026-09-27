import {
  ChildOf,
  Children,
  defineComponent,
  defineSystem,
  type Entity,
  t,
  type World,
} from '@aethervtt/shard-core'

export const ComputedVisibility = defineComponent(
  'render/ComputedVisibility',
  {
    visible: t.bool({
      default: true,
      readonly: true,
      description: 'Final visibility after inheritance.',
    }),
  },
  {
    description: 'Computed from Visibility and the parent chain each frame. Do not write.',
    serialize: false,
  },
)

export const Visibility = defineComponent(
  'render/Visibility',
  {
    mode: t.enum(['inherit', 'visible', 'hidden'], {
      description:
        "'inherit' follows the parent; 'visible' shows even under a hidden parent; 'hidden' hides this and inheriting children.",
    }),
  },
  {
    description: 'Whether this entity (and inheriting children) is drawn.',
    requires: [ComputedVisibility],
  },
)

const MODE_VISIBLE = 1
const MODE_HIDDEN = 2

/** Roots take their own mode; children resolve 'inherit' from the parent, depth-first. */
export const computeVisibility = defineSystem({
  name: 'render/compute-visibility',
  description: 'Resolves Visibility modes through the hierarchy into ComputedVisibility.',
  setup: (world) => ({ roots: world.query({ with: [Visibility], without: [ChildOf] }) }),
  run: ({ roots }, world) => {
    for (const table of roots.tables) {
      const modes = table.column(Visibility, 'mode')
      const out = table.column(ComputedVisibility, 'visible')
      const children = table.has(Children) ? table.column(Children, 'entities') : undefined
      // Only rows whose visibility flips are marked, so consumers can skip unchanged tables.
      for (let i = 0; i < table.count; i++) {
        const visible = modes[i] !== MODE_HIDDEN
        const value = visible ? 1 : 0
        if (out[i] !== value) {
          out[i] = value
          table.markChanged(ComputedVisibility, i)
        }
        const list = children?.[i]
        if (list) walk(world, list, visible)
      }
    }
  },
})

function walk(world: World, list: readonly (Entity | null)[], parentVisible: boolean): void {
  for (let k = 0; k < list.length; k++) {
    const child = list[k]
    if (child === null || child === undefined) continue
    const table = world.entityTableUnchecked(child)
    const row = world.entityRowUnchecked(child)
    let visible = parentVisible
    if (table.has(Visibility)) {
      const mode = table.column(Visibility, 'mode')[row]
      visible = mode === MODE_HIDDEN ? false : mode === MODE_VISIBLE ? true : parentVisible
      const out = table.column(ComputedVisibility, 'visible')
      if (out[row] !== (visible ? 1 : 0)) {
        out[row] = visible ? 1 : 0
        table.markChanged(ComputedVisibility, row)
      }
    }
    if (table.has(Children)) {
      const grandchildren = table.column(Children, 'entities')[row]
      if (grandchildren) walk(world, grandchildren, visible)
    }
  }
}
