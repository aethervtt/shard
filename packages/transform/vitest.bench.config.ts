import { defineConfig } from 'vitest/config'

// Performance acceptance checks. Run alone (`pnpm bench`) so timings aren't skewed by other work.
export default defineConfig({
  test: {
    include: ['bench/**/*.bench.test.ts'],
    execArgv: ['--expose-gc'],
    testTimeout: 60_000,
    fileParallelism: false,
  },
})
