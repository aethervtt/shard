import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    ...testFiles(),
    testTimeout: 20_000 * slow,
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    // `pnpm bench` holds exact budgets (frames to a hot reload among them): one file at a time,
    // so no other file compiles shaders on the GPU meanwhile.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
