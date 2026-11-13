import { defineSystem, PostUpdate, Rng } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin, TransformSystems } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { casterRelevant } from './caster-relevance'
import { Culler, readVisibleSlots, visibleSlots } from './culling'
import { ForwardStateResource } from './forward'
import {
  INSTANCE_FLOATS,
  InstanceSlot,
  Instances,
  Mesh3d,
  MeshMaterial,
  slotSphere,
} from './instances'
import { DirectionalLight, LightingSettings, SpotLight } from './lights'
import { renderPlugin } from './plugin'
import { ShadowsResource, type ShadowViewDraw } from './shadows'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { settle } from './testing'

// 0116: shadow casters per cascade, by shadow volume and size, and casterRelevant.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const CASCADES = { count: 4, maxDistance: 150, splitLambda: 0.8 }

async function scene() {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'casters', width: 96, height: 64 })
  const targetRef = app.world.resource(RenderTargets).add(target, 'casters')
  const world = app.world
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.6 }))
  const unit = world.resource(Meshes).add(cube({ size: 1 }))
  const camera = (eye: [number, number, number], at: [number, number, number]) =>
    world.spawn(
      [Camera3d, { target: targetRef as never, fovY: 60 }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  const box = (at: [number, number, number], scale: [number, number, number] = [1, 1, 1]) =>
    world.spawn(
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material }],
      [Transform, { translation: at, scale }],
    )
  /** A sun whose light travels along `travel`. */
  const sun = (travel: [number, number, number], minCasterTexels = 1) =>
    world.spawn(
      [DirectionalLight, { illuminance: 2000, shadows: true, cascades: CASCADES, minCasterTexels }],
      [Transform, { rotation: lookAt([0, 0, 0], travel) }],
    )
  return { app, world, target, camera, box, sun }
}

type World = Awaited<ReturnType<typeof scene>>['world']

const slotOf = (world: World, e: number) => world.get(e, InstanceSlot)!.slot - 1

/** Slots each of the camera's cascades drew this frame, from the GPU or the CPU cull. */
async function cascadeSets(world: World, camera: number, gpuCull: boolean) {
  const pv = world.resource(ForwardStateResource).views.get(`camera:${camera}`)!
  const sets: Set<number>[] = []
  for (let i = 0; i < pv.cascades.count; i++)
    sets.push(await drawn(world, pv.cascades.views[i]!, gpuCull))
  return sets
}

async function drawn(world: World, view: ShadowViewDraw, gpuCull: boolean): Promise<Set<number>> {
  const store = world.resource(Instances)
  // The baseline tier (0064) culls on the CPU only.
  return gpuCull && world.resource(Culler).active
    ? readVisibleSlots(gpu, world.resource(Culler), view.draws)
    : visibleSlots(store, view.draws)
}

