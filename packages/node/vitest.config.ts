import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // Major GCs as whole pauses instead of marking steps inside whatever allocates: the procgen
    // frame-budget test subtracts GC time, which it can only see when GC reports it.
    execArgv: ['--no-incremental-marking'],
    // `pnpm bench` holds exact time budgets: one file at a time.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
