import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainBudget } from '../components'
import { terrainEditor } from './editor'
import { terrainPreview } from './preview'
import { terrainHeightAt } from './queries'
import {
  capture,
  EDIT_HILLS,
  editSource,
  heightfieldApp,
  lookAt,
  settleHeightfield,
  untilStreaming,
} from './testing'

let full: GpuContext
let compat: GpuContext
let hills: NoiseGraph

beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
  await loadNoiseKernel()
  hills = await NoiseGraph.create(EDIT_HILLS)
})

afterAll(async () => {
  for (const g of [full, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
}, timeout(120_000))

async function overhead(gpu: GpuContext) {
  const p = await heightfieldApp(gpu, {
    ...editSource(),
    noise: { hills },
    block: 4,
    width: 96,
    heightPx: 64,
    clearColor: [0.4, 0.55, 0.8, 1],
  })
  await untilStreaming(p)
  // Correctness: every queued leaf in one frame (the bench holds TerrainBudget.editMs).
  p.world.resource(TerrainBudget).editMs = Number.POSITIVE_INFINITY
  const ground = terrainHeightAt(p.world, p.terrain, 300, 300).height
  lookAt(p, [300, ground + 70, 285], [300, ground, 300])
  await settleHeightfield(p)
  return p
}

/** Mean absolute difference of two captures' RGB, over the pixels within `r` of the center. */
function changed(a: { data: Uint8Array; width: number; height: number }, b: typeof a, r = 1e9) {
  let sum = 0
  let n = 0
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      if (Math.hypot(x - a.width / 2, y - a.height / 2) > r) continue
      const o = (y * a.width + x) * 4
      for (let c = 0; c < 3; c++) sum += Math.abs(a.data[o + c]! - b.data[o + c]!)
      n += 3
    }
  }
  return sum / n
}

describe('edits on screen (0104)', () => {
  it(
    'draws an edit within two frames, rewriting its pages in the pool',
    async () => {
      const p = await overhead(full)
      const before = await capture(p)
      const ed = terrainEditor(p.world, p.terrain)
      ed.stroke({ brush: 'raise', radius: 12, strength: 8, falloff: 0.5 }, 300, 300).end()
      p.app.update(1 / 60)
      const after = await capture(p)
      expect(changed(before, after, 16)).toBeGreaterThan(4)
      expect(p.render()!.stats.rewritten).toBeGreaterThan(0)
      await p.app.dispose()
    },
    timeout(120_000),
  )

  it(
    'draws a brush preview and a shape preview, on both tiers',
    async () => {
      for (const gpu of [full, compat]) {
        const errors = gpu.errors.length
        const p = await overhead(gpu)
        const plain = await capture(p)
        terrainPreview(p.world, p.terrain, { brush: { at: [300, 300], radius: 15, falloff: 0.5 } })
        const brush = await capture(p)
        expect(changed(plain, brush), gpu.tier).toBeGreaterThan(1)
        terrainPreview(p.world, p.terrain, {
          edit: {
            shape: {
              polygon: [
                [285, 290],
                [315, 292],
                [310, 315],
                [290, 312],
              ],
            },
            set: 0,
            edge: { angle: 35 },
          },
        })
        const shape = await capture(p)
        expect(changed(brush, shape), gpu.tier).toBeGreaterThan(1)
        terrainPreview(p.world, p.terrain, null)
        const cleared = await capture(p)
        expect(changed(plain, cleared), gpu.tier).toBeLessThan(0.01)
        expect(gpu.errors.slice(errors)).toEqual([])
        await p.app.dispose()
      }
    },
    timeout(300_000),
  )
})
