import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { forwardPlugin, OffscreenTarget, renderPlugin } from '@aethervtt/shard-render'
import { compareGolden } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { loadScene } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePng } from './png'
import { createProtocolServer, type ProtocolServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))

const scene = {
  version: 1,
  assets: {
    hull: { type: 'Material', value: { baseColor: '#8a93a6', roughness: 0.6 } },
    rock: { type: 'Material', value: { baseColor: '#7a5a40', roughness: 1 } },
  },
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight', shadows: true },
        'core/Transform': { rotationEuler: [-40, 30, 0] },
      },
    },
    {
      name: 'ship',
      components: { 'core/Transform': { translation: [-1.2, 0, 0] } },
      children: [
        {
          name: 'hull',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:cube?size=1.4' } },
            'render/MeshMaterial': { material: { path: '#hull' } },
            'core/Transform': {},
          },
        },
        {
          name: 'cockpit',
          components: {
            'render/Mesh3d': { mesh: { path: 'procedural:sphere?radius=0.4' } },
            'render/MeshMaterial': { material: { path: '#hull' } },
            'core/Transform': { translation: [0, 1.1, 0] },
          },
        },
      ],
    },
    {
      name: 'rock',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:cube?size=1' } },
        'render/MeshMaterial': { material: { path: '#rock' } },
        'core/Transform': { translation: [1.6, -0.2, 0.5], rotationEuler: [0, 30, 0] },
      },
    },
    {
      name: 'lamp',
      components: {
        'render/PointLight': { range: 2 },
        'core/Transform': { translation: [1.6, 1.4, 0.5] },
      },
    },
    {
      name: 'camera',
      components: {
        'render/Camera3d': { clearColor: [0.03, 0.03, 0.05, 1] },
        'core/Transform': { translation: [0, 1.2, 6], rotationEuler: [-8, 0, 0] },
      },
    },
  ],
}

let app: App
let server: ProtocolServer
let gpu: Awaited<ReturnType<typeof createNodeGpuContext>>
let nextId = 1
const call = (method: string, params?: unknown) =>
  server.handle({ jsonrpc: '2.0', id: nextId++, method, params }).then((r) => r!)
const ok = async (method: string, params?: unknown) => {
  const r = await call(method, params)
  if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`)
  return r.result as never
}

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  const target = new OffscreenTarget(gpu, { label: 'debug', width: 320, height: 200 })
  app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  loadScene(app.world, scene, { id: 'scenes/debug.scene.json' })
  server = createProtocolServer(app)
})
afterAll(() => {
  server.close()
  gpu.destroy()
})

describe('debug drawing and picking (spec 0027)', () => {
  it('render.capture with bounds and labels: scene paths next to each entity (golden)', async () => {
    const shot: { data: string; width: number; height: number } = await ok('render.capture', {
      overlays: ['bounds', 'labels'],
    })
    const image = await decodePng(Buffer.from(shot.data, 'base64'))
    expect(compareGolden(here, 'labeled-capture', image).mean).toBeLessThan(1)
    // The overlays were for that capture only.
    const plain = await decodePng(
      Buffer.from(((await ok('render.capture')) as { data: string }).data, 'base64'),
    )
    let differs = 0
    for (let i = 0; i < plain.data.length; i++) if (plain.data[i] !== image.data[i]) differs++
    expect(differs).toBeGreaterThan(1000)
    const gizmos: { lineCount: number } = await ok('debug.gizmos')
    expect(gizmos.lineCount).toBe(0)
  })

  it('render.pick and world.raycast return the same entity and path', async () => {
    const hit: { path: string; entity: number; position: number[]; distance: number } = await ok(
      'render.pick',
      { x: 160 - 48, y: 108 },
    )
    expect(hit.path).toBe('ship/hull')
    const eye = [0, 1.2, 6]
    const dir = hit.position.map((v, k) => v - eye[k]!)
    const cast: { hits: { path: string; distance: number }[] } = await ok('world.raycast', {
      origin: eye,
      direction: dir,
    })
    expect(cast.hits[0]!.path).toBe('ship/hull')
    expect(Math.abs(cast.hits[0]!.distance - hit.distance)).toBeLessThan(0.01)
    expect(await ok('render.pick', { x: 2, y: 2 })).toBeNull()
    const through: { hits: { path: string }[] } = await ok('world.raycast', {
      origin: [-5, -0.2, 0.5],
      direction: [1, 0, 0],
      all: true,
    })
    expect(through.hits.map((h) => h.path)).toEqual(['ship/hull', 'rock'])
  })

  it('debug.overlays toggles each overlay; the filter limits it; debug.gizmos lists the result', async () => {
    const counts: Record<string, number> = {}
    for (const name of ['bounds', 'lights', 'cameras', 'cascades', 'normals', 'axes', 'labels']) {
      await ok('debug.overlays', { overlays: [name] })
      await ok('time.step', { frames: 1 })
      const g: { lineCount: number; labelCount: number } = await ok('debug.gizmos', { limit: 0 })
      counts[name] = g.lineCount + g.labelCount
    }
    expect(counts.bounds).toBe(36) // hull, cockpit, rock
    expect(counts.lights).toBeGreaterThan(90) // the lamp's range, the sun's arrow
    expect(counts.cameras).toBe(0) // only one camera: you're looking through its frustum
    expect(counts.cascades).toBeGreaterThan(0)
    expect(counts.normals).toBeGreaterThan(48)
    expect(counts.axes).toBeGreaterThanOrEqual(3 * 6)
    expect(counts.labels).toBeGreaterThanOrEqual(5)

    const state: { overlays: string[] } = await ok('debug.overlays', {
      overlays: ['bounds', 'labels'],
      filter: 'ship/',
    })
    expect(state.overlays).toEqual(['bounds', 'labels'])
    await ok('time.step', { frames: 1 })
    const g: { lineCount: number; labels: { text: string }[] } = await ok('debug.gizmos')
    expect(g.lineCount).toBe(24)
    expect(g.labels.map((l) => l.text).sort()).toEqual(['ship/cockpit', 'ship/hull'])

    await ok('debug.overlays', { overlays: ['bounds'], components: ['render/PointLight'] })
    await ok('time.step', { frames: 1 })
    expect(((await ok('debug.gizmos')) as { lineCount: number }).lineCount).toBe(0)

    const bad = await call('debug.overlays', { overlays: ['boundz'] })
    expect(bad.error?.data).toMatchObject({ code: 'protocol/unknown-overlay' })
    await ok('debug.overlays', { overlays: [] })
  })
})
