import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProfilerResource, quat, Rng } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { Culler, readVisibleSlots, visibleSlots } from './culling'
import { setDebugView } from './debug-views'
import { ForwardStateResource } from './forward'
import {
  type CullParams,
  createDrawList,
  INSTANCE_FLOATS,
  InstanceFlags,
  InstanceSlot,
  Instances,
  LOD_UNSET,
  Lod,
  Mesh3d,
  MeshMaterial,
  NotShadowCaster,
  ShadowWhenHidden,
  selectLod,
  VisibilityRange,
} from './instances'
import { DirectionalLight, SpotLight } from './lights'
import { captureView, describeRender, Gpu, renderPlugin, Views } from './plugin'
import { ShadowsResource } from './shadows'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { compareGolden, pixel, renderView, settle } from './testing'
import { cameraOf } from './view'
import { Visibility } from './visibility'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]
const ALL = 0xffffffff
const PREP_SYSTEMS = ['render/prepare-instances', 'render/forward-queue', 'render/upload-visible']
const here = dirname(fileURLToPath(import.meta.url))

async function scene(width = 96, height = 64) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'cull-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'cull-target')
  const world = app.world
  const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.6 }))
  const cameraAt = (eye: [number, number, number], at: [number, number, number]) =>
    world.spawn(
      [Camera3d, { target: targetRef as never, fovY: 60 }],
      [Transform, { translation: eye, rotation: lookAt(eye, at) }],
    )
  return { app, world, material, cameraAt }
}

type World = Awaited<ReturnType<typeof scene>>['world']

const slotOf = (world: World, e: number) => world.get(e, InstanceSlot)!.slot - 1

/** The CPU cull of a camera and its shadow views with the frame's own frustums. */
function cpuSets(world: World, name: string) {
  const store = world.resource(Instances)
  const cam = cameraOf(world.resource(Views).list.find((v) => v.name === name)!)!
  const lodState = new Uint8Array(store.capacity).fill(LOD_UNSET)
  const params: CullParams = {
    planes: cam.frustum,
    require: InstanceFlags.Visible,
    eye: cam.position,
    lodScale: 1 / Math.tan(cam.fovY / 2),
    orthographic: false,
    lodState,
    updateLod: true,
  }
  const run = (planes: Float32Array, shadow: boolean) => {
    const list = createDrawList()
    params.planes = planes
    params.require = shadow ? InstanceFlags.Visible | InstanceFlags.Caster : InstanceFlags.Visible
    params.updateLod = !shadow
    store.cullCpu(list, params)
    return visibleSlots(store, list, ALL)
  }
  const camera = run(cam.frustum, false)
  const pv = world.resource(ForwardStateResource).views.get(name)!
  const cascades: Set<number>[] = []
  for (let i = 0; i < pv.cascades.count; i++)
    cascades.push(run(pv.cascades.views[i]!.frustum, true))
  const local = world.resource(ShadowsResource).local
  const spots = local.spots.map((_, i) => run(local.spotViews[i]!.frustum, true))
  return { cam, pv, local, camera, cascades, spots }
}

/** The same views, as the GPU culled them this frame. */
async function gpuSets(world: World, name: string) {
  const culler = world.resource(Culler)
  const { cam, pv, local } = cpuSets(world, name)
  const camera = await readVisibleSlots(gpu, culler, cam.draws, ALL)
  const cascades: Set<number>[] = []
  for (let i = 0; i < pv.cascades.count; i++)
    cascades.push(await readVisibleSlots(gpu, culler, pv.cascades.views[i]!.draws, ALL))
  const spots: Set<number>[] = []
  for (let i = 0; i < local.spots.length; i++)
    spots.push(await readVisibleSlots(gpu, culler, local.spotViews[i]!.draws, ALL))
  return { camera, cascades, spots }
}

const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b)