describe('shadow casters per cascade (0116)', () => {
  for (const gpuCull of [true, false]) {
    const how = gpuCull ? 'GPU' : 'CPU'
    it(`keeps a caster behind the camera whose shadow falls into view, not one whose shadow falls away (${how})`, async () => {
      for (const toward of [true, false]) {
        const { app, world, target, camera, box, sun } = await scene()
        world.resource(Culler).enabled = gpuCull
        const cam = camera([0, 2, 0], [0, 0, -20])
        // A character-sized box 6 m behind the camera, under a low sun.
        const behind = box([0, 0.9, 6], [0.5, 1.8, 0.5])
        box([0, 0.5, -10])
        sun(toward ? [0, -0.15, -1] : [0, -0.15, 1])
        await settle(app, 3)
        const sets = await cascadeSets(world, cam, gpuCull)
        const slot = slotOf(world, behind)
        const any = sets.some((s) => s.has(slot))
        expect(any, toward ? 'its shadow falls into view' : 'its shadow falls away').toBe(toward)
        await app.dispose()
        target.destroy()
      }
    })

    it(`leaves out casters smaller than minCasterTexels in a cascade (${how})`, async () => {
      for (const min of [1, 0]) {
        const { app, world, target, camera, box, sun } = await scene()
        world.resource(Culler).enabled = gpuCull
        world.resource(LightingSettings).cascadeMapSize = 256
        const cam = camera([0, 2, 0], [0, 0, -20])
        // 0.2 m across at 100 m: a fraction of a texel of the last cascade at 256².
        const can = box([0, 0.1, -100], [0.2, 0.2, 0.2])
        sun([0, -0.5, -1], min)
        await settle(app, 3)
        const sets = await cascadeSets(world, cam, gpuCull)
        const pv = world.resource(ForwardStateResource).views.get(`camera:${cam}`)!
        const texel = pv.cascades.texel[3]!
        expect(0.2 * Math.sqrt(3)).toBeLessThan(texel)
        expect(sets[3]!.has(slotOf(world, can)), `minCasterTexels ${min}`).toBe(min === 0)
        await app.dispose()
        target.destroy()
      }
    })

    it(`casterRelevant is true exactly when a cull draws the sphere into the camera's cascades or spot (${how})`, {
      timeout: timeout(120_000),
    }, async () => {
      const { app, world, target, camera, box, sun } = await scene()
      world.resource(Culler).enabled = gpuCull
      const cam = camera([0, 3, 10], [0, 0, 0])
      sun([0.4, -0.6, -1], 0)
      world.spawn(
        [SpotLight, { intensity: 5000, range: 25, shadows: true, outerAngle: 50 }],
        [Transform, { translation: [5, 8, -5], rotation: lookAt([5, 8, -5], [0, 0, -5]) }],
      )
      const rng = new Rng(11)
      const boxes: number[] = []
      for (let i = 0; i < 400; i++)
        boxes.push(
          box(
            [rng.range(-80, 80), rng.range(0, 6), rng.range(-120, 60)],
            [rng.range(0.2, 2), rng.range(0.2, 3), rng.range(0.2, 2)],
          ),
        )
      await settle(app, 3)
      // Their spheres as the cull sees them.
      const store = world.resource(Instances)
      const spheres = new Float32Array(boxes.length * 4)
      const s = new Float32Array(4)
      for (let k = 0; k < boxes.length; k++) {
        const slot = slotOf(world, boxes[k]!)
        const batch = store.batches[store.batchOf[slot]!]!
        slotSphere(s, store.f32, slot * INSTANCE_FLOATS, batch.mesh.bounds)
        spheres.set(s, k * 4)
      }
      // Asked after transform propagation, as 0115 would, while the camera walks.
      const relevant = new Uint8Array(boxes.length)
      const center = new Float32Array(3)
      app.addSystems(
        PostUpdate,
        defineSystem({
          name: 'test/caster-relevant',
          run: () => {
            for (let k = 0; k < boxes.length; k++) {
              center[0] = spheres[k * 4]!
              center[1] = spheres[k * 4 + 1]!
              center[2] = spheres[k * 4 + 2]!
              relevant[k] = casterRelevant(world, cam, center, spheres[k * 4 + 3]!) ? 1 : 0
            }
          },
        }).after(TransformSystems),
      )
      let checked = 0
      let kept = 0
      for (let step = 0; step < 5; step++) {
        world.set(cam, Transform, {
          translation: [step * 3, 3, 10 - step * 4],
          rotation: lookAt([step * 3, 3, 10 - step * 4], [step * 6 - 10, 0, -20]),
        })
        app.update(1 / 60)
        const sets = await cascadeSets(world, cam, gpuCull)
        const local = world.resource(ShadowsResource).local
        expect(local.spots.length).toBe(1)
        sets.push(await drawn(world, local.spotViews[0]!, gpuCull))
        for (let k = 0; k < boxes.length; k++) {
          const slot = slotOf(world, boxes[k]!)
          const inAny = sets.some((set) => set.has(slot))
          expect(relevant[k] === 1, `box ${k}, step ${step}`).toBe(inAny)
          if (inAny) kept++
          checked++
        }
      }
      expect(checked).toBe(5 * boxes.length)
      // Neither everything nor nothing: the test tells them apart.
      expect(kept).toBeGreaterThan(checked * 0.05)
      expect(kept).toBeLessThan(checked * 0.95)
      await app.dispose()
      target.destroy()
    })
  }

  it('casterRelevant allocates nothing over 10,000 calls a frame', async () => {
    const { app, world, target, camera, sun } = await scene()
    const cam = camera([0, 3, 10], [0, 0, 0])
    sun([0.4, -0.6, -1])
    await settle(app, 2)
    const center = new Float32Array(3)
    const frame = () => {
      for (let i = 0; i < 10_000; i++) {
        center[0] = (i % 100) - 50
        center[1] = 1
        center[2] = ((i / 100) | 0) - 50
        casterRelevant(world, cam, center, 0.5)
      }
    }
    for (let i = 0; i < 5; i++) frame() // let V8 optimize
    const window = gcWindow()
    for (let i = 0; i < (allocationChecks ? 20 : 2); i++) frame()
    const collections = await window.end()
    if (allocationChecks) expect(collections).toBe(0)
    await app.dispose()
    target.destroy()
  })
})
