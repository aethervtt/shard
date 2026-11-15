import { ShardError, t } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { NoiseGraph } from '@aethervtt/shard-noise'
import { CharacterController, CharacterIntent, CharacterState } from '@aethervtt/shard-physics'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { FloatingOrigin, placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, describe, expect, it } from 'vitest'
import { bakeTerrain } from './bake'
import { tilesOf } from './colliders'
import { groundAt, TestGround } from './fixtures/ground'
import { defineTerrainGenerator, findTerrainGenerator } from './generator'
import {
  bakeNearPage,
  bakeParent,
  dequantize,
  LEAF_SIDE,
  PAGE,
  quantize,
  readPage,
  SIDE,
} from './kernel'
import { NEAR_ERROR_FACTOR } from './near'
import { memoryPackStore, packOf, readIndex } from './pack'
import { terrainHeightAt } from './queries'
import { parseTerrainSource, terrainLayout } from './source'
import { mainNoise } from './stack'
import {
  NEAR_GRAIN as GRAIN,
  groundSource,
  heightfieldApp,
  nearLeavesHash,
  groundStack as stackOf,
  untilStreaming,
} from './testing'

const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

/** The hash of 500 near leaves of the 2 km source (the playground's #heightfield page prints Chrome's). */
export const NEAR_LEAVES = '63a7910f'

function fnv(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193)
  return h >>> 0
}

