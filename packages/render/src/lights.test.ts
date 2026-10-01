import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { quat, Rng } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { BASELINE_MAX_LIGHTS, baselineViewLights, binBaselineLights } from './baseline/lights'
import { Camera3d, Exposure } from './camera'
import {
  CLUSTER_COUNT,
  clusterLightsCpu,
  MAX_LIGHTS_PER_CLUSTER,
  VIEW_LIGHT_FLOATS,
} from './clusters'
import { captureShadowMap, readBuffer, setDebugView } from './debug-views'
import { ForwardStateResource } from './forward'
import { Mesh3d, MeshMaterial, NotShadowCaster, NotShadowReceiver } from './instances'
import {
  AmbientLight,
  DirectionalLight,
  LightingSettings,
  Lights,
  PointLight,
  SpotLight,
} from './lights'
import { captureBuffer, describeRender, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { Cameras, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(width = 64, height = width, msaa: 1 | 4 = 4) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'lights-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'lights-target')
  return { app, world: app.world, targetRef }
}

type World = Awaited<ReturnType<typeof scene>>['world']

/** A floor, a few cubes and a sphere: something to cast and receive shadows. */
function stage(world: World) {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  const white = materials.add(new MaterialAsset({ baseColor: [0.8, 0.8, 0.8, 1], roughness: 0.8 }))
  const red = materials.add(new MaterialAsset({ baseColor: [0.8, 0.15, 0.1, 1], roughness: 0.5 }))
  const floor = world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 20 })) }],
    [MeshMaterial, { material: white }],
    Transform,
  )
  const box = world.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 1 })) }],
    [MeshMaterial, { material: red }],
    [Transform, { translation: [-1, 1, 0], rotation: q(0, 0.6, 0) }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(sphere({ radius: 0.6, segments: 24 })) }],
    [MeshMaterial, { material: white }],
    [Transform, { translation: [1.2, 0.6, 0.5] }],
  )
  return { floor, box }
}

function camera(world: World, targetRef: unknown, eye: [number, number, number], at = [0, 0, 0]) {
  return world.spawn(
    [Camera3d, { target: targetRef as never, clearColor: [0, 0, 0, 1] }],
    [Exposure, { ev100: 9 }],
    [Transform, { translation: eye, rotation: lookAt(eye, at as [number, number, number]) }],
  )
}

