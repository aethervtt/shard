import { PostUpdate } from '@aethervtt/shard-core'
import { registerShaders, Shaders } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import {
  observeShapeRemovals,
  syncShapes,
  VECTOR_SHADERS,
  VectorMaterial,
  VectorShape,
  VectorState,
} from './shape'

/**
 * Vector drawings (0057): pen, line, rect, ellipse, cone and polygon shapes with stroke and
 * fill, in the drawings band. Needs `forwardPlugin` (render/forward).
 */
export const vectorPlugin = definePlugin({
  name: 'vector',
  dependencies: ['render/forward', 'core/transform'],
  provides: [VectorShape, VectorMaterial, VectorState],
  build(app) {
    app.world.initResource(VectorState)
    observeShapeRemovals(app.world)
    app.addSystems(PostUpdate, syncShapes.before(TransformSystems))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), VECTOR_SHADERS)
  },
})
