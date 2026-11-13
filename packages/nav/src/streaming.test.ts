import type { Entity, World } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { navReady, navReadyIn } from './bake'
import { NavBudget, NavMesh } from './components'
import type { NavMeshRuntime } from './navmesh'
import { Nav } from './state'
import { box, frames, navApp, shape } from './test-level'

// What streaming (0113) needs from nav: readiness over a cell's bounds, and a navmesh sized up
// front so tiles coming and going never rebuild it.

const runtime = (world: World): NavMeshRuntime => [...world.resource(Nav).meshes.values()][0]!

/** A floor 128 m long (20 tiles of 6.4 m on X), on 0.1 m cells. */
async function strip(maxTiles?: number) {
  const app = await navApp()
  const world = app.world
  world.spawn([
    NavMesh,
    {
      cellSize: 0.1,
      cellHeight: 0.1,
      tileSize: 64,
      agentRadius: 0.3,
      agentHeight: 1.8,
      ...(maxTiles === undefined ? {} : { maxTiles }),
    },
  ])
  const nav = world.resource(Nav)
  nav.shapes.set(1 as Entity, shape(box(0, -0.2, 0, 128, 0, 6)))
  return { app, world, nav }
}

describe('nav for streamed cells', () => {
  it('reports a region ready while tiles elsewhere still build', async () => {
    const { app, world, nav } = await strip()
    world.insertResource(NavBudget, { ms: 100, tiles: 1, workers: false, replans: 32 })
    frames(app, 2)
    expect(navReady(world)).toBe(true)
    expect(navReadyIn(world, 0, 0, 64, 6)).toBe(true)
    // A cell's worth of crates at the far end: its tiles build a frame at a time.
    nav.shapes.set(2 as Entity, shape(box(100, 0, 1, 101, 1, 2), box(110, 0, 1, 111, 1, 2)))
    nav.shapes.set(3 as Entity, shape(box(120, 0, 1, 121, 1, 2)))
    frames(app, 1)
    expect(navReady(world)).toBe(false)
    expect(navReadyIn(world, 96, 0, 128, 6)).toBe(false)
    expect(navReadyIn(world, 0, 0, 64, 6)).toBe(true)
    for (let i = 0; i < 20 && !navReady(world); i++) frames(app, 1)
    expect(navReadyIn(world, 96, 0, 128, 6)).toBe(true)
    app.dispose()
  })

  it('starts at maxTiles, so tiles coming in never regrow the navmesh', async () => {
    const small = await strip()
    frames(small.app, 2)
    expect(runtime(small.world).maxTiles).toBe(256)
    const { app, world, nav } = await strip(1024)
    world.insertResource(NavBudget, { ms: 1000, tiles: 64, workers: false, replans: 32 })
    frames(app, 2)
    const rt = runtime(world)
    expect(rt.maxTiles).toBeGreaterThanOrEqual(1024)
    const generation = rt.generation
    // 300 more tiles: past the default 256, within 1024.
    for (let i = 0; i < 15; i++) {
      nav.shapes.set((10 + i) as Entity, shape(box(0, -0.2, 12 + i * 8, 128, 0, 18 + i * 8)))
    }
    for (let i = 0; i < 50 && !navReady(world); i++) frames(app, 1)
    expect(navReady(world)).toBe(true)
    expect(rt.tiles.size).toBeGreaterThan(256)
    expect(rt.generation).toBe(generation)
    // Raising it later grows the navmesh once, then the same.
    world.add([...world.resource(Nav).meshes.keys()][0]!, NavMesh, {
      ...world.get([...world.resource(Nav).meshes.keys()][0]!, NavMesh),
      maxTiles: 4096,
    })
    frames(app, 2)
    expect(rt.maxTiles).toBeGreaterThanOrEqual(4096)
    small.app.dispose()
    app.dispose()
  })
})
