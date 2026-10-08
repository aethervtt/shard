import { timeout } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { decodePng } from '@aethervtt/shard-protocol'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainSources } from './source-asset'
import { heightfieldApp, sourceAsset, untilStreaming, VALLEY_HILLS, valleySource } from './testing'

let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})
afterAll(() => workers.dispose())

describe('terrain.* on a heightfield (0071)', () => {
  it(
    'describes, samples and maps it, and shows which blocks an edit rebaked',
    async () => {
      const valley = valleySource()
      const p = await heightfieldApp(undefined, { ...valley, noise: { hills }, workers })
      await untilStreaming(p)
      const call = async (method: string, params: Record<string, unknown>) => {
        const m = p.app.methods.find((x) => x.name === method)!
        return (await m.handler(
          { world: p.world, app: p.app } as never,
          params as never,
        )) as Record<string, unknown>
      }
      const described = (await call('terrain.describe', {})) as {
        terrains: {
          bake: { state: string; blocks: number; current: number; stale: number }
          depths: number
          pages: { resident: number }
        }[]
      }
      expect(described.terrains).toHaveLength(1)
      const d = described.terrains[0]!
      expect(d.bake).toMatchObject({ state: 'current', blocks: 16, current: 16, stale: 0 })
      expect(d.depths).toBe(4)
      expect(d.pages.resident).toBeGreaterThan(0)
      // On the road: gravel; the leaf depth (pages loaded for the sample).
      const sampled = (await call('terrain.sample', { points: [[1024 * 0.9, 1024 * 0.7]] })) as {
        samples: { layers: string[]; depth: number; slope: number }[]
      }
      expect(sampled.samples[0]!.depth).toBe(3)
      expect(sampled.samples[0]!.layers.length).toBe(2)
      for (const mode of ['height', 'slope', 'layers', 'bake']) {
        const map = (await call('terrain.map', { mode, size: 64 })) as {
          width: number
          height: number
          data: string
        }
        expect([map.width, map.height]).toEqual([64, 64])
        const image = await decodePng(Buffer.from(map.data, 'base64'))
        expect(image.width).toBe(64)
      }
      // Move the valley image: the source asset updates in place (as a hot reload does).
      const store = p.world.resource(TerrainSources)
      const asset = [...store.values()][0]!
      const moved = structuredClone(valley.source) as { height: { at?: number[] }[] }
      moved.height[1]!.at = [1100, 1300]
      const next = sourceAsset(p.world, { ...valley, source: moved, noise: { hills } })
      asset.source = next.source
      asset.hash = next.hash
      asset.deps = next.deps
      asset.version++
      let rebaked: { rebaked: number } | null = null
      for (let i = 0; i < 2000 && !rebaked; i++) {
        p.app.update(1 / 60)
        await new Promise((r) => setTimeout(r, 5))
        const t = (
          (await call('terrain.describe', {})) as {
            terrains: { bake: { state: string; lastBake: { rebaked: number } | null } }[]
          }
        ).terrains[0]!
        if (t.bake.state === 'current' && t.bake.lastBake) rebaked = t.bake.lastBake
      }
      expect(rebaked!.rebaked).toBeGreaterThan(0)
      expect(rebaked!.rebaked).toBeLessThan(16)
      const bake = (await call('terrain.map', { mode: 'bake', size: 64 })) as { data: string }
      const image = await decodePng(Buffer.from(bake.data, 'base64'))
      let cyan = 0
      for (let i = 0; i < image.data.length; i += 4)
        if (image.data[i + 2]! > 200 && image.data[i]! < 100) cyan++
      expect(cyan).toBeGreaterThan(0)
      await p.app.dispose()
    },
    timeout(180_000),
  )
})
