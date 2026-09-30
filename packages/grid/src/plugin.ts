import { PostUpdate } from '@aethervtt/shard-core'
import { registerShaders, Shaders } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { TransformSystems } from '@aethervtt/shard-transform'
import {
  GRID_SHADERS,
  Grid,
  GridLines,
  GridQuad,
  GridState,
  observeGridRemovals,
  syncGrids,
} from './grid'

/**
 * Tabletop grids (0057): square and hex grids drawn analytically, one quad each, in the grid
 * band. Needs `forwardPlugin` (render/forward).
 */
export const gridPlugin = definePlugin({
  name: 'grid',
  dependencies: ['render/forward', 'core/transform'],
  provides: [Grid, GridQuad, GridLines, GridState],
  build(app) {
    app.world.initResource(GridState)
    observeGridRemovals(app.world)
    app.addSystems(PostUpdate, syncGrids.before(TransformSystems))
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), GRID_SHADERS)
  },
})
