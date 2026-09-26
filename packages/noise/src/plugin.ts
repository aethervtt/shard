import { definePlugin } from '@shard/runtime'
import { loadNoiseKernel } from './loader'
import { noiseMethods } from './methods'

/** noise.sample and noise.stats, and the kernel loaded before the first frame. */
export const noisePlugin = definePlugin({
  name: 'noise',
  build(app) {
    app.addMethod(...noiseMethods)
  },
  async ready() {
    await loadNoiseKernel()
  },
})
