import {
  ChildOf,
  defineComponent,
  defineResource,
  defineSchema,
  type Entity,
  t,
  type World,
} from '@aethervtt/shard-core'
import { Mesh3d } from '@aethervtt/shard-render'

export const ScatterSurface = defineComponent(
  'scatter/ScatterSurface',
  {
    set: t.handle('scatter/ScatterSet', {
      description: 'The rules (*.scatter.json) to place on this mesh.',
    }),
    seed: t.u32({ description: 'Mixed into every rule: the same rules, other places.' }),
  },
  {
    description:
      'Scatters props and foliage on this entity’s mesh by a ScatterSet, as on a planet: items sit where a ray straight down (local −Y) meets the mesh. For flat levels; planets use Planet.scatter and Biome.scatter.',
    requires: [Mesh3d],
  },
)

export const Prop = defineComponent(
  'scatter/Prop',
  {
    index: t.u32({
      readonly: true,
      description:
        'Its stable id within its chunk (a lattice cell); the parent scatter/Chunk names the rule and chunk.',
    }),
  },
  {
    description:
      'A prop a ScatterSet placed, a child of its scatter/Chunk. Rebuilt when its chunk comes back in range; despawning it records it as removed (saved), so it stays gone.',
    serialize: false,
  },
)

export const ScatterChunk = defineComponent(
  'scatter/Chunk',
  {
    surface: t.entity({ readonly: true }),
    rule: t.string({ readonly: true, description: 'The rule’s id (set path, biome, name).' }),
    chunk: t.string({ readonly: true, description: 'face/depth/x/y on a planet, x/z on a mesh.' }),
  },
  {
    description:
      'The parent of one chunk of one rule’s props (scatter/Prop): rebuilt from the scatter rules, never saved.',
    serialize: false,
  },
)

/** A prop's rule, chunk and index (the rule and chunk from its parent scatter/Chunk). */
export function propIdentity(
  world: World,
  prop: Entity,
): { rule: string; chunk: string; index: number } | undefined {
  const p = world.tryGet(prop, Prop)
  const parent = world.tryGet(prop, ChildOf)?.parent
  if (!p || parent === undefined || parent === null) return undefined
  const c = world.tryGet(parent, ScatterChunk)
  if (!c) return undefined
  return { rule: c.rule, chunk: c.chunk, index: p.index }
}

export interface ScatterBudgetValue {
  /**
   * Props spawned per frame, at most (a chunk spawns over several frames when it has more). Each
   * costs a few microseconds of main-thread time with its LODs and collider: 250 keeps a frame
   * under a millisecond.
   */
  propsPerFrame: number
  /** Chunks of props that start placement per frame. */
  chunksPerFrame: number
  /** Placed chunks kept after they leave range, so walking back doesn't place them again. */
  cache: number
}

export const ScatterBudget = defineResource<ScatterBudgetValue>('scatter/Budget', {
  description: 'How much scatter work a frame may do, and how many placed chunks stay cached.',
  init: () => ({ propsPerFrame: 250, chunksPerFrame: 16, cache: 512 }),
})

const RemovedSchema = defineSchema('scatter/RemovedProps', {
  props: t.list(t.string, {
    description: 'Removed props as "rule|chunk|index" (chunk: face/depth/x/y, or x/z on a mesh).',
  }),
})

/** Props despawned by gameplay: saved (0038), and skipped when their chunk spawns again. */
export interface RemovedProps {
  /** "rule|chunk|index" keys (`removedKey`). */
  props: string[]
}

export const Removed = defineResource<RemovedProps>('scatter/Removed', {
  description:
    'Props the game removed (destroyed rocks, felled trees), by rule, chunk, and index: saved, so they stay gone however far the player travels.',
  schema: RemovedSchema as never,
  persist: true,
  init: () => ({ props: [] }),
})

/** The key a removed prop is recorded under. */
export function removedKey(rule: string, chunk: string, index: number): string {
  return `${rule}|${chunk}|${index}`
}

const lookups = new WeakMap<string[], Set<string>>()

/** Whether a prop was removed (a set per list, rebuilt when a load replaces the list). */
export function isRemoved(removed: RemovedProps, key: string): boolean {
  if (removed.props.length === 0) return false
  let set = lookups.get(removed.props)
  if (!set || set.size !== removed.props.length) {
    set = new Set(removed.props)
    lookups.set(removed.props, set)
  }
  return set.has(key)
}

/** Records a removed prop (once). */
export function addRemoved(removed: RemovedProps, key: string): void {
  if (isRemoved(removed, key)) return
  removed.props.push(key)
  lookups.get(removed.props)?.add(key)
}
