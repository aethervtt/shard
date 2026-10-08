import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { captureView } from '@aethervtt/shard-render'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainBudget } from '../components'
import { evalHeightPoints } from './kernel'
import { mainNoise } from './stack'
import {
  heightfieldApp,
  lookAt,
  settleHeightfield,
  untilStreaming,
  VALLEY_HILLS,
  valleySource,
} from './testing'

let gpu: GpuContext
let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})

afterAll(async () => {
  await gpu?.device.queue.onSubmittedWorkDone()
  gpu?.destroy()
  workers.dispose()
}, timeout(120_000))

const W = 160
const H = 120

/** Standing 1.7 m over the road, looking along it; the terrain's corner at `at`. */
async function standing(at: [number, number, number], frames: number) {
  const p = await heightfieldApp(gpu, {
    ...valleySource(),
    noise: { hills },
    workers,
    width: W,
    heightPx: H,
    at,
    clearColor: [0.4, 0.55, 0.8, 1],
  })
  // Nothing that changes the picture on its own: no triangle budget steering the detail.
  p.world.resource(TerrainBudget).triangles = 0
  await untilStreaming(p)
  const rt = p.runtime()
  const out = new Float64Array(2)
  evalHeightPoints(mainNoise(), rt.stack!, [920, 420, 940, 440], 2, rt.stack!.height.length, out)
  lookAt(p, [920, out[0]! + 1.7, 420], [940, out[1]! + 1.2, 440])
  await settleHeightfield(p)
  // Chunks that just replaced their parents finish fading in (half a second).
  for (let f = 0; f < 40; f++) p.app.update(1 / 60)
  const images = []
  for (let f = 0; f < frames; f++) {
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    images.push(await shot)
  }
  await p.app.dispose()
  return images
}

function diff(a: Uint8Array, b: Uint8Array): { mean: number; max: number } {
  let sum = 0
  let max = 0
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i]! - b[i]!)
    sum += d
    max = Math.max(max, d)
  }
  return { mean: sum / a.length, max }
}

describe('heightfield precision (0040, 0071)', () => {
  it(
    'stands still 30 km from the origin with no jitter, as it does at the origin',
    async () => {
      const home = await standing([0, 0, 0], 2)
      const far = await standing([30_000, 0, -30_000], 120)
      // Still: every frame is the first frame.
      for (const image of far) expect(diff(image.data, far[0]!.data).max).toBe(0)
      // Grid cells keep it precise: the same picture as at the origin.
      expect(diff(far[0]!.data, home[0]!.data).mean).toBeLessThan(0.5)
    },
    timeout(240_000),
  )
})
