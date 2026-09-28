import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    ...testFiles(),
    testTimeout: 120_000 * slow,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
})
