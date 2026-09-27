import type { Entity, World } from '@aethervtt/shard-core'
import { Collider } from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { NavCache } from './cache'
import { NavAgent, NavAgentState, NavMesh, NavSource, OffMeshLink } from './components'
import { createNavPath, findPath, navRaycast, nearestPoint } from './query'
import { Nav } from './state'
import { frames, level, navApp, slab } from './test-level'

const DT = 1 / 60

function navmesh(world: World, fields: Record<string, unknown> = {}): Entity {
  return world.spawn([NavMesh, { tileSize: 32, ...fields }])
}

describe('navmesh bake', () => {
  it('connects both floors through the ramp and leaves out a slope past maxSlope', async () => {
    const a = await navApp()
    const w = a.world
    const { upper, steep } = level(w)
    const mesh = navmesh(w)
    frames(a, 2)
    const rt = w.resource(Nav).meshes.get(mesh)!
    expect(rt.problem).toBeNull()
    expect(rt.polygons()).toBeGreaterThan(0)

    const path = findPath(w, [0, 0, 10], upper)
    expect(path.status).toBe('complete')
    expect(path.nav).toBe(mesh)
    const last = path.corners.subarray((path.count - 1) * 3, path.count * 3)
    expect(last[1]).toBeCloseTo(3, 0)
    // It turns at the ramp's foot (x 4.5..7.5, z ≈ -2) on the way up.
    let foot = false
    for (let i = 1; i < path.count - 1; i++) {
      const [x, y, z] = path.corners.subarray(i * 3, i * 3 + 3)
      if (x! > 4 && x! < 8 && y! < 1 && Math.abs(z! + 2) < 1.5) foot = true
    }
    expect(foot).toBe(true)
    expect(path.length).toBeGreaterThan(Math.hypot(6, 3, 22))

    // The 60° ramp isn't walkable: its surface has no navmesh, its platform no way up.
    const out = [0, 0, 0]
    expect(nearestPoint(w, [-8, 1.5, -6.9], out)).toBe(true)
    expect(Math.abs(out[1]! - 1.5)).toBeGreaterThan(0.5)
    const up = findPath(w, [0, 0, 10], steep)
    expect(up.status).toBe('partial')
  })

  it('raycasts along the mesh and stops at walls', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 10, 10, 0)
    // A wall across x = 3 from z = -10 to 5.
    w.spawn(
      [NavSource, {}],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 2, 7.5] }],
      [Transform, { translation: [3, 1.5, -2.5] }],
    )
    navmesh(w)
    frames(a, 2)
    const hit = { t: 1, point: new Float64Array(3), normal: new Float64Array(3) }
    expect(navRaycast(w, [0, 0, 0], [8, 0, 0], hit)).toBe(true)
    expect(hit.point[0]).toBeLessThan(3)
    expect(hit.point[0]).toBeGreaterThan(1.5)
    expect(hit.normal[0]).toBeLessThan(-0.5)
    expect(navRaycast(w, [0, 0, 7], [8, 0, 7], hit)).toBe(false)
    expect(hit.t).toBe(1)
  })
})

describe('navmesh tile cache', () => {
  it('loads a warm bake from the cache without running Recast', async () => {
    const cold = await navApp()
    level(cold.world)
    const m1 = navmesh(cold.world)
    frames(cold, 2)
    const rt1 = cold.world.resource(Nav).meshes.get(m1)!
    expect(rt1.stats.totalBuilt).toBeGreaterThan(0)
    const file = cold.world.resource(NavCache).encode()

    const warm = await navApp()
    warm.world.resource(NavCache).decode(file)
    level(warm.world)
    const m2 = navmesh(warm.world)
    frames(warm, 2)
    const rt2 = warm.world.resource(Nav).meshes.get(m2)!
    expect(rt2.stats.totalBuilt).toBe(0)
    expect(rt2.stats.totalCached).toBe(rt1.tiles.size)
    expect(rt2.polygons()).toBe(rt1.polygons())
    expect(findPath(warm.world, [0, 0, 10], [6, 3, -12]).status).toBe('complete')
  })

  it('rebuilds only the tiles a moved source touches', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 20, 20, 0)
    const rock = w.spawn(
      [NavSource, {}],
      [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
      [Transform, { translation: [3.2, 0.5, 3.2] }],
    )
    const mesh = navmesh(w)
    frames(a, 2)
    const rt = w.resource(Nav).meshes.get(mesh)!
    const tiles = rt.tiles.size
    expect(tiles).toBeGreaterThan(16)
    const bakes = rt.stats.bakes
    // Nothing changed: no bake at all.
    frames(a, 3)
    expect(rt.stats.bakes).toBe(bakes)

    w.set(rock, Transform, { translation: [4.2, 0.5, 3.2] })
    frames(a, 2)
    expect(rt.stats.bakes).toBe(bakes + 1)
    // The rock (plus the agent-radius border) touches at most a 2 × 2 block of 6.4 m tiles.
    expect(rt.stats.built).toBeGreaterThan(0)
    expect(rt.stats.built).toBeLessThanOrEqual(4)
    expect(rt.stats.kept).toBe(tiles - rt.stats.built)
  })
})

describe('off-mesh links', () => {
  it('lets an agent reach a platform it could not walk to', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 5, 5, 0) // x -5..5
    slab(w, 12, 0, 5, 5, 0) // x 7..17: a 2 m gap
    const mesh = navmesh(w)
    frames(a, 2)
    expect(findPath(w, [0, 0, 0], [12, 0, 0]).status).toBe('partial')

    const far = w.spawn([Transform, { translation: [8, 0, 0] }])
    w.spawn([OffMeshLink, { to: far, radius: 0.6 }], [Transform, { translation: [4, 0, 0] }])
    frames(a, 2)
    const path = findPath(w, [0, 0, 0], [12, 0, 0], { out: createNavPath() })
    expect(path.status).toBe('complete')
    expect(path.nav).toBe(mesh)

    const agent = w.spawn(
      [NavAgent, { destination: [12, 0, 0], drive: 'transform', speed: 4 }],
      [Transform, { translation: [0, 0, 0] }],
    )
    let arrived = false
    for (let i = 0; i < 600 && !arrived; i++) {
      a.update(DT)
      arrived = w.get(agent, NavAgentState).status === 'arrived'
    }
    expect(arrived).toBe(true)
    const p = w.get(agent, Transform).translation
    expect(Math.hypot(p[0] - 12, p[2])).toBeLessThan(0.5)
  })
})
