import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { heightAt } from './heights'
import { placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  terrain = await NoiseGraph.create({
    output: 'h',
    nodes: {
      continents: { fbm: { source: 'simplex', octaves: 7, frequency: 3e-6, seed: 1 } },
      ridges: { ridged: { source: 'simplex', octaves: 8, frequency: 3e-4, seed: 2 } },
      h: { add: ['continents', { multiply: ['ridges', 0.15] }] },
    },
  })
})

afterAll(() => gpu?.destroy())

/** Chunks selected 500 m up, looking at the horizon, on a target of this size and density. */
async function chunks(width: number, height: number, pixelRatio: number) {
  const R = 6.371e6
  const p = await planetApp(gpu, {
    radius: R,
    heightScale: 3000,
    height: terrain,
    width,
    heightPx: height,
    pixelRatio,
  })
  const rt = p.runtime()
  const n = [0.3, 0.9, 0.3].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
  const east = [n[2]!, 0, -n[0]!].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
  const ground = Math.max(0, heightAt(rt, n[0]!, n[1]!, n[2]!))
  const eye = n.map((v) => v * (R + ground + 500))
  placeCamera(
    p,
    eye,
    n.map((v, k) => v * (R + ground) + east[k]! * 20_000),
  )
  await settleTerrain(p)
  return rt.selection.renderedCount
}

describe('terrain detail on high-density displays (spec 0051)', () => {
  it('selects by CSS pixels: a 2× display gets the detail of a 1× one its CSS size', async () => {
    const css = await chunks(480, 270, 1)
    const retina = await chunks(960, 540, 2)
    const dense = await chunks(960, 540, 1)
    expect(retina).toBe(css)
    // Measured in device pixels it would refine much further.
    expect(dense).toBeGreaterThan(css * 1.3)
  })
})
