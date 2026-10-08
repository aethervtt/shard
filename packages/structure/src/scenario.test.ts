import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Gpu } from '@aethervtt/shard-render'
import { expectScenario, measureScenario, settle } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { maxScene } from './fixtures'
import { rig } from './harness'

// Spec 0075's tabletop-max scenario: 0055's max structure fixture (every contract limit at once:
// 5,000 walls, 1,024 openings, 256 floors, 256 props), panned across at a tabletop pitch under a
// shadowed sun, at 1920×1080 and render scale 1 under `pnpm bench`. `pnpm test` pans a few frames
// small: the capture runs and every slice key covers a span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** 10 s of panning under the bench. */
const FRAMES = bench ? 600 : 24

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

describe('scenario: tabletop-max (0075)', () => {
  it('scenario: tabletop-max pans over the max fixture through a capture; every slice covers spans that ran', {
    timeout: timeout(300_000),
  }, async () => {
    const r = await rig(gpu, { width: WIDTH, height: HEIGHT })
    r.host.sync(maxScene())
    // 40 m up, pitched about 55° down, panning 160 m east over the rooms (225 m a side).
    const place = (i: number) => {
      const x = 30 + (160 * i) / Math.max(1, FRAMES - 1)
      r.look([x, 40, 140], [x, 0, 112])
    }
    place(0)
    await settle(r.app)
    const run = await measureScenario(r.app.world, 'tabletop-max', {
      frames: FRAMES,
      step: async (i) => {
        place(i)
        r.frame()
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((resolve) => setTimeout(resolve, 0))
      },
    })
    expect(r.app.world.resource(Gpu).errors).toEqual([])
    console.info(
      `tabletop-max spans: ${run.spans.join(', ')}\n` +
        run.slices
          .map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`)
          .join('\n'),
    )
    expectScenario(run, expect)
    await r.dispose()
  })
})
