import { defineConfig } from 'vitest/config'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000 * slow,
    // --expose-gc: allocation checks force a collection before counting GC events.
    // --no-incremental-marking: major GCs as whole pauses instead of marking steps inside whatever
    // allocates; the procgen frame-budget test subtracts GC time, which it only sees when GC reports it.
    execArgv: ['--expose-gc', '--no-incremental-marking'],
    // `pnpm bench` holds exact time budgets: one file at a time.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
