import { ChildOf, defineComponent, t } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  DirectionalLight,
  forwardPlugin,
  OffscreenTarget,
  RenderStats,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { lookAt, Transform, TransformPlugin, worldPosition } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { Animator, AnimatorStateEntered, describeAnimator, evaluateGraphs } from './animator'
import { animationLayer } from './api'
import { AnimationClips } from './clip'
import { AnimationPlayer } from './components'
import { AnimationGraphs, createAnimationGraph } from './graph'
import { describeIk, solveIk, TwoBoneIk } from './ik'
import { sampleAnimations } from './player'
import { animationPlugin } from './plugin'
import {
  addBipedAssets,
  addCreatureAssets,
  biped,
  creature,
  spawnBiped,
  spawnCreatures,
} from './testing'

/** Spec budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */
const budget = (ms: number) => ms * (process.env.SHARD_BENCH ? 1 : 3)

/** 200 positions on a 20 × 10 grid, 1.6 m apart. */
function grid(): [number, number, number][] {
  const out: [number, number, number][] = []
  for (let z = 0; z < 10; z++) for (let x = 0; x < 20; x++) out.push([(x - 9.5) * 1.6, 0, -z * 1.6])
  return out
}

const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

const Mover = defineComponent('test-perf/Mover', { velocity: t.vec3() })

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

  it('200 animators evaluate in under 0.5 ms a frame, allocating nothing', async () => {
    const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
    await app.init()
    const w = app.world
    const c = creature()
    const assets = addCreatureAssets(w, c)
    const store = w.resource(AnimationClips)
    const walk = store.add({ ...c.clip, name: 'walk', duration: 1.2 })
    const run = store.add({ ...c.clip, name: 'run', duration: 0.8 })
    const graph = w.resource(AnimationGraphs).add(
      createAnimationGraph({
        parameters: {
          speed: {
            type: 'float',
            bind: { component: 'test-perf/Mover', field: 'velocity', op: 'horizontal' },
          },
          grounded: { type: 'bool', default: true },
          attack: { type: 'trigger' },
        },
        layers: [
          {
            name: 'base',
            states: {
              locomotion: {
                blend1d: {
                  parameter: 'speed',
                  clips: [
                    [0, '#idle'],
                    [1.5, '#walk'],
                    [5, '#run'],
                  ],
                },
              },
              fall: { clip: '#idle' },
            },
            transitions: [
              { from: 'locomotion', to: 'fall', when: '!grounded && speed > 0.1', duration: 0.15 },
              { from: 'fall', to: 'locomotion', when: 'grounded', duration: 0.1 },
            ],
          },
          {
            name: 'upper',
            states: { none: {}, swing: { clip: '#run', loop: 'once' } },
            transitions: [
              { from: 'none', to: 'swing', when: 'attack', duration: 0.1 },
              { from: 'swing', to: 'none', exitTime: 1, duration: 0.2 },
            ],
          },
        ],
        clips: { idle: assets.clip, walk, run },
      }),
    )
    const roots = spawnCreatures(w, c, assets, grid())
    roots.forEach((root, i) => {
      w.add(root, Mover, { velocity: [0.2 + (i % 40) * 0.1, 0, 0] })
      w.add(root, Animator, { graph: graph as never })
    })
    // Moving speeds (bound, written back to AnimatorParams) with no transitions: steady state.
    const movers = w.query({ with: [Mover] })
    let tick = 0
    const move = () => {
      tick++
      for (const table of movers.tables) {
        const v = table.column(Mover, 'velocity')
        for (let r = 0; r < table.count; r++) v[r * 3] = 0.2 + ((r + tick) % 40) * 0.1
      }
    }
    for (let i = 0; i < 120; i++) app.update(1 / 60)
    expect(
      describeAnimator(w, roots[7]!)!.layers[0]!.active[0]!.motions.filter((m) => m.weight > 0),
    ).toHaveLength(2)
    w.reader(AnimatorStateEntered).read()
    const state = evaluateGraphs.setup!(w)
    const step = () => evaluateGraphs.run(state, w, undefined as never)
    for (let i = 0; i < 300; i++) {
      move()
      w.incrementTick()
      step()
    }
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Enough frames that 16 bytes per animator per frame (one boxed number) would fill the young
    // generation.
    const times = new Float64Array(5000)
    let collections = 0
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length
    })
    observer.observe({ entryTypes: ['gc'] })
    for (let f = 0; f < times.length; f++) {
      move()
      w.incrementTick()
      const t0 = performance.now()
      step()
      times[f] = performance.now() - t0
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    const list = [...times]
    console.log(
      `200 animators: ${Math.min(...list).toFixed(3)} ms best, ${median(list).toFixed(3)} ms median; GC events: ${collections}`,
    )
    expect(collections).toBe(0)
    expect(median(list)).toBeLessThan(budget(0.5))
  })

  it('100 characters with two-bone foot IK solve in under 1 ms a frame, allocating nothing', async () => {
    const app = new App().addPlugin(TransformPlugin, ScenePlugin, animationPlugin)
    await app.init()
    const w = app.world
    const body = biped()
    const assets = addBipedAssets(w, body)
    const legs: { ik: number; foot: number; target: number }[] = []
    for (let k = 0; k < 100; k++) {
      const { root, joint } = spawnBiped(w, body, assets, [
        (k % 10) * 1.2,
        0,
        -Math.floor(k / 10) * 1.2,
      ])
      w.add(root, AnimationPlayer, {
        layers: [animationLayer(assets.idle, { time: (k * 0.13) % 2 })],
      })
      for (const side of ['L', 'R'] as const) {
        const target = w.spawn([Transform, {}], [ChildOf, { parent: root }])
        const pole = w.spawn(
          [Transform, { translation: [0, 0.5, -1] }],
          [ChildOf, { parent: root }],
        )
        const foot = joint(body.path('Foot', side))
        const ik = w.spawn(
          [
            TwoBoneIk,
            {
              root: body.path('UpLeg', side),
              mid: body.path('Leg', side),
              tip: body.path('Foot', side),
              target,
              pole,
            },
          ],
          [ChildOf, { parent: root }],
        )
        legs.push({ ik, foot, target })
      }
    }
    // Targets a little above and ahead of each animated foot (knees bend), so every leg really solves.
    app.update(1 / 60)
    for (const leg of legs) {
      const p = worldPosition(w, leg.foot)
      const parent = worldPosition(w, w.get(leg.target, ChildOf).parent!)
      w.set(leg.target, Transform, {
        translation: [p[0] - parent[0] - 0.02, p[1] + 0.08, p[2] - parent[2] - 0.05] as never,
      })
    }
    for (let i = 0; i < 60; i++) app.update(1 / 60)
    const solved = describeIk(w).filter((s) => s.solved)
    expect(solved).toHaveLength(200)
    expect(Math.max(...solved.map((s) => s.targetError as number))).toBeLessThan(0.001)
    // The solver alone. Each run first puts back the pose IK wrote (nothing re-samples here),
    // so this is an upper bound on a real frame's cost.
    const state = solveIk.setup!(w)
    const run = () => solveIk.run(state, w, undefined as never)
    for (let i = 0; i < 300; i++) {
      w.incrementTick()
      run()
    }
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 200))
    const times = new Float64Array(2000)
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
      `two-bone IK, 100 characters × 2 legs: ${Math.min(...list).toFixed(3)} ms best, ${median(list).toFixed(3)} ms median; GC events: ${collections}`,
    )
    expect(collections).toBe(0)
    expect(median(list)).toBeLessThan(budget(1))
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
