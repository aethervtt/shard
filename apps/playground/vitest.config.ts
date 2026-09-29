import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

// Browser runs: one file at a time, so captures don't share the GPU with each other.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: { ...testFiles(), fileParallelism: false, hookTimeout: 60_000 * slow },
})
