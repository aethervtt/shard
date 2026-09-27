import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainBudget } from './components'
import { heightAt } from './heights'
import type { PlanetRender } from './render'
import { placeCamera, planetApp } from './test-planet'

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
    const n = [0.3, 0.9, 0.3].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const east = [n[2]!, 0, -n[0]!].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const ground = Math.max(0, heightAt(rt, n[0]!, n[1]!, n[2]!))
    // 40 000 km to 2 m in 30 s: exponential, looking at the ground ahead.
    const FRAMES = 1800
    const ratio = (2 / 4e7) ** (1 / FRAMES)
    const times: number[] = []
    const cpu: number[] = []
    const gpuTimes: number[] = []
    let jobs = 0
    let most = 0
    let altitude = 4e7
    for (let f = 0; f < FRAMES + 120; f++) {
      if (f < FRAMES) altitude *= ratio
      const eye = n.map((v) => v * (R + ground + altitude))
      const ahead = Math.min(altitude * 1.2, R * 0.5)
      placeCamera(
        p,
        eye,
        n.map((v, k) => v * (R + ground) + east[k]! * ahead),
      )
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
        budget(limits.msPerFrame) + pr.msPerJob,
      )
    expect(pct(times, 0.5)).toBeLessThan(budget(16.6))
    expect(pct(times, 0.95)).toBeLessThan(budget(16.6))
  })
})
