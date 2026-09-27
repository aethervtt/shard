import { defineConfig } from 'vitest/config'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    hookTimeout: 10_000 * slow,
    testTimeout: 5_000 * slow,
    include: ['src/**/*.test.ts'],
  },
})
