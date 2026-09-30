import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, pngBytes, renderView, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parityPlugins, poseParityCamera, showParityView, spawnParity } from './parity'

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function parity() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    ...parityPlugins(),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'parity', width: 160, height: 120 })
  const ref = app.world.resource(RenderTargets).add(target, 'parity') as AssetRef<'RenderTarget'>
  return { app, target, scene: spawnParity(app.world, { target: ref }) }
}

describe('tabletop parity fixture', () => {
  it('keeps band order at 30°, 55° and top-down in both views, and walls hide the bands', {
    timeout: 120_000,
  }, async () => {
    const { app, target, scene } = await parity()
    const world = app.world
    for (const view of ['map', 'tabletop'] as const) {
      const cam = view === 'map' ? scene.map : scene.tabletop
      showParityView(world, scene, view)
      for (const angle of ['top', 55, 30] as const) {
        poseParityCamera(world, scene, view, angle)
        await settle(app)
        const image = await renderView(app, `camera:${cam}`)
        const name = `parity-${view}-${angle}`
        if (process.env.SHARD_GOLDEN_OUT)
          writeFileSync(
            `${process.env.SHARD_GOLDEN_OUT}/${name}.png`,
            pngBytes(image.data, image.width, image.height),
          )
        const at = (p: [number, number, number]) => {
          const css = [0, 0]
          expect(worldToScreen(world, cam, p, css)).toBe(true)
          return pixel(image, Math.floor(css[0]!), Math.floor(css[1]!))
        }
        if (view === 'map') {
          // A disc (band 40) over the drawing polygon (band 30) over the tiles (band 10).
          const token = at([3.5, 0, -4.5])
          expect(token[0]!, name).toBeGreaterThan(token[2]! + 40)
          // The polygon's fill over the tiles: blue wins.
          const drawing = at([4.2, 0, -5.2])
          expect(drawing[2]!, name).toBeGreaterThan(drawing[0]!)
          // Fog (band 50) darkens the token under it; one in the open isn't.
          const fogged = at([6, 0, 2])
          const clear = at([-6, 0, -2])
          expect(fogged[0]! + 30, name).toBeLessThan(clear[0]!)
        }
        expect(compareGolden(here, name, image).mean, name).toBeLessThan(1.5)
      }
    }
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
    target.destroy()
  })
})
