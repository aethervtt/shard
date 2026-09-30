import type { AssetRef } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  Camera3d,
  Exposure,
  forwardPlugin,
  Gpu,
  GroundLayer,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { pixel, renderView } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { vectorPlugin } from './plugin'
import { VectorShape, VectorState } from './shape'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const TOP_DOWN: [number, number, number, number] = [-Math.SQRT1_2, 0, 0, Math.SQRT1_2]

async function scene() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    vectorPlugin,
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'vector', width: 128, height: 128 })
  const ref = world.resource(RenderTargets).add(target, 'vector') as AssetRef<'RenderTarget'>
  const camera = world.spawn(
    [
      Camera3d,
      { target: ref, projection: 'orthographic', orthoHeight: 8, clearColor: [0, 0, 0, 1] },
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

describe('vector shapes', () => {
  it('keep CSS-pixel strokes the same width at any zoom, and world strokes scale', async () => {
    const r = await scene()
    // A horizontal line through the centre: measure its thickness down the middle column.
    const line = r.world.spawn(
      [
        VectorShape,
        {
          geometry: { kind: 'line', from: [-20, 0], to: [20, 0] },
          stroke: [1, 1, 1, 1],
          strokeWidth: 4,
          strokeUnits: 'css-px',
        },
      ],
      Transform,
    )
    const thickness = async () => {
      const image = await renderView(r.app, `camera:${r.camera}`)
      let sum = 0
      for (let y = 0; y < image.height; y++) sum += toLinear(pixel(image, 64, y)[0]!)
      return sum
    }
    for (const orthoHeight of [2, 8, 32]) {
      r.world.set(r.camera, Camera3d, { orthoHeight })
      expect(Math.abs((await thickness()) - 4), `orthoHeight ${orthoHeight}`).toBeLessThanOrEqual(1)
    }
    // 0.25 world units wide: 4 px at orthoHeight 8 on 128 px, 16 px at 2.
    r.world.set(line, VectorShape, { strokeWidth: 0.25, strokeUnits: 'world', rev: 1 })
    r.world.set(r.camera, Camera3d, { orthoHeight: 8 })
    expect(Math.abs((await thickness()) - 4)).toBeLessThanOrEqual(1)
    r.world.set(r.camera, Camera3d, { orthoHeight: 2 })
    expect(Math.abs((await thickness()) - 16)).toBeLessThanOrEqual(1)
    expect(r.world.get(line, GroundLayer).band).toBe(30)
    expect(r.world.resource(Gpu).errors).toEqual([])
    await r.app.dispose()
    r.target.destroy()
  })

  it('rebuilds a mesh only when its rev (or stroke) changes', async () => {
    const r = await scene()
    const shape = r.world.spawn(
      [
        VectorShape,
        { geometry: { kind: 'ellipse', rx: 2, ry: 1 }, fillOpacity: 1, strokeWidth: 0 },
      ],
      Transform,
    )
    r.app.update(1 / 60)
    const state = r.world.resource(VectorState)
    expect(state.rebuilds).toBe(1)
    r.world.set(shape, VectorShape, { fill: [1, 0, 0, 1] })
    r.app.update(1 / 60)
    expect(state.rebuilds).toBe(1)
    r.world.set(shape, VectorShape, { geometry: { kind: 'ellipse', rx: 3, ry: 1 }, rev: 1 })
    r.app.update(1 / 60)
    expect(state.rebuilds).toBe(2)
    r.world.despawn(shape)
    r.app.update(1 / 60)
    expect(state.shapes.size).toBe(0)
    await r.app.dispose()
    r.target.destroy()
  })
})
