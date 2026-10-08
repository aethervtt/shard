import { defineConfig } from 'vite'

/**
 * Cross-origin isolated pages, so the profiler's clock steps 5 µs, not 100 µs; and the JS
 * Self-Profiling API (0074). The same as ISOLATION_HEADERS in @aethervtt/shard-verify/node.
 */
const headers = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'credentialless',
  'Document-Policy': 'js-profiling',
}

export default defineConfig({
  // Relative asset URLs, so a build works at any path: GitHub Pages serves it under /shard/.
  base: './',
  server: { port: 5180, headers },
  preview: { headers },
  // The embedding demo (0052), the verification fixture (0062) and the dice (0054) are pages of their own.
  build: { rollupOptions: { input: ['index.html', 'embedding.html', 'verify.html', 'dice.html'] } },
})
