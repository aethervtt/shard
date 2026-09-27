import { defineConfig } from 'vitest/config'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    hookTimeout: 10_000 * slow,
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000 * slow,
  },
})
