import { defineConfig } from 'vitest/config'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000 * slow,
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    // `pnpm bench` holds exact time budgets: one file at a time, so the crowd and bake tests
    // don't share the CPU with the timed ones.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
