import type { Entity, World } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import {
  CharacterController,
  CharacterIntent,
  createRayHit,
  Physics,
  physics3dPlugin,
} from '@aethervtt/shard-physics'
import { forwardPlugin, Mesh3d, renderPlugin } from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { Structure } from './compile'
import { Cutout, Floor, Opening, Roof, StructureSettings, Wall } from './components'
import { pointAt } from './curve'
import { slabY } from './geometry'
import { StructureModel } from './model'
import { StructureColliders, structurePhysicsPlugin } from './physics'
import { structurePlugin } from './plugin'
import { town } from './town'

// Structure's colliders (0112), headless: no render plugin, no GPU (except render parity).

const DT = 1 / 60

async function headless(): Promise<App> {
  const app = new App().addPlugin(TransformPlugin, physics3dPlugin(), structurePhysicsPlugin)
  await app.init()
  return app
}

function frames(app: App, n = 1): void {
  for (let i = 0; i < n; i++) app.update(DT)
}

const colliders = (world: World) => world.resource(StructureColliders)

/**
 * Every structure collider, in owner order: the owner's rank (apps that spawn other entities
 * first number them differently), enabled, kinds and rounded poses.
 */
function digest(world: World): string {
  const physics = world.resource(Physics)
  const owners = [...colliders(world).owners].sort((a, b) => a - b)
  const out: string[] = []
  for (const [rank, e] of owners.entries()) {
    const set = physics.statics.get(e)!
    const poses = set.colliders.map((c) => {
      const t = c.translation()
      return `${t.x.toFixed(4)},${t.y.toFixed(4)},${t.z.toFixed(4)}`
    })
    out.push(`${rank}:${set.enabled}:${set.kinds.join('/')}:${poses.join(';')}`)
  }
  return out.join('\n')
}

