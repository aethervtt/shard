import { timeout } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type BakeInput, bakeTerrain, readManifest } from './bake'
import { BLOCK_LEVELS, type StackMap } from './kernel'
import { memoryPackStore } from './pack'
import { parseTerrainSource, terrainLayout } from './source'
import { compileStack } from './stack'

let hills: NoiseGraph
const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

function bowl(): StackMap {
  const data = new Float32Array(64 * 64)
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) data[y * 64 + x] = Math.hypot(x - 31.5, y - 31.5) / 45
  return { width: 64, height: 64, data }
}

/** A 512 m terrain at 0.25 m (depth 2) with blocks of 2 × 2 leaves: its roots are above the blocks. */
function terrain(image: { at: [number, number] }) {
  const json = {
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
        at: image.at,
        size: [100, 70],
        rotation: 25,
        range: [-20, 10],
        blend: 'add',
        falloff: 10,
      },
      { spline: 'road', mode: 'flatten' },
    ],
    layers: [{ name: 'grass' }, { name: 'rock' }, { name: 'gravel' }],
    paint: [
      { layer: 'grass' },
      { layer: 'rock', slope: [30, 90], blend: 6 },
      { layer: 'gravel', spline: 'road', blend: 2 },
    ],
  }
  const source = parseTerrainSource(json)
  const layout = terrainLayout(source, 2)
  const input: BakeInput = {
    source,
    layout,
    deps: { 'hills.noise.json': { hash: 'hills-1' }, 'bowl.r16': { hash: 'bowl-1' } },
    hash: JSON.stringify(json),
  }
  const stack = compileStack(source, { noise: () => hills, heightmap: bowl })
  return { input, stack, layout }
}

beforeAll(async () => {
  await loadNoiseKernel()
  hills = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 4, frequency: 0.01, seed: 1 } } },
  })
})

/** Byte-for-byte equality without a deep diff (vitest's is slow on megabytes). */
const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) =>
  a !== undefined && b !== undefined && Buffer.from(a).equals(Buffer.from(b))

describe('terrain bake (0071)', () => {
  it(
    'bakes every block, then rebakes only what an edit touches, to the bytes of a full bake',
    async () => {
      const before = terrain({ at: [300, 300] })
      const store = memoryPackStore()
      const first = await bakeTerrain(before.input, before.stack, store)
      expect(first.rebaked).toBe(before.layout.blocksX * before.layout.blocksZ)
      expect(first.ancestors).toBe(before.layout.rootsX * before.layout.rootsZ)
      const kept = new Map(store.files)
      // The same source again: nothing to do.
      const again = await bakeTerrain(before.input, before.stack, store)
      expect(again.rebaked).toBe(0)
      expect(again.pages).toBe(0)
      // Move the image: only blocks its old or new rectangle (plus falloff) reaches rebake.
      const after = terrain({ at: [150, 120] })
      const moved = await bakeTerrain(after.input, after.stack, store)
      const size = after.layout.block * after.layout.leafSize
      const margin =
        (2 ** Math.min(after.layout.blockLevels, after.layout.depth) + 1) * after.layout.spacing
      const reach = (cx: number, cz: number) => {
        // The rotated 100 × 70 rectangle's bounds plus its 10 m falloff.
        const a = (25 * Math.PI) / 180
        const ex = Math.abs(Math.cos(a)) * 50 + Math.abs(Math.sin(a)) * 35 + 10
        const ez = Math.abs(Math.sin(a)) * 50 + Math.abs(Math.cos(a)) * 35 + 10
        return [cx - ex, cz - ez, cx + ex, cz + ez]
      }
      const expected = new Set<string>()
      for (const [x0, z0, x1, z1] of [reach(300, 300), reach(150, 120)]) {
        for (let bz = 0; bz < after.layout.blocksZ; bz++) {
          for (let bx = 0; bx < after.layout.blocksX; bx++) {
            if (
              bx * size - margin <= x1! &&
              (bx + 1) * size + margin >= x0! &&
              bz * size - margin <= z1! &&
              (bz + 1) * size + margin >= z0!
            )
              expected.add(`${bx},${bz}`)
          }
        }
      }
      expect(new Set(moved.dirtied)).toEqual(expected)
      expect(moved.rebaked).toBeLessThan(first.rebaked / 4)
      // Every ancestor of a rebaked block: the roots over them.
      const roots = new Set(
        moved.dirtied.map((id) =>
          id
            .split(',')
            .map((v) => Number(v) >> 1)
            .join(','),
        ),
      )
      expect(moved.ancestors).toBe(roots.size)
      // Leaf packs no rebaked block lives in are untouched.
      const leafPacks = new Set(
        moved.dirtied.map((id) => {
          const [bx, bz] = id.split(',').map(Number) as [number, number]
          return `d2/${Math.floor((bx * 2) / 16)}_${Math.floor((bz * 2) / 16)}.pack`
        }),
      )
      for (const [path, bytes] of store.files) {
        if (path.startsWith('d2/') && !leafPacks.has(path)) expect(kept.get(path)).toBe(bytes)
      }
      // An incremental bake writes exactly what a full one does.
      const full = memoryPackStore()
      await bakeTerrain(after.input, after.stack, full, { force: true })
      expect([...store.files.keys()].sort()).toEqual([...full.files.keys()].sort())
      for (const [path, bytes] of full.files) {
        if (path !== 'manifest.json') expect(same(store.files.get(path), bytes), path).toBe(true)
      }
      const manifest = await readManifest(store)
      expect(manifest!.depthErrors.length).toBe(after.layout.depth + 1)
      expect(manifest!.depthErrors[0]!).toBeGreaterThan(manifest!.depthErrors[1]!)
      expect(manifest!.depthErrors[2]).toBe(0)
    },
    timeout(120_000),
  )

  it(
    'bakes the same bytes on the worker pool as inline',
    async () => {
      const t = terrain({ at: [300, 300] })
      const inline = memoryPackStore()
      const pooled = memoryPackStore()
      await bakeTerrain(t.input, t.stack, inline)
      const report = await bakeTerrain(t.input, t.stack, pooled, { workers })
      expect(report.rebaked).toBe(t.layout.blocksX * t.layout.blocksZ)
      for (const [path, bytes] of inline.files) {
        // The manifest records how long each block took.
        if (path !== 'manifest.json') expect(same(pooled.files.get(path), bytes), path).toBe(true)
      }
      expect(BLOCK_LEVELS).toBe(4)
    },
    timeout(120_000),
  )

  it(
    'reports heights clipped by heightRange once per block',
    async () => {
      const t = terrain({ at: [300, 300] })
      const narrow = {
        ...t.input,
        source: { ...t.input.source, heightRange: [-5, 5] as [number, number] },
      }
      const stack = { ...t.stack, lo: -5, hi: 5 }
      const warnings: string[] = []
      const report = await bakeTerrain(narrow, stack, memoryPackStore(), {
        warn: (e) => warnings.push(e.code),
      })
      expect(report.outOfRange.length).toBeGreaterThan(0)
      expect(warnings.length).toBe(report.outOfRange.length)
      expect(new Set(warnings)).toEqual(new Set(['terrain/out-of-range']))
    },
    timeout(120_000),
  )
})
