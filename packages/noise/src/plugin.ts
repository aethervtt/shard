import { definePlugin } from '@aethervtt/shard-runtime'
import { loadNoiseKernel } from './loader'
import * as methodsModule from './methods'
import { noiseMethods } from './methods'
import * as noiseGraphModule from './noise-graph'

/** noise.sample and noise.stats, and the kernel loaded before the first frame. */
export const noisePlugin = definePlugin({
  name: 'noise',
  provides: [methodsModule, noiseGraphModule],
  build(app) {
    app.addMethod(...noiseMethods)
  },
  async ready() {
    await loadNoiseKernel()
  },
})
