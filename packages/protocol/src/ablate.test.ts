import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  type AblationResult,
  forwardPlugin,
  Gpu,
  Graph,
  OffscreenTarget,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { loadScene } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createProtocolServer, type ProtocolServer } from './server'

const scene = {
  version: 1,
  entities: [
    {
      name: 'sun',
      components: {
        'render/DirectionalLight': { illuminance: 'daylight', shadows: true },
        'core/Transform': { rotationEuler: [-40, 30, 0] },
      },
    },
    {
      name: 'box',
      components: {
        'render/Mesh3d': { mesh: { path: 'procedural:cube?size=1.4' } },
        'core/Transform': {},
      },
    },
    {
      name: 'camera',
      components: {
        'render/Camera3d': {},
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

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
  const target = new OffscreenTarget(gpu, { label: 'ablate', width: 96, height: 64 })
  app = new App().addPlugin(TransformPlugin, renderPlugin({ gpu, target }), forwardPlugin())
  await app.init()
  loadScene(app.world, scene, { id: 'scenes/ablate.scene.json' })
  server = createProtocolServer(app)
})
afterAll(() => {
  server.close()
  gpu.destroy()
})

describe('perf.ablate (spec 0075)', () => {
  it('measures every pass the last frame ran, or the ones named, and restores them', async () => {
    const graph = app.world.resource(Graph)
    const named = await call('perf.ablate', {
      passes: ['forward-opaque', 'tonemap'],
      frames: 2,
      rounds: 1,
      together: true,
    })
    if (!graph.timer.enabled) {
      expect(named.error?.data).toMatchObject({ code: 'render/gpu-timing-unavailable' })
      return
    }
    const result = named.result as AblationResult
    expect(result.passes.map((p) => p.pass)).toEqual(['forward-opaque', 'tonemap'])
    expect(result.together?.pass).toBe('forward-opaque+tonemap')
    expect(result).toMatchObject({ frames: 2, rounds: 1 })
    expect(graph.ablated()).toEqual([])

    const all = (await call('perf.ablate', { frames: 1, rounds: 1 })).result as AblationResult
    expect(all.passes.map((p) => p.pass)).toEqual(
      expect.arrayContaining(['forward-opaque', 'tonemap']),
    )
    expect(app.world.resource(Gpu).errors).toEqual([])
  })

  it('rejects a pass the graph lacks with render/unknown-node', async () => {
    const r = await call('perf.ablate', { passes: ['no-such-pass'], frames: 1, rounds: 1 })
    expect(r.error?.data).toMatchObject({ code: 'render/unknown-node' })
  })
})
