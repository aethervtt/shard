import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

export default defineConfig({
  // --expose-gc: the allocation check forces a collection before counting GC events.
  test: { ...testFiles(), execArgv: ['--expose-gc'] },
})
