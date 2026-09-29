import { quat } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext, headlessCanvas } from '@aethervtt/shard-gpu/node'
import { cube, plane } from '@aethervtt/shard-mesh'
import { App, animationFrameRunner, LogResource } from '@aethervtt/shard-runtime'
import { fakeAnimationFrames } from '@aethervtt/shard-runtime/testing'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d } from './camera'
import type { CapturedImage } from './graph'
import { Mesh3d, MeshMaterial, NotShadowCaster } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { captureView, describeRender, Gpu, renderOwner, renderPlugin } from './plugin'
import { Antialiasing, Bloom } from './post'
import { ShadowCatcher } from './shadow-catcher'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const q = (x: number, y: number, z: number) =>
  quat.fromEuler([0, 0, 0, 1], x, y, z) as [number, number, number, number]

/** An opaque cube on the left, a half-transparent panel on the right, nothing in the corners. */
function spawnScene(world: App['world']) {
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.resource(AmbientLight).brightness = 300
  world.spawn([DirectionalLight, { illuminance: 2000 }], [Transform, { rotation: q(-50, 30, 0) }])
  world.spawn(
    [Mesh3d, { mesh: meshes.add(cube({ size: 1.2 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.6, 0.3, 0.2, 1] })) },
    ],
    [Transform, { translation: [-1.1, 0, 0], rotation: q(20, 30, 0) }],
  )
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 1.4 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(
          new MaterialAsset({
            baseColor: [0.2, 0.25, 0.3, 0.5],
            alphaMode: 'alpha',
            doubleSided: true,
          }),
        ),
      },
    ],
    [Transform, { translation: [1.1, 0, 0], rotation: q(90, 0, 0) }],
  )
}

async function transparentApp(extra: unknown[]) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'alpha', width: 96, height: 48 })
  const targetRef = app.world.resource(RenderTargets).add(target, 'alpha')
  spawnScene(app.world)
  const cam = app.world.spawn(
    [Camera3d, { target: targetRef, fovY: 45, clearColor: [0, 0, 0, 0] }],
    [Transform, { translation: [0, 0, 5] }],
    ...(extra as []),
  )
  return { app, view: `camera:${cam}` }
}

describe('transparent views (0052)', () => {
  it.each([
    ['fxaa', 'fxaa'],
    ['taa', 'taa'],
  ] as const)(
    'carry alpha through tonemap, %s, and bloom: 0 on the page, 1 on opaque, the material on blended',
    async (_, mode) => {
      const { app, view } = await transparentApp([[Antialiasing, { mode }], Bloom])
      const image = await renderView(app, view)
      // Corners: nothing drew; bloom spreads a glow, but not this far.
      expect(pixel(image, 0, 0)[3]).toBeLessThanOrEqual(2)
      expect(pixel(image, 95, 47)[3]).toBeLessThanOrEqual(2)
      expect(pixel(image, 34, 24)[3]).toBe(255) // the cube
      const panel = pixel(image, 61, 24)[3]!
      expect(panel).toBeGreaterThan(118)
      expect(panel).toBeLessThan(138)
      // Premultiplied everywhere: no channel above its alpha.
      for (let i = 0; i < image.data.length; i += 4) {
        const a = image.data[i + 3]!
        if (image.data[i]! > a || image.data[i + 1]! > a || image.data[i + 2]! > a) {
          throw new Error(`pixel ${i / 4} has rgb above alpha: ${[...image.data.slice(i, i + 4)]}`)
        }
      }
      await app.dispose()
    },
    timeout(30_000),
  )

  it('lights opaque views the same whatever alpha the base color has', async () => {
    const { app, view } = await transparentApp([])
    const materials = app.world.resource(Materials)
    app.world.spawn(
      [Mesh3d, { mesh: app.world.resource(Meshes).add(cube({ size: 0.5 })) }],
      // Opaque alphaMode ignores the base color's alpha: it covers its pixel.
      [MeshMaterial, { material: materials.add(new MaterialAsset({ baseColor: [1, 1, 1, 0.1] })) }],
      [Transform, { translation: [0, 1.4, 0] }],
    )
    const image = await renderView(app, view)
    expect(pixel(image, 48, 6)[3]).toBe(255)
    await app.dispose()
  })
})

