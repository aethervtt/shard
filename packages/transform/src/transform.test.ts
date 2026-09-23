import { affine, ChildOf, defineSystem, quat, Update, vec3 } from '@shard/core'
import { App } from '@shard/runtime'
import { describe, expect, it } from 'vitest'
import {
  GlobalTransform,
  lookAt,
  Transform,
  TransformPlugin,
  transform2d,
  worldPosition,
} from './transform'

async function makeApp() {
  const app = new App().addPlugin(TransformPlugin)
  await app.init()
  return app
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  for (let i = 0; i < b.length; i++) expect(a[i]).toBeCloseTo(b[i]!, 5)
}

describe('Transform', () => {
  it('brings GlobalTransform along', async () => {
    const app = await makeApp()
    const e = app.world.spawn(Transform)
    expect(app.world.has(e, GlobalTransform)).toBe(true)
  })

  it('computes world matrices for roots and nested children', async () => {
    const app = await makeApp()
    const w = app.world
    const root = w.spawn([Transform, { translation: [10, 0, 0], scale: [2, 2, 2] }])
    const child = w.spawn(
      [
        Transform,
        {
          translation: [1, 0, 0],
          rotation: quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], Math.PI / 2) as [
            number,
            number,
            number,
            number,
          ],
        },
      ],
      [ChildOf, { parent: root }],
    )
    const grandchild = w.spawn(
      [Transform, { translation: [0, 0, -1] }],
      [ChildOf, { parent: child }],
    )
    app.update(1 / 60)
    close(worldPosition(w, root), [10, 0, 0])
    close(worldPosition(w, child), [12, 0, 0])
    // Child is rotated 90° around Y, so its -Z points at world -X; scale 2 from the root.
    close(worldPosition(w, grandchild), [10, 0, 0])
  })

  it('updates on change and on reparenting, and leaves unchanged entities alone', async () => {
    const app = await makeApp()
    const w = app.world
    const a = w.spawn([Transform, { translation: [1, 0, 0] }])
    const b = w.spawn([Transform, { translation: [0, 5, 0] }])
    const child = w.spawn([Transform, { translation: [0, 0, 1] }], [ChildOf, { parent: a }])
    const still = w.spawn([Transform, { translation: [7, 7, 7] }])
    app.update(1 / 60)

    const tickOf = (e: number) => w.entityTable(e).changedTicks(GlobalTransform)[w.entityRow(e)]!
    const stillTick = tickOf(still)

    w.set(a, Transform, { translation: [2, 0, 0] })
    app.update(1 / 60)
    close(worldPosition(w, child), [2, 0, 1])
    expect(tickOf(still)).toBe(stillTick)

    w.set(child, ChildOf, { parent: b })
    app.update(1 / 60)
    close(worldPosition(w, child), [0, 5, 1])

    w.remove(child, ChildOf)
    app.update(1 / 60)
    close(worldPosition(w, child), [0, 0, 1])
  })

  it('lets systems that run after propagation see current matrices', async () => {
    const app = await makeApp()
    const seen: number[][] = []
    const e = app.world.spawn([Transform, { translation: [3, 0, 0] }])
    app.addSystems(
      Update,
      defineSystem({
        name: 'test/mover',
        run: (_, world) => world.set(e, Transform, { translation: [4, 0, 0] }),
      }),
    )
    app.update(1 / 60)
    seen.push(worldPosition(app.world, e))
    expect(seen[0]).toEqual([4, 0, 0])
  })
})

describe('helpers', () => {
  it('transform2d builds a Z rotation and layer', () => {
    const t2 = transform2d({ x: 3, y: 4, z: 1, angle: Math.PI / 2, scale: 2 })
    expect(t2.translation).toEqual([3, 4, 1])
    close(vec3.transformQuat([0, 0, 0], [1, 0, 0], t2.rotation), [0, 1, 0])
    expect(t2.scale).toEqual([2, 2, 1])
  })

  it('lookAt faces -Z toward the target', () => {
    const q = lookAt([0, 0, 0], [5, 0, 0])
    close(vec3.transformQuat([0, 0, 0], [0, 0, -1], q), [1, 0, 0])
  })

  it('world matrices match affine.fromTRS for roots', async () => {
    const app = await makeApp()
    const q = quat.fromEuler([0, 0, 0, 1], 0.3, 0.2, 0.1) as [number, number, number, number]
    const e = app.world.spawn([
      Transform,
      { translation: [1, 2, 3], rotation: q, scale: [1, 2, 3] },
    ])
    app.update(1 / 60)
    close(
      app.world.get(e, GlobalTransform).matrix,
      affine.fromTRS(affine.create(), [1, 2, 3], q, [1, 2, 3]),
    )
  })
})
