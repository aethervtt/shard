import { defineConfig } from 'vitest/config'

export default defineConfig({
  // --expose-gc: allocation checks force a collection before counting GC events.
  test: { include: ['src/**/*.test.ts'], testTimeout: 20_000, execArgv: ['--expose-gc'] },
})
