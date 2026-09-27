import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { createProtocolServer, type ProtocolServer } from '@aethervtt/shard-protocol'
import {
  Camera3d,
  forwardPlugin,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  setOverlays,
} from '@aethervtt/shard-render'
import { compareGolden, renderView } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { loadScene, ScenePlugin, whenSceneReady } from '@aethervtt/shard-scene'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Physics, physics2dPlugin, physics3dPlugin } from './plugin'

const here = dirname(fileURLToPath(import.meta.url))

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const scene = {
  version: 1,
  entities: [
    {
      name: 'floor',
      components: {
        'core/Transform': {},
        'physics/Collider': { shape: 'trimesh', mesh: { path: 'procedural:plane?size=20' } },
      },
    },
    {
      name: 'crate',
      components: {
        'core/Transform': { translation: [0, 3, 0], rotationEuler: [20, 30, 10] },
        'physics/RigidBody': { kind: 'dynamic' },
        'physics/Collider': { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] },
      },
      children: [
        {
          name: 'antenna',
          components: {
            'core/Transform': { translation: [0, 0.9, 0] },
            'physics/Collider': { shape: 'capsule', radius: 0.1, halfHeight: 0.3 },
          },
        },
      ],
    },
    {
      name: 'ball',
      components: {
        'core/Transform': { translation: [2, 1, 0] },
        'physics/RigidBody': { kind: 'fixed' },
        'physics/Collider': { shape: 'ball', radius: 0.6 },
      },
    },
    {
      name: 'trigger',
      components: {
        'core/Transform': { translation: [-2, 0.5, 0] },
        'physics/Collider': { shape: 'cylinder', radius: 0.5, halfHeight: 0.5, sensor: true },
      },
    },
  ],
}

async function start(): Promise<{ app: App; server: ProtocolServer }> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    ScenePlugin,
    physics3dPlugin,
  )
  await app.init()
  loadScene(app.world, scene)
  await whenSceneReady(app.world, 'main')
  return { app, server: createProtocolServer(app) }
}