describe('GPU culling', () => {
  it('culls the same slots and LOD levels as the CPU, for camera and shadow views', async () => {
    const { app, world, material, cameraAt } = await scene()
    const meshes = world.resource(Meshes)
    const hi = meshes.add(sphere({ radius: 0.5, segments: 24 }))
    const mid = meshes.add(sphere({ radius: 0.5, segments: 8 }))
    const low = meshes.add(cube({ size: 0.8 }))
    const rng = new Rng(3)
    for (let i = 0; i < 600; i++) {
      const at: [number, number, number] = [rng.range(-60, 60), rng.range(0, 3), rng.range(-60, 60)]
      const kind = i % 4
      world.spawn(
        [Mesh3d, { mesh: kind === 3 ? low : hi }],
        [MeshMaterial, { material }],
        [Transform, { translation: at, rotation: q(0, rng.float() * 6, 0) }],
        ...(kind === 0
          ? [
              [
                Lod,
                {
                  levels: [
                    { mesh: hi, screenSize: 0.2 },
                    { mesh: mid, screenSize: 0.05 },
                    { mesh: low, screenSize: 0.01 },
                  ],
                },
              ] as const,
            ]
          : []),
        ...(kind === 1 ? [[VisibilityRange, { end: 25 }] as const] : []),
        ...(kind === 2 && i % 8 === 2 ? [NotShadowCaster] : []),
      )
    }
    world.spawn(
      [DirectionalLight, { illuminance: 2000, shadows: true }],
      [Transform, { rotation: q(-0.9, 0.6, 0) }],
    )
    world.spawn(
      [SpotLight, { intensity: 5000, range: 30, shadows: true }],
      [Transform, { translation: [0, 10, 0], rotation: q(-Math.PI / 2, 0, 0) }],
    )
    const cam = cameraAt([0, 6, 20], [0, 0, 0])
    const name = `camera:${cam}`
    await settle(app, 4)
    expect(world.resource(Culler).active).toBe(true)

    const gpuSet = await gpuSets(world, name)
    const cpu = cpuSets(world, name)
    expect(gpuSet.camera.size).toBeGreaterThan(50)
    expect(sorted(gpuSet.camera)).toEqual(sorted(cpu.camera))
    expect(cpu.cascades.length).toBe(4)
    expect(gpuSet.cascades.length).toBe(4)
    for (let i = 0; i < 4; i++)
      expect(sorted(gpuSet.cascades[i]!), `cascade ${i}`).toEqual(sorted(cpu.cascades[i]!))
    expect(gpuSet.spots.length).toBe(1)
    expect(gpuSet.spots[0]!.size).toBeGreaterThan(0)
    expect(sorted(gpuSet.spots[0]!)).toEqual(sorted(cpu.spots[0]!))

    // Every LOD level shows up, and shadows draw each instance at the level its camera chose.
    const levels = new Set([...gpuSet.camera].map((e) => e >>> 28))
    expect([...levels].sort()).toEqual([0, 1, 2])
    const cameraLevel = new Map([...gpuSet.camera].map((e) => [e & 0x0fffffff, e >>> 28]))
    let shared = 0
    for (const e of gpuSet.cascades[0]!) {
      const level = cameraLevel.get(e & 0x0fffffff)
      if (level === undefined) continue
      expect(e >>> 28).toBe(level)
      shared++
    }
    expect(shared).toBeGreaterThan(0)

    // Counts come back asynchronously, a frame or two late.
    await settle(app, 3)
    const culling = describeRender(world).culling as {
      mode: string
      instances: number
      views: Record<string, { mode: string; visible: number; perLod?: number[] }>
    }
    expect(culling.mode).toBe('gpu')
    expect(culling.instances).toBe(600)
    expect(culling.views[name]!.visible).toBe(gpuSet.camera.size)
    expect(culling.views[name]!.perLod!.reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(world.resource(Gpu).errors).toEqual([])
  })

  it('uploads nothing for a static 200k scene within 1 ms of CPU, and one record per moved instance', {
    timeout: timeout(60_000),
  }, async () => {
    const { app, world, material, cameraAt } = await scene(32, 32)
    const mesh = world.resource(Meshes).add(cube({ size: 0.5 }))
    const entities: number[] = []
    for (let i = 0; i < 200_000; i++) {
      entities.push(
        world.spawn(
          [Mesh3d, { mesh }],
          [MeshMaterial, { material }],
          [Transform, { translation: [(i % 448) - 224, 0, Math.floor(i / 448) - 224] }],
        ),
      )
    }
    cameraAt([0, 40, 60], [0, 0, 0])
    await settle(app, 2)
    const store = world.resource(Instances)
    app.update(1 / 60)
    expect(store.uploadedBytes).toBe(0)
    // CPU prep of a static frame (slots, culling submission, uploads): best of 10 frames.
    const profiler = world.resource(ProfilerResource)
    let best = Number.POSITIVE_INFINITY
    for (let f = 0; f < 10; f++) {
      app.update(1 / 60)
      let ms = 0
      for (const name of PREP_SYSTEMS) ms += profiler.timing(name)!.last
      best = Math.min(best, ms)
    }
    console.info(`cpu prep, ${entities.length} static instances: ${best.toFixed(2)} ms`)
    expect(best).toBeLessThan(budget(1))
    for (let i = 0; i < 100; i++) {
      const e = entities[i * 997]!
      world.set(e, Transform, { translation: [0, 1 + i, 0] })
    }
    app.update(1 / 60)
    expect(store.uploadedBytes).toBe(100 * 64)
    app.update(1 / 60)
    expect(store.uploadedBytes).toBe(0)
  })

  it('still sees changes to rows of tables it skipped as static', async () => {
    const { app, world, material, cameraAt } = await scene(32, 32)
    const mesh = world.resource(Meshes).add(cube({ size: 0.5 }))
    const es = [0, 1, 2, 3].map((i) =>
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, { translation: [i - 1.5, 0, 0] }],
      ),
    )
    world.spawn(
      [DirectionalLight, { illuminance: 2000, shadows: true }],
      [Transform, { rotation: q(-0.9, 0.6, 0) }],
    )
    const cam = cameraAt([0, 1, 6], [0, 0, 0])
    const name = `camera:${cam}`
    await settle(app, 3)
    const slots = es.map((e) => slotOf(world, e))
    const inShadow = async (slot: number) =>
      (await gpuSets(world, name)).cascades.some((c) => c.has(slot))
    expect(await inShadow(slots[0]!)).toBe(true)

    // Moves the entity into a new table with its old change ticks.
    world.add(es[0]!, NotShadowCaster)
    await settle(app, 2)
    expect(await inShadow(slots[0]!)).toBe(false)

    world.add(es[1]!, Visibility, { mode: 'hidden' })
    await settle(app, 2)
    expect((await gpuSets(world, name)).camera.has(slots[1]!)).toBe(false)
    world.set(es[1]!, Visibility, { mode: 'visible' })
    await settle(app, 2)
    expect((await gpuSets(world, name)).camera.has(slots[1]!)).toBe(true)

    world.despawn(es[2]!)
    await settle(app, 2)
    expect(world.resource(Instances).live).toBe(3)
    expect((await gpuSets(world, name)).camera.size).toBe(3)
  })

  it('keeps an LOD level inside the hysteresis band, on the GPU and the CPU', async () => {
    // Pure selection first: from 0, the size must fall below 0.5 * 0.9 to reach level 1, and rise
    // above 0.5 * 1.1 to come back.
    const t = [0.5, 0.1]
    expect(selectLod(0.47, t, 2, 0.1, 0)).toBe(0)
    expect(selectLod(0.44, t, 2, 0.1, 0)).toBe(1)
    expect(selectLod(0.53, t, 2, 0.1, 1)).toBe(1)
    expect(selectLod(0.56, t, 2, 0.1, 1)).toBe(0)
    expect(selectLod(0.47, t, 2, 0.1, LOD_UNSET)).toBe(1)
    expect(selectLod(0.05, t, 2, 0.1, 1)).toBe(2)

    for (const gpuCull of [true, false]) {
      const { app, world, material, cameraAt } = await scene(32, 32)
      world.resource(Culler).enabled = gpuCull
      const meshes = world.resource(Meshes)
      const hi = meshes.add(sphere({ radius: 1, segments: 16 }))
      const low = meshes.add(cube({ size: 1.6 }))
      const e = world.spawn(
        [Mesh3d, { mesh: hi }],
        [MeshMaterial, { material }],
        [Transform, {}],
        [
          Lod,
          {
            levels: [
              { mesh: hi, screenSize: 0.5 },
              { mesh: low, screenSize: 0.1 },
            ],
          },
        ],
      )
      const cam = cameraAt([0, 0, 2], [0, 0, 0])
      // Size = r / (d tan 30°), with r the bounding sphere of the mesh's box: √3 for a unit sphere.
      const at = (size: number) => Math.sqrt(3) / (size * Math.tan(Math.PI / 6))
      const levelAt = async (size: number) => {
        world.set(cam, Transform, { translation: [0, 0, at(size)] })
        await settle(app, 3)
        const list = cameraOf(world.resource(Views).list[0]!)!.draws
        const set = gpuCull
          ? await readVisibleSlots(gpu, world.resource(Culler), list, ALL)
          : visibleSlots(world.resource(Instances), list, ALL)
        const entry = [...set].find((v) => (v & 0x0fffffff) === slotOf(world, e))
        return entry === undefined ? -1 : entry >>> 28
      }
      const path = [0.6, 0.47, 0.44, 0.53, 0.56, 0.47, 0.44, 0.05]
      const levels: number[] = []
      for (const size of path) levels.push(await levelAt(size))
      expect(levels, gpuCull ? 'gpu' : 'cpu').toEqual([0, 0, 1, 1, 0, 0, 1, -1])
    }
  })

  it('hides a VisibilityRange instance from the camera and its shadows beyond the range', async () => {
    for (const gpuCull of [true, false]) {
      const { app, world, material, cameraAt } = await scene(48, 32)
      world.resource(Culler).enabled = gpuCull
      const mesh = world.resource(Meshes).add(cube({ size: 1 }))
      const e = world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, {}],
        [VisibilityRange, { start: 2, end: 10 }],
      )
      world.spawn(
        [DirectionalLight, { illuminance: 2000, shadows: true }],
        [Transform, { rotation: q(-0.9, 0.6, 0) }],
      )
      const cam = cameraAt([0, 1, 8], [0, 0, 0])
      const name = `camera:${cam}`
      const visibleIn = async () => {
        await settle(app, 3)
        const slot = slotOf(world, e)
        const sets = gpuCull ? await gpuSets(world, name) : cpuSets(world, name)
        return {
          camera: sets.camera.has(slot),
          shadow: sets.cascades.some((s) => s.has(slot)),
        }
      }
      expect(await visibleIn(), 'inside').toEqual({ camera: true, shadow: true })
      world.set(cam, Transform, {
        translation: [0, 1, 12],
        rotation: lookAt([0, 1, 12], [0, 0, 0]),
      })
      expect(await visibleIn(), 'beyond end').toEqual({ camera: false, shadow: false })
      world.set(cam, Transform, { translation: [0, 0, 1.5] })
      expect((await visibleIn()).camera, 'before start').toBe(false)
    }
  })
  it('draws a hidden ShadowWhenHidden mesh in shadow views only', async () => {
    for (const gpuCull of [true, false]) {
      const { app, world, material, cameraAt } = await scene(48, 32)
      world.resource(Culler).enabled = gpuCull
      const mesh = world.resource(Meshes).add(cube({ size: 1 }))
      const roof = world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, {}],
        ShadowWhenHidden,
      )
      const plain = world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, { translation: [2, 0, 0] }],
      )
      world.spawn(
        [DirectionalLight, { illuminance: 2000, shadows: true }],
        [Transform, { rotation: q(-0.9, 0.6, 0) }],
      )
      const cam = cameraAt([1, 2, 8], [1, 0, 0])
      const name = `camera:${cam}`
      const drawnIn = async (e: number) => {
        await settle(app, 3)
        const slot = slotOf(world, e)
        const sets = gpuCull ? await gpuSets(world, name) : cpuSets(world, name)
        return { camera: sets.camera.has(slot), shadow: sets.cascades.some((c) => c.has(slot)) }
      }
      expect(await drawnIn(roof), 'shown').toEqual({ camera: true, shadow: true })
      world.set(roof, Visibility, { mode: 'hidden' })
      world.set(plain, Visibility, { mode: 'hidden' })
      expect(await drawnIn(roof), 'hidden, still casting').toEqual({ camera: false, shadow: true })
      expect(await drawnIn(plain), 'hidden').toEqual({ camera: false, shadow: false })
      world.set(roof, Visibility, { mode: 'inherit' })
      expect(await drawnIn(roof), 'shown again').toEqual({ camera: true, shadow: true })
    }
  })

  it("shows LOD levels as tints, and freezes the camera's cull for inspection", async () => {
    const { app, world, material, cameraAt } = await scene(96, 48)
    const meshes = world.resource(Meshes)
    const hi = meshes.add(sphere({ radius: 0.5, segments: 24 }))
    const low = meshes.add(cube({ size: 0.8 }))
    const lod = {
      levels: [
        { mesh: hi, screenSize: 0.3 },
        { mesh: hi, screenSize: 0.15 },
        { mesh: low, screenSize: 0.07 },
        { mesh: low, screenSize: 0.02 },
      ],
    }
    for (let i = 0; i < 8; i++) {
      world.spawn(
        [Mesh3d, { mesh: hi }],
        [MeshMaterial, { material }],
        [Transform, { translation: [i * 0.5 - 1.5, 0, -1 - i * i * 0.9] }],
        [Lod, lod],
      )
    }
    world.spawn(
      [DirectionalLight, { illuminance: 3000 }],
      [Transform, { rotation: q(-0.9, 0.6, 0) }],
    )
    const cam = cameraAt([0, 0.5, 2], [0, 0, -10])
    app.update(1 / 60)
    setDebugView(world, cam, 'lod')
    const image = await renderView(app, `camera:${cam}`)
    expect(compareGolden(here, 'debug-lod', image).mean).toBeLessThan(1.5)

    setDebugView(world, cam, 'culling')
    const store = world.resource(Instances)
    const list = () => cameraOf(world.resource(Views).list[0]!)!.draws
    await settle(app, 2)
    const before = sorted(await readVisibleSlots(gpu, world.resource(Culler), list()))
    // Turned around, the camera sees nothing, but it still culls with the frozen frustum.
    world.set(cam, Transform, {
      translation: [0, 0.5, 2],
      rotation: lookAt([0, 0.5, 2], [0, 0, 10]),
    })
    await settle(app, 2)
    expect(sorted(await readVisibleSlots(gpu, world.resource(Culler), list()))).toEqual(before)
    expect(
      (describeRender(world).culling as { views: Record<string, { frozen: boolean }> }).views[
        `camera:${cam}`
      ]!.frozen,
    ).toBe(true)
    setDebugView(world, cam, 'none')
    await settle(app, 2)
    expect(await readVisibleSlots(gpu, world.resource(Culler), list())).toEqual(new Set())
    expect(store.live).toBe(8)
  })
})

