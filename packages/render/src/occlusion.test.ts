import type { Entity } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, Mesh, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler, readVisibleSlots, visibleSlots } from './culling'
import { ForwardStateResource } from './forward'
import { DynamicCaster, InstanceSlot, Instances, Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { Occluder, OcclusionCulling, OcclusionPath, occluded } from './occlusion'
import { OcclusionBuffer } from './occlusion-buffer'
import { captureView, renderPlugin, Views } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { settle } from './testing'
import { cameraOf } from './view'
import { ViewVisibility } from './view-visibility'
import { Visibility } from './visibility'

// Occlusion culling (0116).

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('OcclusionBuffer', () => {
  it('hides only what fully covered pixels hide, and never across the near plane', () => {
    const b = new OcclusionBuffer()
    b.resize(64, 32)
    // A camera at the origin looking down -Z.
    b.view.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
    b.sx = 1
    b.sy = 2
    b.near = 0.1
    b.data.fill(Number.POSITIVE_INFINITY)
    // An occluder 10 m away over the left half of the screen.
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) b.data[y * 64 + x] = 10
    b.buildPyramid()
    b.valid = true
    expect(b.hides(-3, 0, -20, 0.5), 'behind it').toBe(true)
    expect(b.hides(3, 0, -20, 0.5), 'beside it').toBe(false)
    expect(b.hides(-3, 0, -5, 0.5), 'in front of it').toBe(false)
    expect(b.hides(-0.2, 0, -20, 0.5), 'straddling its edge').toBe(false)
    expect(b.hides(0, 0, 0, 0.5), 'across the near plane').toBe(false)
    // An odd size keeps its leftover row and column in the pyramid.
    b.resize(9, 5)
    b.data.fill(Number.POSITIVE_INFINITY)
    b.data.fill(5, 0, 9 * 4)
    b.buildPyramid()
    for (let l = 1; l < b.levels; l++) {
      const w = b.widths[l]!
      const h = b.heights[l]!
      expect(b.data[b.offsets[l]! + (h - 1) * w + (w - 1)], `level ${l}`).toBe(
        Number.POSITIVE_INFINITY,
      )
    }
  })
})

/**
 * A street: a long wall 10 m in front of the camera, boxes behind it, beside it and in front, a
 * ground, and a sun. The wall is an occluder.
 */
async function street(gpuCull: boolean, occlusion: boolean) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  world.resource(Culler).enabled = gpuCull
  const target = new OffscreenTarget(gpu, { label: 'occlusion', width: 128, height: 96 })
  const targetRef = world.resource(RenderTargets).add(target, 'occlusion')
  const meshes = world.resource(Meshes)
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.8 }))
  const unit = meshes.add(cube({ size: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 200 })) }],
    [MeshMaterial, { material }],
    Transform,
  )
  // The wall: 12 m wide, 6 m tall, drawn as a box; its occluder a quad through its middle.
  const quad = Mesh.create({
    positions: new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  })
  const wall = world.spawn(
    [Mesh3d, { mesh: unit }],
    [MeshMaterial, { material }],
    [Transform, { translation: [0, 3, -10], scale: [12, 6, 0.4] }],
    [Occluder, { mesh: meshes.add(quad) }],
  )
  const box = (at: [number, number, number]) =>
    world.spawn(
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material }],
      [Transform, { translation: at }],
    )
  const behind = [box([0, 0.5, -20]), box([-6, 0.5, -30]), box([5, 0.5, -16])]
  const beside = box([14, 0.5, -20])
  const before = box([2, 0.5, -5])
  // Rises over the top of the wall as the camera sees it.
  const tall = world.spawn(
    [Mesh3d, { mesh: unit }],
    [MeshMaterial, { material }],
    [Transform, { translation: [-2, 9, -20], scale: [1, 8, 1] }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 3000, shadows: true }],
    [Transform, { rotation: lookAt([0, 0, 0], [-0.3, -1, 0.4]) }],
  )
  const camera = world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 60 }],
    [Exposure, { ev100: 10 }],
    [Transform, { translation: [0, 1.7, 2], rotation: lookAt([0, 1.7, 2], [0, 1.7, -20]) }],
    ...(occlusion ? [[OcclusionCulling, {}] as const] : []),
  )
  return {
    app,
    world,
    target,
    wall,
    behind,
    beside,
    before,
    tall,
    camera,
    name: `camera:${camera}`,
  }
}

type Street = Awaited<ReturnType<typeof street>>

async function cameraSet(s: Street, gpuCull: boolean): Promise<Set<number>> {
  const view = cameraOf(s.world.resource(Views).list.find((v) => v.name === s.name)!)!
  // The baseline tier (0064) culls on the CPU only.
  return gpuCull && s.world.resource(Culler).active
    ? readVisibleSlots(gpu, s.world.resource(Culler), view.draws)
    : visibleSlots(s.world.resource(Instances), view.draws)
}

