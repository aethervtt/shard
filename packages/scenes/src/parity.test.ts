import { writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AssetRef } from '@aethervtt/shard-core'
import { FogSettings } from '@aethervtt/shard-fog'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  captureBuffer,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  type PickHit,
  pick,
  RenderTargets,
  renderPlugin,
  worldToScreen,
} from '@aethervtt/shard-render'
import { compareGolden, pixel, pngBytes, renderView, settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type ParityScene,
  parityPlugins,
  poseParityCamera,
  showParityView,
  spawnParity,
} from './parity'

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
/** The baseline tier (0064), on a compatibility-mode device: its own approved goldens. */
let compat: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  gpu.destroy()
  compat.destroy()
})

async function parity(gpu: GpuContext) {
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
  for (const tier of ['full', 'baseline'] as const) {
    it(`keeps band order at 30°, 55° and top-down in both views, and walls hide the bands (${tier} tier)`, {
      timeout: 120_000,
    }, async () => {
      const { app, target, scene } = await parity(tier === 'full' ? gpu : compat)
      const world = app.world
      for (const view of ['map', 'tabletop'] as const) {
        const cam = view === 'map' ? scene.map : scene.tabletop
        showParityView(world, scene, view)
        for (const angle of ['top', 55, 30] as const) {
          poseParityCamera(world, scene, view, angle)
          await settle(app)
          const image = await renderView(app, `camera:${cam}`)
          const name = `parity-${view}-${angle}${tier === 'baseline' ? '.baseline' : ''}`
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
      expect(world.resource(Gpu).tier).toBe(tier)
      await app.dispose()
      target.destroy()
    })
  }
})

describe('projected fog on the parity fixture (0058)', () => {
  for (const tier of ['full', 'baseline'] as const) {
    it(`covers a prop inside a hidden region to its top, with the same footprint in the Map view (${tier} tier)`, {
      timeout: 120_000,
    }, async () => {
      const { app, target, scene } = await parity(tier === 'full' ? gpu : compat)
      const world = app.world
      // How much fog takes off a point: its brightness with fog over its brightness without.
      const ratios = async (view: 'map' | 'tabletop', points: [number, number, number][]) => {
        const cam = view === 'map' ? scene.map : scene.tabletop
        showParityView(world, scene, view)
        poseParityCamera(world, scene, view, 55)
        // Linear HDR, before the tonemap: fog takes a fixed fraction off there.
        const shot = async () => {
          await settle(app)
          const pending = captureBuffer(world, `camera:${cam}`, 'hdr')
          app.update(1 / 60)
          const b = await pending
          return { width: b.width, data: b.data }
        }
        world.patchResource(FogSettings, { viewerOpacity: 1 })
        const fogged = await shot()
        world.patchResource(FogSettings, { viewerOpacity: 0 })
        const clear = await shot()
        world.patchResource(FogSettings, { viewerOpacity: 1 })
        return points.map((p) => {
          const css = [0, 0]
          expect(worldToScreen(world, cam, p, css)).toBe(true)
          const [x, y] = [Math.floor(css[0]!), Math.floor(css[1]!)]
          const lum = (px: number[]) => px[0]! + px[1]! + px[2]!
          return lum(pixel(fogged, x, y)) / Math.max(1, lum(pixel(clear, x, y)))
        })
      }
      // The prop's top, and floor points in the fog, in its hole, and in the open.
      const propTop: [number, number, number] = [8.5, 1.2, 6.5]
      const floor: [number, number, number][] = [
        [9, 0, -2.5],
        [7.5, 0, 0],
        [-4, 0, -6],
      ]
      const [top] = await ratios('tabletop', [propTop])
      // Hidden at strength 0.75: a quarter of the light is left, at the top as on the floor.
      expect(Math.abs(top! - 0.25), 'the prop top is fogged').toBeLessThan(0.05)
      const tabletop = await ratios('tabletop', floor)
      const map = await ratios('map', floor)
      expect(Math.abs(tabletop[0]! - 0.25)).toBeLessThan(0.05)
      expect(tabletop[1]!).toBeGreaterThan(0.98)
      expect(tabletop[2]!).toBeGreaterThan(0.98)
      for (let i = 0; i < floor.length; i++)
        expect(Math.abs(map[i]! - tabletop[i]!), `point ${i}`).toBeLessThan(0.02)
      expect(world.resource(Gpu).errors).toEqual([])
      expect(world.resource(Gpu).tier).toBe(tier)
      await app.dispose()
      target.destroy()
    })
  }
})

describe('tiles on the parity fixture (0059)', () => {
  for (const tier of ['full', 'baseline'] as const) {
    it(`are lit by the tabletop light, shadowed by the pillar, fogged, hidden behind the wall, and picked by cell, in both views (${tier} tier)`, {
      timeout: 120_000,
    }, async () => {
      const { app, target, scene } = await parity(tier === 'full' ? gpu : compat)
      const world = app.world
      type P = [number, number, number]
      const cameraOf = (s: ParityScene, view: 'map' | 'tabletop') =>
        view === 'map' ? s.map : s.tabletop
      const screen = (view: 'map' | 'tabletop', p: P): [number, number] => {
        const css = [0, 0]
        expect(worldToScreen(world, cameraOf(scene, view), p, css)).toBe(true)
        return [Math.floor(css[0]!), Math.floor(css[1]!)]
      }
      // Linear HDR brightness at world points (before the tonemap: ratios are exact there).
      const brightness = async (view: 'map' | 'tabletop', points: P[]) => {
        await settle(app)
        const pending = captureBuffer(world, `camera:${cameraOf(scene, view)}`, 'hdr')
        app.update(1 / 60)
        const shot = await pending
        return points.map((p) => {
          const [x, y] = screen(view, p)
          const px = pixel({ width: shot.width, data: shot.data }, x, y)
          return px[0]! + px[1]! + px[2]!
        })
      }
      const picks = async (view: 'map' | 'tabletop', points: P[]) => {
        let done = false
        const all = Promise.all(
          points.map((p) => {
            const [x, y] = screen(view, p)
            return pick(world, cameraOf(scene, view), x, y)
          }),
        ).finally(() => {
          done = true
        })
        for (let i = 0; i < 30 && !done; i++) {
          app.update(1 / 60)
          await world.resource(Gpu).pipelines.whenIdle()
          await new Promise((r) => setTimeout(r, 0))
        }
        return (await all) as (PickHit | undefined)[]
      }
      // Stone cells: under the light, in the pillar's shadow, and in the open (neither).
      const lit: P = [5.5, 0, -7]
      const shadowed: P = [1.8, 0, -7.2]
      const open: P = [1.8, 0, -5.9]
      // A moss cell under the fog rect over the tiles' west end.
      const fogged: P = [-1, 0, -7]
      // Beyond the north wall: a dirt cell of the first row.
      const beyond: P = [4.5, 0, -9]
      for (const view of ['map', 'tabletop'] as const) {
        showParityView(world, scene, view)
        poseParityCamera(world, scene, view, view === 'map' ? 'top' : 30)
        const [l, sh, o] = await brightness(view, [lit, shadowed, open])
        expect(l! / o!, `${view}: the tabletop light`).toBeGreaterThan(1.3)
        expect(sh! / o!, `${view}: the pillar's shadow`).toBeLessThan(0.7)
        world.patchResource(FogSettings, { viewerOpacity: 0 })
        const [clear] = await brightness(view, [fogged])
        world.patchResource(FogSettings, { viewerOpacity: 1 })
        const [fog] = await brightness(view, [fogged])
        expect(Math.abs(fog! / clear! - 0.25), `${view}: fog over the tiles`).toBeLessThan(0.05)

        const [litHit, beyondHit] = await picks(view, [lit, beyond])
        expect(litHit?.detail, view).toMatchObject({
          kind: 'tile',
          layer: 'floor',
          x: 7,
          y: 2,
          tile: 'stone',
        })
        if (view === 'map') {
          // Seen from above, the row beyond the wall is there.
          expect(beyondHit?.detail).toMatchObject({ kind: 'tile', x: 6, y: 0, tile: 'dirt' })
        } else {
          // From the table's side, the wall hides it: the pick hits the wall.
          expect(beyondHit?.detail, 'hidden behind the north wall').toBeUndefined()
          expect(beyondHit?.position[2]).toBeGreaterThan(-8.2)
        }
      }
      expect(world.resource(Gpu).errors).toEqual([])
      expect(world.resource(Gpu).tier).toBe(tier)
      await app.dispose()
      target.destroy()
    })
  }
})