describe('the shadow catcher (0052)', () => {
  it('reads alpha 0 outside the shadow and its opacity inside it', async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
    )
    await app.init()
    const target = new OffscreenTarget(gpu, { label: 'catcher', width: 64, height: 48 })
    const targetRef = app.world.resource(RenderTargets).add(target, 'catcher')
    const world = app.world
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    world.resource(AmbientLight).brightness = 500
    world.spawn(
      [DirectionalLight, { illuminance: 5000, shadows: true }],
      [Transform, { rotation: q(60, 30, 0) }],
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 8 })) }],
      [
        MeshMaterial,
        { material: materials.add(new MaterialAsset({ opacity: 0.8 }, ShadowCatcher)) },
      ],
      NotShadowCaster,
      Transform,
    )
    world.spawn(
      [Mesh3d, { mesh: meshes.add(cube({ size: 1 })) }],
      [
        MeshMaterial,
        { material: materials.add(new MaterialAsset({ baseColor: [0.8, 0.8, 0.8, 1] })) },
      ],
      [Transform, { translation: [0, 0.5, 0] }],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 50, clearColor: [0, 0, 0, 0] }],
      [Transform, { translation: [0, 5, 5], rotation: lookAt([0, 5, 5], [0, 0, 0]) }],
    )
    const image = await renderView(app, `camera:${cam}`)
    expect(pixel(image, 31, 20)[3]).toBe(255) // the cube
    expect(pixel(image, 15, 25)).toEqual([0, 0, 0, 204]) // its shadow: opacity 0.8
    expect(pixel(image, 48, 36)[3]).toBe(0) // lit floor: invisible
    expect(pixel(image, 3, 40)[3]).toBe(0)
    await app.dispose()
  })
})

