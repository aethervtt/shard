import { FixedUpdate } from '@aethervtt/shard-core'
import { PhysicsSystems } from '@aethervtt/shard-physics'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { navAgents } from './agents'
import { NavFlowState, navFlow } from './flow'
import { NavFlows } from './flow-state'
import { NavMoverState, navSteer, navTiers } from './steer'
import { NavMovers } from './steer-state'

/**
 * Movement tiers and flow fields (spec 0115): NavTier's steer and coarse movers, and
 * NavFlowField. Without it, NavTier is ignored (every agent is in the crowd) and NavAgent.flow
 * falls back to findPath. Apps that don't move hordes don't bundle it.
 */
export const navTiersPlugin: Plugin = definePlugin({
  name: 'nav/tiers',
  provides: [NavFlows, NavMovers],
  dependencies: ['nav'],
  build(app) {
    app.world.insertResource(NavFlows, new NavFlowState())
    app.world.insertResource(NavMovers, new NavMoverState())
    // Tiers and fields before the agents step; the steer and coarse mover after them and before
    // physics, so a suspended capsule follows this step.
    app.addSystems(FixedUpdate, navTiers.before(navAgents))
    app.addSystems(FixedUpdate, navFlow.before(navAgents))
    app.addSystems(FixedUpdate, navSteer.after(navAgents).before(PhysicsSystems))
  },
})
