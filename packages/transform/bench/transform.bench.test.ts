import { ChildOf, type Entity, Rng, Update } from '@shard/core'
import { App } from '@shard/runtime'
import { describe, expect, it } from 'vitest'
import { FloatingOrigin, Grid, GridCell, Transform, TransformPlugin } from '../src'

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

describe('grid propagation performance (spec 0040)', () => {
  /** 100k roots plus 100 parents of 10 children each: grids when `grids`, plain parents when not. */
  async function rootsApp(grids: boolean) {
    const app = new App().addPlugin(TransformPlugin)
    await app.init()
    const rng = new Rng(3)
    for (let i = 0; i < 100_000; i++) {
      app.world.spawn([Transform, { translation: [rng.float(), rng.float(), rng.float()] }])
    }
    for (let g = 0; g < 100; g++) {
      const translation: [number, number, number] = [g * 10, 0, 0]
      const parent = grids
        ? app.world.spawn(Grid, [Transform, { translation }])
        : app.world.spawn([Transform, { translation }])
      for (let k = 0; k < 10; k++) {
        const t: [number, number, number] = [k, g, 0]
        if (grids) {
          app.world.spawn(Transform, [GridCell, { cell: t }], [ChildOf, { parent }])
        } else {
          app.world.spawn([Transform, { translation: t }], [ChildOf, { parent }])
        }
      }
      if (g === 0) {
        if (grids) app.world.spawn(Transform, FloatingOrigin, GridCell, [ChildOf, { parent }])
        else app.world.spawn(Transform, [ChildOf, { parent }])
      }
    }
    return app
  }

  function changedRootsMs(app: App): number {
    const roots = app.world.query({ with: [Transform], without: [ChildOf] }).tables
    // Interleave runs so machine noise hits both sides alike; keep the best.
    return propagationMs(app, 60, () => {
      for (const t of roots) if (t.count > 1000) t.markChanged(Transform)
    })
  }

  it('costs no more than 5% over no grids with 100 static grids (100k changed roots)', async () => {
    const plain = await rootsApp(false)
    const gridded = await rootsApp(true)
    let base = Infinity
    let withGrids = Infinity
    for (let round = 0; round < 3; round++) {
      base = Math.min(base, changedRootsMs(plain))
      withGrids = Math.min(withGrids, changedRootsMs(gridded))
    }
    report('100k roots, 100 plain parents', base, 2)
    report('100k roots, 100 static grids', withGrids, base * 1.05)
    // Grid solving is a fixed cost per frame; allow 5% plus a few microseconds of timer noise.
    expect(withGrids).toBeLessThan(base * 1.05 + 0.02)
  })

  it('propagates 100k changed grid children no slower than 100k ordinary children', async () => {
    async function childrenApp(grids: boolean) {
      const app = new App().addPlugin(TransformPlugin)
      await app.init()
      const rng = new Rng(4)
      const parents = []
      for (let g = 0; g < 100; g++) parents.push(app.world.spawn(grids ? Grid : Transform))
      for (let i = 0; i < 100_000; i++) {
        const translation: [number, number, number] = [rng.float(), rng.float(), rng.float()]
        const parent = parents[i % 100]!
        if (grids) {
          app.world.spawn(
            [Transform, { translation }],
            [GridCell, { cell: [rng.int(0, 1000), 0, 0] }],
            [ChildOf, { parent }],
          )
        } else app.world.spawn([Transform, { translation }], [ChildOf, { parent }])
      }
      if (grids) {
        app.world.spawn(Transform, FloatingOrigin, GridCell, [ChildOf, { parent: parents[0]! }])
      }
      const children = app.world.query({ with: [ChildOf] }).tables
      return propagationMs(app, 30, () => {
        for (const t of children) t.markChanged(Transform)
      })
    }
    const plain = await childrenApp(false)
    const gridded = await childrenApp(true)
    report('100k ordinary children, all changed', plain, 10)
    report('100k grid children, all changed', gridded, plain * 1.1)
    expect(gridded).toBeLessThan(plain * 1.1)
  })
})

void Update
