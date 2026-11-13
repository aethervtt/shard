import type { Entity } from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import { NavFilters, NavMesh } from './components'
import { findPath } from './query'
import { GATE_CLOSED, GATE_LOCKED, GATE_SOLID, SHUT_AREA } from './recast'
import { NavGates } from './sources'
import { Nav } from './state'
import { box, frames, navApp, shape, slab } from './test-level'

// Breaching (0114) with nav's own shapes and gates, no structure: shut areas, plan and walk
// filters, solid gates, and the checks on filters, gates and areas.

const FLOOR = 1 as Entity
const WALL = 2 as Entity
const DOOR = 3 as Entity

/** Two rooms split at x = 0 by a wall with a 1 m door gate over z ∈ [4.5, 5.5], 0.6 m deep. */
async function rooms() {
  const app = await navApp()
  const world = app.world
  world.spawn([
    NavMesh,
    { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 },
  ])
  world.insertResource(NavFilters, {
    survivor: { exclude: ['locked'] },
    zombie: { breach: ['closed', 'locked'], breachCost: 12 },
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
    flags: GATE_CLOSED,
  })
  frames(app, 2)
  return { app, world, nav, rt: [...nav.meshes.values()][0]! }
}

const across = (world: Parameters<typeof findPath>[0], filter?: string) =>
  findPath(world, [-5, 0, 5], [5, 0, 5], { filter })

describe('breaching gates (0114)', () => {
  it('measures how agents cross a gate: its axis, depth and width', () => {
    const gates = new NavGates()
    const points = [
      [-0.7, 4],
      [0.7, 4],
      [0.7, 5],
      [-0.7, 5],
    ]
    // Across its least width by default: here along z (1 m), not x (1.4 m).
    const shape = (e: Entity) => {
      const g = gates.byOwner.get(e)!
      return [g.mx, g.mz, Math.abs(g.ax), Math.abs(g.az), g.depth, g.halfWidth].map(
        (v) => Math.round(v * 1000) / 1000 + 0,
      )
    }
    gates.set(DOOR, { points, area: 10 })
    expect(shape(DOOR)).toEqual([0, 4.5, 0, 1, 1, 0.7])
    // A door is often wider than deep: its axis says which way agents cross.
    gates.set(DOOR, { points, area: 10, axis: [1, 0] })
    expect(shape(DOOR)).toEqual([0, 4.5, 1, 0, 1.4, 0.5])
    gates.set(4 as Entity, { link: { start: [0, 0, 0], end: [0, 0, 1.2], radius: 0.4 }, area: 11 })
    expect(shape(4 as Entity)).toEqual([0, 0.6, 0, 1, 1.2, 0.4])
    gates.updateDepths()
    expect(gates.depths[10]).toBeCloseTo(1.4)
    expect(gates.depths[11]).toBeCloseTo(1.2)
    expect(gates.depths[9]).toBe(1)
    expect(() => gates.set(5 as Entity, { points, area: SHUT_AREA + 1 })).toThrowError(
      expect.objectContaining({ code: 'nav/invalid-gate' }),
    )
  })

  it('plans through a shut gate at its breach cost, and walks only through an open one', async () => {
    const { app, world, nav, rt } = await rooms()
    // Shut: its polygons take the shut area. Survivors pass `closed` at no extra cost, zombies plan
    // through at 1 + 12 / 0.6 a metre, and walk (their crowd slot) through nothing shut.
    const refs = [...rt.gateRefs.get(DOOR)!.values()].flat()
    expect(refs.length).toBeGreaterThan(0)
    for (const ref of refs) expect(rt.navMesh.getPolyArea(ref).area).toBe(10 + SHUT_AREA)
    expect(rt.queryFilter('survivor').getAreaCost(10 + SHUT_AREA)).toBe(1)
    expect(rt.queryFilter('zombie').getAreaCost(10 + SHUT_AREA)).toBeCloseTo(1 + 12 / 0.6, 4)
    expect(rt.walkFilter('zombie').excludeFlags).toBe(GATE_CLOSED | GATE_LOCKED)
    expect(rt.queryFilter('zombie').excludeFlags).toBe(0)
    const p = across(world, 'zombie')
    expect(p.status).toBe('complete')
    expect(p.breach).toBe(DOOR)
    expect(across(world, 'survivor').breach).toBe(-1)

    // Open: its own area again, nothing to breach.
    nav.gates.setFlags(DOOR, 0)
    frames(app, 1)
    for (const ref of refs) expect(rt.navMesh.getPolyArea(ref).area).toBe(10)
    expect(across(world, 'zombie').breach).toBe(-1)
  })

  it('lets no filter through a solid gate, breaching or not', async () => {
    const { app, world, nav, rt } = await rooms()
    nav.gates.setFlags(DOOR, GATE_SOLID)
    frames(app, 1)
    for (const ref of [...rt.gateRefs.get(DOOR)!.values()].flat())
      expect(rt.navMesh.getPolyFlags(ref).flags).toBe(0)
    for (const filter of [undefined, 'survivor', 'zombie']) {
      const p = across(world, filter)
      expect(p.status).toBe('partial')
      expect(p.breach).toBe(-1)
    }
  })

  it('warns about a filter that both excludes and breaches a state, and leaves it out', async () => {
    const { app, world } = await rooms()
    world.insertResource(NavFilters, { odd: { exclude: ['closed'], breach: ['closed'] } })
    frames(app, 1)
    const codes = world
      .resource(LogResource)
      .tail(20, 'warn')
      .map((e) => e.code)
    expect(codes).toContain('nav/invalid-filter')
    expect(() => across(world, 'odd')).toThrowError(
      expect.objectContaining({ code: 'nav/unknown-filter' }),
    )
  })

  it("bakes a source in a shut gate's area as area 12, and warns once", async () => {
    const app = await navApp()
    const world = app.world
    world.spawn([NavMesh, { tileSize: 32 }])
    slab(world, 0, 0, 10, 10, 0, 40)
    frames(app, 3)
    const codes = world
      .resource(LogResource)
      .tail(20, 'warn')
      .map((e) => e.code)
    expect(codes.filter((c) => c === 'nav/reserved-area')).toHaveLength(1)
  })
})
