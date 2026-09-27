import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Planet, TerrainBudget } from './components'
import type { PlanetRender } from './render'
import { capture, placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let rough: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  rough = await NoiseGraph.create({
    output: 'h',
    nodes: {
      m: { ridged: { source: 'simplex', octaves: 8, frequency: 2e-5, seed: 5 } },
      h: { add: ['m', { multiply: [{ fbm: { octaves: 6, frequency: 1.5e-3, seed: 6 } }, 0.05] }] },
    },
  })
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

describe('terrain detail limits', () => {
  it('stops splitting rough terrain at a screen vertex spacing, without holes', {
    timeout: timeout(240_000),
  }, async () => {
    const R = 6_371_000
    const counts: number[] = []
    for (const vertexPixels of [0, 4]) {
      const p = await planetApp(gpu, {
        radius: R,
        heightScale: 6000,
        height: rough,
        width: 480,
        heightPx: 270,
      })
      p.world.set(p.planet, Planet, { vertexPixels })
      // 2 km over the ground, looking at the horizon.
      const up = [0.3, 0.8, 0.52]
      const l = Math.hypot(up[0]!, up[1]!, up[2]!)
      const n = up.map((v) => v / l)
      placeCamera(
        p,
        n.map((v) => v * (R + 8000)),
        // Down a little: the lower frame is ground out to ~50 km.
        n.map((v, k) => v * (R + 8000 - 9000) + [1, 0, 0][k]! * 50_000),
      )
      await settleTerrain(p, 600)
      counts.push(p.runtime().selection.renderedCount)
      // A hole shows the magenta clear color: none in the lower part of the frame (all ground).
      const shot = await capture(p)
      let magenta = 0
      for (let y = 190; y < 270; y++) {
        for (let x = 0; x < 480; x++) {
          const i = (y * 480 + x) * 4
          if (shot.data[i]! > 200 && shot.data[i + 1]! < 60 && shot.data[i + 2]! > 200) magenta++
        }
      }
      expect(magenta).toBe(0)
      expect(p.world.resource(Gpu).errors).toEqual([])
    }
    // Rough ground: well under two thirds of the chunks.
    expect(counts[1]!).toBeLessThan(counts[0]! * 0.67)
  })

  it('holds TerrainBudget.triangles by coarsening, and refines back when the budget allows', {
    timeout: timeout(240_000),
  }, async () => {
    const R = 6_371_000
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 6000,
      height: rough,
      width: 1280,
      heightPx: 720,
    })
    const n = [0.3, 0.8, 0.52].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    placeCamera(
      p,
      n.map((v) => v * (R + 8000)),
      n.map((v, k) => v * (R + 8000 - 9000) + [1, 0, 0][k]! * 50_000),
    )
    await settleTerrain(p, 600)
    const rt = p.runtime()
    const perChunk = 2 * 32 * 32
    const free = rt.selection.renderedCount * perChunk
    expect(rt.lodBias).toBe(1)
    // Half of what it draws: the bias rises until the planet fits.
    const budget = p.world.resource(TerrainBudget)
    budget.triangles = Math.round(free / 2)
    for (let f = 0; f < 240; f++) p.app.update(1 / 60)
    await settleTerrain(p, 600)
    expect(rt.lodBias).toBeGreaterThan(1)
    expect(rt.selection.renderedCount * perChunk).toBeLessThanOrEqual(budget.triangles * 1.1)
    // Room again: back to the planet's own detail.
    budget.triangles = free * 4
    for (let f = 0; f < 240; f++) p.app.update(1 / 60)
    expect(rt.lodBias).toBe(1)
  })

  it('stops generating once a still camera has its chunks, even with the pool full', {
    timeout: timeout(240_000),
  }, async () => {
    const R = 6_371_000
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 6000,
      height: rough,
      width: 960,
      heightPx: 540,
    })
    // A pool smaller than what the view would prefetch.
    p.world.resource(TerrainBudget).pool = 300
    const n = [0.3, 0.8, 0.52].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    placeCamera(
      p,
      n.map((v) => v * (R + 3000)),
      n.map((v, k) => v * (R + 3000 - 2000) + [1, 0, 0][k]! * 20_000),
    )
    await settleTerrain(p, 400)
    const pr = p.runtime().parts.get('render') as PlanetRender
    expect(pr.slots.length).toBe(300)
    const generated = pr.stats.generated
    const evicted = pr.stats.evicted
    for (let f = 0; f < 120; f++) p.app.update(1 / 60)
    // Prefetches no longer evict each other: nothing regenerates while nothing moves.
    expect(pr.stats.generated - generated).toBe(0)
    expect(pr.stats.evicted - evicted).toBe(0)
  })
})