async function call(server: ProtocolServer, method: string, params?: unknown) {
  const r = await server.handle({ jsonrpc: '2.0', id: 1, method, params })
  if (r?.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`)
  return r!.result as never
}

describe('physics through scenes and the protocol', () => {
  it('builds colliders from a scene, including a mesh asset, and answers physics.* methods', async () => {
    const { app, server } = await start()
    for (let i = 0; i < 120; i++) app.update(1 / 60)
    const described = (await call(server, 'physics.describe')) as {
      bodies: Record<string, number>
      colliders: Record<string, number>
      pending: number
    }
    expect(described.bodies).toEqual({ dynamic: 1, fixed: 1 })
    expect(described.colliders).toEqual({ trimesh: 1, cuboid: 1, capsule: 1, ball: 1, cylinder: 1 })
    expect(described.pending).toBe(0)

    const { findEntityByPath } = await import('@aethervtt/shard-scene')
    const [cx, , cz] = app.world.get(findEntityByPath(app.world, 'crate')!, Transform).translation
    const down = (await call(server, 'physics.raycast', {
      origin: [cx, 10, cz],
      direction: [0, -1, 0],
      all: true,
    })) as { hits: { path: string; bodyPath: string | null }[] }
    // Wherever the crate came to rest on the mesh floor: antenna first, then crate, then floor.
    expect(down.hits.map((h) => h.path)).toEqual(['crate/antenna', 'crate', 'floor'])
    expect(down.hits[0]!.bodyPath).toBe('crate')

    const sensorHits = (await call(server, 'physics.raycast', {
      origin: [-2, 10, 0],
      direction: [0, -1, 0],
      sensors: true,
    })) as { hits: { path: string }[] }
    expect(sensorHits.hits[0]!.path).toBe('trigger')

    const overlap = (await call(server, 'physics.overlap', {
      position: [2, 1, 0],
      shape: 'ball',
      radius: 0.1,
    })) as { colliders: { path: string }[] }
    expect(overlap.colliders.map((c) => c.path)).toEqual(['ball'])

    // Patching a collider through entity.patch rebuilds it at the next step.
    await call(server, 'entity.patch', {
      entity: 'ball',
      components: { 'physics/Collider': { radius: 1.5 } },
    })
    app.update(1 / 60)
    const wide = (await call(server, 'physics.overlap', {
      position: [3.2, 1, 0],
      shape: 'point',
    })) as { colliders: { path: string }[] }
    expect(wide.colliders.map((c) => c.path)).toEqual(['ball'])
    expect(app.world.resource(Physics).describe().colliders.ball).toBe(1)
  })

  it('builds a character from a scene and reports its state through entity.get and physics.describe', async () => {
    const { app, server } = await start()
    const { findEntityByPath } = await import('@aethervtt/shard-scene')
    // A second scene file with just the character; required components come with it.
    loadScene(
      app.world,
      {
        version: 1,
        entities: [
          {
            name: 'hero',
            components: {
              'core/Transform': { translation: [-4, 2, 3] },
              'physics/CharacterController': { height: 1.6, radius: 0.3 },
              'physics/CharacterIntent': { move: [0, 0, -1] },
            },
          },
        ],
      },
      { id: 'player' },
    )
    for (let i = 0; i < 60; i++) app.update(1 / 60)
    const hero = findEntityByPath(app.world, 'hero')!
    const got = (await call(server, 'entity.get', { entity: hero })) as {
      components: Record<string, Record<string, unknown>>
    }
    const s = got.components['physics/CharacterState']!
    expect(s.grounded).toBe(true)
    expect(s.up).toEqual([0, 1, 0])
    expect((s.velocity as number[])[2]).toBeCloseTo(-1, 3)
    const described = (await call(server, 'physics.describe')) as {
      bodies: Record<string, number>
      characters: { path: string; grounded: boolean; groundPath: string | null }[]
    }
    // The character's own body and capsule aren't counted with the scene's bodies.
    expect(described.bodies).toEqual({ dynamic: 1, fixed: 1 })
    expect(described.characters).toMatchObject([
      { path: 'hero', grounded: true, groundPath: 'floor' },
    ])
    // Rays see its capsule.
    const [x, , z] = app.world.get(hero, Transform).translation
    const down = (await call(server, 'physics.raycast', {
      origin: [x, 10, z],
      direction: [0, -1, 0],
    })) as { hits: { path: string; bodyPath: string }[] }
    expect(down.hits[0]).toMatchObject({ path: 'hero', bodyPath: 'hero' })

    // The colliders overlay draws its capsule (cyan) and its up vector (yellow).
    const target = new OffscreenTarget(gpu, { label: 'character', width: 160, height: 160 })
    const ref = app.world.resource(RenderTargets).add(target, 'character')
    const eye: [number, number, number] = [x + 4, 1.5, z + 4]
    const cam = app.world.spawn(
      [Camera3d, { target: ref as never, clearColor: [0.05, 0.05, 0.07, 1] }],
      [Transform, { translation: eye, rotation: lookAt(eye, [x, 1, z]) }],
    )
    setOverlays(app.world, { colliders: true })
    const image = await renderView(app, `camera:${cam}`)
    let cyan = 0
    let yellow = 0
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]
      if (b > 150 && g > 150 && r < b - 30) cyan++
      if (r > 150 && g > 140 && b < r - 50) yellow++
    }
    expect(cyan).toBeGreaterThan(30)
    expect(yellow).toBeGreaterThan(5)
  })

  it('draws the colliders overlay (golden)', async () => {
    const { app } = await start()
    for (let i = 0; i < 90; i++) app.update(1 / 60)
    const target = new OffscreenTarget(gpu, { label: 'physics', width: 320, height: 240 })
    const ref = app.world.resource(RenderTargets).add(target, 'physics')
    const eye: [number, number, number] = [2.5, 2.5, 4.5]
    const cam = app.world.spawn(
      [Camera3d, { target: ref as never, clearColor: [0.05, 0.05, 0.07, 1] }],
      [Transform, { translation: eye, rotation: lookAt(eye, [0, 0.5, 0]) }],
    )
    setOverlays(app.world, { colliders: true })
    const image = await renderView(app, `camera:${cam}`)
    const golden = compareGolden(here, 'colliders-overlay', image)
    if (!golden.written) expect(golden.mean).toBeLessThan(1)
    // Something was drawn: the dynamic crate's outline is orange.
    let orange = 0
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]
      if (r > 150 && r > g + 15 && r > b + 50) orange++
    }
    expect(orange).toBeGreaterThan(20)
  })

  it('draws 2D colliders in the plane (golden)', async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
      physics2dPlugin,
    )
    await app.init()
    const w = app.world
    const { Collider, RigidBody } = await import('./components')
    w.spawn(
      [
        Collider,
        {
          shape: 'polyline',
          points: [
            [-8, 1, 0],
            [-4, -1, 0],
            [4, -1, 0],
            [8, 1, 0],
          ],
        },
      ],
      [Transform, {}],
    )
    const shapes: Record<string, unknown>[] = [
      { shape: 'ball', radius: 0.6 },
      { shape: 'cuboid', halfExtents: [0.6, 0.4, 0] },
      { shape: 'capsule', radius: 0.3, halfHeight: 0.4 },
      {
        shape: 'convex',
        points: [
          [0, 0.7, 0],
          [0.6, -0.4, 0],
          [-0.6, -0.4, 0],
        ],
      },
    ]
    w.spawn(
      [
        Collider,
        {
          shape: 'heightfield',
          halfExtents: [2, 1, 0],
          heightfield: { rows: 1, cols: 5, heights: [0, 0.6, 0.2, 0.8, 0] },
        },
      ],
      [Transform, { translation: [-6, 4, 0] }],
    )
    shapes.forEach((c, i) => {
      w.spawn(
        [RigidBody, { kind: 'dynamic' }],
        [Collider, c],
        [Transform, { translation: [-3 + i * 2, 2, 0] }],
      )
    })
    w.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [1, 1, 0], sensor: true }],
      [Transform, { translation: [5, 3, 0] }],
    )
    for (let i = 0; i < 120; i++) app.update(1 / 60)
    const target = new OffscreenTarget(gpu, { label: 'physics-2d', width: 320, height: 160 })
    const ref = w.resource(RenderTargets).add(target, 'physics-2d')
    const cam = w.spawn(
      [
        Camera3d,
        {
          projection: 'orthographic',
          orthoHeight: 8,
          target: ref as never,
          clearColor: [0.05, 0.05, 0.07, 1],
        },
      ],
      [Transform, { translation: [0, 1, 50] }],
    )
    setOverlays(w, { colliders: true })
    const image = await renderView(app, `camera:${cam}`)
    const golden = compareGolden(here, 'colliders-overlay-2d', image)
    if (!golden.written) expect(golden.mean).toBeLessThan(1)
    // All four dynamic shapes came to rest in the valley and sleep, so they're drawn dimmed
    // orange; the sensor is green.
    const described = w.resource(Physics).describe()
    expect(described.bodies.dynamic).toBe(4)
    expect(described.sleeping).toBe(4)
    let dimmed = 0
    let green = 0
    for (let i = 0; i < image.data.length; i += 4) {
      const [r, g, b] = [image.data[i]!, image.data[i + 1]!, image.data[i + 2]!]
      if (r > g + 10 && r > b + 25) dimmed++
      if (g > r + 30 && g > b + 10) green++
    }
    expect(dimmed).toBeGreaterThan(40)
    expect(green).toBeGreaterThan(40)
  })
})
