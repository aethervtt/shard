import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defineSystem,
  type Entity,
  mat4,
  quat,
  ray,
  Update,
  type World,
} from '@aethervtt/shard-core'
import { budget, gcWindow } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube, plane, sphere } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import { forwardPlugin } from './forward'
import { type GizmoStore, Gizmos, uploadGizmos } from './gizmos'
import { Lod, Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight, PointLight, SpotLight } from './lights'
import { DebugOverlays, setOverlays } from './overlays'
import { pick, raycast } from './picking'
import { Gpu, renderPlugin, Views } from './plugin'
import { OffscreenTarget } from './target'
import { compareGolden, renderView, settle } from './testing'
import { cameraOf } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))
const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

async function scene(width = 160, height = 120) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'gizmo-target', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'gizmo-target')
  return { app, world: app.world, targetRef }
}

function camera(
  world: World,
  targetRef: unknown,
  eye: [number, number, number],
  at: [number, number, number],
) {
  return world.spawn(
    [Camera3d, { target: targetRef as never, clearColor: [0.05, 0.05, 0.07, 1] }],
    [Transform, { translation: eye, rotation: lookAt(eye, at) }],
  )
}

/** Draws with `draw` every frame (gizmos last one frame). */
function everyFrame(app: App, name: string, draw: (g: GizmoStore, world: World) => void) {
  app.addSystems(
    Update,
    defineSystem({ name, run: (_, world) => draw(world.resource(Gizmos), world) }),
  )
}

describe('gizmos', () => {
  it('renders every shape (golden), dimmed behind geometry unless depthTest is off', async () => {
    const { app, world, targetRef } = await scene()
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
      [Transform, { translation: [0, 0.5, 0] }],
    )
    world.spawn(
      [DirectionalLight, { illuminance: 3000 }],
      [Transform, { rotation: q(-0.9, 0.5, 0) }],
    )
    const cam = camera(world, targetRef, [0, 3, 7.5], [0, 0.7, 0])
    const frustum = mat4.multiply(
      mat4.create(),
      mat4.perspectiveReversedZ(mat4.create(), 0.5, 1.5, 0.1),
      mat4.lookAt(mat4.create(), [2.4, 0.6, 2], [1.6, 0.6, -1], [0, 1, 0]),
    )
    everyFrame(app, 'test/shapes', (g) => {
      g.grid([0, 0, 0], [0, 1, 0], 8, 0.5, [0.35, 0.35, 0.4, 1])
      // Through the cube: dimmed where it's behind, full where depth testing is off.
      g.line([-2, 0.5, 0], [2, 0.5, 0], [1, 0.2, 0.2, 1], { width: 3 })
      g.line([-2, 0.8, 0], [2, 0.8, 0], [0.2, 1, 0.3, 1], { width: 3, depthTest: false })
      g.arrow([-2.2, 0.2, 1], [-2.2, 1.6, 1], [1, 0.9, 0.2, 1], { width: 2 })
      g.box([-1.6, 1.2, -1], [0.8, 0.5, 0.5], q(0, 0.6, 0.3), [0.3, 0.8, 1, 1])
      g.sphere([1.5, 1.4, 0.5], 0.45, [1, 0.5, 1, 1])
      g.frustum(frustum, [0.9, 0.9, 0.9, 1])
      g.label([0, 2.4, 0], 'ship/cockpit', [1, 1, 1, 1])
    })
    const image = await renderView(app, `camera:${cam}`)
    const golden = compareGolden(here, 'gizmos', image)
    expect(golden.mean).toBeLessThan(1)
    // The label's backing and text are there.
    const g = world.resource(Gizmos).describe()
    expect(g.labels.map((l) => l.text)).toEqual(['ship/cockpit'])
    expect(g.lineCount).toBeGreaterThan(100)
  })

  it('keeps timed gizmos for their duration, then drops them', async () => {
    const { app, world } = await scene(32, 32)
    world.resource(Gizmos).line([0, 0, 0], [1, 0, 0], [1, 1, 1, 1], { duration: 0.5 })
    world.resource(Gizmos).line([0, 0, 0], [0, 1, 0], [1, 1, 1, 1])
    app.update(1 / 60)
    const g = world.resource(Gizmos)
    expect(g.lineCount).toBe(1) // the untimed one ended with its frame
    for (let i = 0; i < 20; i++) app.update(1 / 60)
    expect(g.lineCount).toBe(1)
    for (let i = 0; i < 20; i++) app.update(1 / 60)
    expect(g.lineCount).toBe(0)
  })

  it('100k lines a frame: no allocations (no GC), under 1 ms of CPU to draw', async () => {
    const { app, world } = await scene(32, 32)
    await settle(app, 4)
    const g = world.resource(Gizmos)
    const color = [0.2, 0.8, 1, 1]
    const a = new Float32Array(3)
    const b = new Float32Array(3)
    const draw = () => {
      g.frame.clear()
      for (let i = 0; i < 100_000; i++) {
        a[0] = i
        b[1] = i
        g.line(a, b, color)
      }
    }
    const upload = () => uploadGizmos.run(undefined, world, undefined as never)
    for (let i = 0; i < 30; i++) {
      draw() // grow the arrays and let V8 optimize
      upload()
    }
    const gc = (globalThis as { gc?: () => void }).gc
    gc?.()
    const gcs = gcWindow()
    const drawTimes: number[] = []
    const uploadTimes: number[] = []
    for (let f = 0; f < 30; f++) {
      const t0 = performance.now()
      draw()
      const t1 = performance.now()
      upload()
      drawTimes.push(t1 - t0)
      uploadTimes.push(performance.now() - t1)
    }
    const collections = await gcs.end()
    const median = (t: number[]) => t.sort((x, y) => x - y)[t.length >> 1]!
    // The fastest frame is the code's cost; the median also has whatever else the machine ran.
    const best = Math.min(...drawTimes)
    console.log(
      `100k gizmo lines: draw ${best.toFixed(3)} ms best, ${median(drawTimes).toFixed(3)} ms median; upload ${median(uploadTimes).toFixed(3)} ms median; GC events: ${collections}`,
    )
    expect(collections).toBe(0)
    expect(best).toBeLessThan(budget(1))
  })
})

