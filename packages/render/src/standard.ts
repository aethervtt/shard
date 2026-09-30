import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { atmospherePlugin } from './atmosphere-plugin'
import { deferredPlugin } from './deferred-plugin'
import { renderDescribePlugin } from './describe-plugin'
import { dynamicResolutionPlugin } from './dynamic-resolution'
import { environmentPlugin } from './environment-plugin'
import { type ForwardPluginOptions, forwardCorePlugin } from './forward'
import { fxaaPlugin } from './fxaa'
import { gizmosPlugin } from './gizmos-plugin'
import { lensPlugin } from './lens-plugin'
import { pickingPlugin } from './picking-plugin'
import { pixelPerfectPlugin } from './pixel-perfect-plugin'
import { postPlugin } from './post-plugin'
import { shadowCatcherPlugin } from './shadow-catcher'
import { skinningPlugin } from './skinning-plugin'

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
        environmentPlugin,
        atmospherePlugin,
        postPlugin,
        fxaaPlugin,
        gizmosPlugin,
        pickingPlugin,
        deferredPlugin,
        skinningPlugin,
        pixelPerfectPlugin,
        lensPlugin,
        shadowCatcherPlugin,
        dynamicResolutionPlugin,
        renderDescribePlugin,
      )
    },
  })
}
