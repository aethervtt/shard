import { definePlugin } from '@aethervtt/shard-runtime'
import { PICK_SHADERS } from './debug-shaders'
import { addPickNodes, BvhResource, Picking } from './picking'
import { Shaders } from './plugin'
import { registerShaders } from './shaders'

/** Picking (spec 0027): what's under a pixel (`pick`), and CPU raycasts against meshes. */
export const pickingPlugin = definePlugin({
  name: 'render/picking',
  dependencies: ['render/forward'],
  provides: [BvhResource, Picking],
  build(app) {
    app.world.initResource(Picking)
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), PICK_SHADERS)
    addPickNodes(app.world)
  },
})
