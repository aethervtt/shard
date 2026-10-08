import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { Gpu } from '@aethervtt/shard-render'
import { expectScenario, measureScenario } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { EARTH_HEIGHT, earthDescent, planetApp, settleTerrain } from './test-planet'

// Spec 0075's planet-descent scenario: 0043's Earth descent (budget.test.ts's, 40 000 km to 2 m),
// at 1920×1080 and render scale 1 under `pnpm bench`, through a capture. `pnpm test` descends in a
// few frames, small: the capture runs and every slice key covers a span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** 30 s of descent, then 2 s on the ground, under the bench. */
const DESCENT = bench ? 1800 : 40
const FRAMES = DESCENT + (bench ? 120 : 8)
const R = 6.371e6

let gpu: GpuContext
let terrain: NoiseGraph

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  await loadNoiseKernel()
  terrain = await NoiseGraph.create(EARTH_HEIGHT)
})

// Descents submit frames faster than a software GPU runs them: wait for the queue before destroying.
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
}, timeout(120_000))

describe('scenario: planet-descent (0075)', () => {
  it('scenario: planet-descent lands on Earth through a capture; every slice covers spans that ran', {
    timeout: timeout(600_000),
  }, async () => {
    const p = await planetApp(gpu, {
      radius: R,
      heightScale: 3000,
      height: terrain,
      width: WIDTH,
      heightPx: HEIGHT,
    })
    const descent = earthDescent(p, R, DESCENT)
    descent.look(0)
    await settleTerrain(p)
    const run = await measureScenario(p.world, 'planet-descent', {
      frames: FRAMES,
      step: async (i) => {
        descent.look(i + 1)
        p.app.update(1 / 60)
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((r) => setTimeout(r, 0))
      },
    })
    expect(p.world.resource(Gpu).errors).toEqual([])
    console.info(
      `planet-descent spans: ${run.spans.join(', ')}\n` +
        run.slices
          .map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`)
          .join('\n'),
    )
    expectScenario(run, expect)
    await p.app.dispose()
  })
})
