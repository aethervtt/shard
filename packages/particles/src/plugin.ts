import { Last } from '@shard/core'
import { Graph, RenderDescribers, RenderSet } from '@shard/render'
import { definePlugin } from '@shard/runtime'
import { ParticleEffects } from './effect'
import { describeParticles, drawNode, Particles, prepareParticles, simulateNode } from './sim'
import './preview'

/** GPU particles (and the CPU backend): simulated after the depth resolve, drawn over HDR. */
export const particlesPlugin = definePlugin({
  name: 'particles',
  dependencies: ['render/forward'],
  build(app) {
    app.world.initResource(ParticleEffects)
    app.world.initResource(Particles)
    app.addSystems(Last, prepareParticles.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const graph = app.world.resource(Graph)
    graph.addNode('particles/simulate', simulateNode())
    graph.addNode('particles', drawNode())
    app.world.initResource(RenderDescribers).set('particles', (w) => describeParticles(w))
  },
})
