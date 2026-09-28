import { definePlugin } from '@aethervtt/shard-runtime'
import { describeCulling, describeLighting } from './debug-views'
import { RenderDescribers } from './plugin'
import { describeRenderScale } from './render-scale'

/**
 * The lighting, culling, and renderScale sections of `render.describe`, for agents and the editor.
 * Only introspection: an app that ships without it renders the same.
 */
export const renderDescribePlugin = definePlugin({
  name: 'render/describe',
  dependencies: ['render/forward'],
  build() {},
  ready(app) {
    const describers = app.world.initResource(RenderDescribers)
    describers.set('lighting', (world) => describeLighting(world))
    describers.set('culling', (world) => describeCulling(world))
    describers.set('renderScale', (world) => describeRenderScale(world))
  },
})
