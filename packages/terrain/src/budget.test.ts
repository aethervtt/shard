import { budget, slack, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainBudget } from './components'
import type { PlanetRender } from './render'
import { EARTH_HEIGHT, earthDescent, planetApp, settleTerrain } from './test-planet'

let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  terrain = await NoiseGraph.create(EARTH_HEIGHT)
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

const sorted = (a: number[]) => [...a].sort((x, y) => x - y)
const pct = (a: number[], p: number) => sorted(a)[Math.min(a.length - 1, Math.floor(a.length * p))]!

describe('terrain budget (spec 0043)', () => {
  it('keeps generation within TerrainBudget and a descent under 16.6 ms a frame', {
    timeout: timeout(240_000),
  }, async () => {
    const R = 6.371e6
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 3000,
      height: terrain,
      width: 960,
      heightPx: 540,
    })
    const w = p.world
    const rt = p.runtime()
    const limits = w.resource(TerrainBudget)
    // 40 000 km to 2 m in 30 s: exponential, looking at the ground ahead. Outside the bench only the
    // budget's limits are checked, and a 10 s descent reaches them as surely (it's 35 minutes of
    // WARP on CI's Windows runners at 30 s).
    const FRAMES = timingMode === 'bench' ? 1800 : 600
    const descent = earthDescent(p, R, FRAMES)
    const times: number[] = []
    const cpu: number[] = []
    const gpuTimes: number[] = []
    let jobs = 0
    let most = 0
    // Start from a loaded planet. Kernels compile asynchronously, and frames here are faster
    // than the compile: without this, generation began ~1,400 frames in, and under a loaded
    // suite (or a slow shader compiler) not at all.
    descent.look(0)
    await settleTerrain(p)
    for (let f = 0; f < FRAMES + 120; f++) {
      descent.look(f + 1)
      // CPU: the update; GPU: submit to done (the queue is idle when the frame starts). A real
      // frame loop overlaps them, so a frame takes the longer of the two.
      const t0 = performance.now()
      p.app.update(1 / 60)
      const t1 = performance.now()
      await gpu.device.queue.onSubmittedWorkDone()
      const t2 = performance.now()
      const pr = rt.parts.get('render') as PlanetRender
      jobs += pr.stats.lastFrameJobs
      most = Math.max(most, pr.stats.lastFrameJobs)
      // The first frames compile pipelines.
      if (f >= 60) {
        cpu.push(t1 - t0)
        gpuTimes.push(t2 - t1)
        times.push(Math.max(t1 - t0, t2 - t1))
      }
    }
    const pr = rt.parts.get('render') as PlanetRender
    expect(w.resource(Gpu).errors).toEqual([])
    expect(jobs).toBeGreaterThan(200)
    expect(most).toBeLessThanOrEqual(limits.chunksPerFrame)
    expect(pr.slots.length).toBeLessThanOrEqual(limits.pool)
    // GPU generation time, where timestamps measure it.
    if (pr.msPerJob > 0)
      expect(pr.msPerJob * limits.chunksPerFrame).toBeLessThan(
        limits.msPerFrame * slack + pr.msPerJob,
      )
    expect(pct(times, 0.5)).toBeLessThan(budget('terrain/descent-frame'))
    expect(pct(times, 0.95)).toBeLessThan(budget('terrain/descent-frame'))
  })
})
