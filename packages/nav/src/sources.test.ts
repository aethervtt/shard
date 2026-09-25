import { ShardError } from '@shard/core'
import { Collider, physics2dPlugin, RigidBody } from '@shard/physics'
import { App } from '@shard/runtime'
import { setTile, Tilemap, TilemapData, TilemapDatas } from '@shard/sprite'
import { Transform, TransformPlugin } from '@shard/transform'
import { describe, expect, it } from 'vitest'
import { NavCache } from './cache'
import { NavGrid, NavGridDatas, NavMesh, navGridFromJson, navGridToJson } from './components'
import { NavGridData } from './grid'
import { describeNav, navMethods } from './methods'
import { navGridPlugin } from './plugin'
import { findPath, navRaycast, nearestPoint } from './query'
import { Nav } from './state'
import { frames, navApp, slab } from './test-level'

function method(name: string) {
  return navMethods.find((m) => m.name === name)!
}

describe('grid sources', () => {
  it('builds from a tilemap layer and follows tile edits', async () => {
    const a = await navApp()
    const w = a.world
    // 8 × 4 tiles; a wall of tile 1 down column 4 except the bottom row (y = 3).
    const data = TilemapData.create(8, 4, ['walls'])
    for (let y = 0; y < 3; y++) data.layers[0]!.set(4, y, 1)
    const ref = w.initResource(TilemapDatas).add(data)
    const map = w.spawn(
      [Tilemap, { data: ref, tileSize: [2, 2] }],
      [Transform, { translation: [10, 20, 0] }],
    )
    const grid = w.spawn([NavGrid, { source: 'tilemap', tilemap: map }], [Transform, {}])
    frames(a, 1)
    const rec = w.resource(Nav).grids.get(grid)!
    expect(rec.problem).toBeNull()
    // Tile (x, y) covers x 10 + 2x .. and y 20 − 2(y + 1) .. 20 − 2y: cell (x, 3 − y).
    expect([rec.ox, rec.oy, rec.csx, rec.csy]).toEqual([10, 12, 2, 2])
    expect(rec.grid!.get(4, 3)).toBe(0)
    expect(rec.grid!.get(4, 0)).toBe(1)
    // Across the wall: around through the bottom row's gap (tile y = 3 → world y 12..14).
    const from = [11, 19, 0]
    const to = [25, 19, 0]
    let path = findPath(w, from, to)
    expect(path.status).toBe('complete')
    expect(
      Math.min(...Array.from({ length: path.count }, (_, i) => path.corners[i * 3 + 1]!)),
    ).toBeLessThan(14)
    // Close the gap: no way across.
    setTile(w, map, 4, 3, 1)
    frames(a, 1)
    path = findPath(w, from, to)
    expect(path.status).toBe('partial')
    // Open the top: straight across.
    setTile(w, map, 4, 0, 0)
    frames(a, 1)
    path = findPath(w, from, to)
    expect(path.status).toBe('complete')
    expect(path.count).toBe(2)
  })

  it('treats only listed tiles as blocking when blockingTiles is set', async () => {
    const a = await navApp()
    const w = a.world
    const data = TilemapData.create(4, 1)
    data.layers[0]!.set(1, 0, 5) // decoration
    data.layers[0]!.set(2, 0, 9) // water
    const map = w.spawn(
      [Tilemap, { data: w.initResource(TilemapDatas).add(data) }],
      [Transform, {}],
    )
    const grid = w.spawn(
      [NavGrid, { source: 'tilemap', tilemap: map, blockingTiles: [9] }],
      [Transform, {}],
    )
    frames(a, 1)
    const g = w.resource(Nav).grids.get(grid)!.grid!
    expect(Array.from(g.costs)).toEqual([1, 1, 0, 1])
  })

  it('rasterizes fixed 2D colliders, not dynamic ones', async () => {
    const a = await navApp(physics2dPlugin)
    const w = a.world
    // A wall filling column 5 (x 5..6) from y 0 to 6.
    w.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 3, 0.5] }],
      [Transform, { translation: [5.5, 3, 0] }],
    )
    w.spawn(
      [RigidBody, { kind: 'dynamic', gravityScale: 0 }],
      [Collider, { shape: 'ball', radius: 0.4 }],
      [Transform, { translation: [2.5, 2.5, 0] }],
    )
    const grid = w.spawn([NavGrid, { source: 'colliders', width: 10, height: 10 }], [Transform, {}])
    frames(a, 2)
    const g = w.resource(Nav).grids.get(grid)!.grid!
    for (let y = 0; y < 6; y++) expect(g.get(5, y)).toBe(0)
    expect(g.get(5, 6)).toBe(1)
    expect(g.get(2, 2)).toBe(1)
    expect(g.get(4, 2)).toBe(1)
    // A new wall shows up once physics has it.
    w.spawn(
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
      [Transform, { translation: [8.5, 8.5, 0] }],
    )
    frames(a, 2)
    expect(w.resource(Nav).grids.get(grid)!.grid!.get(8, 8)).toBe(0)
  })

  it('round-trips *.navgrid.json data and uses it through a handle', async () => {
    const data = new NavGridData(3, 2, new Uint8Array([1, 0, 1, 1, 3, 1]))
    const json = navGridToJson(data)
    expect(json).toEqual({ width: 3, height: 2, costs: expect.any(String) })
    expect(Array.from(navGridFromJson(json).costs)).toEqual([1, 0, 1, 1, 3, 1])
    expect(() => navGridFromJson({ width: 3, height: 3, costs: json.costs })).toThrow(/needs 9/)

    const a = await navApp()
    const w = a.world
    const ref = w.resource(NavGridDatas).add(data, 'room')
    w.spawn(
      [NavGrid, { source: 'data', data: ref, cellSize: [2, 2], origin: [-3, -2] }],
      [Transform, { translation: [1, 1, 0] }],
    )
    frames(a, 1)
    // Cell (1, 0) is blocked: from cell (0, 0) to (2, 0) goes up through row 1.
    const path = findPath(w, [-1, 0, 0], [3, 0, 0])
    expect(path.status).toBe('complete')
    expect(path.count).toBeGreaterThan(2)
    const hit = { t: 1, point: new Float64Array(3), normal: new Float64Array(3) }
    expect(navRaycast(w, [-1, 0, 0], [3, 0, 0], hit)).toBe(true)
    expect(hit.point[0]).toBeCloseTo(0, 5)
    expect(hit.normal[0]).toBe(-1)
    const near = [0, 0, 0]
    // (1, 0) is in the blocked cell: the nearest walkable cell centers are one cell (2 m) away.
    expect(nearestPoint(w, [1, 0, 0], near)).toBe(true)
    expect(Math.hypot(near[0]! - 1, near[1]!)).toBeCloseTo(2, 5)
  })
})

