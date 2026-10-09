import { World } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, describe, expect, it } from 'vitest'
import { bakeTerrain } from './bake'
import { memoryPackStore } from './pack'
import { compileStack } from './stack'
import { sourceAsset, VALLEY_HILLS, valleySource } from './testing'

// 0071's rebake budget: moving one image layer of the 2 km terrain at 0.5 m rebakes what it
// touches (bake.test.ts checks which blocks, on a small terrain) in under terrain/heightfield-rebake.
// Timing only, so it runs under `pnpm bench`.

let workers: ReturnType<typeof createNodeWorkers> | undefined
afterAll(() => workers?.dispose())

describe('terrain rebake (0071)', () => {
  it.runIf(timingMode === 'bench')(
    'rebakes a moved image layer of the 2 km terrain within terrain/heightfield-rebake',
    async () => {
      workers = createNodeWorkers()
      await loadNoiseKernel()
      const hills = await NoiseGraph.create(VALLEY_HILLS)
      const world = new World()
      const valley = valleySource()
      const compile = (source: unknown) => {
        const asset = sourceAsset(world, { ...valley, source, noise: { hills } })
        return {
          asset,
          stack: compileStack(asset.source, {
            noise: () => hills,
            heightmap: () => valley.heightmaps.valley,
          }),
        }
      }
      const store = memoryPackStore()
      const before = compile(valley.source)
      await bakeTerrain(before.asset, before.stack, store, { workers: workers! })
      const moved = structuredClone(valley.source) as { height: { at?: number[] }[] }
      moved.height[1]!.at = [1100, 1300]
      const after = compile(moved)
      const t0 = performance.now()
      const report = await bakeTerrain(after.asset, after.stack, store, { workers: workers! })
      const ms = performance.now() - t0
      console.info(
        `rebake: ${report.rebaked} of ${report.blocks} blocks, ${report.pages} pages in ${ms.toFixed(0)} ms`,
      )
      expect(report.rebaked).toBeGreaterThan(0)
      expect(report.rebaked).toBeLessThan(report.blocks)
      expect(ms).toBeLessThan(budget('terrain/heightfield-rebake'))
    },
    timeout(300_000),
  )
})
