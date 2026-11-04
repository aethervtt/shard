import { registerShaders, Shaders } from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import * as generatorModule from './generator'
import * as materialModule from './material'
import { NATURE_SHADERS } from './material'
import * as speciesModule from './species'

/**
 * Procedural trees (spec 0095, experimental): the `nature/Tree` generator, `nature/TreeSpecies`
 * data files (`*.tree.json`), and the `nature/Tree` material's shader. Add `procgenPlugin()` too;
 * scattered trees sway with scatter's `Wind`.
 */
export const naturePlugin = definePlugin({
  name: 'nature',
  provides: [generatorModule, materialModule, speciesModule],
  build() {},
  ready(app) {
    const shaders = app.world.tryResource(Shaders)
    if (shaders) registerShaders(shaders, NATURE_SHADERS)
  },
})
