import { defineResource, type Entity, type World } from '@aethervtt/shard-core'
import { NavFlowField } from './components'
import type { NavFlowState } from './flow'

// The flow-field state nav's core reads (0115). The runtime that fills it is navTiersPlugin's, so
// apps without movement tiers don't bundle it: until that plugin installs, there's no state.

export const NavFlows = defineResource<NavFlowState>('nav/Flows', {
  description:
    'Flow field runtimes (0115): the field each NavFlowField entity built, and the polygon graphs.',
})

/** `entity` when it names a live NavFlowField, else -1 (NavAgent.flow). */
export function flowOf(world: World, entity: number): number {
  if (entity < 0 || !world.isAlive(entity as Entity) || !world.has(entity as Entity, NavFlowField))
    return -1
  return entity
}

/**
 * Where field `entity` leads: its built goal, or where it should lead before the first build. The
 * array is the field's own (or a scratch one): read it, don't keep it.
 */
export function flowGoal(world: World, entity: number): Float64Array {
  const f = world.tryResource(NavFlows)?.fields.get(entity as Entity)
  if (f) return f.cur ? f.cur.goal : f.want
  const v = world.get(entity as Entity, NavFlowField)
  unbuilt[0] = v.goal[0]
  unbuilt[1] = v.goal[1]
  unbuilt[2] = v.goal[2]
  return unbuilt
}

const unbuilt = new Float64Array(3)
