import {
  ChildOf,
  Children,
  defineComponent,
  defineSystem,
  defineTag,
  type Entity,
  type Table,
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
    shadowOnly: t.bool({
      readonly: true,
      description: 'Not visible, but drawn in shadow views (shadow-only after inheritance).',
    }),
    proxied: t.bool({
      readonly: true,
      description:
        'Drawn by a proxy (DrawnByProxy on this entity or an ancestor, 0073): no instance slot at all.',
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
    mode: t.enum(['inherit', 'visible', 'hidden', 'shadow-only'], {
      description:
        "'inherit' follows the parent; 'visible' shows even under a hidden parent; 'hidden' hides this and inheriting children; 'shadow-only' hides this and inheriting children from cameras but keeps them in shadow views, unless a parent is hidden (0116).",
    }),
  },
  {
    description: 'Whether this entity (and inheriting children) is drawn.',
    requires: [ComputedVisibility],
  },
)

/**
 * Tag (0073): another entity draws this one and its subtree, an HLOD proxy for a cell. Inherited
 * like `hidden`, whatever the modes below say, and stronger: a proxied mesh gives up its instance
 * slot, so it costs nothing a frame, where a hidden one still costs its slot.
 */
export const DrawnByProxy = defineTag('render/DrawnByProxy', {
  description:
    'Drawn by a proxy (HLOD, 0073): this subtree gives up its instance slots and occludes nothing.',
  serialize: false,
})

const MODE_VISIBLE = 1
const MODE_HIDDEN = 2
const MODE_SHADOW_ONLY = 3

// Resolved states: hidden, visible, or drawn only in shadow views.
const HIDDEN = 0
const VISIBLE = 1
const SHADOW_ONLY = 2
// Drawn by a proxy (0073): hidden, and no instance slot. Nothing below overrides it.
const PROXIED = 3

/** A mode's state under a parent in state `parent`. Shadow-only follows a hidden parent (0116). */
function resolve(mode: number, parent: number): number {
  if (parent === PROXIED) return PROXIED
  if (mode === MODE_HIDDEN) return HIDDEN
  if (mode === MODE_VISIBLE) return VISIBLE
  if (mode === MODE_SHADOW_ONLY) return parent === HIDDEN ? HIDDEN : SHADOW_ONLY
  return parent
}

/** Writes a row's state, marking it changed only when it flips. */
function store(table: Table, row: number, state: number): void {
  const visible = table.column(ComputedVisibility, 'visible')
  const shadowOnly = table.column(ComputedVisibility, 'shadowOnly')
  const proxied = table.column(ComputedVisibility, 'proxied')
  const v = state === VISIBLE ? 1 : 0
  const s = state === SHADOW_ONLY ? 1 : 0
  const p = state === PROXIED ? 1 : 0
  if (visible[row] !== v || shadowOnly[row] !== s || proxied[row] !== p) {
    visible[row] = v
    shadowOnly[row] = s
    proxied[row] = p
    table.markChanged(ComputedVisibility, row)
  }
}

/**
 * Roots take their own mode; children resolve 'inherit' from the parent, depth-first. A root
 * without Visibility (a structure group, a scene root) counts as visible, so modes under it apply.
 * DrawnByProxy (0073) makes its entity and everything under it proxied.
 */
export const computeVisibility = defineSystem({
  name: 'render/compute-visibility',
  description: 'Resolves Visibility modes through the hierarchy into ComputedVisibility.',
  setup: (world) => ({
    roots: world.query({ with: [Visibility], without: [ChildOf] }),
    bare: world.query({ with: [Children], without: [ChildOf, Visibility] }),
    modes: world.query({ with: [Visibility] }),
    links: world.query({ with: [ChildOf] }),
    proxied: world.query({ with: [DrawnByProxy] }),
  }),
  run: ({ roots, bare, modes, links, proxied }, world, ctx) => {
    // Nothing to resolve unless a mode, a parent link, or what has them changed.
    const since = ctx.lastRunTick
    let changed = since === 0
    for (let t = 0; t < modes.tables.length && !changed; t++) {
      const table = modes.tables[t]!
      if (table.lastChanged(Visibility) > since || table.lastStructural > since) changed = true
    }
    for (let t = 0; t < links.tables.length && !changed; t++) {
      const table = links.tables[t]!
      if (table.lastChanged(ChildOf) > since || table.lastStructural > since) changed = true
    }
    // A tag added or removed moves its entity between tables: both are structural changes.
    for (let t = 0; t < proxied.tables.length && !changed; t++)
      if (proxied.tables[t]!.lastStructural > since) changed = true
    for (let t = 0; t < bare.tables.length && !changed; t++)
      if (bare.tables[t]!.lastStructural > since) changed = true
    if (!changed) return
    for (const table of bare.tables) {
      const children = table.column(Children, 'entities')
      const base = table.has(DrawnByProxy) ? PROXIED : VISIBLE
      for (let i = 0; i < table.count; i++) {
        const list = children[i]
        if (list) walk(world, list, base)
      }
    }
    for (const table of roots.tables) {
      const modes = table.column(Visibility, 'mode')
      const children = table.has(Children) ? table.column(Children, 'entities') : undefined
      const base = table.has(DrawnByProxy) ? PROXIED : VISIBLE
      // Only rows whose state flips are marked, so consumers can skip unchanged tables.
      for (let i = 0; i < table.count; i++) {
        const state = resolve(modes[i]!, base)
        store(table, i, state)
        const list = children?.[i]
        if (list) walk(world, list, state)
      }
    }
  },
})

function walk(world: World, list: readonly (Entity | null)[], parent: number): void {
  for (let k = 0; k < list.length; k++) {
    const child = list[k]
    if (child === null || child === undefined) continue
    const table = world.entityTableUnchecked(child)
    const row = world.entityRowUnchecked(child)
    let state = table.has(DrawnByProxy) ? PROXIED : parent
    if (table.has(Visibility)) {
      state = resolve(table.column(Visibility, 'mode')[row]!, state)
      store(table, row, state)
    }
    if (table.has(Children)) {
      const grandchildren = table.column(Children, 'entities')[row]
      if (grandchildren) walk(world, grandchildren, state)
    }
  }
}