describe('structure colliders', () => {
  it('builds every collider of a town headless, with no render code running', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: 30 })
    frames(app, 2)
    let walls = 0
    let openings = 0
    for (const b of t.buildings) {
      walls += b.walls.length
      openings += b.doors.length + b.windows.length
    }
    const c = colliders(world)
    expect(c.owners.size).toBe(walls + openings + 1)
    expect(world.resource(Physics).describe().static).toMatchObject({
      sets: walls + openings + 1,
      disabled: 0,
    })
    expect(world.query({ with: [Mesh3d] }).count()).toBe(0)
    expect(world.tryResource(Structure)).toBeUndefined()
    const describe = app.methods.find((m) => m.name === 'structure.describe')!
    const described = (await describe.handler({ app, world }, {})) as {
      model: { walls: number }
      colliders: { owners: number }
    }
    expect(described.model.walls).toBe(walls)
    expect(described.colliders.owners).toBe(walls + openings + 1)
  })

  for (const shape of ['straight', 'arc', 'bezier'] as const) {
    it(`blocks along the ${shape} wall except through its openings, by their state`, async () => {
      const app = await headless()
      const world = app.world
      const wall = world.spawn([
        Wall,
        {
          a: [0, 0],
          b: [6, 0],
          height: 3,
          thickness: 0.2,
          shape,
          bow: 1.5,
          c0: [2, 2],
          c1: [4, -1],
        },
      ])
      const door = world.spawn([Opening, { wall, kind: 'door', offset: 1, width: 1, height: 2.1 }])
      const window = world.spawn([
        Opening,
        { wall, kind: 'window', offset: 4, width: 1, sill: 0.9, height: 1.2 },
      ])
      frames(app)
      const physics = world.resource(Physics)
      const line = world.resource(StructureModel).walls.get(wall)!.shape.line
      const tolerance = world.resource(StructureSettings).curveTolerance
      const hit = createRayHit()
      const p = new Float64Array(2)
      const q = new Float64Array(2)
      const check = (state: { door: Entity | null; window: Entity | null }) => {
        for (let s = 0.25; s < line.length; s += 0.5) {
          // Cast across the wall at arc length s: from 2 m off one face, along its normal.
          pointAt(line, Math.max(0, s - 0.01), p)
          pointAt(line, Math.min(line.length, s + 0.01), q)
          const tx = q[0]! - p[0]!
          const tz = q[1]! - p[1]!
          const tl = Math.sqrt(tx * tx + tz * tz)
          const nx = -tz / tl
          const nz = tx / tl
          pointAt(line, s, p)
          for (const y of [0.5, 1.5, 2.5]) {
            const inDoor = s > 1 && s < 2 && y < 2.1
            const inWindow = s > 4 && s < 5 && y > 0.9 && y < 2.1
            const expected = inDoor ? state.door : inWindow ? state.window : wall
            const origin = [p[0]! - nx * 2, y, p[1]! - nz * 2]
            const found = physics.raycast(origin, [nx, 0, nz], { maxDistance: 4 }, hit)
            const label = `${shape} s=${s} y=${y}`
            if (expected === null) {
              expect(found, label).toBe(false)
              continue
            }
            expect(found, label).toBe(true)
            expect(hit.entity, label).toBe(expected)
            expect(Math.abs(hit.distance - 1.9), label).toBeLessThan(0.01 + tolerance * 2)
          }
        }
      }
      check({ door, window })
      world.set(door, Opening, { state: 'open' })
      world.set(window, Opening, { movement: 'none' })
      frames(app)
      check({ door: null, window: null })
      world.set(door, Opening, { state: 'locked' })
      frames(app)
      check({ door, window: null })
    })
  }

  it('gives floors and roofs their slabs, holes open and hatches by state', async () => {
    const app = await headless()
    const world = app.world
    const floor = world.spawn([
      Floor,
      {
        points: [
          [0, 0],
          [6, 0],
          [6, 6],
          [0, 6],
        ],
        elevation: 0.5,
        thickness: 0.2,
      },
    ])
    const square = (x: number, z: number): [number, number][] => [
      [x, z],
      [x + 1, z],
      [x + 1, z + 1],
      [x, z + 1],
    ]
    world.spawn([Cutout, { host: floor, points: square(1, 1), kind: 'hole' }])
    const hatch = world.spawn([Cutout, { host: floor, points: square(4, 4), kind: 'hatch' }])
    const roof = world.spawn(
      [
        Roof,
        {
          points: [
            [10, 0],
            [16, 0],
            [16, 6],
            [10, 6],
          ],
          height: 3,
          pitch: 30,
          ridge: [0, 1],
        },
      ],
      Transform,
    )
    frames(app)
    const physics = world.resource(Physics)
    const hit = createRayHit()
    const down = (x: number, z: number) =>
      physics.raycast([x, 10, z], [0, -1, 0], { maxDistance: 20 }, hit) ? hit : null
    expect(down(0.5, 0.5)?.entity).toBe(floor)
    expect(down(0.5, 0.5)?.point[1]).toBeCloseTo(0.5, 4)
    expect(down(1.5, 1.5)).toBeNull()
    expect(down(4.5, 4.5)?.entity).toBe(hatch)
    world.set(hatch, Cutout, { state: 'open' })
    frames(app)
    expect(down(4.5, 4.5)).toBeNull()
    const slab = world.resource(StructureModel).slabs.get(roof)!.shape
    for (const [x, z] of [
      [11, 1],
      [13, 3],
      [15, 5.5],
    ] as const) {
      expect(down(x, z)?.entity).toBe(roof)
      expect(down(x, z)?.point[1]).toBeCloseTo(slabY(slab, x, z), 3)
    }
  })

  it('rebuilds only the colliders an edit changed, and toggles doors without a rebuild', async () => {
    const app = await headless()
    const world = app.world
    const t = town(world, { buildings: 40 })
    frames(app, 2)
    const physics = world.resource(Physics)
    const c = colliders(world)
    const sets = () => physics.describe().static.sets
    const before = sets()
    const edit = (change: () => void) => {
      change()
      frames(app)
      const model = world.resource(StructureModel)
      return { ...c.last, ms: model.last.ms + c.last.ms }
    }

    // Add one wall: one set.
    let r = edit(() => world.spawn([Wall, { a: [2, 2], b: [2, 8] }]))
    expect(r).toMatchObject({ built: 1, toggled: 0, removed: 0 })
    expect(sets()).toBe(before + 1)

    // Split a building's front wall (and its door) into two: the two walls and the door.
    const b = t.buildings[7]!
    const [x0, z0, x1] = b.bounds
    const door = b.doors[0]!
    const { offset } = world.get(door, Opening)
    const mid = x0 + offset + 0.5
    let left = -1 as Entity
    r = edit(() => {
      world.despawn(b.front)
      left = world.spawn([Wall, { a: [x0, z0], b: [mid + 1, z0], height: 3, thickness: 0.2 }])
      world.spawn([Wall, { a: [mid + 1, z0], b: [x1, z0], height: 3, thickness: 0.2 }])
      world.set(door, Opening, { wall: left })
    })
    expect(r).toMatchObject({ built: 3, toggled: 0, removed: 1 })
    expect(sets()).toBe(before + 2)
    expect(r.ms).toBeLessThan(budget('structure/edit'))

    // Remove a wall with a window: the wall's set goes, and the window has no hole to fill.
    const window = b.windows[0]!
    r = edit(() => world.despawn(b.left))
    expect(r).toMatchObject({ built: 0, removed: 1 })
    expect(physics.statics.has(window)).toBe(false)
    expect(sets()).toBe(before)

    // A door toggle: one collider off, nothing built.
    const other = t.buildings[3]!.doors[0]!
    r = edit(() => world.set(other, Opening, { state: 'open' }))
    expect(r).toMatchObject({ built: 0, toggled: 1, removed: 0 })
    expect(physics.isStaticEnabled(other)).toBe(false)
    expect(sets()).toBe(before)
    // Its leaf's look (no geometry, no state) changes nothing.
    r = edit(() => world.set(other, Opening, { swing: 'right', frameWidth: 0.12 }))
    expect(r).toMatchObject({ built: 0, toggled: 0, removed: 0 })
  })

  it('stops a character at a wall, a closed door and a window; an open door lets it through', async () => {
    const app = await headless()
    const world = app.world
    world.spawn([
      Floor,
      {
        points: [
          [-10, -10],
          [10, -10],
          [10, 10],
          [-10, 10],
        ],
      },
    ])
    // A wall along x at z = 0: a door over x ∈ [−0.5, 0.5], a window over x ∈ [3, 4].
    const wall = world.spawn([Wall, { a: [-6, 0], b: [6, 0], thickness: 0.2 }])
    const door = world.spawn([Opening, { wall, kind: 'door', offset: 5.5, width: 1 }])
    world.spawn([Opening, { wall, kind: 'window', offset: 9, width: 1, sill: 0.9 }])
    const walker = (x: number) =>
      world.spawn(
        [CharacterController, { radius: 0.3 }],
        [Transform, { translation: [x, 0.92, -3] }],
      )
    const walkers = [walker(-3), walker(0), walker(3.5)]
    frames(app, 2)
    for (const e of walkers) world.set(e, CharacterIntent, { move: [0, 0, 4] })
    let worst = -Infinity
    for (let i = 0; i < 600; i++) {
      frames(app)
      for (const e of walkers) worst = Math.max(worst, world.get(e, Transform).translation[2]!)
    }
    // The face is at z = −0.1; the capsule's radius and the controller's offset keep it off it.
    const stop = -0.1 - 0.3
    expect(worst).toBeLessThan(stop + 0.02)
    for (const e of walkers)
      expect(world.get(e, Transform).translation[2]).toBeGreaterThan(stop - 0.05)
    world.set(door, Opening, { state: 'open' })
    frames(app, 90)
    expect(world.get(walkers[1]!, Transform).translation[2]).toBeGreaterThan(1)
    expect(world.get(walkers[0]!, Transform).translation[2]).toBeLessThan(stop + 0.02)
  })

  it('builds the same colliders on every run', async () => {
    const run = async () => {
      const app = await headless()
      const t = town(app.world, { buildings: 12, seed: 4 })
      frames(app, 2)
      app.world.despawn(t.buildings[2]!.back)
      app.world.set(t.buildings[5]!.doors[0]!, Opening, { state: 'open' })
      app.world.spawn([Wall, { a: [1, 1], b: [3, 2], shape: 'arc', bow: 0.5 }])
      frames(app, 2)
      return digest(app.world)
    }
    const a = await run()
    expect(a.length).toBeGreaterThan(0)
    expect(await run()).toBe(a)
  })

  it('removes every collider when turned off, and builds them again when turned on', async () => {
    const app = await headless()
    const world = app.world
    town(world, { buildings: 4 })
    frames(app)
    const all = digest(world)
    world.patchResource(StructureSettings, {
      colliders: { ...world.resource(StructureSettings).colliders, enabled: false },
    })
    frames(app)
    expect(world.resource(Physics).describe().static.sets).toBe(0)
    world.patchResource(StructureSettings, {
      colliders: { ...world.resource(StructureSettings).colliders, enabled: true },
    })
    frames(app)
    expect(digest(world)).toBe(all)
  })

  it('builds the same colliders with structure drawing as headless', async () => {
    const gpu = await createNodeGpuContext()
    try {
      const drawn = new App().addPlugin(
        TransformPlugin,
        renderPlugin({ gpu, windowView: false }),
        forwardPlugin({ msaa: 1 }),
        structurePlugin,
        physics3dPlugin(),
        structurePhysicsPlugin,
      )
      await drawn.init()
      const bare = await headless()
      for (const app of [drawn, bare]) {
        town(app.world, { buildings: 10, seed: 9 })
        frames(app, 2)
      }
      expect(drawn.world.resource(Structure).walls.size).toBeGreaterThan(0)
      expect(digest(drawn.world)).toBe(digest(bare.world))
      await drawn.dispose()
    } finally {
      gpu.destroy()
    }
  })
})
