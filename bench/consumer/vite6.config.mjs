// Aether's Vite 6 / Rollup toolchain, alongside the workspace's Vite 8 / Rolldown fixture.
export default {
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
  build: { outDir: 'dist-vite6', rollupOptions: { input: 'compat.html' } },
}
