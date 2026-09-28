import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5180 },
  // The embedding demo (0052) is its own page: two apps and a DOM underlay.
  build: { rollupOptions: { input: ['index.html', 'embedding.html'] } },
})
