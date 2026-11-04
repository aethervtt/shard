import { registerShaders, Shaders } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { windPlugin } from '@aethervtt/shard-wind'
import * as generatorModule from './generator'
import * as materialModule from './material'
import { NATURE_SHADERS } from './material'
import * as speciesModule from './species'

/**
 * Procedural trees (spec 0095, experimental): the `nature/Tree` generator, `nature/TreeSpecies`
 * data files (`*.tree.json`), and the `nature/Tree` material's shader. Add `procgenPlugin()` too.
 * Trees sway with wind/Wind (0096): it adds the wind plugin when it's missing.
 */
export const naturePlugin = definePlugin({
  name: 'nature',
  provides: [generatorModule, materialModule, speciesModule],
  build(app) {
    if (!app.hasPlugin('wind')) app.addPlugin(windPlugin)
  },
  ready(app) {
    const shaders = app.world.tryResource(Shaders)
    if (shaders) registerShaders(shaders, NATURE_SHADERS)
  },
})
