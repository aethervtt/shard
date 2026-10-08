import { World } from '@aethervtt/shard-core'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, describe, expect, it } from 'vitest'
import { bakeTerrain, packHash } from './bake'
import { memoryPackStore } from './pack'
import { compileStack } from './stack'
import { sourceAsset, VALLEY_HILLS, valleySource } from './testing'

const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

/**
 * The playground's #heightfield terrain (2 km at 0.5 m), baked here: the pack hash it pins is what
 * Chrome's bake prints on that page, so the two hosts write identical pack bytes (0071).
 */
export const VALLEY_PACK_HASH = 'ec848bdc3cf63b92'

describe('bake determinism (0071)', () => {
  it('bakes the valley terrain to the bytes Chrome bakes, twice the same', async () => {
    await loadNoiseKernel()
    const hills = await NoiseGraph.create(VALLEY_HILLS)
    const world = new World()
    const asset = sourceAsset(world, { ...valleySource(), noise: { hills } })
    const stack = compileStack(asset.source, {
      noise: () => hills,
      heightmap: () => valleySource().heightmaps.valley,
    })
    const a = memoryPackStore()
    const b = memoryPackStore()
    await bakeTerrain(asset, stack, a, { workers })
    await bakeTerrain(asset, stack, b)
    const ha = await packHash(a.files)
    expect(await packHash(b.files)).toBe(ha)
    expect(ha.slice(0, 16)).toBe(VALLEY_PACK_HASH)
  }, 120_000)
})
