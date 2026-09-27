import { App } from '@aethervtt/shard-runtime'
import { loadScene } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { createProtocolServer } from './server'

const scene = {
  version: 1,
  entities: [
    {
      name: 'system',
      components: { 'transform/Grid': { cellSize: 2000 } },
      children: [
        {
          name: 'planet',
          components: {
            'transform/Grid': { cellSize: 1000 },
            'transform/GridCell': { cell: [75_000, 0, 0] },
          },
          children: [
            { name: 'base', components: { 'core/Transform': { translation: [5, 0, 0] } } },
          ],
        },
        {
          name: 'ship',
          components: {
            'core/Transform': { translation: [10, 0, 0] },
            'transform/GridCell': { cell: [500_000_000, 0, 0] },
          },
          children: [
            {
              name: 'camera',
              components: {
                'core/Transform': { translation: [0, 2, 0] },
                'transform/FloatingOrigin': {},
              },
            },
          ],
        },
        { name: 'probe', components: { 'core/Transform': {} } },
      ],
    },
    { name: 'loose', components: { 'core/Transform': { translation: [1, 2, 3] } } },
  ],
}

async function setup(json: unknown = scene) {
  const app = new App().addPlugin(TransformPlugin)
  await app.init()
  loadScene(app.world, json)
  app.update(1 / 60)
  const server = createProtocolServer(app)
  const call = async (method: string, params?: unknown) => {
    const r = await server.handle({ jsonrpc: '2.0', id: 1, method, params })
    return r!
  }
  const ok = async (method: string, params?: unknown) => {
    const r = await call(method, params)
    if (r.error) throw new Error(`${method}: ${JSON.stringify(r.error)}`)
    return r.result as Record<string, unknown>
  }
  return { app, server, call, ok }
}

describe('large-world coordinates over the protocol (spec 0040)', () => {
  it('app.describe reports the grid tree and the origin', async () => {
    const { ok, server } = await setup()
    const d = await ok('app.describe')
    expect(d.grids).toEqual({
      grids: [
        { grid: 'system', cellSize: 2000, parent: null, cell: [0, 0, 0], entities: 3 },
        {
          grid: 'system/planet',
          cellSize: 1000,
          parent: 'system',
          cell: [75_000, 0, 0],
          entities: 1,
        },
      ],
      origin: { entity: 'system/ship/camera', grid: 'system', cell: [500_000_000, 0, 0] },
    })
    server.close()
  })

  it('leaves app.describe and entity.get as they were without grids', async () => {
    const { ok, server } = await setup({
      version: 1,
      entities: [{ name: 'a', components: { 'core/Transform': {} } }],
    })
    expect((await ok('app.describe')).grids).toBeUndefined()
    expect((await ok('entity.get', { entity: 'a' })).worldPosition64).toBeUndefined()
    server.close()
  })

  it('entity.get includes the exact position relative to the floating origin', async () => {
    const { ok, server } = await setup()
    const probe = await ok('entity.get', { entity: 'system/probe' })
    // Positions are relative to the origin's cell (10¹² m out), not the camera itself.
    expect(probe.worldPosition64).toEqual([-1e12, 0, 0])
    const camera = await ok('entity.get', { entity: 'system/ship/camera' })
    expect(camera.worldPosition64).toEqual([10, 2, 0])
    // The root frame (outside any grid) is shifted the same way.
    expect((await ok('entity.get', { entity: 'loose' })).worldPosition64).toEqual([1 - 1e12, 2, 3])
    server.close()
  })

  it('entity.patch places an entity by f64 position, splitting it into a cell and an offset', async () => {
    const { ok, call, server } = await setup()
    const moon = await ok('entity.patch', {
      entity: 'loose',
      position64: [3.8e8 + 12.25, -7, 1e12],
      grid: 'system',
      components: { 'core/Transform': { scale: [2, 2, 2] } },
    })
    const c = moon.components as Record<string, Record<string, unknown>>
    expect(c['transform/GridCell']!.cell).toEqual([190_000, 0, 500_000_000])
    expect(c['core/Transform']!.translation).toEqual([12.25, -7, 0])
    expect(c['core/Transform']!.scale).toEqual([2, 2, 2])
    const system = (await ok('entity.get', { entity: 'system' })).id
    expect(c['core/ChildOf']!.parent).toBe(system)
    // Without "grid", the entity's own grid.
    const moved = await ok('entity.patch', { entity: moon.id, position64: [4001, 0, 0] })
    expect((moved.components as typeof c)['transform/GridCell']!.cell).toEqual([2, 0, 0])
    // Nothing changes when the grid is wrong.
    const bad = await call('entity.patch', {
      entity: 'system/probe',
      position64: [1, 2, 3],
      grid: 'loose',
      components: { 'core/Transform': { translation: [9, 9, 9] } },
    })
    expect((bad.error!.data as { code: string }).code).toBe('protocol/not-a-grid')
    expect(
      ((await ok('entity.get', { entity: 'system/probe' })).components as typeof c)[
        'core/Transform'
      ]!.translation,
    ).toEqual([0, 0, 0])
    const short = await call('entity.patch', { entity: 'system/probe', position64: [1, 2] })
    expect((short.error!.data as { code: string }).code).toBe('protocol/invalid-position64')
    server.close()
  })
})
