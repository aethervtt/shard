import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    ...testFiles(),
    testTimeout: 20_000 * slow,
    // `pnpm bench` holds exact time budgets: one file at a time, so the 1,000-body tests don't
    // share the CPU with the timed ones.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
