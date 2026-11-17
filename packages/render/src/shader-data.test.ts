import { defineSystem, ProfilerResource, type ShardError, Update } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { SHADER_DATA_SLOTS, ShaderData, ShaderDataBlock } from './globals'
import { Mesh3d, MeshMaterial } from './instances'
import { Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { settle } from './testing'

// shard::shader_data (0127). What materials read from it, in every pass and on both tiers, is
// tested with the wind plugin on in wind/src/shader-data.test.ts (render can't depend on wind).

describe('ShaderData (0127)', () => {
  it('hands out named slots once, and says how many are left when full', () => {
    const data = new ShaderDataBlock()
    expect(data.length).toBe(0)
    expect(data.reserve('sea', 82)).toBe(0)
    expect(data.reserve('spray', 300)).toBe(82)
    expect(data.reserve('sea', 82)).toBe(0)
    expect(data.length).toBe(382 * 4)
    let error: ShardError | undefined
    try {
      data.reserve('wakes', SHADER_DATA_SLOTS)
    } catch (e) {
      error = e as ShardError
    }
    expect(error?.code).toBe('render/shader-data-full')
    expect(error?.message).toContain(`${SHADER_DATA_SLOTS - 382} are left`)
    expect(data.reserve('rest', SHADER_DATA_SLOTS - 382)).toBe(382)
  })
})

describe('ShaderData uploads (0127)', () => {
  let gpu: GpuContext
  beforeAll(async () => {
    gpu = await createNodeGpuContext()
  })
  afterAll(() => gpu?.destroy())

  async function scene(slots: number) {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
    )
    await app.init()
    const world = app.world
    const block = slots > 0 ? world.resource(ShaderData).reserve('test/all', slots) : 0
    // What a game does each frame: rewrite every slot it reserved.
    let frame = 0
    app.addSystems(
      Update,
      defineSystem({
        name: 'test/rewrite',
        run(_, w) {
          const values = w.resource(ShaderData).values
          frame++
          for (let i = block * 4; i < (block + slots) * 4; i++) values[i] = frame + i
        },
      }),
    )
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
      [MeshMaterial, { material: world.resource(Materials).add(new MaterialAsset({})) }],
      [Transform, { translation: [0, 0, -4] }],
    )
    const target = world
      .resource(RenderTargets)
      .add(new OffscreenTarget(gpu, { label: 'shader-data', width: 32, height: 32 }), 'shader-data')
    world.spawn([Camera3d, { target }], Transform)
    await settle(app)
    return app
  }

  /** render/forward-queue's CPU time (it uploads the block), best of `frames`. */
  function queueTime(app: App, frames: number): number {
    const profiler = app.world.resource(ProfilerResource)
    let best = Number.POSITIVE_INFINITY
    for (let f = 0; f < frames; f++) {
      app.update(1 / 60)
      best = Math.min(best, profiler.timing('render/forward-queue')!.last)
    }
    return best
  }

  it('uploads all 1024 slots each frame for under render/shader-data-upload', {
    timeout: timeout(60_000),
  }, async () => {
    const full = await scene(SHADER_DATA_SLOTS)
    const empty = await scene(0)
    // Only `pnpm bench` measures; elsewhere the frames just have to run.
    const frames = timingMode === 'bench' ? 200 : 2
    const withBlock = queueTime(full, frames)
    const without = queueTime(empty, frames)
    if (timingMode === 'bench') {
      console.info(
        `render/forward-queue: ${withBlock.toFixed(3)} ms with 1024 slots, ${without.toFixed(3)} ms without`,
      )
    }
    expect(withBlock - without).toBeLessThan(budget('render/shader-data-upload'))
    expect(full.world.resource(Gpu).errors).toEqual([])
    await full.dispose()
    await empty.dispose()
  })
})
