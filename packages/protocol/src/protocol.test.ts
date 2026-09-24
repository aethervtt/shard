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

  it('captures debug views, shadow maps, and raw HDR buffers', async () => {
    const decode = async (shot: { data: string }) =>
      decodePng(Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)))
    const normal = await decode(await ok('render.capture', { camera: 'camera' }))
    const clusters = await decode(
      await ok('render.capture', { camera: 'camera', debug: 'clusters' }),
    )
    expect([...clusters.data]).not.toEqual([...normal.data])
    // The debug view is only for that capture.
    const again = await decode(await ok('render.capture', { camera: 'camera' }))
    expect([...again.data]).toEqual([...normal.data])
    const lod = await decode(await ok('render.capture', { camera: 'camera', debug: 'lod' }))
    expect([...lod.data]).not.toEqual([...normal.data])
    // 'culling' stays frozen across captures until 'none'.
    const frozen = async () =>
      Object.values(
        (
          (await ok('render.describe', {})) as {
            culling: { views: Record<string, { frozen: boolean }> }
          }
        ).culling.views,
      )[0]!.frozen
    await ok('render.capture', { camera: 'camera', debug: 'culling' })
    await ok('render.capture', { camera: 'camera' })
    expect(await frozen()).toBe(true)
    await ok('render.capture', { camera: 'camera', debug: 'none' })
    expect(await frozen()).toBe(false)
    const bad = await call('render.capture', { camera: 'camera', debug: 'nope' })
    expect((bad.error!.data as { code: string }).code).toBe('protocol/unknown-debug-view')
    // The sun has no shadows: a clear error, not an empty image.
    const none = await call('render.capture', { camera: 'camera', debug: 'shadow-map:sun' })
    expect((none.error!.data as { code: string }).code).toBe('render/no-shadow-map')
    await ok('entity.patch', {
      entity: 'sun',
      components: { 'render/DirectionalLight': { shadows: true } },
    })
    const map = await decode(
      await ok('render.capture', { camera: 'camera', debug: 'shadow-map:sun' }),
    )
    expect(map.width).toBe(2048)
    expect(map.data.some((v, i) => i % 4 === 0 && v > 0)).toBe(true)
    await ok('entity.patch', {
      entity: 'sun',
      components: { 'render/DirectionalLight': { shadows: false } },
    })
    const hdr: { format: string; width: number; data: string } = await ok('render.capture', {
      camera: 'camera',
      buffer: 'hdr',
    })
    expect(hdr.format).toBe('rgba32float')
    const floats = new Float32Array(Uint8Array.from(atob(hdr.data), (c) => c.charCodeAt(0)).buffer)
    expect(floats.length).toBe(hdr.width * hdr.width * 4)
    // Daylight on a red box: hundreds of cd/m² in red, next to nothing in blue.
    const center = ((hdr.width / 2) * hdr.width + hdr.width / 2) * 4
    expect(floats[center]!).toBeGreaterThan(100)
    expect(floats[center + 2]!).toBeLessThan(floats[center]! / 20)
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

