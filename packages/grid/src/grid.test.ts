import { writeFileSync } from 'node:fs'
import type { AssetRef } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  Exposure,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, pngBytes, renderView } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Grid } from './grid'
import { distance } from './math'
import { gridPlugin } from './plugin'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** Straight down, screen-up toward −z. */
const TOP_DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]

const CSS_W = 256
const CSS_H = 128

async function scene(ratio: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    gridPlugin,
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, {
    label: 'grid',
    width: CSS_W * ratio,
    height: CSS_H * ratio,
    pixelRatio: ratio,
  })
  const ref = world.resource(RenderTargets).add(target, 'grid') as AssetRef<'RenderTarget'>
  const camera = world.spawn(
    [
      Camera3d,
      { target: ref, projection: 'orthographic', orthoHeight: 14, clearColor: [0, 0, 0, 1] },
    ],
    [Exposure, { ev100: 0 }],
    [Tonemapping, { curve: 'none', dither: false }],
    [Transform, { translation: [0, 10, 0], rotation: TOP_DOWN }],
  )
  return { app, world, target, camera }
}

const toLinear = (v: number) => {
  const c = v / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Coverage of each full line crossing along a row (or column): its width in target pixels. */
function crossings(values: number[]): number[] {
  const out: number[] = []
  let sum = 0
  let start = -1
  for (let i = 0; i <= values.length; i++) {
    const v = i < values.length ? values[i]! : 0
    if (v > 0.002) {
      if (start < 0) start = i
      sum += v
    } else if (start >= 0) {
      if (start > 0 && i < values.length) out.push(sum)
      start = -1
      sum = 0
    }
  }
  return out
}

describe('grid lines', () => {
  for (const [kind, orientation] of [
    ['square', 'pointy'],
    ['hex', 'pointy'],
    ['hex', 'flat'],
  ] as const) {
    it(`measure lineWidth ± 0.5 CSS px at every zoom and pixel ratio (${kind}${kind === 'hex' ? ` ${orientation}` : ''})`, async () => {
      for (const ratio of [1, 2]) {
        const r = await scene(ratio)
        const grid = r.world.spawn(
          [
            Grid,
            {
              kind,
              orientation,
              size: 3,
              offset: [0, 0],
              color: [1, 1, 1, 1],
              opacity: 1,
              lineWidth: 1,
              extent: [400, 400],
            },
          ],
          Transform,
        )
        for (const zoom of [0.25, 1, 4]) {
          for (const lineWidth of [1, 3]) {
            r.world.set(r.camera, Camera3d, { orthoHeight: 14 / zoom })
            r.world.set(grid, Grid, { lineWidth })
            const image = await renderView(r.app, `camera:${r.camera}`)
            const worldPerPx = 14 / zoom / image.height
            let values: number[] = []
            if (kind === 'hex' && orientation === 'flat') {
              // A column through cell centres crosses only horizontal edges.
              const x = Math.floor(image.width / 2)
              for (let y = 0; y < image.height; y++) values.push(toLinear(pixel(image, x, y)[0]!))
            } else {
              // A row through cell centres (hex) or mid-cell (square) crosses only vertical lines.
              const z = kind === 'square' ? 1.5 : 0
              const y = Math.floor(image.height / 2 + z / worldPerPx)
              values = []
              for (let x = 0; x < image.width; x++) values.push(toLinear(pixel(image, x, y)[0]!))
            }
            const widths = crossings(values)
            if (process.env.SHARD_GOLDEN_OUT)
              writeFileSync(
                `${process.env.SHARD_GOLDEN_OUT}/grid-${kind}-${orientation}-${ratio}-${zoom}-${lineWidth}.png`,
                pngBytes(image.data, image.width, image.height),
              )
            const label = `${kind} ${orientation} ratio ${ratio} zoom ${zoom} width ${lineWidth}: ${widths.map((w) => (w / ratio).toFixed(2))}`
            expect(widths.length, label).toBeGreaterThan(0)
            for (const w of widths)
              expect(Math.abs(w / ratio - lineWidth), label).toBeLessThanOrEqual(0.5)
          }
        }
        expect(r.world.resource(Gpu).errors).toEqual([])
        await r.app.dispose()
        r.target.destroy()
      }
    })
  }

  it("draws the same pixels whatever the grid's game distance, unit or diagonal rule", async () => {
    const r = await scene(1)
    // A host's grid document: only size and offset reach the engine; distance, unit and diagonal
    // are measuring rules.
    const doc = {
      size: 70,
      offset: { x: 10, y: 5 },
      distance: 5,
      unit: 'ft',
      diagonal: 'euclidean' as const,
    }
    const k = 1.5 / 70
    const apply = (d: { size: number; offset: { x: number; y: number } }) =>
      r.world.set(grid, Grid, { size: d.size * k, offset: [d.offset.x * k, d.offset.y * k] })
    const grid = r.world.spawn([Grid, { color: [1, 1, 1, 1], opacity: 1 }], Transform)
    apply(doc)
    const before = await renderView(r.app, `camera:${r.camera}`)
    const relabelled: Omit<typeof doc, 'diagonal'> & { diagonal: 'euclidean' | 'alternating' } = {
      ...doc,
      distance: 1.5,
      unit: 'm',
      diagonal: 'alternating',
    }
    apply(relabelled)
    const after = await renderView(r.app, `camera:${r.camera}`)
    expect(Buffer.from(after.data).equals(Buffer.from(before.data))).toBe(true)
    // The rules only measure.
    const g = {
      kind: 'square' as const,
      orientation: 'pointy' as const,
      size: 70,
      offset: [0, 0] as const,
    }
    expect(distance(g, [0, 0], [140, 70], doc.diagonal)).toBeCloseTo(Math.sqrt(5), 9)
    expect(distance(g, [0, 0], [140, 70], relabelled.diagonal)).toBe(2)
    await r.app.dispose()
    r.target.destroy()
  })
})
