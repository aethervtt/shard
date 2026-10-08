import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  type BlockResult,
  bakeBlock,
  bakeLeaf,
  decodePage,
  dequantize,
  encodePage,
  inflate,
  LEAF_SIDE,
  PAGE,
  pageBytes,
  readPage,
  SIDE,
  type Stack,
} from './kernel'
import { parseTerrainSource, type TerrainLayout, terrainLayout } from './source'
import { compileStack, mainNoise } from './stack'

let stack: Stack
let layout: TerrainLayout
/** Blocks of 2 × 2 leaves: the roots (level 2) are above the blocks. */
let small: TerrainLayout

/** A 64 × 64 bowl heightmap. */
function bowl() {
  const data = new Float32Array(64 * 64)
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) data[y * 64 + x] = Math.hypot(x - 31.5, y - 31.5) / 45
  return { width: 64, height: 64, data }
}

export const TEST_SOURCE = {
  size: [512, 512],
  spacing: 0.25,
  heightRange: [-50, 150],
  seed: 3,
  splines: {
    road: {
      points: [
        [40, 'ground', 60],
        [250, 'ground', 200],
        [470, 'ground', 420],
      ],
      width: 8,
      falloff: 12,
    },
  },
  height: [
    { noise: { path: 'hills.noise.json' }, scale: 30 },
    {
      image: { path: 'bowl.r16' },
      at: [300, 300],
      size: [160, 120],
      rotation: 25,
      range: [-20, 10],
      blend: 'add',
      falloff: 20,
    },
    { spline: 'road', mode: 'flatten' },
  ],
  layers: [{ name: 'grass' }, { name: 'rock', triplanar: true }, { name: 'gravel' }],
  paint: [
    { layer: 'grass' },
    { layer: 'rock', slope: [30, 90], blend: 6 },
    { layer: 'gravel', spline: 'road', blend: 2 },
  ],
}

beforeAll(async () => {
  await loadNoiseKernel()
  const hills = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 5, frequency: 0.01, seed: 1 } } },
  })
  const source = parseTerrainSource(TEST_SOURCE)
  // Blocks of 4 × 4 leaves bake both levels above the leaves themselves; blocks of 2 × 2 leave
  // the roots to the levels above them.
  layout = terrainLayout(source, 4)
  small = terrainLayout(source, 2)
  stack = compileStack(source, { noise: () => hills, heightmap: () => bowl() })
})

function leafOf(r: BlockResult, x: number, z: number) {
  const p = r.pages.find((q) => q.level === 0 && q.x === x && q.z === z)!
  return readPage(p.data, true, layout.cells)
}

/** The largest |leaf − parent surface| over every leaf sample under a parent (anti-diagonal cells). */
function exactError(level: number, x: number, z: number, page: ReturnType<typeof readPage>) {
  const s = 2 ** level
  const { lo, hi } = stack
  const noise = mainNoise()
  let worst = 0
  for (let lz = 0; lz < s; lz++) {
    for (let lx = 0; lx < s; lx++) {
      const leaf = bakeLeaf(noise, stack, layout, x * s + lx, z * s + lz).page
      for (let j = 0; j <= PAGE; j++) {
        for (let i = 0; i <= PAGE; i++) {
          const gi = lx * PAGE + i
          const gj = lz * PAGE + j
          const ci = Math.min(PAGE - 1, Math.floor(gi / s))
          const cj = Math.min(PAGE - 1, Math.floor(gj / s))
          const u = gi / s - ci
          const v = gj / s - cj
          const h = (a: number, b: number) =>
            dequantize(page.heights[(cj + b) * SIDE + ci + a]!, lo, hi)
          const surface =
            u + v <= 1
              ? h(0, 0) + u * (h(1, 0) - h(0, 0)) + v * (h(0, 1) - h(0, 0))
              : h(1, 1) + (1 - u) * (h(0, 1) - h(1, 1)) + (1 - v) * (h(1, 0) - h(1, 1))
          const value = dequantize(leaf.heights[(j + 1) * LEAF_SIDE + i + 1]!, lo, hi)
          worst = Math.max(worst, Math.abs(value - surface))
        }
      }
    }
  }
  return worst
}

