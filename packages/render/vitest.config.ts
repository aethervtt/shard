import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    testTimeout: 20_000,
    // --expose-gc: allocation checks force a collection before counting GC events.
    execArgv: ['--expose-gc'],
    // `pnpm bench` holds exact budgets (frames to a hot reload among them): one file at a time,
    // so no other file compiles shaders on the GPU meanwhile.
    fileParallelism: !process.env.SHARD_BENCH,
  },
})
