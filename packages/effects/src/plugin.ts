import { Update } from '@aethervtt/shard-core'
import { definePlugin } from '@aethervtt/shard-runtime'
import * as document from './document'
import * as methods from './methods'
import * as runtime from './runtime'

export const effectsPlugin = definePlugin({
  name: 'effects',
  provides: [document, methods, runtime],
  build(app) {
    const state = app.world.initResource(runtime.Effects)
    for (const plugin of app.describe().plugins) state.plugins.add(plugin.name)
    app.addSystems(Update, runtime.updateEffects)
    app.addMethod(...methods.effectMethods)
  },
  dispose(app) {
    runtime.disposeEffects(app.world)
  },
})