/** Runs frames until the picks resolve (the first may wait on the pick pipelines). */
async function resolve<T>(app: App, picks: Promise<T>[]): Promise<T[]> {
  let done = false
  const all = Promise.all(picks).finally(() => {
    done = true
  })
  for (let i = 0; i < 60 && !done; i++) {
    app.update(1 / 60)
    await app.world.resource(Gpu).pipelines.whenIdle()
    await new Promise((r) => setTimeout(r, 0))
  }
  return all
}

describe('picking and raycasts', () => {
  async function fixture() {
    const { app, world, targetRef } = await scene(160, 120)
    const meshes = world.resource(Meshes)
    const box = meshes.add(cube({ size: 1 }))
    const ball = meshes.add(sphere({ radius: 0.5, segments: 24 }))
    const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.5 }))
    const entities: Entity[] = []
    // Instanced: one mesh and material, many entities.
    for (let i = 0; i < 6; i++) {
      entities.push(
        world.spawn(
          [Mesh3d, { mesh: box }],
          [MeshMaterial, { material }],
          [Transform, { translation: [-3.75 + i * 1.5, 1, 0], rotation: q(0, i * 0.3, 0) }],
        ),
      )
    }
    // LOD: two levels.
    for (let i = 0; i < 3; i++) {
      entities.push(
        world.spawn(
          [Mesh3d, { mesh: ball }],
          [
            Lod,
            {
              levels: [
                { mesh: ball, screenSize: 0.3 },
                { mesh: box, screenSize: 0 },
              ],
            },
          ],
          [Transform, { translation: [-2 + i * 2, -1.2, 0] }],
        ),
      )
    }
    const floor = world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 12 })) }],
      [Transform, { translation: [0, -2, 0] }],
    )
    world.spawn(
      [DirectionalLight, { illuminance: 3000 }],
      [Transform, { rotation: q(-0.9, 0.5, 0) }],
    )
    const cam = camera(world, targetRef, [0, 1, 8], [0, 0, 0])
    await settle(app)
    return { app, world, cam, entities, floor }
  }

  it('GPU picks and CPU raycasts agree on the entity; positions agree within 1 cm', async () => {
    const { app, world, cam, entities, floor } = await fixture()
    const view = world.resource(Views).list.find((v) => v.name === `camera:${cam}`)!
    const c = cameraOf(view)!
    const inv = mat4.invert(mat4.create(), c.viewProjNoJitter)!
    const r = ray.create()
    const samples: [number, number][] = []
    for (let y = 8; y < 120; y += 16) for (let x = 6; x < 160; x += 22) samples.push([x, y])
    const picks = samples.map(([x, y]) => pick(world, cam, x, y))
    const hits = await resolve(app, picks)
    let meshHits = 0
    samples.forEach(([x, y], i) => {
      ray.fromScreen(r, x + 0.5, y + 0.5, c.width, c.height, inv)
      const cast = raycast(world, r.subarray(0, 3), r.subarray(3, 6))[0]
      const hit = hits[i]
      expect(hit?.entity, `pixel ${x},${y}`).toBe(cast?.entity)
      if (!hit || !cast) return
      meshHits++
      // LOD spheres draw as boxes up close or far away; the raycast tests level 0. Compare
      // positions only where the drawn mesh is the one cast against.
      if (!entities.slice(6).includes(hit.entity)) {
        for (let k = 0; k < 3; k++)
          expect(Math.abs(hit.position[k]! - cast.position[k]!)).toBeLessThan(0.01)
        expect(
          hit.normal[0] * cast.normal[0] +
            hit.normal[1] * cast.normal[1] +
            hit.normal[2] * cast.normal[2],
        ).toBeGreaterThan(0.98)
      }
    })
    expect(meshHits).toBeGreaterThan(20)
    expect(hits.some((h) => h?.entity === floor)).toBe(true)
  })

  it('raycasts without a GPU, against triangles, bounds, and every hit', async () => {
    const app = new App().addPlugin(TransformPlugin)
    await app.init()
    const world = app.world
    const meshes = world.initResource(Meshes)
    const ball = world.spawn(
      [Mesh3d, { mesh: meshes.add(sphere({ radius: 1, segments: 32 })) }],
      [Transform, { translation: [0, 0, -5] }],
    )
    const far = world.spawn(
      [Mesh3d, { mesh: meshes.add(cube({ size: 2 })) }],
      [Transform, { translation: [0, 0, -10], scale: [2, 2, 2] }],
    )
    app.update(1 / 60)
    const [hit] = raycast(world, [0, 0, 0], [0, 0, -1])
    expect(hit?.entity).toBe(ball)
    expect(hit!.distance).toBeCloseTo(4, 2)
    expect(hit!.normal[2]).toBeGreaterThan(0.99)
    // Past the sphere's silhouette, inside its bounds: triangles miss, bounds hit.
    const corner = [0.9, 0.9, 0]
    expect(raycast(world, corner, [0, 0, -1])[0]?.entity).toBe(far)
    expect(raycast(world, corner, [0, 0, -1], { boundsOnly: true })[0]?.entity).toBe(ball)
    const all = raycast(world, [0, 0, 0], [0, 0, -1], { all: true })
    // One hit per entity: its nearest surface.
    expect(all.map((h) => h.entity)).toEqual([ball, far])
    expect(all[1]!.distance).toBeCloseTo(8, 3)
    expect(raycast(world, [0, 0, 0], [0, 0, -1], { maxDistance: 3 })).toEqual([])
    // Moving it rebuilds the BVH.
    world.set(ball, Transform, { translation: [5, 0, -5] })
    app.update(1 / 60)
    expect(raycast(world, [0, 0, 0], [0, 0, -1])[0]?.entity).toBe(far)
  })
})

