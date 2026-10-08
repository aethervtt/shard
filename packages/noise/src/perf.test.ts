import { budget } from '@aethervtt/shard-core/test-env'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  loadNoiseKernel,
  NoiseGraph,
  noiseKernel,
  poolTiming,
  sampleNoise,
  sampleSpherePatchAsync,
} from '.'
import { PLANET } from './planet'

beforeAll(async () => {
  await loadNoiseKernel()
})

describe('noise performance', () => {
  it('samples a 6-octave fBm simplex 3D graph at ≥ 40M points/s per core (SIMD)', () => {
    expect(noiseKernel().simd).toBe(true)
    const g = NoiseGraph.fromJson({
      output: 'n',
      nodes: { n: { fbm: { source: 'simplex', octaves: 6 } } },
    })
    const n = 1 << 20
    const pts = new Float32Array(n * 3)
    for (let i = 0; i < pts.length; i++) pts[i] = ((i * 2654435761) % 10007) / 100 - 50
    const out = new Float32Array(n)
    let best = Infinity
    // Warm up so V8 tiers the kernel up, then keep the best run (the CPU is shared).
    for (let r = 0; r < 24; r++) {
      const t0 = performance.now()
      sampleNoise(g, 7, pts, out)
      best = Math.min(best, performance.now() - t0)
    }
    const rate = (n / best) * 1000
    console.log(`fbm6 simplex3: ${(rate / 1e6).toFixed(1)}M points/s`)
    expect(rate).toBeGreaterThanOrEqual(budget('noise/fbm6'))
  })

  describe('a 257² sphere patch of the planet graph on the pool', () => {
    const pool = createNodeWorkers()
    afterAll(() => pool.dispose())

    it('completes in ≤ 8 ms with the main thread blocked ≤ 0.2 ms', async () => {
      const g = NoiseGraph.fromJson(PLANET)
      const out = new Float32Array(257 * 257)
      const patch = { face: 2, x0: -0.4, y0: 0.1, extent: 0.05, resolution: 257, radius: 6.371e6 }
      const times: number[] = []
      const blocked: number[] = []
      for (let r = 0; r < 40; r++) {
        poolTiming.mainThreadMs = 0
        const t0 = performance.now()
        await sampleSpherePatchAsync(pool, g, r, patch, out)
        times.push(performance.now() - t0)
        blocked.push(poolTiming.mainThreadMs)
      }
      // After warm-up (workers instantiated and tiered up).
      const settled = times.slice(20).sort((a, b) => a - b)
      const median = settled[settled.length >> 1]!
      const block = blocked.slice(20).sort((a, b) => a - b)[10]!
      console.log(
        `257² patch on ${pool.size} workers: ${median.toFixed(2)} ms, main thread ${block.toFixed(3)} ms`,
      )
      expect(median).toBeLessThanOrEqual(budget('noise/sphere-patch'))
      expect(block).toBeLessThanOrEqual(budget('noise/sphere-patch-main'))
    })
  })
})
