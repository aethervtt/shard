import { defineResource, defineSystem, Last, PostUpdate } from '@aethervtt/shard-core'
import { definePlugin, FrameDemand } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import { Decals, describeDecals, updateDecals } from './decals'
import { addRenderFeatures } from './features'
import { Graph, RenderDescribers, RenderSet, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { DecalsPath } from './vfx'
import { VFX_SHADERS, VfxRenderer } from './vfx-draw'
import { computeVisibility } from './visibility'
export const DecalGpu = defineResource<{ renderer?: VfxRenderer }>('render/DecalGpu', {
  init: () => ({}),
})
const prune = defineSystem({
  name: 'render/decals-prune',
  run: (_, world) => world.resource(DecalGpu).renderer?.prune(world),
})
export const decalsPlugin = definePlugin({
  name: 'render/decals',
  dependencies: ['render/forward'],
  provides: [Decals, DecalGpu, updateDecals],
  build(app) {
    app.world.initResource(DecalsPath)
    app.world.initResource(Decals)
    app.world.initResource(DecalGpu)
    app.addSystems(PostUpdate, updateDecals.after(TransformSystems, computeVisibility))
    app.addSystems(Last, prune.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const w = app.world,
      renderer = new VfxRenderer(w.resource(Decals).records, true)
    w.resource(DecalGpu).renderer = renderer
    registerShaders(w.resource(Shaders), VFX_SHADERS)
    addRenderFeatures(w, {
      name: 'render/decals',
      description: 'Clipped rigid-mesh projected decals.',
      nodes: ['decals'],
      baseline: { strategy: 'CPU projection and the same vertex/fragment passes' },
    })
    w.resource(Graph).addNode('decals', renderer.node())
    w.initResource(RenderDescribers).set('decals', describeDecals)
  },
  dispose(app) {
    app.world.resource(DecalGpu).renderer?.dispose()
    const s = app.world.resource(Decals)
    s.records.length = 0
    s.receivers.length = 0
    s.receiverByEntity.clear()
    app.world.tryResource(FrameDemand)?.set('render/decals', false)
  },
})
