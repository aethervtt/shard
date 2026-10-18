import { defineResource, defineSystem, Last, PostUpdate } from '@aethervtt/shard-core'
import { definePlugin, FrameDemand } from '@aethervtt/shard-runtime'
import { OriginShift, TransformSystems } from '@aethervtt/shard-transform'
import { addRenderFeatures } from './features'
import { Graph, RenderDescribers, RenderSet, Shaders } from './plugin'
import { describeRibbons, Ribbons, shiftRibbons, updateRibbons } from './ribbons'
import { registerShaders } from './shaders'
import { RibbonsPath } from './vfx'
import { VFX_SHADERS, VfxRenderer } from './vfx-draw'
import { computeVisibility } from './visibility'
export const RibbonGpu = defineResource<{ renderer?: VfxRenderer }>('render/RibbonGpu', {
  init: () => ({}),
})
const prune = defineSystem({
  name: 'render/ribbons-prune',
  run: (_, world) => world.resource(RibbonGpu).renderer?.prune(world),
})
export const ribbonsPlugin = definePlugin({
  name: 'render/ribbons',
  dependencies: ['render/forward'],
  provides: [Ribbons, RibbonGpu, updateRibbons],
  build(app) {
    const w = app.world
    w.initResource(RibbonsPath)
    w.initResource(Ribbons)
    w.initResource(RibbonGpu)
    w.observe(OriginShift, ({ data }) =>
      shiftRibbons(w, data.offset[0], data.offset[1], data.offset[2]),
    )
    app.addSystems(PostUpdate, updateRibbons.after(TransformSystems, computeVisibility))
    app.addSystems(Last, prune.inSet(RenderSet.Prepare))
  },
  ready(app) {
    const w = app.world,
      renderer = new VfxRenderer(w.resource(Ribbons).records, false)
    w.resource(RibbonGpu).renderer = renderer
    registerShaders(w.resource(Shaders), VFX_SHADERS)
    addRenderFeatures(w, {
      name: 'render/ribbons',
      description: 'Bounded trails and beams.',
      nodes: ['ribbons'],
      baseline: { strategy: 'The same vertex attributes, uniform buffers and fragment passes' },
    })
    w.resource(Graph).addNode('ribbons', renderer.node())
    w.initResource(RenderDescribers).set('ribbons', describeRibbons)
  },
  dispose(app) {
    app.world.resource(RibbonGpu).renderer?.dispose()
    const s = app.world.resource(Ribbons)
    s.records.length = 0
    s.trails.clear()
    s.beams.clear()
    app.world.tryResource(FrameDemand)?.set('render/ribbons', false)
  },
})
