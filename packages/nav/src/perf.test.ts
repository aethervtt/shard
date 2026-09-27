import type { Entity } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { NavAgent, NavGrid, NavGridDatas, NavMesh } from './components'
import { createNavPath, findPath } from './query'
import { frames, navApp, slab } from './test-level'
import { maze, rng } from './test-maze'

const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!
const DT = 1 / 60

async function countGc(fn: () => void): Promise<number> {
  globalThis.gc?.()
  await new Promise((r) => setTimeout(r, 200))
  let collections = 0
  const observer = new PerformanceObserver((list) => {
    collections += list.getEntries().length
  })
  observer.observe({ entryTypes: ['gc'] })
  fn()
  await new Promise((r) => setTimeout(r, 50))
  observer.disconnect()
  return collections
}

describe('navigation per frame', () => {
  it('findPath on a 256×256 maze grid takes under 2 ms and allocates nothing', async () => {
    const a = await navApp()
    const w = a.world
    const grid = maze(256, 11)
    w.spawn(
      [NavGrid, { source: 'data', data: w.resource(NavGridDatas).add(grid) }],
      [Transform, {}],
    )
    frames(a, 1)
    const random = rng(9)
    const points: Float64Array[] = []
    while (points.length < 40) {
      const x = Math.floor(random() * 256)
      const y = Math.floor(random() * 256)
      if (grid.get(x, y) > 0) points.push(new Float64Array([x + 0.5, y + 0.5, 0]))
    }
    const out = createNavPath(512)
    const options = { out }
    for (let r = 0; r < 10; r++)
      for (let i = 0; i < 20; i++) findPath(w, points[i]!, points[i + 20]!, options)
    const times = new Float64Array(200)
    const gc = await countGc(() => {
      for (let r = 0; r < 10; r++) {
        for (let i = 0; i < 20; i++) {
          const t0 = performance.now()
          findPath(w, points[i]!, points[i + 20]!, options)
          times[r * 20 + i] = performance.now() - t0
        }
      }
    })
    expect(out.status).toBe('complete')
    expect(gc).toBe(0)
    expect(median([...times])).toBeLessThan(budget(2))
  })

  it('steps 200 grid agents chasing a moving target in under 1 ms a frame, without GC', async () => {
    const a = await navApp()
    const w = a.world
    const grid = maze(64, 3, 0.3)
    w.spawn(
      [NavGrid, { source: 'data', data: w.resource(NavGridDatas).add(grid) }],
      [Transform, {}],
    )
    const target = w.spawn([Transform, { translation: [32.5, 32.5, 0] }])
    const random = rng(4)
    for (let n = 0; n < 200; ) {
      const x = Math.floor(random() * 64)
      const y = Math.floor(random() * 64)
      if (grid.get(x, y) === 0) continue
      w.spawn(
        [NavAgent, { target, radius: 0.3, speed: 3, drive: 'transform', repathInterval: 1 }],
        [Transform, { translation: [x + 0.5, y + 0.5, 0] }],
      )
      n++
    }
    frames(a, 120)
    const times: number[] = []
    const gc = await countGc(() => {
      for (let f = 0; f < 120; f++) {
        const t0 = performance.now()
        a.update(DT)
        times.push(performance.now() - t0)
      }
    })
    expect(gc).toBe(0)
    expect(median(times)).toBeLessThan(budget(1))
  })

  it('steps 100 navmesh agents in a crowd in under 1.5 ms a frame', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 25, 25, 0)
    w.spawn([NavMesh, { tileSize: 64 }])
    frames(a, 2)
    const agents: Entity[] = []
    const random = rng(8)
    for (let i = 0; i < 100; i++) {
      const at: [number, number, number] = [random() * 40 - 20, 0, random() * 40 - 20]
      const to: [number, number, number] = [random() * 40 - 20, 0, random() * 40 - 20]
      agents.push(
        w.spawn(
          [NavAgent, { destination: to, drive: 'transform' }],
          [Transform, { translation: at }],
        ),
      )
    }
    frames(a, 30)
    const times: number[] = []
    for (let f = 0; f < 120; f++) {
      const t0 = performance.now()
      a.update(DT)
      times.push(performance.now() - t0)
    }
    expect(median(times)).toBeLessThan(budget(1.5))
  })
})
