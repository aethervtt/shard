import { Last } from '@shard/core'
import { Graph, RenderDescribers, RenderSet } from '@shard/render'
import { definePlugin } from '@shard/runtime'
import { OriginShift } from '@shard/transform'
import { ParticleEffects } from './effect'
import {
  describeParticles,
  drawNode,
  Particles,
  prepareParticles,
  shiftParticles,
  simulateNode,
} from './sim'
import './preview'

/** GPU particles (and the CPU backend): simulated after the depth resolve, drawn over HDR. */
export const particlesPlugin = definePlugin({
  name: 'particles',
  dependencies: ['render/forward'],
  build(app) {
    app.world.initResource(ParticleEffects)
    const store = app.world.initResource(Particles)
    // Sync with propagation (PostUpdate), before this frame's prepare and simulate (spec 0040).
    app.world.observe(OriginShift, ({ data }) => {
      shiftParticles(store, data.offset[0], data.offset[1], data.offset[2])
    })
    app.addSystems(Last, prepareParticles.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const graph = app.world.resource(Graph)
    graph.addNode('particles/simulate', simulateNode())
    graph.addNode('particles', drawNode())
    app.world.initResource(RenderDescribers).set('particles', (w) => describeParticles(w))
  },
})
