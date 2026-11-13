import type { Entity, World } from '@aethervtt/shard-core'
import { navPlugin } from '@aethervtt/shard-nav'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { App } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { Backdrop, Level, Wall } from './components'
import { StructureNav, structureNavPlugin } from './nav'
import { StructureColliders, structurePhysicsPlugin } from './physics'
import { town } from './town'

// structure/Backdrop (0113): drawn, not solid. A streamed cell's far level marks its shells with it.

const DT = 1 / 60

async function headless(): Promise<App> {
  const app = new App().addPlugin(
    TransformPlugin,
    physics3dPlugin(),
    navPlugin,
    structurePhysicsPlugin,
    structureNavPlugin,
  )
  await app.init()
  return app
}

function frames(app: App, n = 1): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

const solid = (world: World, e: Entity) => ({
  collider: world.resource(StructureColliders).owners.has(e),
  nav: world.resource(StructureNav).shapes.has(e),
})

describe('structure/Backdrop', () => {
  it('takes a wall, its openings and everything on a backdrop level out of physics and nav', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: 2 })
    const [a, b] = t.buildings as [(typeof t.buildings)[0], (typeof t.buildings)[0]]
    frames(app, 2)
    expect(solid(world, a.front)).toEqual({ collider: true, nav: true })
    const door = a.doors[0]!
    expect(world.resource(StructureColliders).owners.has(door)).toBe(true)
    expect(world.resource(StructureNav).gates.has(door)).toBe(true)

    // One wall: its colliders, its nav shape and its door's collider and gate go.
    world.add(a.front, Backdrop, {})
    frames(app, 2)
    expect(solid(world, a.front)).toEqual({ collider: false, nav: false })
    expect(world.resource(StructureColliders).owners.has(door)).toBe(false)
    expect(world.resource(StructureNav).gates.has(door)).toBe(false)
    expect(solid(world, a.back)).toEqual({ collider: true, nav: true })

    // And back.
    world.remove(a.front, Backdrop)
    frames(app, 2)
    expect(solid(world, a.front)).toEqual({ collider: true, nav: true })
    expect(world.resource(StructureNav).gates.has(door)).toBe(true)

    // A whole building, through its level.
    const level = world.spawn([Level, {}])
    for (const w of b.walls) world.add(w, Wall, { ...world.get(w, Wall), level })
    frames(app, 2)
    expect(b.walls.every((w) => solid(world, w).collider)).toBe(true)
    world.add(level, Backdrop, {})
    frames(app, 2)
    expect(b.walls.some((w) => solid(world, w).collider || solid(world, w).nav)).toBe(false)
    expect(solid(world, a.back)).toEqual({ collider: true, nav: true })
    world.remove(level, Backdrop)
    frames(app, 2)
    expect(b.walls.every((w) => solid(world, w).collider && solid(world, w).nav)).toBe(true)
    app.dispose()
  })
})
