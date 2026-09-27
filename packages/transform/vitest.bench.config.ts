import { defineConfig } from 'vitest/config'

// Performance acceptance checks. Run alone (`pnpm bench`) so timings aren't skewed by other work.
// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    include: ['bench/**/*.bench.test.ts'],
    execArgv: ['--expose-gc'],
    testTimeout: 60_000 * slow,
    fileParallelism: false,
  },
})
