import { writeFileSync } from 'node:fs'
import type { AssetRef } from '@aethervtt/shard-core'
import { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext, nodeGpu } from '@aethervtt/shard-gpu/node'
import {
  describeRender,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { pngBytes, renderView, settle, watchBaseline } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parityPlugins, poseParityCamera, showParityView, spawnParity } from './parity'

// Stage 1 of 0064: the parity fixture, with fog and ground tiles, at the baseline tier on a WebGPU
// compatibility-mode device, matching the full tier.

let full: GpuContext
let compat: GpuContext
/**
 * The baseline tier on a core device. Compatibility-mode Dawn can't multisample `rgba16float`, so
 * MSAA there is 1×; this device runs the baseline tier's 4× path (the single-sample depth prepass
 * that fog reads), which WebGL2 runs for real.
 */
let baselineCore: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
  const gpu = nodeGpu()
  const adapter = (await gpu.requestAdapter())!
  const device = await adapter.requestDevice({ label: 'shard' })
  baselineCore = new GpuContext({ gpu }, adapter, device, 'rgba8unorm', { tier: 'baseline' })
})
afterAll(() => {
  full.destroy()
  compat.destroy()
  baselineCore.destroy()
})

async function parity(gpu: GpuContext, msaa: 1 | 4) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa }),
    ...parityPlugins(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'parity', width: 160, height: 120 })
  const ref = app.world.resource(RenderTargets).add(target, 'parity') as AssetRef<'RenderTarget'>
  return { app, target, scene: spawnParity(app.world, { target: ref }) }
}

const cases = [
  { device: 'compat', msaa: 1, samples: 1 },
  // Capped to 1× (render.describe says why): compat can't multisample rgba16float.
  { device: 'compat', msaa: 4, samples: 1 },
  { device: 'baseline on core', msaa: 4, samples: 4 },
] as const

describe('the parity fixture at the baseline tier (0064 stage 1)', () => {
  for (const c of cases) {
    it(`draws both views as the full tier does, with no compute or render-stage storage (${c.device}, MSAA ${c.msaa})`, {
      timeout: 120_000,
    }, async () => {
      const gpu = c.device === 'compat' ? compat : baselineCore
      const found = watchBaseline(gpu)
      const errors = gpu.errors.length
      const a = await parity(full, c.msaa)
      const b = await parity(gpu, c.msaa)
      for (const view of ['map', 'tabletop'] as const) {
        for (const p of [a, b]) {
          showParityView(p.app.world, p.scene, view)
          poseParityCamera(p.app.world, p.scene, view, 55)
          await settle(p.app)
        }
        const cam = (p: typeof a) => (view === 'map' ? p.scene.map : p.scene.tabletop)
        const fullShot = await renderView(a.app, `camera:${cam(a)}`)
        const baseShot = await renderView(b.app, `camera:${cam(b)}`)
        if (process.env.SHARD_GOLDEN_OUT) {
          const out = `${process.env.SHARD_GOLDEN_OUT}/parity-${view}-msaa${c.msaa}`
          writeFileSync(`${out}-full.png`, pngBytes(fullShot.data, 160, 120))
          writeFileSync(
            `${out}-${c.device.replace(/ /g, '-')}.png`,
            pngBytes(baseShot.data, 160, 120),
          )
        }
        let sum = 0
        for (let i = 0; i < fullShot.data.length; i++)
          sum += Math.abs(fullShot.data[i]! - baseShot.data[i]!)
        expect(sum / fullShot.data.length, view).toBeLessThan(2)
        const described = describeRender(b.app.world) as unknown as {
          deferred: { views: Record<string, { msaa: number; msaaLimit?: string }> }
        }
        const v = described.deferred.views[`camera:${cam(b)}`]!
        expect(v.msaa).toBe(c.samples)
        expect(v.msaaLimit !== undefined).toBe(c.samples < c.msaa)
      }
      expect(gpu.errors.slice(errors).map((e) => e.message)).toEqual([])
      expect(found.computePasses).toBe(0)
      expect(found.renderStorage).toEqual([])
      expect(b.app.world.resource(Gpu).tier).toBe('baseline')
      await a.app.dispose()
      await b.app.dispose()
      a.target.destroy()
      b.target.destroy()
    })
  }
})