const slotOf = (s: Street, e: Entity) => s.world.get(e, InstanceSlot)!.slot - 1

async function shot(s: Street) {
  await settle(s.app)
  const image = captureView(s.world, s.name)
  s.app.update(1 / 60)
  return image
}

describe('occlusion culling (0116)', () => {
  for (const gpuCull of [true, false]) {
    const how = gpuCull ? 'GPU' : 'CPU'
    it(`culls what a wall hides, keeps what peeks past it, and renders the same (${how})`, async () => {
      const on = await street(gpuCull, true)
      const off = await street(gpuCull, false)
      const [a, b] = [await shot(on), await shot(off)]
      expect(a.data, 'renders bit-identical with and without occlusion').toEqual(b.data)
      const set = await cameraSet(on, gpuCull)
      for (const e of on.behind) expect(set.has(slotOf(on, e)), `behind ${e}`).toBe(false)
      expect(set.has(slotOf(on, on.beside))).toBe(true)
      expect(set.has(slotOf(on, on.before))).toBe(true)
      expect(set.has(slotOf(on, on.tall)), 'peeks over the top').toBe(true)
      expect(set.has(slotOf(on, on.wall))).toBe(true)
      const offSet = await cameraSet(off, gpuCull)
      for (const e of off.behind) expect(offSet.has(slotOf(off, e))).toBe(true)
      for (const s of [on, off]) {
        await s.app.dispose()
        s.target.destroy()
      }
    })
  }

  it('an occluder hidden from the camera, or shadow-only, hides nothing', async () => {
    for (const how of ['view', 'shadow-only'] as const) {
      const s = await street(false, true)
      if (how === 'view') s.world.add(s.camera, ViewVisibility, { hide: [s.wall] })
      else s.world.set(s.wall, Visibility, { mode: 'shadow-only' })
      await settle(s.app)
      const set = await cameraSet(s, false)
      for (const e of s.behind) expect(set.has(slotOf(s, e)), `${how}: behind ${e}`).toBe(true)
      await s.app.dispose()
      s.target.destroy()
    }
  })

  it('a still camera over still occluders keeps its raster; occluded() reads it', async () => {
    const s = await street(false, true)
    await settle(s.app)
    const buffer = s.world.resource(OcclusionPath).bufferOf(s.camera) as OcclusionBuffer
    const rasters = buffer.rasters
    for (let i = 0; i < 5; i++) s.app.update(1 / 60)
    expect(buffer.rasters).toBe(rasters)
    expect(occluded(s.world, s.camera, [0, 0.5, -20], 0.9)).toBe(true)
    expect(occluded(s.world, s.camera, [20, 0.5, -20], 0.9)).toBe(false)
    s.world.set(s.camera, Transform, {
      translation: [0.5, 1.7, 2],
      rotation: lookAt([0.5, 1.7, 2], [0, 1.7, -20]),
    })
    s.app.update(1 / 60)
    expect(buffer.rasters).toBe(rasters + 1)
    await s.app.dispose()
    s.target.destroy()
  })

  for (const gpuCull of [true, false]) {
    it(`drops a dynamic caster whose shadow falls behind the wall from the cascades (${gpuCull ? 'GPU' : 'CPU'})`, async () => {
      const s = await street(gpuCull, true)
      const hiddenCaster = s.world.spawn(
        [Mesh3d, { mesh: s.world.resource(Meshes).add(cube({ size: 1 })) }],
        [MeshMaterial, { material: null }],
        [Transform, { translation: [0, 0.9, -25], scale: [0.5, 1.8, 0.5] }],
        DynamicCaster,
      )
      const seenCaster = s.world.spawn(
        [Mesh3d, { mesh: s.world.resource(Meshes).add(cube({ size: 1 })) }],
        [MeshMaterial, { material: null }],
        [Transform, { translation: [3, 0.9, -6], scale: [0.5, 1.8, 0.5] }],
        DynamicCaster,
      )
      await settle(s.app)
      const pv = s.world.resource(ForwardStateResource).views.get(s.name)!
      const store = s.world.resource(Instances)
      const inCascades = async (e: Entity) => {
        const slot = slotOf(s, e)
        for (let i = 0; i < pv.cascades.count; i++) {
          const view = pv.cascades.views[i]!
          const set =
            gpuCull && s.world.resource(Culler).active
              ? await readVisibleSlots(gpu, s.world.resource(Culler), view.draws)
              : visibleSlots(store, view.draws)
          if (set.has(slot)) return true
        }
        return false
      }
      expect(await inCascades(hiddenCaster), 'its shadow falls behind the wall').toBe(false)
      expect(await inCascades(seenCaster), 'its shadow falls in view').toBe(true)
      await s.app.dispose()
      s.target.destroy()
    })
  }
})
