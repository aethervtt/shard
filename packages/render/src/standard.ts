import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { atmospherePlugin } from './atmosphere-plugin'
import { type ForwardPluginOptions, forwardCorePlugin } from './forward'
import { fxaaPlugin } from './fxaa'
import { gizmosPlugin } from './gizmos-plugin'
import { pickingPlugin } from './picking-plugin'
import { postPlugin } from './post-plugin'

/**
 * The whole 3D renderer: `forwardCorePlugin` and every render feature. Apps that want a smaller
 * build install `forwardCorePlugin` and only the features they use (spec 0056).
 */
export function forwardPlugin(options: ForwardPluginOptions = {}): Plugin {
  return definePlugin({
    name: 'render/standard',
    build(app) {
      app.addPlugin(
        forwardCorePlugin(options),
        atmospherePlugin,
        postPlugin,
        fxaaPlugin,
        gizmosPlugin,
        pickingPlugin,
      )
    },
  })
}
