import { defineResource } from '@aethervtt/shard-core'
import type { WaveGpu } from './gpu'

export const WaveRender = defineResource<WaveGpu>('water/WaveRender', {
  description: 'The sea’s GPU side (0098): spectra, FFT fields and resolved cascades.',
})
