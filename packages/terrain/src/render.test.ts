import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderOf } from './render'
import { capture, placeCamera, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let hills: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create({
    output: 'h',
    nodes: {
      c: { fbm: { source: 'simplex', octaves: 6, frequency: 4e-4, seed: 1 } },
      h: { add: ['c', { multiply: [{ ridged: { octaves: 5, frequency: 4e-3, seed: 2 } }, 0.2] }] },
    },
  })
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

const isSky = (d: Uint8Array, i: number) => d[i]! > 200 && d[i + 1]! < 60 && d[i + 2]! > 200

describe('planet rendering', () => {
  it('draws a 4 km planet from orbit with GPU chunks', async () => {
    const p = await planetApp(gpu, { radius: 4000, heightScale: 300, height: hills })
    placeCamera(p, [0, 0, 14000], [0, 0, 0])
    const frames = await settleTerrain(p)
    const shot = await capture(p)
    expect(p.world.resource(Gpu).errors).toEqual([])
    const pr = renderOf(p.world, p.runtime())
    expect(pr.stats.generated).toBeGreaterThan(0)
    // The planet covers the middle of the view; the corners are sky.
    const mid = (32 * 96 + 48) * 4
    expect(isSky(shot.data, mid)).toBe(false)
    expect(isSky(shot.data, 0)).toBe(true)
    expect(frames).toBeLessThan(400)
  })
})
