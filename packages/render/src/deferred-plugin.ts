import { definePlugin } from '@aethervtt/shard-runtime'
import { addDeferredNodes } from './deferred'
import { DEFERRED_SHADERS } from './deferred-shaders'
import { Shaders } from './plugin'
import { registerShaders } from './shaders'
import { DeferredPath } from './view'

/**
 * The deferred path (spec 0021): cameras with `RenderPath { mode: 'deferred' }` shade opaque
 * geometry through a G-buffer. Without it they render forward.
 */
export const deferredPlugin = definePlugin({
  name: 'render/deferred',
  dependencies: ['render/forward'],
  build(app) {
    app.insertResource(DeferredPath, { installed: true })
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), DEFERRED_SHADERS)
    addDeferredNodes(app)
  },
})
