import { ChildOf, type Entity, Rng, Update } from '@shard/core'
import { App } from '@shard/runtime'
import { describe, expect, it } from 'vitest'
import { Transform, TransformPlugin } from '../src'

function report(label: string, ms: number, budget: number): void {
  console.log(`${label.padEnd(40)} ${ms.toFixed(3).padStart(9)} ms   (budget ${budget} ms)`)
}

/** Times the propagation system alone (from the profiler), best of N frames after warm-up. */
function propagationMs(app: App, frames: number, touch: () => void): number {
  const profiler = app.world.resource(app.world.registry.get('core/Profiler') as never) as {
    timing(name: string): { last: number } | undefined
  }
  let best = Infinity
  for (let f = 0; f < frames; f++) {
    touch()
    app.update(1 / 60)
    if (f >= 5) best = Math.min(best, profiler.timing('core/transform-propagate')!.last)
  }
  return best
}

describe('transform propagation performance (spec 0004)', () => {
  it('propagates 100k changed roots in under 2 ms', async () => {
    const app = new App().addPlugin(TransformPlugin)
    await app.init()
    const rng = new Rng(1)
    const table = () => app.world.query({ with: [Transform] }).tables
    for (let i = 0; i < 100_000; i++) {
      app.world.spawn([Transform, { translation: [rng.float(), rng.float(), rng.float()] }])
    }
    const ms = propagationMs(app, 30, () => {
      for (const t of table()) t.markChanged(Transform)
    })
    report('100k roots, all changed', ms, 2)
    expect(ms).toBeLessThan(2)
  })

  it('propagates a 10k hierarchy (depth 10) with 1% changed in under 0.5 ms', async () => {
    const app = new App().addPlugin(TransformPlugin)
    await app.init()
    const rng = new Rng(2)
    const all: Entity[] = []
    // 1,000 chains of depth 10.
    for (let c = 0; c < 1_000; c++) {
      let parent = app.world.spawn([Transform, { translation: [c, 0, 0] }])
      all.push(parent)
      for (let d = 1; d < 10; d++) {
        parent = app.world.spawn([Transform, { translation: [0, 1, 0] }], [ChildOf, { parent }])
        all.push(parent)
      }
    }
    const ms = propagationMs(app, 30, () => {
      for (let i = 0; i < 100; i++) {
        const e = all[rng.int(0, all.length - 1)]!
        app.world.entityTable(e).markChanged(Transform, app.world.entityRow(e))
      }
    })
    report('10k hierarchy, 1% changed', ms, 0.5)
    expect(ms).toBeLessThan(0.5)
  })
})

void Update
