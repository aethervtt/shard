import { Last } from '@aethervtt/shard-core'
import { Graph, RenderDescribers, RenderSet } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { OriginShift } from '@aethervtt/shard-transform'
import * as componentsModule from './components'
import * as effectModule from './effect'
import { ParticleEffects } from './effect'
import * as previewModule from './preview'
import * as simModule from './sim'
import {
  describeParticles,
  drawNode,
  Particles,
  prepareParticles,
  shiftParticles,
  simulateNode,
} from './sim'

/** GPU particles (and the CPU backend): simulated after the depth resolve, drawn over HDR. */
export const particlesPlugin = definePlugin({
  name: 'particles',
  provides: [componentsModule, effectModule, previewModule, simModule],
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