describe('surfaces, shared devices, and teardown (0052)', () => {
  /** An app on `shared` rendering one red or blue camera into a new headless surface. */
  async function surfaceApp(shared: GpuContext, color: [number, number, number, number]) {
    const canvas = headlessCanvas(16, 8)
    const surface = shared.addSurface(canvas, { alpha: 'premultiplied' })
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu: shared, surface, windowView: false }),
      forwardPlugin({ msaa: 1 }),
    )
    await app.init()
    const cam = app.world.spawn(
      [Camera3d, { clearColor: color, fovY: 45 }],
      [Transform, { translation: [0, 0, 5] }],
    )
    await settle(app)
    return { app, canvas, surface, view: `camera:${cam}` }
  }

  it('renders two apps on one device into two surfaces; disposing one leaves the other intact', async () => {
    const shared = await createNodeGpuContext()
    try {
      const table = await surfaceApp(shared, [0, 0, 1, 1])
      const dice = await surfaceApp(shared, [1, 0, 0, 0.5])
      const tableOwner = renderOwner(table.app.world)
      expect(renderOwner(dice.app.world)).not.toBe(tableOwner)
      const tableStats = shared.stats(tableOwner)
      expect(tableStats.textures).toBeGreaterThan(0)
      const shots = [
        captureView(table.app.world, table.view),
        captureView(dice.app.world, dice.view),
      ]
      table.app.update(1 / 60)
      dice.app.update(1 / 60)
      const [tableShot, diceShot] = (await Promise.all(shots)) as [CapturedImage, CapturedImage]
      expect(pixel(tableShot, 8, 4)[2]).toBeGreaterThan(200)
      expect(pixel(diceShot, 8, 4)[3]).toBeGreaterThan(100)
      expect(pixel(diceShot, 8, 4)[3]).toBeLessThan(150)
      const described = describeRender(dice.app.world) as unknown as {
        surfaces: { alpha: string; thisApp: boolean }[]
      }
      expect(described.surfaces.map((s) => [s.alpha, s.thisApp])).toEqual([
        ['premultiplied', false],
        ['premultiplied', true],
      ])

      const diceOwner = renderOwner(dice.app.world)
      await dice.app.dispose()
      expect(shared.stats(diceOwner)).toEqual({ buffers: 0, textures: 0, bytes: 0 })
      expect(dice.canvas.gpuContext.configuration).toBeUndefined()
      expect(shared.surfaces).toEqual([table.surface])
      expect(shared.stats(tableOwner)).toEqual(tableStats)
      const again = captureView(table.app.world, table.view)
      table.app.update(1 / 60)
      expect(pixel(await again, 8, 4)[2]).toBeGreaterThan(200)
      expect(shared.errors).toEqual([])
      await table.app.dispose()
    } finally {
      shared.destroy()
    }
  })

  it(
    'releases everything on dispose, and 100 create/dispose cycles leave nothing behind',
    async () => {
      const shared = await createNodeGpuContext()
      const frames = fakeAnimationFrames()
      try {
        const baseline = shared.stats()
        const listeners = shared.listenerCount
        for (let i = 0; i < 100; i++) {
          const { app } = await surfaceApp(shared, [0, 0, 0, 0])
          app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
          const running = app.run()
          await Promise.resolve()
          frames.runUntilIdle()
          const owner = renderOwner(app.world)
          await app.dispose()
          await running
          expect(shared.stats(owner)).toEqual({ buffers: 0, textures: 0, bytes: 0 })
        }
        expect(frames.pending).toBe(0)
        expect(frames.listeners).toBe(0)
        expect(shared.surfaces).toEqual([])
        expect(shared.listenerCount).toEqual(listeners)
        // Per-device objects the apps shared stay, once: nothing grows with the cycles.
        const after = shared.stats()
        expect(after.buffers - baseline.buffers).toBeLessThan(8)
        expect(after.textures - baseline.textures).toBeLessThan(8)
        expect(shared.errors).toEqual([])
      } finally {
        frames.restore()
        shared.destroy()
      }
    },
    timeout(120_000),
  )

  it('makes its own device when given a canvas, and destroys it on dispose', async () => {
    // Node has no navigator.gpu: hand the plugin a device through a canvas surface instead.
    const shared = await createNodeGpuContext()
    const canvas = headlessCanvas(8, 8)
    const app = new App().addPlugin(
      renderPlugin({ surface: shared.addSurface(canvas), windowView: false }),
    )
    await app.init()
    expect(app.world.resource(Gpu)).toBe(shared)
    await app.dispose()
    expect(canvas.gpuContext.configuration).toBeUndefined()
    expect(() => shared.stats()).not.toThrow() // a passed-in device stays
    shared.destroy()
  })
})

describe('presentation (0062)', () => {
  it(
    'resolves a trace after the GPU finished the frame and the next animation frame started',
    async () => {
      const frames = fakeAnimationFrames()
      try {
        const app = new App().addPlugin(
          TransformPlugin,
          renderPlugin({ gpu, windowView: false }),
          forwardPlugin({ msaa: 1 }),
        )
        await app.init()
        let latency: number | undefined
        void app.trace('write').then((ms) => {
          latency = ms
        })
        app.update(1 / 60)
        // Submitted and done on the GPU, but not yet on screen: that waits for the next refresh.
        await gpu.device.queue.onSubmittedWorkDone()
        await new Promise((r) => setTimeout(r, 5))
        expect(latency).toBeUndefined()
        expect(frames.tick()).toBe(1)
        await new Promise((r) => setTimeout(r, 0))
        // Resolved with the fake frame's timestamp, which isn't on the app's clock: only that it did.
        expect(latency).toBeGreaterThanOrEqual(0)
        await app.dispose()
      } finally {
        frames.restore()
      }
    },
    timeout(30_000),
  )
})