describe('assets', () => {
  it('lists, describes, re-imports, and moves assets', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createNodePlatform } = await import('@shard/platform-node')
    const { assetServer } = await import('@shard/assets')
    const root = mkdtempSync(join(tmpdir(), 'shard-protocol-assets-'))
    try {
      mkdirSync(join(root, 'materials'), { recursive: true })
      mkdirSync(join(root, 'scenes'), { recursive: true })
      writeFileSync(join(root, 'materials/paint.material.json'), '{ "baseColor": "#00ff00" }')
      writeFileSync(join(root, 'materials/bad.material.json'), '{ "roughness": 7 }')
      writeFileSync(
        join(root, 'scenes/s.scene.json'),
        JSON.stringify({
          version: 1,
          entities: [
            {
              name: 'm',
              components: {
                'render/Mesh3d': { mesh: { path: 'procedural:cube' } },
                'render/MeshMaterial': { material: { path: 'materials/paint.material.json' } },
              },
            },
          ],
        }),
      )
      assetServer(app.world).configure({ platform: createNodePlatform({ root, logTo: () => {} }) })

      const scan = await ok('asset.import', {})
      expect((scan as { failed: { path: string }[] }).failed.map((f) => f.path)).toEqual([
        'materials/bad.material.json',
      ])
      const listed = (await ok('asset.list', { type: 'Material' })) as {
        assets: { path: string; state: string }[]
      }
      expect(listed.assets.map((a) => a.path)).toEqual(['materials/paint.material.json'])

      const bad = (await ok('asset.get', { asset: 'materials/bad.material.json' })) as {
        error: { code: string; path: string }
      }
      expect(bad.error).toMatchObject({ code: 'assets/import-failed', path: '/roughness' })

      const sceneJson = JSON.parse(readFileSync(join(root, 'scenes/s.scene.json'), 'utf8'))
      await ok('scene.load', { json: sceneJson, id: 'assets-scene' })
      const info = (await ok('asset.get', { asset: 'materials/paint.material.json' })) as {
        state: string
        importer: string
      }
      expect(info).toMatchObject({ state: 'loaded', importer: 'data/material' })

      const moved = (await ok('asset.move', {
        from: 'materials/paint.material.json',
        to: 'materials/green.material.json',
      })) as { rewritten: string[] }
      expect(moved.rewritten).toEqual(['scenes/s.scene.json'])
      expect(readFileSync(join(root, 'scenes/s.scene.json'), 'utf8')).toContain(
        'materials/green.material.json',
      )
      const unknown = await call('asset.get', { asset: 'materials/paint.material.json' })
      expect((unknown.error!.data as { code: string }).code).toBe('assets/not-found')
      await ok('scene.load', { json: { version: 1, entities: [] }, id: 'assets-scene' })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
  it('asset.get on a data asset returns its value, its $extends chain, and who set each field', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createNodePlatform } = await import('@shard/platform-node')
    const { assetServer, defineDataType } = await import('@shard/assets')
    const { t } = await import('@shard/core')
    defineDataType(
      'test-protocol/Item',
      { price: t.u32({ default: 5 }), weight: t.f32({ default: 1 }) },
      { extension: 'item' },
    )
    const root = mkdtempSync(join(tmpdir(), 'shard-protocol-data-'))
    try {
      mkdirSync(join(root, 'data/items'), { recursive: true })
      writeFileSync(join(root, 'data/items/rock.item.json'), '{ "weight": 3 }')
      writeFileSync(
        join(root, 'data/items/gold.item.json'),
        '{ "$extends": { "path": "data/items/rock.item.json" }, "price": 900 }',
      )
      assetServer(app.world).configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      await ok('asset.import', {})
      const listed = (await ok('asset.list', { type: 'test-protocol/Item' })) as {
        assets: { path: string }[]
      }
      expect(listed.assets.map((a) => a.path)).toEqual([
        'data/items/gold.item.json',
        'data/items/rock.item.json',
      ])
      const gold = await ok('asset.get', { asset: 'data/items/gold.item.json' })
      expect(gold).toMatchObject({
        type: 'test-protocol/Item',
        value: { price: 900, weight: 3 },
        info: {
          extends: ['data/items/rock.item.json'],
          setBy: { '/price': 'data/items/gold.item.json', '/weight': 'data/items/rock.item.json' },
        },
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('prefabs', () => {
  it('spawns, reports overrides, saves a patched child as an override, and applies to the prefab', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { createNodePlatform } = await import('@shard/platform-node')
    const { assetServer } = await import('@shard/assets')
    const { ScenePlugin } = await import('@shard/scene')
    const root = mkdtempSync(join(tmpdir(), 'shard-protocol-prefabs-'))
    const prefab = {
      version: 1,
      root: {
        name: 'ship',
        components: { 'core/Transform': {} },
        children: [
          { name: 'Hull', components: { 'core/Transform': { scale: [2, 1, 4] } } },
          { name: 'Exhaust', components: { 'core/Transform': { translation: [0, 0, 2] } } },
        ],
      },
    }
    const sceneFile = {
      version: 1,
      entities: [
        {
          name: 'player-ship',
          components: {
            'core/Transform': { translation: [0, 5, 0] },
            'scene/PrefabInstance': { prefab: { path: 'prefabs/ship.prefab.json' } },
          },
        },
      ],
    }
    try {
      mkdirSync(join(root, 'prefabs'), { recursive: true })
      mkdirSync(join(root, 'scenes'), { recursive: true })
      writeFileSync(join(root, 'prefabs/ship.prefab.json'), JSON.stringify(prefab))
      writeFileSync(join(root, 'scenes/main.scene.json'), JSON.stringify(sceneFile))
      const platform = createNodePlatform({ root, logTo: () => {} })
      const own = new App().addPlugin(TransformPlugin, ScenePlugin)
      await own.init()
      await assetServer(own.world).configure({ platform }).scan()
      const srv = createProtocolServer(own, { platform })
      const req = async (method: string, params?: unknown) => {
        const r = await srv.handle({ jsonrpc: '2.0', id: nextId++, method, params })
        if (r!.error) throw new Error(`${method}: ${JSON.stringify(r!.error)}`)
        return r!.result as never
      }
      await req('scene.load', { file: 'scenes/main.scene.json' })

      await req('entity.patch', {
        entity: 'player-ship/Exhaust',
        components: { 'core/Transform': { translation: [0, 0, 3] } },
      })
      const saved = (await req('scene.save', { id: 'scenes/main.scene.json' })) as typeof sceneFile
      expect(saved.entities[0]!.components['scene/PrefabInstance']).toEqual({
        prefab: { path: 'prefabs/ship.prefab.json' },
        overrides: { Exhaust: { 'core/Transform': { translation: [0, 0, 3] } } },
      })
      expect(await req('prefab.overrides', { entity: 'player-ship' })).toMatchObject({
        overrides: { Exhaust: { 'core/Transform': { translation: [0, 0, 3] } } },
      })

      const spawned = (await req('prefab.spawn', {
        prefab: 'prefabs/ship.prefab.json',
        transform: { translation: [10, 0, 0] },
        overrides: { Hull: { 'core/Transform': { scale: [1, 1, 1] } } },
      })) as { root: number; paths: Record<string, number> }
      expect(Object.keys(spawned.paths)).toEqual(['Hull', 'Exhaust'])
      const hull = (await req('entity.get', { entity: spawned.paths.Hull })) as {
        components: Record<string, { scale: number[] }>
      }
      expect(hull.components['core/Transform']!.scale).toEqual([1, 1, 1])

      await req('prefab.apply', { entity: 'player-ship' })
      const written = JSON.parse(readFileSync(join(root, 'prefabs/ship.prefab.json'), 'utf8'))
      expect(written.root.children[1].components['core/Transform']).toEqual({
        translation: [0, 0, 3],
      })
      expect(await req('prefab.overrides', { entity: 'player-ship' })).toMatchObject({
        overrides: {},
      })
      // The runtime instance picked up the change too (its children respawned, with new ids).
      const children = (await req('world.query', {
        with: ['core/ChildOf', 'core/Transform'],
        limit: 100,
      })) as {
        entities: { components: Record<string, { parent: number; translation: number[] }> }[]
      }
      const mine = children.entities.filter(
        (e) => e.components['core/ChildOf']!.parent === spawned.root,
      )
      expect(mine.map((e) => e.components['core/Transform']!.translation)).toContainEqual([0, 0, 3])
      srv.close()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
