import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PassCosts } from './ablation'
import { RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { crowdCamera, spawnCrowd } from './crowd'
import { Gpu, Graph, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { expectScenario, measureScenario, settle } from './testing'

// Spec 0075's crowd scenario: 0022's 200k instances (the playground's #crowd page, `spawnCrowd`)
// on its turntable, at 1920×1080 and render scale 1 under `pnpm bench`. `pnpm test` renders 20k
// small for a few frames: the capture runs and every slice key covers a span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** 10 s of the turntable under the bench. */
const FRAMES = bench ? 600 : 24
/** The playground's turn: 2.86° a second. */
const TURN = (2.86 * Math.PI) / 180

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

/** The crowd, its camera on the turntable, settled; `step` runs path frame `i`. */
async function crowd(count: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'crowd', width: WIDTH, height: HEIGHT })
  const ref = world.resource(RenderTargets).add(target, 'crowd')
  const camera = world.spawn(
    [Camera3d, { target: ref as never, fovY: 60, far: 800 }],
    [Exposure, { ev100: 14 }],
    Transform,
  )
  spawnCrowd(world, { count })
  const place = (i: number) => {
    const { eye, target: at } = crowdCamera((i * TURN) / 60)
    world.set(camera, Transform, { translation: eye, rotation: lookAt(eye, at) })
  }
  place(0)
  await settle(app)
  return {
    app,
    world,
    step: async (i: number) => {
      place(i)
      app.update(1 / 60)
      await gpu.device.queue.onSubmittedWorkDone()
      await new Promise((r) => setTimeout(r, 0))
    },
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}

describe('scenario: crowd (0075)', () => {
  it('scenario: crowd turns round 0022’s instances through a capture; every slice covers spans that ran', {
    timeout: timeout(300_000),
  }, async () => {
    const c = await crowd(bench ? 200_000 : 20_000)
    const run = await measureScenario(c.world, 'crowd', { frames: FRAMES, step: c.step })
    expect(c.world.resource(Gpu).errors).toEqual([])
    console.info(
      `crowd spans: ${run.spans.join(', ')}\n` +
        run.slices
          .map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`)
          .join('\n'),
    )
    expectScenario(run, expect)
    await c.dispose()
  })

  it('measures GPU slices by ablation where pass timestamps overlap: each disables the nodes it covers', {
    timeout: timeout(120_000),
  }, async () => {
    const c = await crowd(2000)
    if (!c.world.resource(Graph).timer.enabled) return
    const run = await measureScenario(c.world, 'crowd', {
      frames: 8,
      step: c.step,
      ablation: { frames: 3, rounds: 1, force: true },
    })
    const gpuSlices = run.slices.filter((s) => s.track === 'gpu')
    expect(gpuSlices.map((s) => s.measuredBy)).toEqual(gpuSlices.map(() => 'ablation'))
    for (const s of gpuSlices) expect(Number.isFinite(s.p95) && s.p95 >= 0).toBe(true)
    // gpu:shadows stood for both cascade nodes' passes, disabled together.
    const latest = c.world.resource(PassCosts).latest!
    expect(latest.passes.map((p) => p.pass).sort()).toEqual(gpuSlices.map((s) => s.key).sort())
    // Every node runs again afterwards.
    expect(c.world.resource(Gpu).errors).toEqual([])
    await c.dispose()
  })
})
