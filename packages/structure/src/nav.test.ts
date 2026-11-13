import type { World } from '@aethervtt/shard-core'
import { allocationChecks, budget, gcWindow } from '@aethervtt/shard-core/test-env'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  findPath,
  Nav,
  NavAgent,
  NavAgentState,
  NavFilters,
  NavMesh,
  type NavMeshRuntime,
  navBake,
  navPlugin,
  navReady,
} from '@aethervtt/shard-nav'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { forwardPlugin, renderPlugin } from '@aethervtt/shard-render'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { Cutout, Floor, Opening, Wall } from './components'
import { StructureModel, syncStructure, syncStructureFixed } from './model'
import {
  StructureNav,
  structureNavFixed,
  structureNavPlugin,
  structureNav as structureNavSystem,
} from './nav'
import { structureColliders, structurePhysicsPlugin } from './physics'
import { structurePlugin } from './plugin'
import { BACK_ROOM, building, ground, OUTSIDE } from './test-building'
import { town } from './town'

// Structure as a nav source (0112), headless: no render plugin, no GPU (except render parity).

const DT = 1 / 60
/** 0.1 m cells, so a 1 m door fits a 0.3 m agent (0.2 m cells shut it, see 0112). */
const MESH = { cellSize: 0.1, cellHeight: 0.1, tileSize: 64, agentRadius: 0.3, agentHeight: 1.8 }
const FILTERS = {
  survivor: { exclude: ['locked' as const] },
  zombie: { exclude: ['closed' as const, 'locked' as const], areas: { 11: 0 } },
}

async function headless(extra: Parameters<App['addPlugin']> = []): Promise<App> {
  const app = new App().addPlugin(TransformPlugin, navPlugin, structureNavPlugin, ...extra)
  await app.init()
  app.world.insertResource(NavFilters, FILTERS)
  return app
}

function frames(app: App, n = 1): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

const runtime = (world: World): NavMeshRuntime => [...world.resource(Nav).meshes.values()][0]!

/** Tile keys by tile. */
const keys = (rt: NavMeshRuntime) =>
  new Map([...rt.tiles.values()].map((t) => [`${t.tx},${t.ty}`, t.key]))

function status(world: World, filter?: string) {
  return findPath(world, OUTSIDE, BACK_ROOM, { filter }).status
}