describe('draw lists', () => {
  it('skips batches whose instances are all hidden, and draws opaque batches nearest first', async () => {
    const { app, world, material, cameraAt } = await scene()
    // Eight single-instance batches (one mesh each) straight ahead, in shuffled distances.
    const distances = [30, 10, 50, 20, 70, 40, 80, 60]
    const entities = distances.map((z) =>
      world.spawn(
        [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
        [MeshMaterial, { material }],
        [Transform, { translation: [0, 0, -z] }],
      ),
    )
    // Hidden ones (a planet's pooled chunks) get no draw at all, not an empty one.
    for (const i of [2, 4]) world.set(entities[i]!, Visibility, { mode: 'hidden' })
    const cam = cameraAt([0, 0, 0], [0, 0, -1])
    await settle(app)
    expect(world.resource(Culler).active).toBe(true)
    const view = world.resource(Views).list.find((v) => cameraOf(v)?.entity === cam)!
    const draws = cameraOf(view)!.draws
    expect(draws.length).toBe(6)
    const store = world.resource(Instances)
    const depthOf = (i: number) => {
      const batch = draws.items[i]!.batch
      return -store.f32[batch.members[0]! * INSTANCE_FLOATS + 11]!
    }
    const order = Array.from({ length: draws.length }, (_, i) => depthOf(i))
    expect(order).toEqual([10, 20, 30, 40, 60, 80])
  })

  it('draws a batch culled on the CPU the first frame it comes into view', async () => {
    // The baseline tier (0064) always culls on the CPU, which draws only what's in view: the
    // pipelines of what isn't are asked for ahead, so nothing pops in a few frames late.
    const { app, world, material, cameraAt } = await scene()
    world.resource(Culler).enabled = false
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 2 })) }],
      [MeshMaterial, { material }],
      [Transform, { translation: [0, 0, 6] }],
    )
    const cam = cameraAt([0, 0, 0], [0, 0, -1])
    await settle(app)
    const view = world.resource(Views).list.find((v) => cameraOf(v)?.entity === cam)!
    expect(cameraOf(view)!.draws.length).toBe(0)
    world.set(cam, Transform, { translation: [0, 0, 0], rotation: lookAt([0, 0, 0], [0, 0, 6]) })
    const shot = captureView(world, `camera:${cam}`)
    app.update(1 / 60)
    const image = await shot
    expect(cameraOf(view)!.draws.length).toBe(1)
    expect(pixel(image, 48, 32)).not.toEqual(pixel(image, 2, 2))
  })
})