describe('heightfield bake kernel (0071)', () => {
  it('lays out roots, depths and blocks', () => {
    expect(layout).toMatchObject({
      depth: 2,
      rootsX: 8,
      rootsZ: 8,
      rootSize: 64,
      leavesX: 32,
      leafSize: 16,
      cells: 32,
      blocksX: 8,
      blockLevels: 2,
    })
    expect(small).toMatchObject({ block: 2, blocksX: 16, blockLevels: 1 })
  })

  it('bakes a block the same way twice, and a leaf alone to the same bytes', () => {
    const noise = mainNoise()
    const a = bakeBlock(noise, stack, layout, 1, 2)
    const b = bakeBlock(noise, stack, layout, 1, 2)
    expect(a.pages.map((p) => p.data)).toEqual(b.pages.map((p) => p.data))
    for (const p of a.pages.filter((q) => q.level === 0)) {
      const alone = bakeLeaf(noise, stack, layout, p.x, p.z)
      const raw = inflate(p.data, pageBytes(true, layout.cells))
      expect(encodePage(alone.page, true, layout.cells)).toEqual(raw)
      expect([alone.min, alone.max]).toEqual([p.min, p.max])
    }
  })

  it('shares leaf edges across blocks, and parents are their children’s even samples', () => {
    const noise = mainNoise()
    const left = bakeBlock(noise, stack, layout, 0, 0)
    const right = bakeBlock(noise, stack, layout, 1, 0)
    const a = leafOf(left, 3, 1)
    const b = leafOf(right, 4, 1)
    for (let j = 0; j < LEAF_SIDE; j++) {
      // a's sample 64 (and its border 65) are b's 0 and 1; a's 63 is b's border −1.
      expect(a.heights[j * LEAF_SIDE + PAGE + 1]).toBe(b.heights[j * LEAF_SIDE + 1])
      expect(a.heights[j * LEAF_SIDE + PAGE + 2]).toBe(b.heights[j * LEAF_SIDE + 2])
      expect(a.heights[j * LEAF_SIDE + PAGE]).toBe(b.heights[j * LEAF_SIDE])
    }
    // Level 1 in block (0, 0): node (1, 0) has children leaves (2, 0), (3, 0), (2, 1), (3, 1).
    const parent = left.pages.find((p) => p.level === 1 && p.x === 1 && p.z === 0)!
    const page = readPage(parent.data, false, layout.cells)
    for (let c = 0; c < 4; c++) {
      const child = leafOf(left, 2 + (c & 1), c >> 1)
      for (let j = 0; j <= PAGE / 2; j++) {
        for (let i = 0; i <= PAGE / 2; i++) {
          const pi = (c & 1) * (PAGE / 2) + i
          const pj = (c >> 1) * (PAGE / 2) + j
          expect(page.heights[pj * SIDE + pi]).toBe(
            child.heights[(2 * j + 1) * LEAF_SIDE + 2 * i + 1],
          )
        }
      }
    }
  })

  it('measures each parent’s error exactly against its subtree', () => {
    const r = bakeBlock(mainNoise(), stack, layout, 2, 1)
    for (const parent of r.pages.filter((p) => p.level > 0)) {
      const page = readPage(parent.data, false, layout.cells)
      const worst = exactError(parent.level, parent.x, parent.z, page)
      expect(parent.error).toBeCloseTo(worst, 9)
      expect(parent.error).toBeGreaterThan(0)
    }
    expect(r.above).toEqual([])
  })

  it('gives levels above the block their share of the error', () => {
    // Root (1, 0) covers blocks (2, 0), (3, 0), (2, 1), (3, 1) of 2 × 2 leaves.
    const shares = [
      [2, 0],
      [3, 0],
      [2, 1],
      [3, 1],
    ].map(([bx, bz]) => bakeBlock(mainNoise(), stack, small, bx!, bz!))
    for (const r of shares) expect(r.above.length).toBe(small.depth - small.blockLevels)
    const own = bakeBlock(mainNoise(), stack, layout, 0, 0).pages.find(
      (p) => p.level === 2 && p.x === 0 && p.z === 0,
    )!
    const root = bakeBlock(mainNoise(), stack, layout, 1, 0).pages.find((p) => p.level === 2)!
    expect(root.x).toBe(1)
    expect(Math.max(...shares.map((r) => r.above[0]!))).toBeCloseTo(root.error, 9)
    expect(own.error).toBeCloseTo(exactError(2, 0, 0, readPage(own.data, false, layout.cells)), 9)
  })

  it('round-trips pages through encode and decode', () => {
    const r = bakeBlock(mainNoise(), stack, layout, 0, 3)
    for (const p of r.pages) {
      const leaf = p.level === 0
      const raw = inflate(p.data, pageBytes(leaf, layout.cells))
      expect(encodePage(decodePage(raw, leaf, layout.cells), leaf, layout.cells)).toEqual(raw)
    }
  })
})
