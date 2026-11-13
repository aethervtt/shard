import { defineResource, type Entity, type World } from '@aethervtt/shard-core'
import type { NavMoverState } from './steer'

// The movement-tier state nav's core reads (0115); navTiersPlugin installs and fills it.

const COARSE = 2

export const NavMovers = defineResource<NavMoverState>('nav/Movers', {
  description:
    "Movement tiers' runtime (0115): which agents nav/steer moves, their legs and tiers.",
})

/** The movement tier nav/steer moves an agent at ('crowd' when nav/agents' crowd does). */
export function navMoverTier(world: World, entity: Entity): 'crowd' | 'steer' | 'coarse' {
  const m = world.tryResource(NavMovers)?.movers.get(entity)
  return !m?.owned ? 'crowd' : m.tier === COARSE ? 'coarse' : 'steer'
}
