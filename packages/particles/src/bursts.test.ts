import { defineSystem, Last, ProfilerResource } from '@aethervtt/shard-core'
import { budget, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App, FrameDemand } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ParticleEffect, ParticleEffects } from './effect'
import { particlesPlugin } from './plugin'
import {
  describeParticles,
  emitParticles,
  type ParticleBurst,
  Particles,
  prepareParticles,
  readParticles,
} from './sim'

// One-off bursts (0128): an effect spawned at a point, along a direction, with no entity.

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  full.destroy()
  compat.destroy()
})

/** Droplets in a 15° cone. Its own rate and authored burst don't run for one-off bursts. */
const splash = {
  emitters: [
    {
      name: 'droplets',
      capacity: 2048,
      spawn: { rate: 500, bursts: [{ time: 0, count: 100 }] },
      shape: { type: 'cone', angle: 15, radius: 0 },
      init: { lifetime: [2, 2], speed: [4, 5], size: 0.05, color: '#cdf' },
      render: { blend: 'additive', emissive: 2000 },
    },
  ],
}

async function scene(gpu: GpuContext) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    particlesPlugin,
  )
  await app.init()
  const world = app.world
  const target = world
    .resource(RenderTargets)
    .add(new OffscreenTarget(gpu, { label: 'bursts', width: 32, height: 32 }), 'bursts')
  // Particles simulate for the primary camera.
  const eye: [number, number, number] = [0, 4, 20]
  world.spawn(
    [Camera3d, { target: target as never, fovY: 50 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  const effect = world.resource(ParticleEffects).add(ParticleEffect.fromJson(splash))
  const step = async (n: number) => {
    for (let i = 0; i < n; i++) {
      app.update(1 / 60)
      await world.resource(Shaders).whenIdle()
      await gpu.pipelines.whenIdle()
    }
  }
  return { app, world, effect, step }
}

const BURSTS: (ParticleBurst & { position: number[]; direction: number[] })[] = [
  { position: [10, 0, 0], direction: [1, 0, 0], count: 30 },
  { position: [-5, 3, 2], direction: [0, -1, 1], count: 20 },
  { position: [0, 6, -4], direction: [0, -1, 0], count: 12 },
]

describe('one-off bursts (0128)', () => {
  it('spawns each burst at its point, along its direction within the cone, on every backend', async () => {
    const runs: Float32Array[] = []
    for (const [gpu, backend] of [
      [() => full, 'gpu'],
      [() => full, 'cpu'],
      [() => compat, 'gpu'],
    ] as const) {
      const { app, world, effect, step } = await scene(gpu())
      const entities = world.entityCount
      for (const b of BURSTS) expect(emitParticles(world, effect, { ...b, backend })).toBe(b.count)
      // A burst of an emitter the effect doesn't have queues nothing.
      expect(emitParticles(world, effect, { ...BURSTS[0]!, emitter: 'smoke', backend })).toBe(0)
      await step(3)
      const store = world.resource(Particles)
      // Baseline has no compute: its bursts run on the CPU (0064).
      const cpu = backend === 'cpu' || gpu() === compat
      expect((cpu ? store.cpuBursts : store.bursts).size).toBe(1)
      expect(store.systems.size).toBe(0)
      expect(world.entityCount).toBe(entities)
      const e = (cpu ? store.cpuBursts : store.bursts).get(effect.guid!)!.emitters[0]!
      // Only the bursts spawned: not the effect's rate, nor its authored burst.
      expect(e.spawned).toBe(62)
      const data = await readParticles(gpu(), e)
      runs.push(data)
      const counts = [0, 0, 0]
      for (let o = 0; o < data.length; o += 16) {
        const life = data[o + 7]!
        if (!(life > 0)) continue
        const age = data[o + 3]!
        expect(age).toBeLessThan(life)
        const vel = [data[o + 4]!, data[o + 5]!, data[o + 6]!]
        // Without modules a particle moves straight: back along its velocity is where it spawned.
        const from = [0, 1, 2].map((k) => data[o + k]! - vel[k]! * age)
        const b = BURSTS.findIndex(
          (b) => Math.hypot(...from.map((v, k) => v - b.position[k]!)) < 1e-3,
        )
        expect(b, `particle at ${from}`).toBeGreaterThanOrEqual(0)
        counts[b]!++
        const d = BURSTS[b]!.direction
        const speed = Math.hypot(...vel)
        expect(speed).toBeGreaterThanOrEqual(4 - 1e-4)
        expect(speed).toBeLessThanOrEqual(5 + 1e-4)
        const cos = (vel[0]! * d[0]! + vel[1]! * d[1]! + vel[2]! * d[2]!) / speed / Math.hypot(...d)
        expect(Math.acos(Math.min(1, cos))).toBeLessThanOrEqual((15 * Math.PI) / 180 + 1e-4)
      }
      expect(counts).toEqual(BURSTS.map((b) => b.count))
      expect(world.resource(Gpu).errors).toEqual([])
      await app.dispose()
    }
    // The same seeds on every backend: the same particles. Positions and ages differ by the frames
    // a GPU spends compiling before its first dispatch; the rest is set at spawn.
    for (const other of runs.slice(1)) {
      let worst = 0
      for (let i = 0; i < runs[0]!.length; i++) {
        if (i % 16 < 4 || i % 16 === 11) continue // position and age, seed bits
        worst = Math.max(worst, Math.abs(runs[0]![i]! - other[i]!))
      }
      expect(worst).toBeLessThan(1e-3)
    }
  })

  it('lands later bursts in the same simulation, and goes idle once its particles die', async () => {
    const { app, world, effect, step } = await scene(full)
    const demand = world.resource(FrameDemand)
    emitParticles(world, effect, { position: [0, 0, 0], count: 40, seed: 9 })
    await step(2)
    emitParticles(world, effect, { position: [4, 0, 0], count: 40, seed: 9 })
    await step(1)
    const e = world.resource(Particles).bursts.get(effect.guid!)!.emitters[0]!
    expect(e.spawned).toBe(80)
    const data = await readParticles(full, e)
    // The same seed spawns the same burst: the second is the first moved 4 m along x.
    for (let i = 0; i < 40; i++) {
      const a = i * 16
      const b = (40 + i) * 16
      expect(data[b + 4]).toBeCloseTo(data[a + 4]!, 5)
      expect(data[b + 5]).toBeCloseTo(data[a + 5]!, 5)
    }
    expect(demand.isHeld('particles')).toBe(true)
    expect(describeParticles(world)!.bursts[0]).toMatchObject({ backend: 'gpu', emitted: 2 })
    // A burst emitted after prepare, in the same frame as one before it, spawns the next frame.
    let late = true
    app.addSystems(
      Last,
      defineSystem({
        name: 'test/late-burst',
        run: (_, w) => {
          if (late) emitParticles(w, effect, { position: [8, 0, 0], count: 5, seed: 9 })
          late = false
        },
      }).after(prepareParticles),
    )
    emitParticles(world, effect, { position: [12, 0, 0], count: 7, seed: 9 })
    await step(1)
    expect(e.spawned).toBe(87)
    await step(1)
    expect(e.spawned).toBe(92)
    const both = await readParticles(full, e)
    // Back along its velocity from the 5th particle of the late burst: 8 m along x.
    const o = 91 * 16
    expect(both[o]! - both[o + 4]! * both[o + 3]!).toBeCloseTo(8, 3)
    await step(130) // past the 2 s lifetime
    expect(demand.isHeld('particles')).toBe(false)
    expect(describeParticles(world)!.bursts[0]!.emitters[0]!.visible).toBe(false)
    await app.dispose()
  })

  it('spawns 50 bursts in one frame within particles/bursts', async () => {
    const { app, world, effect, step } = await scene(full)
    const profiler = world.resource(ProfilerResource)
    const at = new Float32Array(3)
    const up = new Float32Array(3)
    const burst: ParticleBurst = { position: at, direction: up, count: 30 }
    const frames = timingMode === 'bench' ? 120 : 2
    // Compile first: a frame the pipelines weren't ready keeps its bursts for the next.
    emitParticles(world, effect, { position: at, count: 1 })
    await step(2)
    const e = world.resource(Particles).bursts.get(effect.guid!)!.emitters[0]!
    const before = e.spawned
    const times: number[] = []
    for (let f = 0; f < frames; f++) {
      const t0 = performance.now()
      for (let i = 0; i < 50; i++) {
        at[0] = i
        up[0] = Math.sin(i)
        up[1] = 1
        emitParticles(world, effect, burst)
      }
      const emitted = performance.now() - t0
      await step(1)
      times.push(emitted + profiler.timing('particles/prepare')!.last)
    }
    expect(e.spawned - before).toBe(frames * 1500)
    times.sort((a, b) => a - b)
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(budget('particles/bursts'))
    await app.dispose()
  })
})
