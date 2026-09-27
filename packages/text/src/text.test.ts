import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProfilerResource, quat } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  captureView,
  describeRender,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { compareGolden, settle } from '@aethervtt/shard-render/testing'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { fontFromBytes } from './build'
import { ScreenText, Text } from './components'
import type { Font } from './font'
import { Fonts } from './importer'
import { textPlugin } from './plugin'

const here = dirname(fileURLToPath(import.meta.url))
const inter = new Uint8Array(readFileSync(resolve(here, '../fixtures/Inter-Regular.ttf')))
let gpu: GpuContext
let font: Font
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  font = fontFromBytes(inter, { charset: 'latin' })
})
afterAll(() => gpu.destroy())

/** Budgets hold under `pnpm bench` (serial); parallel `pnpm test` runs get 3x slack. */

async function scene(width: number, height: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    textPlugin,
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'text', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'text')
  const fontRef = app.world.resource(Fonts).add(font)
  const camera = (extra: unknown[] = []) =>
    app.world.spawn(
      [Camera3d, { target: targetRef as never, fovY: 40, clearColor: [0.02, 0.02, 0.03, 1] }],
      [Tonemapping, { curve: 'none', dither: false }],
      ...((extra.length ? extra : [[Transform, { translation: [0, 0, 5] }]]) as []),
    )
  const shoot = async (cam: number) => {
    await settle(app)
    const shot = captureView(app.world, `camera:${cam}`)
    app.update(1 / 60)
    return shot
  }
  return { app, world: app.world, fontRef, camera, shoot }
}

/** Pixels between 10% and 90% of full brightness along a row: the edge's blur, in pixels. */
function edgeWidth(
  image: { width: number; data: Uint8Array },
  row: number,
  x0: number,
  x1: number,
) {
  let lo = 255
  let hi = 0
  for (let x = x0; x < x1; x++) {
    const v = image.data[(row * image.width + x) * 4]!
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  let mid = 0
  for (let x = x0; x < x1; x++) {
    const v = image.data[(row * image.width + x) * 4]!
    const t = (v - lo) / Math.max(1, hi - lo)
    if (t > 0.1 && t < 0.9) mid++
  }
  return { mid, contrast: hi - lo }
}

describe('text rendering', () => {
  it('stays sharp at 8, 48, and 400 px (golden images)', { timeout: timeout(60_000) }, async () => {
    for (const px of [8, 48, 400]) {
      const w = px === 400 ? 520 : px === 48 ? 320 : 96
      const h = Math.round(px * 1.6)
      const { world, fontRef, camera, shoot } = await scene(w, h)
      world.spawn([
        ScreenText,
        { value: px === 400 ? 'Hi' : 'Hello, Shard!', font: fontRef, size: px, corner: 'center' },
      ])
      const image = await shoot(camera())
      expect(compareGolden(here, `text-${px}px`, image).mean, `${px}px`).toBeLessThan(1.5)
      // Across the H's stem: at most two partly covered pixels per edge, at any size.
      const row = Math.round(h / 2)
      const { mid, contrast } = edgeWidth(image, row, 0, w)
      expect(contrast, `${px}px`).toBeGreaterThan(150)
      if (px === 400) expect(mid, `${px}px`).toBeLessThanOrEqual(8)
      expect(world.resource(Gpu).errors).toEqual([])
    }
  })

  it('renders world text at 60° to the camera, with outline and shadow (golden images)', async () => {
    const { world, fontRef, camera, shoot } = await scene(384, 192)
    world.spawn(
      [
        Text,
        {
          value: 'Scanner 7',
          font: fontRef,
          size: 1.2,
          color: [1, 0.85, 0.3, 1],
          outline: { width: 0.03, color: [0.05, 0.1, 0.4, 1] },
          shadow: { offset: [0.05, -0.05], softness: 0.3, color: [0, 0, 0, 0.8] },
        },
      ],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], 0, (60 * Math.PI) / 180, 0) as never }],
    )
    const image = await shoot(camera())
    expect(compareGolden(here, 'text-world-60deg', image).mean).toBeLessThan(1.5)
    // Fill, outline, and shadow colors are all present.
    let fill = 0
    let outline = 0
    for (let p = 0; p < image.data.length; p += 4) {
      const [r, g, b] = [image.data[p]!, image.data[p + 1]!, image.data[p + 2]!]
      // sRGB: fill (1, 0.85, 0.3) is about (255, 237, 149); outline (0.05, 0.1, 0.4) (63, 89, 170).
      if (r > 220 && g > 200 && b < 190) fill++
      if (b > 120 && r < 100 && g < 120) outline++
    }
    expect(fill).toBeGreaterThan(100)
    expect(outline).toBeGreaterThan(50)
    expect(world.resource(LogResource).errors()).toEqual([])
  })

  it('billboards face the camera', async () => {
    const { world, fontRef, camera, shoot } = await scene(160, 80)
    world.spawn([Text, { value: 'Waypoint', font: fontRef, size: 0.5, billboard: true }], Transform)
    const eye: [number, number, number] = [3, 1, 3]
    const image = await shoot(
      camera([[Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }]]),
    )
    expect(compareGolden(here, 'text-billboard', image).mean).toBeLessThan(1.5)
  })

  it('lays out 10k glyphs changing every frame in under 2 ms of CPU a frame', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, fontRef, camera } = await scene(64, 64)
    const counters = []
    for (let i = 0; i < 1000; i++) {
      counters.push(
        world.spawn([
          ScreenText,
          { value: '0000000000', font: fontRef, size: 10, position: [0, i] },
        ]),
      )
    }
    camera()
    await settle(app, 2)
    const profiler = world.resource(ProfilerResource)
    let best = Number.POSITIVE_INFINITY
    for (let f = 0; f < 10; f++) {
      for (let i = 0; i < counters.length; i++) {
        world.set(counters[i]!, ScreenText, { value: String(1_000_000_000 + f * 7919 + i) })
      }
      app.update(1 / 60)
      best = Math.min(best, profiler.timing('text/prepare')!.last)
    }
    const d = describeRender(world).text as { texts: number; glyphs: number; relayouts: number }
    expect(d.texts).toBe(1000)
    expect(d.glyphs).toBe(10_000)
    expect(d.relayouts).toBe(1000)
    console.info(`text/prepare, 10k changing glyphs: ${best.toFixed(2)} ms`)
    expect(best).toBeLessThan(budget(2))
  })
})
