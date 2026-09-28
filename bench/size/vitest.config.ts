import { defineConfig } from 'vitest/config'

// CI renders the GPU tests on a software driver: every timeout is 5× longer there.
const slow = process.env.SHARD_CI ? 5 : 1

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000 * slow,
  },
})