describe('lights', () => {
  it('an 800 lm point light 2 m above a white Lambertian plane gives the analytic luminance', async () => {
    const { app, world, targetRef } = await scene(32, 32)
    const white = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [1, 1, 1, 1], roughness: 1 }))
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 20 })) }],
      [MeshMaterial, { material: white }],
      Transform,
    )
    world.spawn(
      [PointLight, { intensity: 800, range: 50 }],
      [Transform, { translation: [0, 2, 0] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 20 }],
      [Exposure, { ev100: 0 }],
      [Transform, { translation: [0, 1, 0], rotation: lookAt([0, 1, 0], [0, 0, 0], [0, 0, -1]) }],
    )
    await settle(app)
    const shot = captureBuffer(world, `camera:${cam}`, 'hdr')
    app.update(1 / 60)
    const hdr = await shot
    const [r] = pixel(hdr, 16, 16)
    const rho = 1
    const expected = (800 / (4 * Math.PI) / 2 ** 2) * (rho / Math.PI)
    expect(Math.abs(r! - expected) / expected).toBeLessThan(0.02)
  })

  it('clusters lights identically on the GPU and the CPU (256 point and spot lights)', async () => {
    const { app, world, targetRef } = await scene(160, 90)
    stage(world)
    const rng = new Rng(7)
    for (let i = 0; i < 256; i++) {
      const pos: [number, number, number] = [
        rng.range(-10, 10),
        rng.range(0.2, 4),
        rng.range(-12, 6),
      ]
      if (i % 4 === 0) {
        world.spawn(
          [
            SpotLight,
            {
              intensity: 600,
              range: rng.range(2, 6),
              outerAngle: rng.range(15, 60),
              innerAngle: 10,
            },
          ],
          [Transform, { translation: pos, rotation: q(rng.range(-1.5, 0), rng.range(0, 6), 0) }],
        )
      } else {
        world.spawn(
          [PointLight, { intensity: 200, range: rng.range(1, 4) }],
          [Transform, { translation: pos }],
        )
      }
    }
    const cam = camera(world, targetRef, [0, 3, 8], [0, 0.5, -2])
    await settle(app)
    const pv = world.resource(ForwardStateResource).views.get(`camera:${cam}`)!
    const cpu = clusterLightsCpu(pv.lightList, world.resource(Cameras).get(cam)!, 0)
    const gpuData = new Uint32Array(
      await readBuffer(
        gpu,
        pv.clusters!.clusters.buffer,
        CLUSTER_COUNT * (1 + MAX_LIGHTS_PER_CLUSTER) * 4,
      ),
    )
    let mismatches = 0
    let total = 0
    for (let c = 0; c < CLUSTER_COUNT; c++) {
      const n = cpu.counts[c]!
      total += n
      if (gpuData[c] !== n) {
        mismatches++
        continue
      }
      for (let k = 0; k < n; k++) {
        const g = gpuData[CLUSTER_COUNT + c * MAX_LIGHTS_PER_CLUSTER + k]
        if (g !== cpu.indices[c * MAX_LIGHTS_PER_CLUSTER + k]) mismatches++
      }
    }
    expect(pv.lightList.count).toBeGreaterThan(50)
    expect(total).toBeGreaterThan(500)
    expect(mismatches).toBe(0)
  })

  it('bins the same lights into each cluster on baseline, as a bitmask of the nearest 128 (0064)', async () => {
    const { app, world, targetRef } = await scene(160, 90)
    stage(world)
    const rng = new Rng(9)
    for (let i = 0; i < 200; i++) {
      const pos: [number, number, number] = [
        rng.range(-10, 10),
        rng.range(0.2, 4),
        rng.range(-12, 6),
      ]
      if (i % 4 === 0) {
        world.spawn(
          [
            SpotLight,
            {
              intensity: 600,
              range: rng.range(2, 6),
              outerAngle: rng.range(15, 60),
              innerAngle: 10,
            },
          ],
          [Transform, { translation: pos, rotation: q(rng.range(-1.5, 0), rng.range(0, 6), 0) }],
        )
      } else {
        world.spawn(
          [PointLight, { intensity: 200, range: rng.range(1, 4) }],
          [Transform, { translation: pos }],
        )
      }
    }
    for (const [eye, at, ortho] of [
      [[0, 3, 8], [0, 0.5, -2], false],
      [[4, 12, 2], [0, 0, -3], true],
    ] as const) {
      const cam = world.spawn(
        [
          Camera3d,
          ortho
            ? { target: targetRef, projection: 'orthographic', orthoHeight: 14, far: 60 }
            : { target: targetRef, fovY: 60 },
        ],
        [Exposure, { ev100: 0 }],
        [Transform, { translation: [...eye], rotation: lookAt([...eye], [...at]) }],
      )
      await settle(app)
      const pv = world.resource(ForwardStateResource).views.get(`camera:${cam}`)!
      const camera = world.resource(Cameras).get(cam)!
      const cpu = clusterLightsCpu(pv.lightList, camera, 0)
      const v = baselineViewLights(gpu, 'test')
      binBaselineLights(
        v,
        pv.lightList,
        world.resource(Lights).data,
        camera,
        0,
        BASELINE_MAX_LIGHTS,
      )
      expect(v.count).toBe(Math.min(BASELINE_MAX_LIGHTS, pv.lightList.count))
      expect(v.dropped).toBe(pv.lightList.count - v.count)
      const kept = new Set(Array.from(v.slots.subarray(0, v.count)))
      // The ones kept are the nearest: none dropped is nearer than the farthest kept.
      const list = pv.lightList
      const distanceOf = (i: number) => {
        const o = 4 + i * VIEW_LIGHT_FLOATS
        const [x, y, z, r] = [
          list.data[o]!,
          list.data[o + 1]!,
          list.data[o + 2]!,
          list.data[o + 3]!,
        ]
        return Math.max(0, Math.sqrt(x * x + y * y + z * z) - r)
      }
      let farthestKept = 0
      let nearestDropped = Number.POSITIVE_INFINITY
      for (let i = 0; i < list.count; i++) {
        const slot = list.u32[4 + i * VIEW_LIGHT_FLOATS + 8]!
        if (kept.has(slot)) farthestKept = Math.max(farthestKept, distanceOf(i))
        else nearestDropped = Math.min(nearestDropped, distanceOf(i))
      }
      if (v.dropped > 0) expect(nearestDropped).toBeGreaterThanOrEqual(farthestKept - 1 / 256)
      let bits = 0
      let mismatches = 0
      for (let c = 0; c < CLUSTER_COUNT; c++) {
        const expected = new Set<number>()
        for (let k = 0; k < cpu.counts[c]!; k++) {
          const slot = cpu.indices[c * MAX_LIGHTS_PER_CLUSTER + k]!
          if (kept.has(slot)) expected.add(slot)
        }
        const got = new Set<number>()
        for (let k = 0; k < v.count; k++) {
          if (v.words[c * 4 + (k >> 5)]! & (1 << (k & 31))) got.add(v.slots[k]!)
        }
        bits += got.size
        if (got.size !== expected.size || [...got].some((s) => !expected.has(s))) mismatches++
      }
      expect(bits, ortho ? 'orthographic' : 'perspective').toBeGreaterThan(100)
      expect(mismatches, ortho ? 'orthographic' : 'perspective').toBe(0)
      v.lights.destroy()
      v.bits.destroy()
      world.despawn(cam)
    }
  })

  it('renders 256 point lights as a golden image', async () => {
    const { app, world, targetRef } = await scene(160, 90)
    stage(world)
    const rng = new Rng(3)
    for (let i = 0; i < 256; i++) {
      world.spawn(
        [
          PointLight,
          { intensity: 1500, range: 3, color: [rng.float(), rng.float(), rng.float(), 1] },
        ],
        [Transform, { translation: [rng.range(-8, 8), rng.range(0.1, 1.5), rng.range(-10, 4)] }],
      )
    }
    const cam = camera(world, targetRef, [0, 4, 8], [0, 0, -2])
    const image = await renderView(app, `camera:${cam}`)
    const stats = describeRender(world).lighting as { views: Record<string, { lights: unknown[] }> }
    expect(stats.views[`camera:${cam}`]!.lights.length).toBeGreaterThan(100)
    expect(compareGolden(here, 'point-lights-256', image).mean).toBeLessThan(1.5)
  })

  it('renders directional, spot, and point shadows (golden images)', async () => {
    const shots: Record<string, { mean: number }> = {}
    for (const kind of ['directional', 'spot', 'point'] as const) {
      const { app, world, targetRef } = await scene(192, 128)
      stage(world)
      world.resource(AmbientLight).brightness = 20
      if (kind === 'directional') {
        world.spawn(
          [DirectionalLight, { illuminance: 2000, shadows: true }],
          [Transform, { rotation: q(-0.9, 0.5, 0) }],
        )
      } else if (kind === 'spot') {
        world.spawn(
          [SpotLight, { intensity: 20000, range: 20, outerAngle: 50, shadows: true }],
          [Transform, { translation: [2, 4, 2], rotation: lookAt([2, 4, 2], [-0.5, 0, 0]) }],
        )
      } else {
        world.spawn(
          [PointLight, { intensity: 12000, range: 15, shadows: true }],
          [Transform, { translation: [0.2, 2.6, 1.2] }],
        )
      }
      const cam = camera(world, targetRef, [0, 4, 6], [0, 0.3, 0])
      if (kind === 'directional') world.get(cam, Exposure).ev100 = 11
      const image = await renderView(app, `camera:${cam}`)
      shots[kind] = compareGolden(here, `shadows-${kind}`, image)
    }
    for (const [, r] of Object.entries(shots)) expect(r.mean).toBeLessThan(1.5)
  })

  it('keeps cascade shadow maps pixel-identical when the camera moves less than a texel', async () => {
    const { app, world, targetRef } = await scene(64, 64)
    stage(world)
    const sun = world.spawn(
      [DirectionalLight, { illuminance: 2000, shadows: true }],
      [Transform, { rotation: q(-0.9, 0.5, 0) }],
    )
    world.resource(LightingSettings).cascadeMapSize = 512
    const eye: [number, number, number] = [0, 4, 6]
    const cam = camera(world, targetRef, eye)
    await settle(app)
    const pv = world.resource(ForwardStateResource).views.get(`camera:${cam}`)!
    const centers = [...pv.cascades.centers]
    const texel = pv.cascades.texel[0]!
    const before = await captureShadowMap(world, sun, 0)
    // Move a tenth of a cascade-0 texel along the camera's right axis.
    world.get(cam, Transform).translation[0] = eye[0] + texel * 0.1
    world.entityTable(cam).markChanged(Transform, world.entityRow(cam))
    app.update(1 / 60)
    app.update(1 / 60)
    expect([...pv.cascades.centers]).toEqual(centers)
    const after = await captureShadowMap(world, sun, 0)
    let differing = 0
    for (let i = 0; i < before.data.length; i += 4)
      if (before.data[i] !== after.data[i]) differing++
    expect(differing).toBe(0)
    // Something was actually rendered into the map.
    expect(before.data.some((v) => v > 0)).toBe(true)
  })

  it('removes NotShadowCaster meshes from shadow maps and NotShadowReceiver meshes from lookups', async () => {
    const brightnessUnderBox = async (tag?: 'caster' | 'receiver') => {
      const { app, world, targetRef } = await scene(48, 48)
      const { floor, box } = stage(world)
      if (tag === 'caster') world.add(box, NotShadowCaster)
      if (tag === 'receiver') world.add(floor, NotShadowReceiver)
      world.spawn(
        [DirectionalLight, { illuminance: 2000, shadows: true }],
        [Transform, { rotation: q(-Math.PI / 2, 0, 0) }],
      )
      // Straight down onto the box's shadow, which falls right under it.
      const cam = world.spawn(
        [Camera3d, { target: targetRef, fovY: 30 }],
        [Exposure, { ev100: 9 }],
        [Tonemapping, { curve: 'none', dither: false }],
        [
          Transform,
          { translation: [-1.9, 0.4, 0], rotation: lookAt([-1.9, 0.4, 0], [-1.45, 0, 0]) },
        ],
      )
      const image = await renderView(app, `camera:${cam}`)
      return pixel(image, 24, 36)[0]!
    }
    const shadowed = await brightnessUnderBox()
    const noCaster = await brightnessUnderBox('caster')
    const noReceiver = await brightnessUnderBox('receiver')
    expect(noCaster).toBeGreaterThan(shadowed + 40)
    expect(noReceiver).toBeGreaterThan(shadowed + 40)
    expect(Math.abs(noCaster - noReceiver)).toBeLessThan(6)
  })

  it('reports shadowed lights over the budget and lights them without shadows', async () => {
    const { app, world, targetRef } = await scene(32, 32)
    stage(world)
    const lights = []
    for (let i = 0; i < 6; i++) {
      lights.push(
        world.spawn(
          [PointLight, { intensity: 800, range: 6 + i, shadows: true }],
          [Transform, { translation: [i * 0.5 - 1.5, 2, 0] }],
        ),
      )
    }
    const cam = camera(world, targetRef, [0, 4, 6])
    await settle(app)
    const lighting = describeRender(world).lighting as {
      shadowBudget: { points: string; overBudget: { entity: number; type: string }[] }
      views: Record<string, { lights: { entity: number; castsShadows: boolean }[] }>
    }
    expect(lighting.shadowBudget.points).toBe('4/4')
    expect(lighting.shadowBudget.overBudget.map((l) => l.type)).toEqual(['point', 'point'])
    const inView = lighting.views[`camera:${cam}`]!.lights
    expect(inView.filter((l) => l.castsShadows)).toHaveLength(4)
    expect(inView.filter((l) => !l.castsShadows)).toHaveLength(2)
    const warnings = world
      .resource(LogResource)
      .tail(50, 'warn')
      .filter((e) => e.code === 'render/shadow-budget')
    expect(warnings).toHaveLength(1)
  })

  it('re-uploads only the light whose intensity or color changed', async () => {
    const { app, world, targetRef } = await scene(16, 16)
    const lights = []
    for (let i = 0; i < 10; i++) {
      lights.push(
        world.spawn([PointLight, { intensity: 100 }], [Transform, { translation: [i, 1, 0] }]),
      )
    }
    camera(world, targetRef, [0, 4, 6])
    app.update(1 / 60)
    expect(world.resource(Lights).uploadedLights).toBe(10)
    app.update(1 / 60)
    expect(world.resource(Lights).uploadedLights).toBe(0)
    world.set(lights[3]!, PointLight, { intensity: 250 })
    app.update(1 / 60)
    expect(world.resource(Lights).uploadedLights).toBe(1)
    world.set(lights[7]!, PointLight, { color: [1, 0, 0, 1] })
    app.update(1 / 60)
    expect(world.resource(Lights).uploadedLights).toBe(1)
    expect(world.resource(Lights).uploadedBytes).toBe(80)
    app.update(1 / 60)
    expect(world.resource(Lights).uploadedLights).toBe(0)
  })

  it('renders the cluster and cascade debug views', async () => {
    const { app, world, targetRef } = await scene(64, 48)
    stage(world)
    world.spawn(
      [DirectionalLight, { illuminance: 2000, shadows: true }],
      [Transform, { rotation: q(-0.9, 0.5, 0) }],
    )
    for (let i = 0; i < 20; i++)
      world.spawn([PointLight, { range: 3 }], [Transform, { translation: [i - 10, 0.5, -i * 0.5] }])
    const cam = camera(world, targetRef, [0, 4, 6])
    const normal = await renderView(app, `camera:${cam}`)
    setDebugView(world, cam, 'clusters')
    const clusters = await renderView(app, `camera:${cam}`)
    setDebugView(world, cam, 'cascades')
    const cascades = await renderView(app, `camera:${cam}`)
    const diff = (a: Uint8Array, b: Uint8Array) => {
      let s = 0
      for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!)
      return s / a.length
    }
    expect(diff(normal.data, clusters.data)).toBeGreaterThan(5)
    expect(diff(normal.data, cascades.data)).toBeGreaterThan(2)
    expect(compareGolden(here, 'debug-clusters', clusters).mean).toBeLessThan(1.5)
    expect(compareGolden(here, 'debug-cascades', cascades).mean).toBeLessThan(1.5)
  })
})
