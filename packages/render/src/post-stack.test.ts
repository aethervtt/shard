import { timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Gpu, renderPlugin, Views } from './plugin'
import { PostEffect } from './post'
import {
  ALL_POST_EFFECTS,
  POST_LENS,
  postCamera,
  postEffects,
  postScenePlugin,
  spawnPostScene,
} from './post-scene'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { expectScenario, measureScenario, settle } from './testing'
import { cameraOf } from './view'

// Spec 0075's post-stack scenario: the playground's #post courtyard (`spawnPostScene`) with every
// post effect on (TAA, SSAO, fog, motion blur, depth of field, bloom, auto exposure, grading,
// vignette), flown along `postCamera` at 1920×1080 and render scale 1 under `pnpm bench`, 120 fps.
// `pnpm test` flies a few frames small: the capture runs and every slice key covers a span that ran.

const bench = timingMode === 'bench'
const WIDTH = bench ? 1920 : 320
const HEIGHT = bench ? 1080 : 180
/** 10 s of the path under the bench. */
const FRAMES = bench ? 600 : 24

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
})

describe('scenario: post-stack (0075)', () => {
  it('scenario: post-stack flies the #post courtyard with every effect on through a capture; every slice covers spans that ran', {
    timeout: timeout(300_000),
  }, async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin(),
      postScenePlugin,
    )
    await app.init()
    const world = app.world
    const target = new OffscreenTarget(gpu, { label: 'post', width: WIDTH, height: HEIGHT })
    const ref = world.resource(RenderTargets).add(target, 'post')
    const camera = world.spawn(
      [Camera3d, { target: ref as never, fovY: 50 }],
      POST_LENS,
      Transform,
      ...(postEffects(ALL_POST_EFFECTS) as []),
    )
    spawnPostScene(world)
    const place = (i: number) => {
      const { eye, target: at } = postCamera(i / 60)
      world.set(camera, Transform, { translation: eye, rotation: lookAt(eye, at) })
    }
    place(0)
    await settle(app)
    // Every effect the page turns on runs here too.
    const view = world.resource(Views).list[0]!
    const effects = cameraOf(view)!.post.effects
    for (const bit of [
      PostEffect.Taa,
      PostEffect.Ssao,
      PostEffect.Fog,
      PostEffect.MotionBlur,
      PostEffect.DepthOfField,
      PostEffect.Bloom,
      PostEffect.AutoExposure,
      PostEffect.Grading,
      PostEffect.Vignette,
    ]) {
      expect(effects & bit).toBe(bit)
    }
    const run = await measureScenario(world, 'post-stack', {
      frames: FRAMES,
      step: async (i) => {
        place(i)
        app.update(1 / 60)
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((r) => setTimeout(r, 0))
      },
    })
    expect(world.resource(Gpu).errors).toEqual([])
    console.info(
      `post-stack spans: ${run.spans.join(', ')}\n` +
        run.slices
          .map((s) => `  ${s.track} ${s.key}: p95 ${s.p95.toFixed(3)} ms (${s.covers.join(', ')})`)
          .join('\n'),
    )
    expectScenario(run, expect)
    await app.dispose()
    target.destroy()
  })
})
