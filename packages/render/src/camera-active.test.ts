import type { GpuContext } from '@shard/gpu'
import { createNodeGpuContext } from '@shard/gpu/node'
import { cube } from '@shard/mesh'
import { App } from '@shard/runtime'
import { Transform, TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { forwardPlugin } from './forward'
import { Mesh3d } from './instances'
import { Gpu, renderPlugin, Views } from './plugin'
import { Antialiasing } from './post'
import { RenderCounters } from './stats'
import { OffscreenTarget } from './target'
import { settle } from './testing'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

async function scene() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'active', width: 16, height: 16 })
  const targetRef = app.world.resource(RenderTargets).add(target, 'active')
  app.world.spawn([Mesh3d, { mesh: app.world.resource(Meshes).add(cube({ size: 1 })) }], Transform)
  return { app, world: app.world, targetRef }
}

const viewNames = (world: App['world']) => world.resource(Views).list.map((v) => v.name)

describe('Camera3d.active', () => {
  it('renders only active cameras, and switching keeps both cameras as they were', async () => {
    const { app, world, targetRef } = await scene()
    const top = world.spawn(
      [Camera3d, { target: targetRef, projection: 'orthographic', orthoHeight: 20 }],
      Exposure,
      [Transform, { translation: [0, 10, 0] }],
    )
    const persp = world.spawn(
      [Camera3d, { target: targetRef, active: false, fovY: 50 }],
      Exposure,
      [Transform, { translation: [0, 3, 8] }],
    )
    await settle(app)
    expect(world.resource(Gpu).errors).toEqual([])
    expect(viewNames(world)).toEqual([`camera:${top}`])

    world.set(top, Camera3d, { active: false })
    world.set(persp, Camera3d, { active: true })
    app.update(1 / 60)
    expect(viewNames(world)).toEqual([`camera:${persp}`])
    // The inactive camera keeps its own settings for when it comes back.
    expect(world.get(top, Camera3d).projection).toBe('orthographic')
    expect(world.get(top, Camera3d).orthoHeight).toBe(20)

    world.set(persp, Camera3d, { active: false })
    app.update(1 / 60)
    expect(viewNames(world)).toEqual([])
  })

  it('starts a fresh TAA history when a camera becomes active again', async () => {
    const { app, world, targetRef } = await scene()
    const cam = world.spawn(
      [Camera3d, { target: targetRef }],
      Exposure,
      [Transform, { translation: [0, 2, 6] }],
      [Antialiasing, { mode: 'taa' }],
    )
    await settle(app)
    const counters = world.resource(RenderCounters)
    const before = counters.taaResets
    app.update(1 / 60)
    expect(counters.taaResets).toBe(before)

    world.set(cam, Camera3d, { active: false })
    app.update(1 / 60)
    world.set(cam, Camera3d, { active: true })
    app.update(1 / 60)
    expect(counters.taaResets).toBe(before + 1)
    app.update(1 / 60)
    expect(counters.taaResets).toBe(before + 1)
  })
})