describe('debug overlays', () => {
  it('each overlay draws through Gizmos, and the filter limits it', async () => {
    const { app, world, targetRef } = await scene(64, 64)
    const box = world.resource(Meshes).add(cube())
    const a = world.spawn([Mesh3d, { mesh: box }], [Transform, { translation: [-1, 0, 0] }])
    world.spawn([Mesh3d, { mesh: box }], [Transform, { translation: [1, 0, 0] }])
    world.spawn([PointLight, { range: 3 }], [Transform, { translation: [0, 2, 0] }])
    world.spawn(
      [SpotLight, { range: 4 }],
      [Transform, { translation: [0, 3, 0], rotation: q(-1.5, 0, 0) }],
    )
    world.spawn([DirectionalLight, { shadows: true }], [Transform, { rotation: q(-0.9, 0.5, 0) }])
    camera(world, targetRef, [0, 1, 6], [0, 0, 0])
    camera(world, targetRef, [4, 1, 4], [0, 0, 0])
    await settle(app)
    const g = world.resource(Gizmos)
    const count = (
      on: Parameters<typeof setOverlays>[1],
      filter?: Parameters<typeof setOverlays>[2],
    ) => {
      const o = world.resource(DebugOverlays)
      for (const k of [
        'bounds',
        'lights',
        'cameras',
        'cascades',
        'normals',
        'axes',
        'labels',
      ] as const)
        o[k] = false
      o.filter = { components: [], path: '' }
      setOverlays(world, on, filter)
      app.update(1 / 60)
      return { lines: g.lineCount, labels: g.labelCount }
    }
    expect(count({})).toEqual({ lines: 0, labels: 0 })
    expect(count({ bounds: true }).lines).toBe(24) // two boxes, 12 edges each
    expect(count({ lights: true }).lines).toBeGreaterThan(96) // a sphere, a cone, an arrow
    expect(count({ cameras: true }).lines).toBe(12) // the other camera's frustum
    expect(count({ cascades: true }).lines).toBeGreaterThanOrEqual(12)
    expect(count({ normals: true }).lines).toBe(48) // 24 vertices per cube
    expect(count({ axes: true }).lines).toBeGreaterThanOrEqual(3 * 7)
    expect(count({ labels: true }).labels).toBe(2)
    // Filters: by component, and by name (a path prefix).
    expect(count({ bounds: true, lights: true }, { components: ['render/PointLight'] }).lines).toBe(
      3 * 32,
    )
    world.resource(DebugOverlays).name = (_, e) => (e === a ? 'ship/hull' : 'rock')
    expect(count({ bounds: true, labels: true }, { path: 'ship' })).toEqual({
      lines: 12,
      labels: 1,
    })
    expect(g.describe().labels[0]!.text).toBe('ship/hull')
    world.resource(DebugOverlays).name = () => undefined
    void world.resource(Gpu)
  })
})
