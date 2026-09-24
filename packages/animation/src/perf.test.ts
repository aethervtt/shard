import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import {
  Camera3d,
  DirectionalLight,
  forwardPlugin,
  OffscreenTarget,
  RenderStats,
  renderPlugin,
  Shaders,
} from '@shard/render'
import { App } from '@shard/runtime'
import { ScenePlugin } from '@shard/scene'
import { lookAt, Transform, TransformPlugin } from '@shard/transform'
import { describe, expect, it } from 'vitest'
import { sampleAnimations } from './player'
import { animationPlugin } from './plugin'
import { addCreatureAssets, creature, spawnCreatures } from './testing'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

/** 200 positions on a 20 × 10 grid, 1.6 m apart. */
function grid(): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let z = 0; z < 10; z++) for (let x = 0; x < 20; x++) out.push([(x - 9.5) * 1.6, 0, -z * 1.6])
  return out
}

const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

describe('the benchmark creature', () => {
  it('its clip loops without a seam: every channel ends where it starts', () => {
    const { clip } = creature()
    for (const c of clip.channels) {
      const last = c.values.length - c.width
      for (let k = 0; k < c.width; k++) expect(c.values[last + k]).toBeCloseTo(c.values[k]!, 5)
    }
  })
})

describe('performance', () => {
  it('200 characters of 60 joints: sampling under 2 ms a frame, allocating nothing', async () => {
    const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
    await app.init()
    const w = app.world
    const c = creature()
    expect(c.joints.length).toBe(60)
    const assets = addCreatureAssets(w, c)
    spawnCreatures(w, c, assets, grid())
    for (let i = 0; i < 120; i++) app.update(1 / 60) // bind, then let V8 optimize
    // Run the system alone, so the GC count is its own.
    const state = sampleAnimations.setup!(w)
    const run = () => sampleAnimations.run(state, w, undefined as never)
    for (let i = 0; i < 200; i++) {
      w.incrementTick()
      run()
    }
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    // Let the garbage from spawning 12,000 entities settle before counting collections.
    await new Promise((resolve) => setTimeout(resolve, 200))
    const times = new Float64Array(300)
    let collections = 0
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length
    })
    observer.observe({ entryTypes: ['gc'] })
    for (let f = 0; f < times.length; f++) {
      w.incrementTick()
      const t0 = performance.now()
      run()
      times[f] = performance.now() - t0
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    const list = [...times]
    console.log(
      `sampling 200 × 60 joints: ${Math.min(...list).toFixed(3)} ms best, ${median(list).toFixed(3)} ms median; GC events: ${collections}`,
    )
    expect(collections).toBe(0)
    expect(median(list)).toBeLessThan(budget(2))
  })

  it('200 skinned characters hold 60 fps at 1080p', async () => {
    const gpu: GpuContext = await createNodeGpuContext()
    const target = new OffscreenTarget(gpu, { label: 'perf', width: 1920, height: 1080 })
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, target }),
      forwardPlugin(),
      ScenePlugin,
      animationPlugin,
    )
    try {
      await app.init()
      const w = app.world
      const c = creature()
      const assets = addCreatureAssets(w, c)
      spawnCreatures(w, c, assets, grid())
      w.spawn(
        [DirectionalLight, { illuminance: 30_000, shadows: true }],
        [Transform, { rotation: lookAt([0, 0, 0], [0.4, -1, -0.6]) as never }],
      )
      const eye: [number, number, number] = [0, 14, 18]
      w.spawn(
        [Camera3d, { fovY: 50 }],
        [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, -7]) as never }],
      )
      const frame = async () => {
        const t0 = performance.now()
        app.update(1 / 60)
        await gpu.device.queue.onSubmittedWorkDone()
        return performance.now() - t0
      }
      for (let i = 0; i < 60; i++) {
        await frame()
        await w.resource(Shaders).whenIdle()
        await gpu.pipelines.whenIdle()
      }
      const times: number[] = []
      for (let i = 0; i < 120; i++) times.push(await frame())
      const stats = [...w.resource(RenderStats).values()][0]!
      console.log(
        `200 skinned characters at 1080p: ${median(times).toFixed(2)} ms median frame (CPU + GPU), ${stats.visible} visible, ${stats.drawCalls} draws`,
      )
      expect(stats.visible).toBeGreaterThanOrEqual(200)
      expect(median(times)).toBeLessThan(budget(1000 / 60))
    } finally {
      target.destroy()
      gpu.destroy()
    }
  }, 60_000)
})
