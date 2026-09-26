import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 30_000,
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    // `pnpm bench` holds exact time budgets: one file at a time.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
