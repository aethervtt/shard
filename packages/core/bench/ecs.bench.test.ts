import { PerformanceObserver } from 'node:perf_hooks'
import { describe, expect, it } from 'vitest'
import { defineComponent, type Query, t, World } from '../src'

const Position = defineComponent('bench/Position', { value: t.vec3 })
const Velocity = defineComponent('bench/Velocity', { value: t.vec3 })

function spawnMany(world: World, n: number): void {
  for (let i = 0; i < n; i++) {
    world.spawn([Position, { value: [i, 0, 0] }], [Velocity, { value: [1, 1, 1] }])
  }
}

function integrate(q: Query, dt: number): void {
  const tables = q.tables
  for (let t = 0; t < tables.length; t++) {
    const table = tables[t]!
    const pos = table.column(Position, 'value')
    const vel = table.column(Velocity, 'value')
    for (let i = 0, n = table.count * 3; i < n; i++) pos[i]! += vel[i]! * dt
    table.markChanged(Position)
  }
}

/** Best-of-N wall time in ms, after warm-up runs. */
function measure(fn: () => void, runs: number, warmup = 3): number {
  for (let i = 0; i < warmup; i++) fn()
  let best = Infinity
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    fn()
    best = Math.min(best, performance.now() - start)
  }
  return best
}

function report(label: string, ms: number, budget: number): void {
  console.log(`${label.padEnd(36)} ${ms.toFixed(3).padStart(9)} ms   (budget ${budget} ms)`)
}

describe('ECS performance (spec 0001)', () => {
  it('spawns 100k entities with Position + Velocity in under 50 ms', () => {
    const ms = measure(() => spawnMany(new World(), 100_000), 5)
    report('spawn 100k', ms, 50)
    expect(ms).toBeLessThan(50)
  })

  it('integrates 100k entities in under 1 ms per frame', () => {
    const world = new World()
    spawnMany(world, 100_000)
    const q = world.query({ with: [Position, Velocity] })
    const ms = measure(() => integrate(q, 1 / 60), 50, 20)
    report('integrate 100k', ms, 1)
    expect(ms).toBeLessThan(1)
  })

  it('stretch: spawns 1M in under 500 ms and integrates them in under 10 ms', () => {
    const spawnMs = measure(() => spawnMany(new World(), 1_000_000), 3, 1)
    report('spawn 1M', spawnMs, 500)

    const world = new World()
    spawnMany(world, 1_000_000)
    const q = world.query({ with: [Position, Velocity] })
    const integrateMs = measure(() => integrate(q, 1 / 60), 20, 10)
    report('integrate 1M', integrateMs, 10)

    expect(spawnMs).toBeLessThan(500)
    expect(integrateMs).toBeLessThan(10)
  })

  it('steady-state query iteration allocates nothing (no GC over 1,000 frames)', async () => {
    const gc = (globalThis as { gc?: () => void }).gc
    expect(gc, 'run with --expose-gc').toBeTypeOf('function')

    const world = new World()
    spawnMany(world, 100_000)
    const q = world.query({ with: [Position, Velocity] })
    for (let i = 0; i < 200; i++) integrate(q, 1 / 60) // warm up the JIT

    let collections = 0
    const observer = new PerformanceObserver((list) => {
      collections += list.getEntries().length
    })
    gc!()
    observer.observe({ entryTypes: ['gc'] })
    for (let frame = 0; frame < 1_000; frame++) {
      world.incrementTick()
      integrate(q, 1 / 60)
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
    observer.disconnect()
    report('GC events over 1,000 frames', collections, 0)
    expect(collections).toBe(0)
  })
})
