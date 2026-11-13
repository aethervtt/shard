import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Culler, visibleSlots } from './culling'
import { readTextureLayer } from './debug-views'
import { ForwardStateResource } from './forward'
import {
  DynamicCaster,
  InstanceSlot,
  Instances,
  Mesh3d,
  MeshMaterial,
  sphereInFrustum,
} from './instances'
import { DirectionalLight, LightingSettings } from './lights'
import { captureView, Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { RenderStats } from './stats'
import { OffscreenTarget } from './target'
import { settle } from './testing'

// 0116: cached static layers under dynamic casters.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const SUN = [-0.5, -0.8, -0.4] as [number, number, number]

async function scene(
  update: 'always' | 'on-change',
  cascades: Partial<{ step: number; farEvery: number }> = {},
  size = 96,
) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'cached', width: size, height: size })
  const targetRef = app.world.resource(RenderTargets).add(target, 'cached')
  const world = app.world
  const materials = world.resource(Materials)
  const meshes = world.resource(Meshes)
  const material = materials.add(new MaterialAsset({ roughness: 0.8 }))
  const unit = meshes.add(cube({ size: 1 }))
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 60 })) }],
    [MeshMaterial, { material }],
    [Transform, {}],
  )
  const box = (at: [number, number, number], scale: [number, number, number] = [1, 1, 1]) =>
    world.spawn(
      [Mesh3d, { mesh: unit }],
      [MeshMaterial, { material }],
      [Transform, { translation: at, scale }],
    )
  // A row of "buildings".
  for (let i = 0; i < 6; i++) box([i * 4 - 10, 1.5, -4], [3, 3, 3])
  const sun = world.spawn(
    [
      DirectionalLight,
      {
        illuminance: 4000,
        shadows: true,
        shadowUpdate: update,
        cascades: { count: 4, maxDistance: 60, splitLambda: 0.8 },
        shadowStep: cascades.step ?? 0.125,
        shadowFarEvery: cascades.farEvery ?? 4,
      },
    ],
    [Transform, { rotation: lookAt([0, 0, 0], SUN) }],
  )
  const camera = world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 60 }],
    [Exposure, { ev100: 10 }],
    [Transform, { translation: [0, 6, 12], rotation: lookAt([0, 6, 12], [0, 0, -2]) }],
  )
  const name = `camera:${camera}`
  const cascadesOf = () => world.resource(ForwardStateResource).views.get(name)!.cascades
  const stats = world.resource(RenderStats)
  return { app, world, target, box, sun, camera, name, cascadesOf, stats }
}

async function shot(app: App, name: string) {
  const image = captureView(app.world, name)
  app.update(1 / 60)
  return image
}

/** Pixels where any channel differs by more than `tolerance`, as a fraction. */
function differing(a: { data: ArrayLike<number> }, b: { data: ArrayLike<number> }, tolerance = 2) {
  let n = 0
  for (let i = 0; i < a.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      if (Math.abs(a.data[i + c]! - b.data[i + c]!) > tolerance) {
        n++
        break
      }
    }
  }
  return n / (a.data.length / 4)
}

