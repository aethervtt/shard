import { defineConfig } from 'vitest/config'
import { testFiles } from '../../scripts/test-shard.mjs'

export default defineConfig({
  test: { ...testFiles() },
})