describe('generated terrain (0119)', () => {
  it('parses generator layers, defaults the bake to near, and keys the stack by version and params', async () => {
    const { source, stack } = await stackOf(groundSource())
    expect(source.bake).toBe('near')
    expect(parseTerrainSource({ ...groundSource(), bake: 'ahead' }).bake).toBe('ahead')
    expect(stack.generators).toEqual([
      {
        name: 'shard-test/Ground',
        version: 1,
        params: {
          seed: 9,
          relief: 70,
          pad: [1000, 1000, 24, 16, 110],
          basement: [1000, 1000, 10, 8],
        },
      },
    ])
    // The paint entry shares the height layer's generator and params.
    expect(stack.paint[1]!.generated).toEqual({ gen: 0, layers: [0, 1, 2] })
    expect(() => parseTerrainSource({ ...groundSource(), paint: [{ generator: 'x/Y' }] })).toThrow(
      /needs its own "params"/,
    )
    await expect(
      stackOf({ ...groundSource(), height: [{ generator: 'shard-test/Nope' }], paint: [] }),
    ).rejects.toMatchObject({ code: 'terrain/unknown-generator' })
    await expect(
      stackOf({
        ...groundSource(),
        height: [{ generator: 'shard-test/Ground', params: { seed: -1 } }],
      }),
    ).rejects.toMatchObject({ code: 'terrain/bad-source' })
  })

  it(
    'bakes leaves to the same bytes near, inline and ahead, and parents to the ahead bake’s heights',
    async () => {
      const { source, stack } = await stackOf(groundSource())
      const layout = terrainLayout(source, 4)
      const store = memoryPackStore()
      await bakeTerrain({ source, layout, deps: {}, hash: 'ground' }, stack, store, { workers })
      const D = layout.depth
      const noise = mainNoise()
      let h = 0x811c9dc5
      let leaves = 0
      for (let z = 0; z < layout.leavesZ && leaves < 500; z++) {
        for (let x = 0; x < layout.leavesX && leaves < 500; x++, leaves++) {
          const { path, slot } = packOf(D, x, z)
          const pack = await store.read(path)
          const e = readIndex(path, pack!).entries[slot]!
          const ahead = readPage(pack!.subarray(e.offset, e.offset + e.length), true, layout.cells)
          const near = bakeNearPage(noise, stack, layout, D, x, z)
          expect(near.heights).toEqual(ahead.heights)
          expect(near.control).toEqual(ahead.control)
          expect([near.min, near.max]).toEqual([e.min, e.max])
          h = fnv(new Uint8Array(near.heights.buffer), h)
          h = fnv(near.control, h)
        }
      }
      expect(h.toString(16).padStart(8, '0')).toBe(NEAR_LEAVES)
      expect(await nearLeavesHash()).toBe(NEAR_LEAVES)
      // Parents: point samples, so the same heights; errors estimated within [1×, 4×] per depth.
      for (let d = 0; d < D; d++) {
        const n = layout.leavesX >> (D - d)
        let exact = 0
        let estimate = 0
        for (let z = 0; z < n; z++) {
          for (let x = 0; x < n; x++) {
            const { path, slot } = packOf(d, x, z)
            const pack = await store.read(path)
            const e = readIndex(path, pack!).entries[slot]!
            const ahead = readPage(
              pack!.subarray(e.offset, e.offset + e.length),
              false,
              layout.cells,
            )
            const near = bakeParent(noise, stack, layout, d, x, z)
            expect(near.page.heights).toEqual(ahead.heights)
            exact = Math.max(exact, e.error)
            estimate = Math.max(estimate, near.error * NEAR_ERROR_FACTOR)
          }
        }
        expect(estimate / exact).toBeGreaterThanOrEqual(1)
        expect(estimate / exact).toBeLessThanOrEqual(4)
      }
    },
    timeout(240_000),
  )

  it(
    'streams 20 × 16 km after its resident levels only, and a walker never waits for ground',
    async () => {
      const grain = await NoiseGraph.create(GRAIN)
      const p = await heightfieldApp(undefined, {
        source: { ...groundSource(), size: [20480, 16384] },
        noise: { grain },
        physics: true,
      })
      await untilStreaming(p)
      const rt = p.runtime()
      const near = rt.pages!.near!
      expect(rt.layout!.depth).toBe(6)
      expect(rt.residentDepth).toBe(1)
      expect(near.stats.parents).toBe(100)
      expect(near.stats.leaves).toBe(0)
      const w = p.world
      const x0 = 12_345
      const z0 = 9_876
      const plan = findTerrainGenerator('shard-test/Ground')!
      expect(plan).toBe(TestGround)
      const c = w.spawn(
        [CharacterController, { radius: 0.35, height: 1.8 }],
        [CharacterIntent, {}],
        [CharacterState, {}],
        Transform,
        FloatingOrigin,
      )
      const start = terrainHeightAt(w, p.terrain, x0, z0)
      placeInGrid(w, c, p.terrain, [x0, start.height + 1.5, z0])
      // Two frames of collider delay: the tile under it is there on the third.
      for (let f = 0; f < 3; f++) p.app.update(1 / 60)
      const tiles = tilesOf(rt)
      expect(tiles.tiles.size).toBeGreaterThan(0)
      for (let f = 0; f < 60; f++) {
        p.app.update(1 / 60)
        await new Promise((r) => setTimeout(r, 0))
      }
      const inlineAfterLanding = tiles.bakedInline
      w.set(c, CharacterIntent, { move: [6, 0, 0] })
      const pos = new Float64Array(3)
      for (let f = 0; f < 50 * 60; f++) {
        p.app.update(1 / 60)
        if (f % 4 === 0) await new Promise((r) => setTimeout(r, 0))
      }
      worldPosition64(w, c, pos, p.terrain)
      expect(pos[0]! - x0).toBeGreaterThan(280)
      // On the ground, not under it.
      const under = terrainHeightAt(w, p.terrain, pos[0]!, pos[2]!)
      expect(pos[1]! - under.height).toBeGreaterThan(0.5)
      expect(tiles.bakedInline).toBe(inlineAfterLanding)
      // Only pages near the walker and the resident levels: nothing like a full bake (81 920 leaves).
      expect(near.stats.leaves).toBeLessThan(400)
      await p.app.dispose()
    },
    timeout(240_000),
  )

  it(
    'rebakes when the generator is defined again, and reports a NaN',
    async () => {
      defineTerrainGenerator('shard-test/Flat', {
        params: { level: t.f64({ default: 10 }) },
        heights: (s, area, out) => out.fill(s.level, 0, area.nx * area.nz),
      })
      const p = await heightfieldApp(undefined, {
        source: {
          size: [1024, 1024],
          spacing: 1,
          heightRange: [-100, 100],
          height: [{ generator: 'shard-test/Flat' }],
        },
        name: 'flat',
      })
      await untilStreaming(p)
      const rt = p.runtime()
      expect(terrainHeightAt(p.world, p.terrain, 300, 300).height).toBeCloseTo(10, 2)
      const version = rt.version
      defineTerrainGenerator('shard-test/Flat', {
        params: { level: t.f64({ default: 10 }) },
        version: 2,
        heights: (s, area, out) => out.fill(s.level + 15, 0, area.nx * area.nz),
      })
      // The old pages draw (streaming stays on) until the new resident levels are in.
      for (let f = 0; f < 600 && rt.version === version; f++) {
        p.app.update(1 / 60)
        expect(rt.streaming).toBe(true)
        await new Promise((r) => setTimeout(r, 1))
      }
      expect(rt.version).toBe(version + 1)
      expect(terrainHeightAt(p.world, p.terrain, 300, 300).height).toBeCloseTo(25, 2)
      defineTerrainGenerator('shard-test/Flat', {
        params: { level: t.f64({ default: 10 }) },
        version: 3,
        heights: (_s, area, out) => {
          out.fill(1, 0, area.nx * area.nz)
          if (area.x0 < 100) out[0] = Number.NaN
        },
      })
      for (let f = 0; f < 600 && !rt.problem; f++) {
        p.app.update(1 / 60)
        await new Promise((r) => setTimeout(r, 1))
      }
      expect(rt.bake).toBe('failed')
      expect(rt.problem).toBeInstanceOf(ShardError)
      expect(rt.problem!.code).toBe('terrain/bad-generator-output')
      expect(rt.problem!.message).toMatch(/shard-test\/Flat/)
      await p.app.dispose()
    },
    timeout(60_000),
  )

  it('samples the generator itself: a leaf’s heights are groundAt quantized', async () => {
    const { source, stack } = await stackOf({
      ...groundSource(),
      height: [groundSource().height[0]],
    })
    const layout = terrainLayout(source)
    const page = bakeNearPage(mainNoise(), stack, layout, layout.depth, 10, 12)
    const plan = (TestGround.options.prepare as (p: unknown) => never)({
      seed: 9,
      relief: 70,
      pad: [1000, 1000, 24, 16, 110],
      basement: [1000, 1000, 10, 8],
    })
    for (let j = 0; j < SIDE; j += 7) {
      for (let i = 0; i < SIDE; i += 5) {
        const q = page.heights[(j + 1) * LEAF_SIDE + i + 1]!
        expect(q).toBe(quantize(groundAt(plan, 10 * PAGE + i, 12 * PAGE + j), -50, 450))
        expect(
          Math.abs(dequantize(q, -50, 450) - groundAt(plan, 10 * PAGE + i, 12 * PAGE + j)),
        ).toBeLessThan(0.004)
      }
    }
  })
})
