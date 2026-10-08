import type { World } from '@aethervtt/shard-core'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import { App } from '@aethervtt/shard-runtime'
import { Planet, TerrainWorld, terrainPlugin } from '@aethervtt/shard-terrain'
import { Grid, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { beforeAll, describe, expect, it } from 'vitest'
import { PlanetSurface } from './planet'
import { type CompiledRule, compileRules } from './rules'
import { ScatterSet } from './set'
import { P_X, PLACEMENT_STRIDE, type SurfaceChunk } from './surface'
import { cameraQuery } from './viewers'

const R = 600_000

let graph: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  graph = await NoiseGraph.create({
    output: 'h',
    nodes: { h: { fbm: { source: 'simplex', octaves: 4, frequency: 1e-3, seed: 3 } } },
  })
})

async function planet(): Promise<{ world: World; surface: PlanetSurface }> {
  const app = new App().addPlugin(TransformPlugin, terrainPlugin())
  await app.init()
  const w = app.world
  const height = w.initResource(NoiseGraphs).add(graph, 'hills')
  const e = w.spawn(
    [Grid, { cellSize: 2000 }],
    [Planet, { radius: R, height, heightScale: 120, seed: 5, ocean: false }],
    Transform,
  )
  app.update(1 / 60)
  const rt = w.resource(TerrainWorld).planets.get(e)!
  expect(rt.ready).toBe(true)
  return { world: w, surface: new PlanetSurface(rt, cameraQuery(w)) }
}

function rules(json: unknown): CompiledRule[] {
  const set = ScatterSet.deserialize(json as never)
  return compileRules([{ path: 'test.scatter.json', set, biome: -1 }], 5)
}

/** Every placement of `rule` in a block of chunks, as planet-frame points. */
function placeBlock(surface: PlanetSurface, rule: CompiledRule, side: number): Float64Array {
  const depth = surface.depths[rule.index]!
  // A block near a face's middle, away from cube edges.
  const mid = 2 ** (depth - 1)
  const points: number[] = []
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const chunk = surface.chunk(rule, 4, depth, mid + x, mid + y) as SurfaceChunk
      const job = surface.startPlacement(chunk, 0, undefined)
      const p = surface.finishPlacement(job)
      for (let i = 0; i < p.count; i++) {
        const o = i * PLACEMENT_STRIDE + P_X
        points.push(
          chunk.center[0]! + p.data[o]!,
          chunk.center[1]! + p.data[o + 1]!,
          chunk.center[2]! + p.data[o + 2]!,
        )
      }
    }
  }
  return Float64Array.from(points)
}

/** The smallest distance between any two points (a hash grid of `cell`-sized buckets). */
function minDistance(points: Float64Array, cell: number): number {
  const grid = new Map<string, number[]>()
  const n = points.length / 3
  let best = Number.POSITIVE_INFINITY
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(points[i * 3]! / cell)
    const cy = Math.floor(points[i * 3 + 1]! / cell)
    const cz = Math.floor(points[i * 3 + 2]! / cell)
    for (let dz = -1; dz <= 1; dz++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          for (const j of grid.get(key(cx + dx, cy + dy, cz + dz)) ?? []) {
            const d = Math.hypot(
              points[i * 3]! - points[j * 3]!,
              points[i * 3 + 1]! - points[j * 3 + 1]!,
              points[i * 3 + 2]! - points[j * 3 + 2]!,
            )
            if (d < best) best = d
          }
        }
    const k = key(cx, cy, cz)
    const list = grid.get(k)
    if (list) list.push(i)
    else grid.set(k, [i])
  }
  return best
}

describe('placement on a planet', () => {
  it('is seamless across 100 chunks: spacing holds across borders and density is within 10%', async () => {
    const { surface } = await planet()
    const compiled = rules({
      rules: [
        {
          name: 'boulders',
          items: [{ generator: 'shard/Rock' }],
          density: 0.01,
          spacing: 6,
          range: 400,
        },
      ],
    })
    surface.configure(compiled, [undefined], 1)
    const rule = compiled[0]!
    const points = placeBlock(surface, rule, 10)
    expect(minDistance(points, rule.spacing)).toBeGreaterThanOrEqual(rule.spacing - 1e-6)
    // Area of the block: 10 × 10 chunks of the rule's depth (they're near-square there).
    const depth = surface.depths[rule.index]!
    const size = (R * Math.PI) / 2 / 2 ** depth
    const expected = rule.density * 100 * size * size
    expect(Math.abs(points.length / 3 - expected) / expected).toBeLessThan(0.1)
  })

  it('places a chunk the same way twice, and in isolation', async () => {
    const { surface } = await planet()
    const compiled = rules({
      rules: [{ name: 'trees', items: [{ generator: 'shard/Tree' }], density: 0.02, spacing: 4 }],
    })
    surface.configure(compiled, [undefined], 1)
    const rule = compiled[0]!
    const depth = surface.depths[0]!
    const chunk = () => surface.chunk(rule, 2, depth, 7, 9)
    const a = surface.finishPlacement(surface.startPlacement(chunk(), 0, undefined))
    const b = surface.finishPlacement(surface.startPlacement(chunk(), 0, undefined))
    expect(a.count).toBeGreaterThan(20)
    expect(Array.from(a.data.subarray(0, a.count * PLACEMENT_STRIDE))).toEqual(
      Array.from(b.data.subarray(0, b.count * PLACEMENT_STRIDE)),
    )
  })

  it('keeps items within the slope and height masks', async () => {
    const { surface } = await planet()
    const compiled = rules({
      rules: [
        {
          name: 'flat',
          items: [{ generator: 'shard/Rock' }],
          density: 0.05,
          masks: { slope: [0, 8], height: [-20, 40] },
        },
      ],
    })
    surface.configure(compiled, [undefined], 1)
    const rule = compiled[0]!
    const depth = surface.depths[0]!
    const mid = 2 ** (depth - 1)
    let total = 0
    for (let x = 0; x < 6; x++) {
      const chunk = surface.chunk(rule, 4, depth, mid + x, mid)
      const p = surface.finishPlacement(surface.startPlacement(chunk, 0, undefined))
      total += p.count
      for (let i = 0; i < p.count; i++) {
        const o = i * PLACEMENT_STRIDE + P_X
        const x = chunk.center[0]! + p.data[o]!
        const y = chunk.center[1]! + p.data[o + 1]!
        const z = chunk.center[2]! + p.data[o + 2]!
        const h = Math.hypot(x, y, z) - R
        expect(h).toBeGreaterThanOrEqual(-20.01)
        expect(h).toBeLessThanOrEqual(40.01)
      }
    }
    // Some pass, and fewer than without masks.
    expect(total).toBeGreaterThan(0)
    const open = rules({
      rules: [{ name: 'flat', items: [{ generator: 'shard/Rock' }], density: 0.05 }],
    })
    surface.configure(open, [undefined], 2)
    let all = 0
    for (let x = 0; x < 6; x++) {
      const chunk = surface.chunk(open[0]!, 4, depth, mid + x, mid)
      all += surface.finishPlacement(surface.startPlacement(chunk, 0, undefined)).count
    }
    expect(total).toBeLessThan(all)
  })
})
