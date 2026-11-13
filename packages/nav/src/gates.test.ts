import type { Entity, World } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { navBake, updateNavigation } from './bake'
import { NavFilters, NavMesh } from './components'
import type { NavMeshRuntime } from './navmesh'
import { findPath } from './query'
import { GATE_CLOSED, GATE_LOCKED } from './recast'
import { Nav } from './state'
import { frames, navApp } from './test-level'

// Shapes, gates and filters (0112): sources without entities, polygons whose flags change at
// runtime, and named filters that decide who passes.

/** 12 triangles of an axis-aligned box, world space. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const c = [
    [x0, y0, z0],
    [x1, y0, z0],
    [x1, y0, z1],
    [x0, y0, z1],
    [x0, y1, z0],
    [x1, y1, z0],
    [x1, y1, z1],
    [x0, y1, z1],
  ]
  // Recast takes a face as walkable when (v1 − v0) × (v2 − v0) points up: the top's must.
  const faces = [
    [0, 1, 2, 0, 2, 3],
    [4, 6, 5, 4, 7, 6],
    [0, 1, 5, 0, 5, 4],
    [1, 2, 6, 1, 6, 5],
    [2, 3, 7, 2, 7, 6],
    [3, 0, 4, 3, 4, 7],
  ]
  const out: number[] = []
  for (const f of faces) for (const i of f) out.push(...c[i]!)
  return out
}

const shape = (...boxes: number[][]) => new Float32Array(boxes.flat())

const FLOOR = 1 as Entity
const WALL = 2 as Entity
const DOOR = 3 as Entity
const WINDOW_WALL = 4 as Entity
const WINDOW = 5 as Entity

/**
 * Two rooms on a 20 × 10 m floor, split at x = 0 by a 0.2 m wall with a 1 m doorway over
 * z ∈ [4.5, 5.5], and a door gate in it. 0.1 m cells, so a 0.3 m agent fits through.
 */
async function rooms() {
  const app = await navApp()
  const world = app.world
  world.spawn([
    NavMesh,
    { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 },
  ])
  world.insertResource(NavFilters, {
    survivor: { exclude: ['locked'] },
    zombie: { exclude: ['closed', 'locked'] },
  })
  const nav = world.resource(Nav)
  nav.shapes.set(FLOOR, shape(box(-10, -0.2, 0, 10, 0, 10)))
  nav.shapes.set(WALL, shape(box(-0.1, 0, 0, 0.1, 3, 4.5), box(-0.1, 0, 5.5, 0.1, 3, 10)))
  nav.gates.set(DOOR, {
    points: [
      [-0.3, 4.5],
      [0.3, 4.5],
      [0.3, 5.5],
      [-0.3, 5.5],
    ],
    yMin: -0.5,
    yMax: 0.5,
    area: 10,
  })
  frames(app, 2)
  return { app, world, nav, rt: [...nav.meshes.values()][0]! }
}

function status(world: World, filter?: string) {
  return findPath(world, [-5, 0, 5], [5, 0, 5], { filter }).status
}

/** Tile keys by tile, to compare navmeshes. */
const keys = (rt: NavMeshRuntime) =>
  new Map([...rt.tiles.values()].map((t) => [`${t.tx},${t.ty}`, t.key]))

describe('nav gates and filters', () => {
  it('lets each filter through a door by its state, rebuilding nothing', async () => {
    const { app, world, nav, rt } = await rooms()
    expect(rt.gatePolygons(DOOR)).toBeGreaterThan(0)
    expect(status(world)).toBe('complete')
    expect(status(world, 'survivor')).toBe('complete')
    expect(status(world, 'zombie')).toBe('complete')
    const built = rt.stats.totalBuilt
    const bakes = rt.stats.bakes

    // The toggle's whole navmesh work: the gate's polygons' flags, nothing baked.
    nav.gates.setFlags(DOOR, GATE_CLOSED)
    const t0 = performance.now()
    updateNavigation(world, world.tick)
    expect(performance.now() - t0).toBeLessThan(budget('nav/gate'))
    frames(app, 1)
    expect(status(world)).toBe('complete')
    expect(status(world, 'survivor')).toBe('complete')
    expect(status(world, 'zombie')).toBe('partial')

    nav.gates.setFlags(DOOR, GATE_CLOSED | GATE_LOCKED)
    frames(app, 1)
    expect(status(world, 'survivor')).toBe('partial')
    expect(status(world, 'zombie')).toBe('partial')

    nav.gates.setFlags(DOOR, 0)
    frames(app, 1)
    expect(status(world, 'zombie')).toBe('complete')
    expect(rt.stats.totalBuilt).toBe(built)
    expect(rt.stats.bakes).toBe(bakes)
  })

  it('throws nav/unknown-filter for a filter nav/Filters lacks', async () => {
    const { world } = await rooms()
    expect(() => status(world, 'ghost')).toThrow(/nav\/unknown-filter|No navmesh filter/)
  })

  it('opens a link gate by its state', async () => {
    const { app, world, nav } = await rooms()
    // A solid wall at x = 5 (no doorway), and a link across it at z = 2.
    nav.shapes.set(WINDOW_WALL, shape(box(4.9, 0, 0, 5.1, 3, 10)))
    nav.gates.set(WINDOW, {
      link: { start: [4.4, 0, 2], end: [5.6, 0, 2], radius: 0.4 },
      area: 11,
      flags: GATE_LOCKED,
    })
    frames(app, 2)
    const across = (filter?: string) => findPath(world, [2, 0, 2], [8, 0, 2], { filter }).status
    expect(across()).toBe('complete')
    expect(across('survivor')).toBe('partial')
    nav.gates.setFlags(WINDOW, 0)
    frames(app, 1)
    expect(across('survivor')).toBe('complete')
  })

  it('rebuilds only the tiles whose key an edit changes, gathering only what changed', async () => {
    const { app, nav, rt } = await rooms()
    nav.shapes.set(10 as Entity, shape(box(-8, 0, 1, -7, 1, 2)))
    frames(app, 1)
    const before = keys(rt)
    // Move the crate 3 m.
    nav.shapes.set(10 as Entity, shape(box(-5, 0, 1, -4, 1, 2)))
    frames(app, 1)
    const after = keys(rt)
    let differ = 0
    for (const [tile, key] of after) if (before.get(tile) !== key) differ++
    expect(rt.stats.gathered).toBe(1)
    expect(differ).toBeGreaterThan(0)
    expect(rt.stats.built + rt.stats.cached).toBe(differ)
    expect(rt.stats.examined).toBeLessThan(after.size)

    // A navmesh baked from scratch with the result keys every tile the same.
    const fresh = await rooms()
    fresh.nav.shapes.set(10 as Entity, shape(box(-5, 0, 1, -4, 1, 2)))
    frames(fresh.app, 1)
    expect(keys(fresh.rt)).toEqual(after)
  })

  it('bakes nothing and allocates nothing on a frame where nothing changed', async () => {
    const { world, rt } = await rooms()
    const bakes = rt.stats.bakes
    const local = navBake.setup!(world)
    const step = () => {
      world.incrementTick()
      navBake.run(local, world, { lastRunTick: world.tick - 1, thisRunTick: world.tick } as never)
    }
    for (let i = 0; i < 200; i++) step()
    if (allocationChecks) {
      globalThis.gc?.()
      await new Promise((resolve) => setTimeout(resolve, 200))
      const window = gcWindow()
      for (let i = 0; i < 2000; i++) step()
      expect(await window.end()).toBe(0)
    }
    expect(rt.stats.bakes).toBe(bakes)
  })
})