describe('cached shadows under dynamic casters (0116)', () => {
  it('a still scene draws no shadow pass; an idle dynamic caster draws only the dynamic layers it reaches', async () => {
    const s = await scene('on-change')
    await settle(s.app)
    for (let i = 0; i < 120; i++) {
      s.app.update(1 / 60)
      expect(s.stats.lastFrame.shadowMapsRendered, `still frame ${i}`).toBe(0)
      expect(s.stats.lastFrame.sceneBytes, `still frame ${i}`).toBe(0)
    }
    // A character that never stops animating (a skinned one is dynamic the same way).
    const character = s.box([0, 0.9, 4], [0.5, 1.8, 0.5])
    s.world.add(character, DynamicCaster)
    await settle(s.app, 4)
    for (let i = 0; i < 8; i++) {
      s.app.update(1 / 60)
      const c = s.cascadesOf()
      expect(c.fullRedraws + c.rectRedraws, `frame ${i}`).toBe(0)
      // Exactly the cascades whose slice its shadow can reach draw a dynamic layer (and the far
      // ones only on their turn).
      let drawn = 0
      for (let k = 0; k < c.count; k++) {
        if (!c.dynamic[k]!.redraw) continue
        drawn++
        expect(c.dynamicOn[k], `cascade ${k} drew its dynamic layer`).toBe(1)
      }
      expect(s.stats.lastFrame.shadowMapsRendered).toBe(drawn)
      expect(drawn).toBeGreaterThan(0)
      expect(drawn).toBeLessThan(4)
    }
    await s.app.dispose()
    s.target.destroy()
  })

  it("a walking character's shadow over cached static layers matches 'always' within penumbra overlaps", {
    timeout: timeout(120_000),
  }, async () => {
    // step 0: the same cascade boxes as 'always'; farEvery 1: every dynamic layer every frame (the
    // far cadence lags by design, tested on its own). Only the layering differs.
    const cached = await scene('on-change', { step: 0, farEvery: 1 })
    const always = await scene('always')
    const walkers = [cached, always].map((s) => {
      const e = s.box([-8, 0.9, 1], [0.5, 1.8, 0.5])
      s.world.add(e, DynamicCaster)
      return e
    })
    await settle(cached.app)
    await settle(always.app)
    let staticRedraws = 0
    for (let f = 1; f <= 60; f++) {
      const x = -8 + f * 0.25
      for (const [k, s] of [cached, always].entries())
        s.world.set(walkers[k]!, Transform, { translation: [x, 0.9, 1], scale: [0.5, 1.8, 0.5] })
      if (f === 1 || f === 30 || f === 60) {
        const [a, b] = await Promise.all([
          shot(cached.app, cached.name),
          shot(always.app, always.name),
        ])
        expect(differing(a, b), `frame ${f}`).toBeLessThanOrEqual(0.001)
      } else {
        cached.app.update(1 / 60)
        always.app.update(1 / 60)
      }
      const c = cached.cascadesOf()
      staticRedraws += c.fullRedraws + c.rectRedraws
    }
    expect(staticRedraws).toBe(0)
    for (const s of [cached, always]) {
      await s.app.dispose()
      s.target.destroy()
    }
  })

  it('a new static caster redraws only its rectangle, drawing only the static casters over it', async () => {
    const s = await scene('on-change', {}, 64)
    s.world.resource(Culler).enabled = false
    s.world.resource(LightingSettings).cascadeMapSize = 256
    await settle(s.app)
    s.app.update(1 / 60)
    const c = s.cascadesOf()
    // The layer cascade 1 holds, before and after a building appears in it.
    const layer = 1
    const before = new Float32Array(
      (await readTextureLayer(s.world.resource(Gpu), c.texture!, layer)).data.buffer.slice(0),
    )
    const added = s.box([3, 1.5, 3], [3, 3, 3])
    s.app.update(1 / 60)
    expect(c.fullRedraws).toBe(0)
    expect(c.rectMask & (1 << layer)).not.toBe(0)
    const view = c.views[layer]!
    const rect = [...view.rects]
    // What it drew: exactly the static casters over the rectangle.
    const store = s.world.resource(Instances)
    const drawnSlots = visibleSlots(store, view.draws)
    const sphere = new Float32Array(4)
    for (const e of s.world.query({ with: [Mesh3d, InstanceSlot] }).entities()) {
      const slot = s.world.get(e, InstanceSlot)!.slot - 1
      const { slotSphere, INSTANCE_FLOATS } = await import('./instances')
      const batch = store.batches[store.batchOf[slot]!]!
      slotSphere(sphere, store.f32, slot * INSTANCE_FLOATS, batch.mesh.bounds)
      expect(drawnSlots.has(slot), `entity ${e}`).toBe(sphereInFrustum(view.cullPlanes, sphere))
    }
    expect(drawnSlots.has(s.world.get(added, InstanceSlot)!.slot - 1)).toBe(true)
    s.app.update(1 / 60)
    const after = new Float32Array(
      (await readTextureLayer(s.world.resource(Gpu), c.texture!, layer)).data.buffer.slice(0),
    )
    const size = c.size
    let inside = 0
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Captures expand each texel to four floats.
        const i = (y * size + x) * 4
        const inRect = x >= rect[0]! && x < rect[2]! && y >= rect[1]! && y < rect[3]!
        if (inRect) {
          if (before[i] !== after[i]) inside++
        } else expect(after[i], `texel ${x},${y} outside the rect`).toBe(before[i])
      }
    }
    expect(inside).toBeGreaterThan(0)
    await s.app.dispose()
    s.target.destroy()
  })

  it('a door that swings and settles costs two rect redraws, its swing in the dynamic layer', async () => {
    const s = await scene('on-change')
    s.world.resource(LightingSettings).staticAfterFrames = 5
    const door = s.box([-2, 1, 3], [1, 2, 0.1])
    await settle(s.app)
    s.app.update(1 / 60)
    let rectFrames = 0
    let full = 0
    let dynamicFrames = 0
    for (let f = 0; f < 30; f++) {
      if (f < 10)
        s.world.set(door, Transform, { translation: [-2 + f * 0.05, 1, 3], scale: [1, 2, 0.1] })
      s.app.update(1 / 60)
      const c = s.cascadesOf()
      if (c.rectRedraws > 0) rectFrames++
      full += c.fullRedraws
      if (c.dynamic.some((v) => v.redraw)) dynamicFrames++
    }
    expect(full).toBe(0)
    expect(rectFrames).toBe(2)
    expect(dynamicFrames).toBeGreaterThanOrEqual(10)
    await s.app.dispose()
    s.target.destroy()
  })

  it('a cached cascade redraws when the eye crosses a step, not within one', async () => {
    const s = await scene('on-change')
    await settle(s.app)
    s.app.update(1 / 60)
    const c = s.cascadesOf()
    let crossings = 0
    let redraws = 0
    let center = [...c.centers.subarray(0, 3)]
    for (let f = 0; f < 200; f++) {
      const x = f * 0.05
      s.world.set(s.camera, Transform, {
        translation: [x, 6, 12],
        rotation: lookAt([x, 6, 12], [x, 0, -2]),
      })
      s.app.update(1 / 60)
      const now = [...c.centers.subarray(0, 3)]
      const moved = now.some((v, k) => v !== center[k])
      center = now
      if (moved) crossings++
      const redrew = (c.fullMask & 1) !== 0
      if (redrew) redraws++
      expect(redrew, `frame ${f}: cascade 0 redraws exactly when its center steps`).toBe(moved)
    }
    // 10 m of walking over steps of an eighth of cascade 0's width.
    expect(crossings).toBeGreaterThan(2)
    expect(crossings).toBeLessThan(40)
    expect(redraws).toBe(crossings)
    await s.app.dispose()
    s.target.destroy()
  })

  it('far cascades draw their dynamic layers less often, never two far ones in one frame', async () => {
    const s = await scene('on-change', { farEvery: 4 })
    // Eye height, looking level, with a dynamic caster in each slice of the view.
    s.world.set(s.camera, Transform, {
      translation: [0, 1.6, 12],
      rotation: lookAt([0, 1.6, 12], [0, 1.6, -20]),
    })
    for (const depth of [1, 4, 12, 35]) {
      const e = s.box([0, 1.6, 12 - depth], [0.3, 0.3, 0.3])
      s.world.add(e, DynamicCaster)
    }
    await settle(s.app)
    const counts = [0, 0, 0, 0]
    for (let f = 0; f < 16; f++) {
      s.app.update(1 / 60)
      const c = s.cascadesOf()
      for (let k = 0; k < 4; k++) if (c.dynamic[k]!.redraw) counts[k]!++
      expect(c.dynamic[2]!.redraw && c.dynamic[3]!.redraw, `frame ${f}`).toBe(false)
    }
    expect(counts).toEqual([16, 16, 8, 4])
    await s.app.dispose()
    s.target.destroy()
  })
})