describe('errors and the grid-only plugin', () => {
  it('says why there is nothing to query', async () => {
    const a = await navApp()
    const err = (() => {
      try {
        findPath(a.world, [0, 0, 0], [1, 0, 0])
      } catch (e) {
        return e as ShardError
      }
    })()
    expect(err).toBeInstanceOf(ShardError)
    expect(err!.code).toBe('nav/no-navmesh')
    slab(a.world, 0, 0, 5, 5, 0)
    a.world.spawn([NavMesh, { tileSize: 32 }])
    frames(a, 2)
    expect(() => findPath(a.world, [50, 0, 0], [0, 0, 0])).toThrow(
      expect.objectContaining({ code: 'nav/out-of-bounds' }),
    )
  })

  it('does grids without loading Recast, and reports navmeshes it cannot build', async () => {
    const a = new App().addPlugin(TransformPlugin, navGridPlugin)
    await a.init()
    const w = a.world
    const ref = w.resource(NavGridDatas).add(new NavGridData(4, 4))
    w.spawn([NavGrid, { source: 'data', data: ref }], [Transform, {}])
    w.spawn([NavMesh, {}])
    frames(a, 1)
    expect(w.resource(Nav).R).toBeNull()
    expect(findPath(w, [0.5, 0.5, 0], [3.5, 3.5, 0]).status).toBe('complete')
    const d = describeNav(w)
    expect(d.recast).toBe(false)
    expect(d.meshes[0]!.problem).toMatch(/nav\/no-navmesh/)
  })
})

describe('methods', () => {
  it('nav.path, nav.describe, and nav.bake', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 10, 10, 0)
    w.spawn([NavMesh, { tileSize: 32 }])
    frames(a, 2)
    const ctx = { app: a, world: w }
    const path = (await method('nav.path').handler(ctx, { from: [-5, 0, -5], to: [5, 0, 5] })) as {
      status: string
      corners: number[][]
    }
    expect(path.status).toBe('complete')
    expect(path.corners.length).toBe(2)

    const d = (await method('nav.describe').handler(ctx, {})) as ReturnType<typeof describeNav>
    expect(d.meshes[0]!.tiles).toBeGreaterThan(0)
    expect(d.sources.triangles).toBe(12)

    // A bake with nothing changed keeps every tile; a forced one rebuilds them all.
    const kept = (await method('nav.bake').handler(ctx, { save: false })) as {
      meshes: { built: number; kept: number; tiles: number }[]
    }
    expect(kept.meshes[0]!.built).toBe(0)
    const forced = (await method('nav.bake').handler(ctx, {
      save: false,
      force: true,
    })) as typeof kept
    expect(forced.meshes[0]!.built).toBe(forced.meshes[0]!.tiles)

    // Saving writes the tiles through the connected file system.
    const files = new Map<string, Uint8Array>()
    const cache = w.resource(NavCache)
    cache.fs = {
      writable: true,
      readText: async () => '',
      readBytes: async (p) => files.get(p)!,
      writeText: async () => {},
      writeBytes: async (p, b) => void files.set(p, b),
      exists: async (p) => files.has(p),
    }
    const saved = (await method('nav.bake').handler(ctx, {})) as {
      saved: { file: string; bytes: number }
    }
    expect(saved.saved.file).toBe('.shard/cache/nav/tiles.bin')
    expect(files.get('.shard/cache/nav/tiles.bin')!.length).toBe(saved.saved.bytes)
  })
})
