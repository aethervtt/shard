import { createNodeGpuContext } from '@shard/gpu/node'
import { inputPlugin } from '@shard/input'
import { forwardPlugin, OffscreenTarget, renderPlugin } from '@shard/render'
import { App, AppControlResource, LogResource, Time } from '@shard/runtime'
import { loadScene } from '@shard/scene'
import { TransformPlugin } from '@shard/transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'
import { decodePng } from './png'
import { createProtocolServer, type JsonRpcNotification, type ProtocolServer } from './server'
import { connectToHub } from './transport'

const scene = {
  version: 1,
  assets: { red: { type: 'Material', value: { baseColor: '#ff0000', roughness: 1 } } },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight' },
        'core/Transform': { rotationEuler: [-10, 0, 0] },
      },
    }, // roughly along the camera's view: lights the box's front
    {
      name: 'box',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:cube?size=40' } },
        'render/MeshMaterial': { material: { path: '#red' } },
        'core/Transform': { translation: [0, 0, -30] },
      },
    },
    {
      name: 'camera',
      components: { 'render/Camera3d': { clearColor: [0, 0, 1, 1] }, 'core/Transform': {} },
    },
  ],
}

let app: App
let server: ProtocolServer
let gpu: Awaited<ReturnType<typeof createNodeGpuContext>>
let nextId = 1
const call = async (method: string, params?: unknown) => {
  const response = await server.handle({ jsonrpc: '2.0', id: nextId++, method, params })
  return response!
}
const ok = async (method: string, params?: unknown) => {
  const r = await call(method, params)
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`)
  return r.result as never
}

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  const target = new OffscreenTarget(gpu, { label: 'protocol', width: 32, height: 32 })
  app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin({ msaa: 1 }),
    inputPlugin(),
  )
  await app.init()
  loadScene(app.world, scene, { id: 'scenes/test.scene.json' })
  server = createProtocolServer(app)
})
afterAll(() => {
  server.close()
  gpu.destroy()
})

describe('methods', () => {
  it('describes the app and schemas', async () => {
    const d = await ok('app.describe')
    expect((d as { plugins: { name: string }[] }).plugins.map((p) => p.name)).toContain(
      'render/forward',
    )
    expect((d as { scenes: string[] }).scenes).toEqual(['scenes/test.scene.json'])
    const list: { name: string }[] = await ok('schema.list')
    expect(list.map((c) => c.name)).toContain('render/Camera3d')
    expect(list.some((c) => c.name.startsWith('protocol/'))).toBe(false)
    expect(await ok('schema.get', { name: 'render/Camera3d' })).toMatchObject({
      title: 'render/Camera3d',
    })
  })

  it('queries and gets entities by id or path', async () => {
    const q: { total: number; entities: { id: number; path: string }[] } = await ok('world.query', {
      with: ['render/Mesh3d'],
    })
    expect(q.total).toBe(1)
    expect(q.entities[0]!.path).toBe('box')
    const e: { components: Record<string, unknown> } = await ok('entity.get', { entity: 'box' })
    expect(e.components['core/Transform']).toMatchObject({ translation: [0, 0, -30] })
    expect(e.components['core/GlobalTransform']).toBeUndefined() // derived, not reported
    expect(((await ok('entity.get', { entity: q.entities[0]!.id })) as { path: string }).path).toBe(
      'box',
    )
  })

  it('spawns, patches, and despawns with validation', async () => {
    const spawned: { id: number; components: Record<string, { translation: number[] }> } = await ok(
      'entity.spawn',
      {
        components: {
          'core/Transform': { translation: [1, 2, 3] },
          'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=1' } },
        },
        parent: 'box',
      },
    )
    expect(spawned.components['core/ChildOf']).toBeDefined()
    const patched: { components: Record<string, { translation: number[]; scale: number[] }> } =
      await ok('entity.patch', {
        entity: spawned.id,
        components: { 'core/Transform': { translation: [5, 5, 5] } },
      })
    expect(patched.components['core/Transform']!.translation).toEqual([5, 5, 5])
    expect(patched.components['core/Transform']!.scale).toEqual([1, 1, 1]) // merge, not replace
    await ok('entity.despawn', { entity: spawned.id })
    expect((await call('entity.get', { entity: spawned.id })).error?.data).toMatchObject({
      code: 'protocol/unknown-entity',
    })
  })

  it('rejects an out-of-range patch with the field pointer and changes nothing', async () => {
    const r = await call('entity.patch', {
      entity: 'camera',
      components: {
        'render/Camera3d': { fovY: 500 },
        'core/Transform': { translation: [9, 9, 9] },
      },
    })
    expect(r.error?.data).toMatchObject({
      code: 'protocol/invalid-components',
      path: '/components/render~1Camera3d/fovY',
    })
    const cam: { components: Record<string, { translation: number[] }> } = await ok('entity.get', {
      entity: 'camera',
    })
    expect(cam.components['core/Transform']!.translation).toEqual([0, 0, 0]) // nothing applied
  })

  it('reports bad params and unknown methods as JSON-RPC errors with ShardError data', async () => {
    const bad = await call('world.query', { limit: 'lots' })
    expect(bad.error).toMatchObject({
      code: -32602,
      data: { code: 'protocol/invalid-params', path: '/limit' },
    })
    expect((await call('nope.nothing')).error?.code).toBe(-32601)
    expect(await server.handle({ jsonrpc: '2.0', method: 'time.pause' })).toBeUndefined() // notification: no reply
  })

  it('steps exactly n frames and stays paused', async () => {
    const before = app.world.resource(Time).frame
    const r: { frame: number } = await ok('time.step', { frames: 7 })
    expect(r.frame).toBe(before + 7)
    expect(app.world.resource(AppControlResource).paused).toBe(true)
    await ok('time.resume')
    expect(app.world.resource(AppControlResource).paused).toBe(false)
  })

  it('captures a PNG that decodes to the rendered pixels', async () => {
    const shot: { mimeType: string; width: number; height: number; data: string } = await ok(
      'render.capture',
      {
        camera: 'camera',
        width: 16,
        height: 16,
      },
    )
    expect(shot.mimeType).toBe('image/png')
    const png = await decodePng(Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)))
    expect([png.width, png.height]).toEqual([16, 16])
    const center = [...png.data.slice((8 * 16 + 8) * 4, (8 * 16 + 8) * 4 + 4)]
    expect(center[0]).toBeGreaterThan(100) // the red box fills the middle
    expect(center[2]).toBeLessThan(60)
  })

  it('injects input, validates and saves scenes, reads resources and logs', async () => {
    expect(await ok('input.inject', { key: 'KeyW' })).toEqual({ queued: true })
    const v: { valid: boolean; errors: { code: string }[] } = await ok('scene.validate', {
      json: { version: 1, entities: [{ name: 'x', components: { 'core/Nope': {} } }] },
    })
    expect(v.valid).toBe(false)
    expect(v.errors[0]!.code).toBe('scene/unknown-component')
    const saved: { entities: { name: string }[] } = await ok('scene.save', {
      id: 'scenes/test.scene.json',
    })
    expect(saved.entities.map((e) => e.name)).toEqual(['sun', 'box', 'camera'])
    expect(
      await ok('resource.set', { name: 'render/AmbientLight', value: { brightness: 42 } }),
    ).toMatchObject({ brightness: 42 })
    app.world.resource(LogResource).warn('careful')
    const tail: { message: string }[] = await ok('log.tail', { count: 5 })
    expect(tail.at(-1)!.message).toBe('careful')
  })
})

describe('subscriptions', () => {
  it('delivers log, error, and frame notifications', async () => {
    const got: JsonRpcNotification[] = []
    const off = server.onNotification((n) => got.push(n))
    await ok('subscribe', { topics: ['log', 'error', 'frame'] })
    app.world.resource(LogResource).info('hello')
    app.world.resource(LogResource).error(new Error('boom'))
    await ok('time.step', { frames: 2 })
    off()
    await ok('subscribe', { topics: ['log', 'error', 'frame'], unsubscribe: true })
    expect(got.map((n) => n.method)).toEqual(['log', 'log', 'error', 'frame', 'frame'])
  })
})

describe('hub transport', () => {
  it('an app dials out to a hub and answers requests', async () => {
    const hub = new WebSocketServer({ port: 0 })
    const port = (hub.address() as { port: number }).port
    const hello = new Promise<{ name: string }>((resolve) => {
      hub.on('connection', (socket) => {
        socket.on('message', (raw) => {
          const msg = JSON.parse(String(raw))
          if (msg.method === 'hello') {
            resolve(msg.params)
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'world.stats' }))
          }
        })
      })
    })
    const answer = new Promise<{ id: number; result: { entities: number } }>((resolve) => {
      hub.on('connection', (socket) =>
        socket.on('message', (raw) => {
          const msg = JSON.parse(String(raw))
          if (msg.id === 99) resolve(msg)
        }),
      )
    })
    const disconnect = connectToHub(`ws://127.0.0.1:${port}`, server, {
      name: 'test-app',
      reconnect: false,
    })
    expect(await hello).toMatchObject({ name: 'test-app' })
    expect((await answer).result.entities).toBe(app.world.entityCount)
    disconnect()
    hub.close()
  })
})
