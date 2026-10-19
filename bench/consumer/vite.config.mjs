import { defineConfig } from 'vite'

export default defineConfig({
  worker: { format: 'es' },
  optimizeDeps: {
    include: ['@aethervtt/shard-texture > jpeg-js'],
    exclude: [
      '@aethervtt/shard-dice',
      '@aethervtt/shard-gpu-webgl2',
      '@aethervtt/shard-texture',
      '@aethervtt/shard-noise',
    ],
  },
  build: { rolldownOptions: { input: ['index.html', 'compat.html'] } },
})
