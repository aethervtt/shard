import { defineConfig } from 'vite'

export default defineConfig({
  server: { port: 5180 },
  // The embedding demo (0052), the verification fixture (0062) and the dice (0054) are pages of their own.
  build: { rollupOptions: { input: ['index.html', 'embedding.html', 'verify.html', 'dice.html'] } },
})
