import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    // `pnpm bench` holds exact time budgets: one file at a time, so the crowd and bake tests
    // don't share the CPU with the timed ones.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
