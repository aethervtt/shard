import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // `pnpm bench` holds exact time budgets: one file at a time, so the 1,000-body tests don't
    // share the CPU with the timed ones.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
