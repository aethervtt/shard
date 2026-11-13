import type { Entity } from '@aethervtt/shard-core'
import {
  allocationChecks,
  budget,
  gcWindow,
  timeout,
  timingMode,
} from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TierBudget } from './components'
import { ensureBake } from './rig'
import { jointEntityCount } from './rigs'
import { type Ctx, startCharacters, stopCharacters, zombie } from './test-app'
import { TierRunResource } from './tiers'

// Correctness at a small size under `pnpm test`; the spec's sizes and budgets under `pnpm bench`.
const bench = timingMode === 'bench'

let gpu: GpuContext | undefined
const contexts: Ctx[] = []

beforeAll(async () => {
  gpu = await createNodeGpuContext().catch(() => undefined)
})

afterAll(async () => {
  for (const c of contexts) await stopCharacters(c)
})

const median = (t: number[]) => [...t].sort((a, b) => a - b)[t.length >> 1]!

/** 0115's bands: 40 at 2–15 m, 160 at 15–60 m, the rest at 60–`far` m, spread across the view. */
function horde(c: Ctx, n: number, far: number): Entity[] {
  const out: Entity[] = []
  const band = (count: number, lo: number, hi: number) => {
    for (let k = 0; k < count; k++) {
      const d = lo + ((hi - lo) * (k + 0.5)) / count
      // Within ±25° of the view direction, so most are on screen.
      const angle = (((k * 37) % 50) - 25) * (Math.PI / 180)
      out.push(zombie(c, d * Math.cos(angle), { x: d * Math.sin(angle) }))
    }
  }
  const scale = n / 500
  band(Math.round(40 * Math.min(1, scale)), 2, 15)
  band(Math.round(160 * Math.min(1, scale)), 15, 60)
  band(n - out.length, 60, far)
  return out
}

describe('character tier costs (0115)', () => {
  it('selection costs at most characters/select per character, allocating nothing', {
    timeout: timeout(600_000),
  }, async () => {
    if (!gpu) return
    const c = await startCharacters(gpu)
    contexts.push(c)
    // Past 256 under `pnpm test` too: the selection scratch grows.
    const n = bench ? 2000 : 300
    horde(c, n, 500)
    for (let f = 0; f < 30; f++) c.app.update(1 / 60)
    const run = c.world.resource(TierRunResource).run!
    console.log(
      `tiers for ${n}: ${JSON.stringify([...run.stats.counts])}, joint entities ${jointEntityCount(c.world)}`,
    )
    expect(run.stats.counts[0]).toBeLessThanOrEqual(c.world.resource(TierBudget).maxNear)
    const times: number[] = []
    const gcs = gcWindow()
    for (let f = 0; f < 120; f++) {
      c.app.update(1 / 60)
      times.push(run.stats.selectMs)
    }
    const collections = await gcs.end()
    console.log(
      `characters/select for ${n}: ${median(times).toFixed(3)} ms median; GC events ${collections}`,
    )
    if (allocationChecks) expect(collections).toBe(0)
    expect(median(times)).toBeLessThan(budget('characters/select', { count: n }))
  })

  it('a dolly through the horde stays within characters/swap a frame', {
    timeout: timeout(600_000),
  }, async () => {
    if (!gpu) return
    const c = await startCharacters(gpu)
    contexts.push(c)
    const budgetValue = c.world.resource(TierBudget)
    horde(c, bench ? 500 : 100, 300)
    for (let f = 0; f < 10; f++) c.app.update(1 / 60)
    const run = c.world.resource(TierRunResource).run!
    let worst = 0
    let swaps = 0
    let maxJoins = 0
    // Fly in from 30 m behind to 150 m into the horde.
    for (let f = 0; f < 240; f++) {
      c.world.set(c.camera, Transform, { translation: [0, 1.5, 30 - f * 0.75] })
      const nearBefore = run.stats.counts[0]!
      c.app.update(1 / 60)
      const joined = Math.max(0, run.stats.counts[0]! - nearBefore)
      maxJoins = Math.max(maxJoins, joined)
      swaps += run.stats.swaps
      if (f > 0) worst = Math.max(worst, run.stats.selectMs + run.stats.sampleMs)
    }
    console.log(
      `dolly: ${swaps} swaps, worst frame of select + sample ${worst.toFixed(3)} ms, most joins ${maxJoins}`,
    )
    expect(swaps).toBeGreaterThan(0)
    expect(maxJoins).toBeLessThanOrEqual(budgetValue.joinsPerFrame)
    expect(worst).toBeLessThan(budget('characters/swap'))
  })

  it('bakes the three clips of a build within characters/bake', {
    timeout: timeout(120_000),
  }, async () => {
    if (!gpu) return
    const c = await startCharacters(gpu)
    contexts.push(c)
    const times: number[] = []
    for (let b = 0; b < c.rig.builds.length; b++) {
      const t0 = performance.now()
      const bake = ensureBake(c.world, c.rig, b)!
      times.push(performance.now() - t0)
      expect(bake.clips.map((x) => x.name)).toEqual(['walk', 'idle', 'attack'])
    }
    const bytes = c.rig.builds.reduce((n, b) => n + (b.bake?.vec4s ?? 0) * 16, 0)
    console.log(
      `bakes: ${times.map((t) => t.toFixed(2)).join(', ')} ms; ${(bytes / 1024).toFixed(0)} KB for ${c.rig.builds.length} builds`,
    )
    // The first bake pays for binding (warm-up); later ones are the steady cost.
    expect(median(times.slice(1))).toBeLessThan(budget('characters/bake'))
  })
})