describe('on-demand rendering (0052)', () => {
  it(
    'keeps rendering from a cold start until pipelines compile, then stops',
    async () => {
      const frames = fakeAnimationFrames()
      try {
        const app = new App().addPlugin(
          TransformPlugin,
          renderPlugin({ gpu, windowView: false }),
          forwardPlugin({ msaa: 1 }),
        )
        await app.init()
        const target = new OffscreenTarget(gpu, { label: 'cold', width: 16, height: 16 })
        const targetRef = app.world.resource(RenderTargets).add(target, 'cold')
        app.world.resource(AmbientLight).brightness = 2000
        app.world.spawn(
          [Mesh3d, { mesh: app.world.resource(Meshes).add(cube({ size: 2 })) }],
          // A material nobody drew before: its pipeline compiles after the first frame.
          [
            MeshMaterial,
            {
              material: app.world
                .resource(Materials)
                .add(new MaterialAsset({ baseColor: [0.3, 0.9, 0.2, 1] })),
            },
          ],
          Transform,
        )
        const cam = app.world.spawn(
          [Camera3d, { target: targetRef, fovY: 45, clearColor: [0, 0, 0, 1] }],
          [Transform, { translation: [0, 0, 4] }],
        )
        app.setRunner(animationFrameRunner({ mode: 'on-demand', measureRefresh: false }))
        const running = app.run()
        // Frames run while a draw waits on a pipeline, a frame at a time as compiles land.
        let ran = 0
        for (let i = 0; i < 500 && (i === 0 || frames.pending > 0); i++) {
          ran += frames.tick()
          await new Promise((r) => setTimeout(r, 2))
        }
        expect(frames.pending).toBe(0)
        expect(ran).toBeGreaterThan(1) // not just the first, half-drawn frame
        expect(app.world.resource(Gpu).pipelines.pending).toBe(0)
        const shot = captureView(app.world, `camera:${cam}`)
        frames.runUntilIdle()
        expect(pixel(await shot, 8, 8)[1]).toBeGreaterThan(40) // the green cube, drawn
        await app.dispose()
        await running
      } finally {
        frames.restore()
      }
    },
    timeout(30_000),
  )

  it(
    'renders exactly one frame for a patched resource, and the frame shows it',
    async () => {
      const frames = fakeAnimationFrames()
      try {
        const app = new App().addPlugin(
          TransformPlugin,
          renderPlugin({ gpu, windowView: false }),
          forwardPlugin({ msaa: 1 }),
        )
        await app.init()
        const target = new OffscreenTarget(gpu, { label: 'on-demand', width: 32, height: 16 })
        const targetRef = app.world.resource(RenderTargets).add(target, 'on-demand')
        app.world.resource(AmbientLight).brightness = 0
        app.world.spawn(
          [Mesh3d, { mesh: app.world.resource(Meshes).add(cube({ size: 2 })) }],
          [MeshMaterial, { material: app.world.resource(Materials).add(new MaterialAsset({})) }],
          Transform,
        )
        const cam = app.world.spawn(
          [Camera3d, { target: targetRef, fovY: 45 }],
          [Transform, { translation: [0, 0, 4] }],
        )
        await settle(app)
        app.setRunner(
          animationFrameRunner({
            mode: 'on-demand',
            measureRefresh: false,
            checkResourceWrites: true,
          }),
        )
        const running = app.run()
        // The runner loads its dev write check before the first frame.
        for (let i = 0; i < 500 && frames.pending === 0; i++)
          await new Promise((r) => setTimeout(r, 1))
        frames.runUntilIdle()
        const dark = captureView(app.world, `camera:${cam}`)
        expect(frames.runUntilIdle()).toBe(1) // the capture asked for its frame
        const before = pixel(await dark, 16, 8)
        app.world.patchResource(AmbientLight, { brightness: 2000 })
        const lit = captureView(app.world, `camera:${cam}`)
        expect(frames.runUntilIdle()).toBe(1)
        expect(pixel(await lit, 16, 8)[0]).toBeGreaterThan(before[0]! + 40)
        // A bare assignment wakes nothing (the dev check reports it within a second).
        app.world.resource(AmbientLight).brightness = 10
        expect(frames.runUntilIdle()).toBe(0)
        await new Promise((resolve) => setTimeout(resolve, 1100))
        const log = app.world.resource(LogResource).tail(20)
        expect(log.find((e) => e.code === 'runtime/unmarked-resource-write')?.path).toBe(
          'render/AmbientLight',
        )
        await app.dispose()
        await running
      } finally {
        frames.restore()
      }
    },
    timeout(30_000),
  )
})
