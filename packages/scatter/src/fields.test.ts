import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import { timeout } from '@aethervtt/shard-core/test-env'
import { NoiseGraph } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { procgenPlugin } from '@aethervtt/shard-procgen'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Terrain } from '@aethervtt/shard-terrain'
import {
  groundSource,
  groundStack,
  heightfieldApp,
  NEAR_GRAIN,
  untilStreaming,
} from '@aethervtt/shard-terrain/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { HeightfieldIndex, HeightfieldSurface } from './heightfield-surface'
import { scatterPlugin } from './plugin'
import { type CompiledRule, compileRules } from './rules'
import { Scatter } from './runtime'
import { ScatterSet } from './set'
import { P_X, PLACEMENT_STRIDE } from './surface'
import { cameraQuery } from './viewers'

const roots: string[] = []
let grain: NoiseGraph

beforeAll(async () => {
  await groundStack()
  grain = await NoiseGraph.create(NEAR_GRAIN)
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

function rules(field: string, kind: 'prop' | 'foliage' = 'prop'): CompiledRule[] {
  const set = ScatterSet.deserialize({
    rules: [
      {
        name: 'trees',
        kind,
        items: [{ generator: kind === 'prop' ? 'shard/Tree' : 'shard/GrassClump' }],
        density: kind === 'prop' ? 0.02 : 2,
        spacing: kind === 'prop' ? 4 : 0,
        masks: { field },
      },
    ],
  } as never)
  return compileRules([{ path: 'test.scatter.json', set, biome: -1 }], 5)
}

/** Every item of a block of 6 × 6 chunks crossing the road at z = 1200, as "x,z" keys. */
async function place(field: string): Promise<{ keys: Set<string>; points: number[] }> {
  const p = await heightfieldApp(undefined, { source: groundSource(), noise: { grain } })
  await untilStreaming(p)
  const surface = new HeightfieldSurface(p.world, p.runtime(), cameraQuery(p.world))
  surface.setTerrain()
  const compiled = rules(field)
  surface.configure(compiled, [undefined], 1)
  const rule = compiled[0]!
  const size = surface.sizes[0]!
  const keys = new Set<string>()
  const points: number[] = []
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 6; x++) {
      const chunk = surface.chunkAt(rule, 900 + (x + 0.5) * size, 0, 1050 + (y + 0.5) * size)
      const placed = surface.finishPlacement(surface.startPlacement(chunk, 0, undefined))
      for (let i = 0; i < placed.count; i++) {
        const o = i * PLACEMENT_STRIDE + P_X
        const px = chunk.center[0]! + placed.data[o]!
        const pz = chunk.center[2]! + placed.data[o + 2]!
        keys.add(`${px.toFixed(4)},${pz.toFixed(4)}`)
        points.push(px, pz)
      }
    }
  }
  await p.app.dispose()
  return { keys, points }
}

describe('scatter fields from a terrain generator (0121)', () => {
  it(
    'places exactly the unmasked items with a field of 1, none on the road, and thins by half',
    async () => {
      const plain = await place('')
      const one = await place('one')
      const road = await place('road')
      const half = await place('half')
      expect(plain.keys.size).toBeGreaterThan(2000 * 0.02 * 4)
      expect([...one.keys]).toEqual([...plain.keys])
      // No tree on the road, and every other one kept.
      for (let i = 0; i < road.points.length; i += 2)
        expect(Math.abs(road.points[i + 1]! - 1200)).toBeGreaterThanOrEqual(5)
      let off = 0
      for (let i = 0; i < plain.points.length; i += 2)
        if (Math.abs(plain.points[i + 1]! - 1200) >= 5) off++
      expect(road.keys.size).toBe(off)
      for (const k of road.keys) expect(plain.keys.has(k)).toBe(true)
      // Half the density: about half the items, each one the unmasked rule's.
      for (const k of half.keys) expect(plain.keys.has(k)).toBe(true)
      expect(Math.abs(half.keys.size / plain.keys.size - 0.5)).toBeLessThan(0.05)
    },
    timeout(120_000),
  )

  it('scales foliage density by the field at every patch vertex', async () => {
    const p = await heightfieldApp(undefined, { source: groundSource(), noise: { grain } })
    await untilStreaming(p)
    const surface = new HeightfieldSurface(p.world, p.runtime(), cameraQuery(p.world))
    surface.setTerrain()
    const compiled = rules('road', 'foliage')
    surface.configure(compiled, [undefined], 1)
    const chunk = surface.chunkAt(compiled[0]!, 1000, 0, 1200)
    const patch = surface.finishPatch(surface.startPatch(chunk, undefined))
    let onRoad = 0
    for (let v = 0; v < patch.grid * patch.grid; v++) {
      const z = chunk.center[2]! + patch.positions[v * 3 + 2]!
      if (Math.abs(z - 1200) < 5) {
        onRoad++
        expect(patch.density[v]).toBe(0)
      }
    }
    expect(onRoad).toBeGreaterThan(0)
    await p.app.dispose()
  })

  it('places nothing over a terrain hole (0120)', async () => {
    const p = await heightfieldApp(undefined, {
      source: groundSource(2048, { holes: { generator: 'shard-test/Ground' } }),
      noise: { grain },
    })
    await untilStreaming(p)
    const index = new HeightfieldIndex(p.runtime())
    const hit = new Float64Array(4)
    // The test generator's basement: 10 × 8 m at (1000, 1000).
    expect(index.heightAt(1000, 1000, hit)).toBe(false)
    expect(index.heightAt(1003, 997, hit)).toBe(false)
    expect(index.heightAt(1009, 1000, hit)).toBe(true)
    await p.app.dispose()
  })

  it(
    'reports a field no generator has, listing the ones there are',
    async () => {
      const p = await heightfieldApp(undefined, {
        source: groundSource(),
        noise: { grain },
        extra: [ScenePlugin, procgenPlugin(), scatterPlugin()],
      })
      const root = mkdtempSync(join(tmpdir(), 'shard-fields-'))
      roots.push(root)
      await assetServer(p.world)
        .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
        .scan()
      await untilStreaming(p)
      const w = p.world
      const set = w.initResource(ScatterSet.store).add(
        ScatterSet.deserialize({
          rules: [
            {
              name: 'trees',
              items: [{ generator: 'shard/Tree' }],
              density: 0.01,
              masks: { field: 'forest' },
            },
          ],
        } as never),
        'set',
      )
      w.set(p.terrain, Terrain, { ...w.get(p.terrain, Terrain), scatter: set })
      for (let i = 0; i < 5; i++) p.app.update(1 / 60)
      const problem = w.resource(Scatter).surfaces.get(p.terrain)!.problem
      expect(problem?.code).toBe('scatter/unknown-field')
      expect(problem?.hint).toMatch(/road, half, one/)
      await p.app.dispose()
    },
    timeout(60_000),
  )
})