describe('structure nav sources', () => {
  it('lets each filter through a door by its state, re-baking nothing', async () => {
    const app = await headless()
    const world = app.world
    ground(world)
    const { door } = building(world)
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    const rt = runtime(world)
    expect(rt.gatePolygons(door)).toBeGreaterThan(0)
    const built = rt.stats.totalBuilt
    const bakes = rt.stats.bakes
    const toggle = (state: 'open' | 'closed' | 'locked') => {
      world.set(door, Opening, { state })
      frames(app)
    }

    // Doors are closed by default.
    expect([status(world), status(world, 'survivor'), status(world, 'zombie')]).toEqual([
      'complete',
      'complete',
      'partial',
    ])
    toggle('open')
    expect([status(world), status(world, 'survivor'), status(world, 'zombie')]).toEqual([
      'complete',
      'complete',
      'complete',
    ])
    toggle('locked')
    expect([status(world, 'survivor'), status(world, 'zombie')]).toEqual(['partial', 'partial'])
    toggle('closed')
    expect(rt.stats.totalBuilt).toBe(built)
    expect(rt.stats.bakes).toBe(bakes)
    expect(world.resource(StructureNav).last).toMatchObject({ shapes: 0, gates: 0, flags: 1 })

    // Crowd agents path the same way: the survivor walks in, the zombie can't.
    const agent = (filter: string) =>
      world.spawn(
        [NavAgent, { destination: BACK_ROOM, filter, drive: 'transform', speed: 4, radius: 0.3 }],
        [Transform, { translation: OUTSIDE }],
      )
    // One at a time: a zombie waiting at the door would only be in the survivor's way.
    const survivor = agent('survivor')
    frames(app, 400)
    expect(world.get(survivor, NavAgentState).status).toBe('arrived')
    world.despawn(survivor)
    const zombie = agent('zombie')
    frames(app, 400)
    expect(world.get(zombie, NavAgentState).status).toBe('unreachable')
  })

  it('sends zombies through a second door while the first is shut', async () => {
    const app = await headless()
    const world = app.world
    ground(world)
    const { sideDoor } = building(world, true)
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    expect(status(world, 'zombie')).toBe('partial')
    world.set(sideDoor!, Opening, { state: 'open' })
    frames(app)
    const path = findPath(world, OUTSIDE, BACK_ROOM, { filter: 'zombie' })
    expect(path.status).toBe('complete')
    // Around the building to the side door at x = 8.
    let east = -Infinity
    for (let i = 0; i < path.count; i++) east = Math.max(east, path.corners[i * 3]!)
    expect(east).toBeGreaterThan(8)
  })

  it('passes windows only when passable, and keeps people off open hatches', async () => {
    const app = await headless()
    const world = app.world
    ground(world)
    // A closed room (no door) with a window on its front wall over x ∈ [1, 2].
    const front = world.spawn([Wall, { a: [0, 0], b: [4, 0] }])
    world.spawn([Wall, { a: [4, 0], b: [4, 4] }])
    world.spawn([Wall, { a: [4, 4], b: [0, 4] }])
    world.spawn([Wall, { a: [0, 4], b: [0, 0] }])
    const window = world.spawn([
      Opening,
      { wall: front, kind: 'window', offset: 1, width: 1, sill: 0.9, height: 1.2 },
    ])
    // A raised floor east of it with a hatch in the middle.
    const deck = world.spawn([
      Floor,
      {
        points: [
          [8, 0],
          [12, 0],
          [12, 4],
          [8, 4],
        ],
        elevation: 0.2,
      },
    ])
    const hatch = world.spawn([
      Cutout,
      {
        host: deck,
        kind: 'hatch',
        points: [
          [9.5, 1.5],
          [10.5, 1.5],
          [10.5, 2.5],
          [9.5, 2.5],
        ],
      },
    ])
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    const built = runtime(world).stats.totalBuilt
    const inside = (filter?: string) => findPath(world, [1.5, 0, -2], [2, 0, 2], { filter }).status
    expect(inside('survivor')).toBe('partial')
    world.set(window, Opening, { movement: 'none' })
    frames(app)
    expect(inside('survivor')).toBe('complete')
    expect(inside('zombie')).toBe('partial')

    // Across the deck, over the hatch: straight while it's shut, around the hole while it's open.
    const across = () => findPath(world, [8.5, 0.2, 2], [11.5, 0.2, 2], { filter: 'survivor' })
    expect(across().status).toBe('complete')
    expect(across().length).toBeLessThan(3.05)
    world.set(hatch, Cutout, { state: 'open' })
    frames(app)
    expect(across().status).toBe('complete')
    // Round the hole's edge: excluded polygons aren't eroded, so the path hugs them.
    expect(across().length).toBeGreaterThan(3.2)
    expect(runtime(world).stats.totalBuilt).toBe(built)
  })

  it('re-bakes only the tiles a wall edit changes, gathering only the walls edited', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: 12 })
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    const rt = runtime(world)
    const check = (edit: () => void, walls: number) => {
      const before = keys(rt)
      const s0 = { ...rt.stats }
      edit()
      // NavBudget paces the rebuild: frames until every touched tile is in.
      frames(app)
      const gathered = rt.stats.gathered
      const editMs = world.resource(StructureModel).last.ms + world.resource(StructureNav).last.ms
      let n = 1
      for (; n < 20 && !navReady(world); n++) frames(app)
      expect(navReady(world)).toBe(true)
      expect(n).toBeLessThanOrEqual(budget('nav/edit-frames'))
      expect(editMs).toBeLessThan(budget('structure/edit'))
      const after = keys(rt)
      let differ = 0
      for (const [tile, key] of after) if (before.get(tile) !== key) differ++
      for (const tile of before.keys()) if (!after.has(tile)) differ++
      const landed =
        rt.stats.totalBuilt -
        s0.totalBuilt +
        rt.stats.totalCached -
        s0.totalCached +
        rt.stats.totalRemoved -
        s0.totalRemoved
      expect(gathered).toBe(walls)
      expect(landed).toBe(differ)
      expect(rt.stats.totalExamined - s0.totalExamined).toBeLessThan(after.size / 4)
      return after
    }
    // Add a wall, remove one, split one (with its door) into two.
    check(() => world.spawn([Wall, { a: [2, 2], b: [2, 9] }]), 1)
    check(() => world.despawn(t.buildings[4]!.back), 1)
    const b = t.buildings[7]!
    const [x0, z0, x1] = b.bounds
    const door = b.doors[0]!
    const mid = x0 + world.get(door, Opening).offset + 1.5
    const after = check(() => {
      world.despawn(b.front)
      const left = world.spawn([Wall, { a: [x0, z0], b: [mid, z0] }])
      world.spawn([Wall, { a: [mid, z0], b: [x1, z0] }])
      world.set(door, Opening, { wall: left })
    }, 3)

    // A navmesh baked from scratch on the result keys every tile the same.
    const fresh = await headless()
    const t2 = town(fresh.world, { buildings: 12 })
    fresh.world.spawn([Wall, { a: [2, 2], b: [2, 9] }])
    fresh.world.despawn(t2.buildings[4]!.back)
    const b2 = t2.buildings[7]!
    fresh.world.despawn(b2.front)
    const left2 = fresh.world.spawn([Wall, { a: [x0, z0], b: [mid, z0] }])
    fresh.world.spawn([Wall, { a: [mid, z0], b: [x1, z0] }])
    fresh.world.set(b2.doors[0]!, Opening, { wall: left2 })
    fresh.world.spawn([NavMesh, MESH])
    frames(fresh, 3)
    expect(keys(runtime(fresh.world))).toEqual(after)
  })

  it('opens every door of a town to the agents it fits', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: 20 })
    for (const b of t.buildings) for (const d of b.doors) world.set(d, Opening, { state: 'open' })
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    // Straight through each door: from 1.5 m off one face of its wall to 1.5 m off the other.
    for (const b of t.buildings) {
      for (const door of b.doors) {
        const o = world.get(door, Opening)
        const wall = world.get(o.wall!, Wall)
        const [ax, az] = wall.a
        const [bx, bz] = wall.b
        const len = Math.hypot(bx! - ax!, bz! - az!)
        const tx = (bx! - ax!) / len
        const tz = (bz! - az!) / len
        const s = o.offset + o.width / 2
        const x = ax! + tx * s
        const z = az! + tz * s
        const p = findPath(world, [x + tz * 1.5, 0, z - tx * 1.5], [x - tz * 1.5, 0, z + tx * 1.5])
        expect(p.status, `door ${door}`).toBe('complete')
        expect(p.length, `door ${door}`).toBeLessThan(3.3)
      }
    }
    expect(
      world
        .resource(LogResource)
        .tail(50, 'warn')
        .map((e) => e.code),
    ).not.toContain('structure/door-too-narrow')
  })

  it('warns once about a door too narrow for a navmesh', async () => {
    const app = await headless()
    const world = app.world
    ground(world)
    const { door } = building(world)
    world.spawn([NavMesh, { ...MESH, cellSize: 0.2 }])
    frames(app, 3)
    world.set(door, Opening, { width: 1.01 })
    frames(app, 2)
    const narrow = world
      .resource(LogResource)
      .tail(100, 'warn')
      .filter((e) => e.code === 'structure/door-too-narrow')
    // Both doors (front and inner), once each, though the front one changed.
    expect(narrow.length).toBe(2)
  })

  it('bakes the same tiles with structure drawing as headless', async () => {
    const gpu = await createNodeGpuContext()
    try {
      const drawn = await headless([
        renderPlugin({ gpu, windowView: false }),
        forwardPlugin({ msaa: 1 }),
        structurePlugin,
      ])
      const bare = await headless()
      for (const app of [drawn, bare]) {
        town(app.world, { buildings: 6, seed: 3 })
        app.world.spawn([NavMesh, MESH])
        frames(app, 3)
      }
      expect(keys(runtime(drawn.world)).size).toBeGreaterThan(0)
      expect(keys(runtime(drawn.world))).toEqual(keys(runtime(bare.world)))
      await drawn.dispose()
    } finally {
      gpu.destroy()
    }
  })

  it('does nothing and allocates nothing on a frame where nothing changed', async () => {
    const app = await headless([physics3dPlugin(), structurePhysicsPlugin])
    const world = app.world
    town(world, { buildings: 8 })
    world.spawn([NavMesh, MESH])
    frames(app, 3)
    const rt = runtime(world)
    const bakes = rt.stats.bakes
    const systems = [
      syncStructureFixed,
      structureColliders,
      structureNavFixed,
      syncStructure,
      structureNavSystem,
      navBake,
    ]
    const locals = systems.map((system) => (system.setup ? system.setup(world) : undefined))
    const step = () => {
      for (let i = 0; i < systems.length; i++) {
        world.incrementTick()
        systems[i]!.run(locals[i] as never, world, {
          lastRunTick: world.tick - 1,
          thisRunTick: world.tick,
        } as never)
      }
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
