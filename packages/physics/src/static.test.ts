import type { Entity } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { Collider, CollisionEvent, RigidBody, Velocity } from './components'
import { Physics, physics3dPlugin } from './plugin'
import { createRayHit } from './world'

// Owned static collider sets (0112): colliders without components that report their owner.

async function app(): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, physics3dPlugin())
  await a.init()
  return a
}

describe('owned static colliders', () => {
  it('answers queries with its owner, turns off without a rebuild, and goes away', async () => {
    const a = await app()
    const physics = a.world.resource(Physics)
    const owner = a.world.spawn() as Entity
    // A 4 m wall along +x turned 90° about +y: it now runs along z, 0.1 m either side of x = 2.
    physics.setStatic(owner, [
      { kind: 'cuboid', center: [2, 1, 0], halfExtents: [2, 1, 0.1], yaw: Math.PI / 2 },
    ])
    a.update(1 / 60)
    const hit = createRayHit()
    expect(physics.raycast([0, 1, 1.5], [1, 0, 0], undefined, hit)).toBe(true)
    expect(hit.entity).toBe(owner)
    expect(hit.body).toBe(-1)
    expect(hit.distance).toBeCloseTo(1.9, 4)
    expect(physics.describe().static).toEqual({ sets: 1, colliders: 1, disabled: 0 })

    physics.enableStatic(owner, false)
    a.update(1 / 60)
    expect(physics.raycast([0, 1, 1.5], [1, 0, 0], undefined, hit)).toBe(false)
    expect(physics.describe().static.disabled).toBe(1)
    // Replacing the shapes keeps it off.
    physics.setStatic(owner, [{ kind: 'cuboid', center: [2, 1, 0], halfExtents: [0.1, 1, 2] }])
    expect(physics.isStaticEnabled(owner)).toBe(false)
    physics.enableStatic(owner, true)
    a.update(1 / 60)
    expect(physics.raycast([0, 1, 1.5], [1, 0, 0], undefined, hit)).toBe(true)

    physics.clearStatic(owner)
    a.update(1 / 60)
    expect(physics.raycast([0, 1, 1.5], [1, 0, 0], undefined, hit)).toBe(false)
    expect(physics.describe().static).toEqual({ sets: 0, colliders: 0, disabled: 0 })
  })

  it('holds up bodies and reports collisions with its owner', async () => {
    const a = await app()
    const world = a.world
    const physics = world.resource(Physics)
    const floor = world.spawn() as Entity
    // A trimesh floor (two triangles over 10 × 10 m at y = 0) and a convex block on it.
    physics.setStatic(floor, [
      {
        kind: 'trimesh',
        positions: new Float32Array([-5, 0, -5, 5, 0, -5, 5, 0, 5, -5, 0, 5]),
        indices: new Uint32Array([0, 2, 1, 0, 3, 2]),
      },
    ])
    const block = world.spawn() as Entity
    const p: number[] = []
    for (const x of [2, 3]) for (const y of [0, 1]) for (const z of [-1, 1]) p.push(x, y, z)
    physics.setStatic(block, [{ kind: 'convex', points: new Float32Array(p) }])
    const ball = world.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'ball', radius: 0.5, events: true }],
      [Velocity, {}],
      [Transform, { translation: [0, 3, 0] }],
    )
    const reader = world.reader(CollisionEvent)
    const hits: Entity[] = []
    for (let i = 0; i < 120; i++) {
      a.update(1 / 60)
      for (const e of reader.read()) if (e.kind === 'started') hits.push(e.a === ball ? e.b : e.a)
    }
    expect(world.get(ball, Transform).translation[1]).toBeCloseTo(0.5, 1)
    expect(hits).toEqual([floor])
    const hit = createRayHit()
    expect(physics.raycast([0, 0.5, 0], [1, 0, 0], { exclude: ball }, hit)).toBe(true)
    expect(hit.entity).toBe(block)
    expect(hit.distance).toBeCloseTo(2, 4)
  })

  it('moves with an origin shift', async () => {
    const a = await app()
    const physics = a.world.resource(Physics)
    const owner = a.world.spawn() as Entity
    physics.setStatic(owner, [{ kind: 'cuboid', center: [10, 0, 0], halfExtents: [1, 1, 1] }])
    physics.shiftOrigin(-10, 0, 0, () => {})
    const hit = createRayHit()
    expect(physics.raycast([-3, 0, 0], [1, 0, 0], undefined, hit)).toBe(true)
    expect(hit.distance).toBeCloseTo(2, 4)
  })
})
