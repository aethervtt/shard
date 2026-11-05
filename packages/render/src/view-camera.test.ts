import { World } from '@aethervtt/shard-core'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { RenderTargets } from './assets'
import { Camera3d, DrivesView, Exposure, viewCamera } from './camera'
import { Tonemapping } from './view'

// The camera that drives view-dependent work (terrain LOD, the water clipmap, particle culling,
// shadow ranking): active, sees the layers, the window before offscreen, then order, then entity.

function scene() {
  const world = new World()
  const thumbnails = world.initResource(RenderTargets).add(
    {
      label: 'thumbnail',
      format: 'rgba8unorm',
      width: 64,
      height: 64,
      texture: () => {
        throw new Error('not rendered')
      },
    },
    'thumbnail',
  )
  return { world, cameras: world.query({ with: [Camera3d] }), thumbnails }
}

describe('viewCamera', () => {
  it('keeps the window camera over a thumbnail camera with a lower order, in any table order', () => {
    const { world, cameras, thumbnails } = scene()
    // The thumbnail's table (fewer components) comes first in the query.
    const thumbnail = world.spawn(
      [Camera3d, { target: thumbnails, order: -10, layers: 2 }],
      Exposure,
      Transform,
    )
    const main = world.spawn(Camera3d, Exposure, Tonemapping, Transform)
    expect(cameras.tables[0]!.entities[0]).toBe(thumbnail)
    expect(viewCamera(cameras)).toBe(main)
    // Even when the thumbnail sees layer 1: it renders offscreen.
    world.set(thumbnail, Camera3d, { layers: 0xffff })
    expect(viewCamera(cameras)).toBe(main)
    expect(viewCamera(cameras, 2)).toBe(main)
  })

  it('takes the lowest order, then the lowest entity, among window cameras', () => {
    const { world, cameras } = scene()
    const a = world.spawn([Camera3d, { order: 5 }], Exposure, Transform)
    const b = world.spawn([Camera3d, { order: 5 }], Exposure, Tonemapping, Transform)
    expect(viewCamera(cameras)).toBe(Math.min(a, b))
    const c = world.spawn([Camera3d, { order: 1 }], Exposure, Tonemapping, Transform)
    expect(viewCamera(cameras)).toBe(c)
  })

  it('skips inactive cameras and cameras that leave out the layers', () => {
    const { world, cameras } = scene()
    const main = world.spawn([Camera3d, { order: 0 }], Exposure, Transform)
    const ui = world.spawn([Camera3d, { order: -1, layers: 4 }], Exposure, Transform)
    expect(viewCamera(cameras)).toBe(main)
    expect(viewCamera(cameras, 4)).toBe(ui)
    expect(viewCamera(cameras, 0xffff)).toBe(ui)
    world.set(main, Camera3d, { active: false })
    expect(viewCamera(cameras)).toBeUndefined()
    expect(viewCamera(cameras, 0xffff)).toBe(ui)
  })

  it('falls back to an offscreen camera when no window camera can drive', () => {
    const { world, cameras, thumbnails } = scene()
    const far = world.spawn([Camera3d, { target: thumbnails, order: 3 }], Exposure, Transform)
    const near = world.spawn([Camera3d, { target: thumbnails, order: 2 }], Exposure, Transform)
    expect(viewCamera(cameras)).toBe(near)
    world.set(near, Camera3d, { active: false })
    expect(viewCamera(cameras)).toBe(far)
  })

  it('lets an offscreen camera with DrivesView drive like a window camera', () => {
    const { world, cameras, thumbnails } = scene()
    const main = world.spawn([Camera3d, { order: 0 }], Exposure, Transform)
    const minimap = world.spawn([Camera3d, { target: thumbnails, order: -10 }], Exposure, Transform)
    expect(viewCamera(cameras)).toBe(main)
    world.add(minimap, DrivesView)
    expect(viewCamera(cameras)).toBe(minimap)
    // It still competes on order with the window cameras.
    world.set(minimap, Camera3d, { order: 10 })
    expect(viewCamera(cameras)).toBe(main)
  })
})
