import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { captureView, Gpu, RenderHealth } from '@aethervtt/shard-render'
import { compareGolden, watchBaseline } from '@aethervtt/shard-render/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
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

const here = dirname(fileURLToPath(import.meta.url))
let full: GpuContext
let compat: GpuContext
let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})

afterAll(async () => {
  for (const g of [full, compat]) {
    await g?.device.queue.onSubmittedWorkDone()
    g?.destroy()
  }
  workers.dispose()
}, timeout(120_000))

/** The five views of the crack test: from standing near the road to 3 km up. */
export const FIVE_VIEWS = [
  { at: [400, 400], altitude: 15, toward: [1, 0.4] },
  { at: [900, 700], altitude: 60, toward: [0.3, 1] },
  { at: [1500, 300], altitude: 250, toward: [-0.6, 1] },
  { at: [300, 1700], altitude: 900, toward: [1, -0.5] },
  { at: [1024, 1024], altitude: 3000, toward: [0.2, 0.2] },
]

async function views(gpu: GpuContext) {
  const p = await heightfieldApp(gpu, {
    ...valleySource(),
    noise: { hills },
    workers,
    width: 160,
    heightPx: 120,
    clearColor: [0.4, 0.55, 0.8, 1],
  })
  await untilStreaming(p)
  const rt = p.runtime()
  const images = []
  for (const v of FIVE_VIEWS) {
    const [x, z] = v.at as [number, number]
    const out = new Float64Array(1)
    evalHeightPoints(mainNoise(), rt.stack!, [x, z], 1, rt.stack!.height.length, out)
    const d = Math.max(80, v.altitude * 1.5)
    lookAt(p, [x, out[0]! + v.altitude, z], [x + v.toward[0]! * d, out[0]!, z + v.toward[1]! * d])
    await settleHeightfield(p)
    const shot = captureView(p.world, p.view)
    p.app.update(1 / 60)
    images.push(await shot)
  }
  return { p, images }
}

describe('heightfields on the baseline tier (0064, 0071)', () => {
  it(
    'renders the five views within golden tolerance of WebGPU, with no compute',
    async () => {
      const reference = await views(full)
      const found = watchBaseline(compat)
      const errors = compat.errors.length
      const baseline = await views(compat)
      expect(baseline.p.world.resource(Gpu).tier).toBe('baseline')
      expect(found.computePasses).toBe(0)
      const health = baseline.p.world.resource(RenderHealth)
      expect(health.issues.filter((i) => i.code === 'render/feature-unsupported')).toEqual([])
      expect(compat.errors.slice(errors)).toEqual([])
      for (let i = 0; i < FIVE_VIEWS.length; i++) {
        // The WebGPU render is the golden; the baseline one is compared with it.
        compareGolden(here, `heightfield-full-${i}`, reference.images[i]!)
        expect(
          compareGolden(here, `heightfield-full-${i}`, baseline.images[i]!).mean,
          `view ${i}`,
        ).toBeLessThan(1.5)
      }
      await reference.p.app.dispose()
      await baseline.p.app.dispose()
    },
    timeout(300_000),
  )
})
