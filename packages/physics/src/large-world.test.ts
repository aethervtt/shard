import type { Entity, World } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import {
  FloatingOrigin,
  Grid,
  GridCell,
  OriginShift,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  Collider,
  PhysicsConfig,
  PhysicsParked,
  PhysicsRange,
  RigidBody,
  Velocity,
} from './components'
import { Physics, physics3dPlugin } from './plugin'
import { createRayHit } from './world'

const DT = 1 / 60
const FAR = 1e8

async function app(): Promise<App> {
  const a = new App().addPlugin(TransformPlugin, physics3dPlugin)
  await a.init()
  return a
}

function frames(a: App, n: number): void {
  for (let i = 0; i < n; i++) a.update(DT)
}

function box(world: World, extra: Record<string, unknown> = {}): Entity {
  return world.spawn(
    [RigidBody, { kind: 'dynamic', ...extra }],
    [Collider, { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] }],
    [Velocity, {}],
    Transform,
  )
}

function groundBody(world: World): Entity {
  return world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'cuboid', halfExtents: [10, 0.5, 10] }],
    Transform,
  )
}

/** Absolute position in a grid (cell × cellSize + translation), in f64. */
function at(world: World, e: Entity, grid: Entity): Float64Array {
  return worldPosition64(world, e, new Float64Array(3), grid)
}

function drift(a: Float64Array, b: Float64Array): number {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2 + (a[2]! - b[2]!) ** 2)
}

describe('physics in large worlds (spec 0040)', () => {
  it('keeps a box stack 10⁸ m out at rest, with the origin on it', async () => {
    const a = await app()
    const w = a.world
    const grid = w.spawn(Grid)
    placeInGrid(w, groundBody(w), grid, [FAR, FAR - 0.5, FAR])
    const boxes: Entity[] = []
    for (let i = 0; i < 4; i++) {
      const b = box(w)
      placeInGrid(w, b, grid, [FAR, FAR + 0.5 + i, FAR])
      boxes.push(b)
    }
    const origin = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, origin, grid, [FAR + 3, FAR + 2, FAR + 5])
    frames(a, 60) // settle into contact
    const start = boxes.map((b) => at(w, b, grid))
    let max = 0
    for (let f = 0; f < 600; f++) {
      a.update(DT)
      for (let i = 0; i < boxes.length; i++)
        max = Math.max(max, drift(at(w, boxes[i]!, grid), start[i]!))
    }
    expect(max).toBeLessThan(1e-3)
    // Where it was put, to the millimetre.
    expect(Math.abs(at(w, boxes[3]!, grid)[1]! - FAR - 3.5)).toBeLessThan(0.01)
    expect(Math.abs(at(w, boxes[3]!, grid)[0]! - FAR)).toBeLessThan(0.01)
  })

  it('shows why: the same stack 10⁸ m out without grids falls apart', async () => {
    const a = await app()
    const w = a.world
    const g = groundBody(w)
    w.set(g, Transform, { translation: [FAR, FAR - 0.5, FAR] })
    const boxes: Entity[] = []
    for (let i = 0; i < 4; i++) {
      const b = box(w)
      w.set(b, Transform, { translation: [FAR, FAR + 0.5 + i, FAR] })
      boxes.push(b)
    }
    // f32 has 8 m between representable values at 10⁸: every box lands on the same value as the
    // ground, so the stack starts as one lump of overlapping boxes, and each move is 8 m or none.
    expect(new Set(boxes.map((b) => w.get(b, Transform).translation[1])).size).toBe(1)
    const heights = new Set<number>()
    for (let f = 0; f < 600; f++) {
      a.update(DT)
      for (const b of boxes) heights.add(w.get(b, Transform).translation[1]!)
    }
    for (const y of heights) expect((y - FAR) % 8).toBe(0)
    const spacing =
      w.get(boxes[1]!, Transform).translation[1]! - w.get(boxes[0]!, Transform).translation[1]!
    expect(Math.abs(spacing - 1)).toBeGreaterThan(0.5)
  })

  it('keeps a body’s velocity across cell crossings as the origin follows it', async () => {
    const a = await app()
    const w = a.world
    w.resource(PhysicsConfig).gravity = [0, 0, 0]
    // Small cells, so the ship crosses many at a speed Rapier allows (it caps bodies at 400 m/s).
    const grid = w.spawn([Grid, { cellSize: 200, hysteresis: 10 }])
    const speed = 300
    const ship = box(w)
    w.set(ship, Velocity, { linear: [speed, 0, 0] })
    const start = FAR + 70
    placeInGrid(w, ship, grid, [start, 10, -3])
    // The camera rides along: it copies the ship's cell and translation every frame.
    const camera = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, camera, grid, [start, 10, -3])
    let shifts = 0
    w.observe(OriginShift, () => {
      shifts++
    })
    const p = w.resource(Physics)
    frames(a, 1)
    const record = p.bodies.get(ship)
    expect(record).toBeDefined()
    const steps0 = p.steps
    const x0 = at(w, ship, grid)[0]!
    for (let f = 0; f < 480; f++) {
      w.set(camera, Transform, { translation: [...w.get(ship, Transform).translation] })
      w.set(camera, GridCell, { cell: [...w.get(ship, GridCell).cell] })
      a.update(DT)
      const v = w.get(ship, Velocity).linear
      expect(Math.abs(v[0]! - speed) / speed).toBeLessThan(1e-6)
      expect(Math.abs(v[1]!) + Math.abs(v[2]!)).toBeLessThan(1e-6)
      const rv = p.bodies.get(ship)!.body.linvel()
      expect(Math.abs(rv.x - speed) / speed).toBeLessThan(1e-6)
    }
    expect(p.bodies.get(ship)).toBe(record) // never rebuilt
    expect(shifts).toBeGreaterThanOrEqual(10)
    const pos = at(w, ship, grid)
    const expected = x0 + speed * DT * (p.steps - steps0)
    expect(Math.abs(pos[0]! - expected)).toBeLessThan(0.05)
    expect(Math.abs(pos[1]! - 10)).toBeLessThan(1e-3)
    expect(Math.abs(pos[2]! + 3)).toBeLessThan(1e-3)
    // Rapier stays near the origin: the ship is always within a cell or so of it.
    const t = p.bodies.get(ship)!.body.translation()
    expect(Math.abs(t.x)).toBeLessThan(200)
  })

  it('parks bodies beyond PhysicsRange, hides them from raycasts, and resumes them', async () => {
    const a = await app()
    const w = a.world
    w.resource(PhysicsConfig).gravity = [0, 0, 0]
    w.resource(PhysicsRange).radius = 1000
    const grid = w.spawn(Grid)
    const near = box(w)
    placeInGrid(w, near, grid, [0, 0, 0])
    const far = box(w)
    w.set(far, Velocity, { linear: [0, 0, 3], angular: [0, 0.5, 0] })
    placeInGrid(w, far, grid, [5000, 0, 0])
    const origin = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, origin, grid, [0, 0, 10])
    frames(a, 3)

    const p = w.resource(Physics)
    expect(p.bodies.get(far)!.parked).toBe(true)
    expect(p.bodies.get(near)!.parked).toBe(false)
    expect(w.get(far, PhysicsParked).linear[2]).toBeCloseTo(3, 5)
    expect(w.get(far, PhysicsParked).angular[1]).toBeCloseTo(0.5, 3)
    expect(p.describe().parked).toBe(1)
    const hit = createRayHit()
    expect(p.raycast([4990, 0, 0], [1, 0, 0], undefined, hit)).toBe(false)
    expect(p.raycast([10, 0, 0], [-1, 0, 0], undefined, hit)).toBe(true)
    expect(hit.body).toBe(near)
    // Parked: it doesn't move.
    const parkedAt = at(w, far, grid)
    frames(a, 30)
    expect(drift(at(w, far, grid), parkedAt)).toBe(0)

    // The origin flies over: the far body comes back with the velocity it had.
    placeInGrid(w, origin, grid, [4990, 0, 0])
    frames(a, 2)
    expect(p.bodies.get(far)!.parked).toBe(false)
    expect(w.has(far, PhysicsParked)).toBe(false)
    expect(p.bodies.get(near)!.parked).toBe(true)
    // Rapier's frame is now around cell (2, 0, 0): the far body is at about x = 1000 there.
    expect(p.raycast([990, 0, 0], [1, 0, 0], undefined, hit)).toBe(true)
    expect(hit.body).toBe(far)
    const back = at(w, far, grid)
    frames(a, 60)
    const moved = at(w, far, grid)
    expect(Math.abs(moved[2]! - back[2]! - 3 * DT * 60)).toBeLessThan(0.1)
    expect(w.get(far, Velocity).linear[2]).toBeCloseTo(3, 5)
    // (Angular velocity drifts a little with gyroscopic integration, parked or not.)
    expect(w.get(far, Velocity).angular[1]).toBeCloseTo(0.5, 3)
    expect(Math.abs(moved[0]! - 5000)).toBeLessThan(1e-3)
  })

  it('shifts fixed colliders and interpolation with the origin', async () => {
    const a = await app()
    const w = a.world
    w.resource(PhysicsConfig).interpolate = true
    const grid = w.spawn(Grid)
    // A floor with no RigidBody (a free collider) and a ball resting on it, both 1 km out.
    const floor = w.spawn([Collider, { shape: 'cuboid', halfExtents: [20, 0.5, 20] }], Transform)
    placeInGrid(w, floor, grid, [900, -0.5, 0])
    const ball = w.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'ball', radius: 0.5 }],
      Transform,
    )
    placeInGrid(w, ball, grid, [900, 3, 0])
    const origin = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, origin, grid, [0, 0, 0])
    frames(a, 90)
    expect(at(w, ball, grid)[1]).toBeCloseTo(0.5, 2)
    // Across a cell: the ball stays on the floor, and a ray down from above it still hits.
    placeInGrid(w, origin, grid, [1500, 0, 0])
    frames(a, 1)
    const p = w.resource(Physics)
    const hit = createRayHit()
    expect(p.raycast([900 - 2000, 5, 0], [0, -1, 0], undefined, hit)).toBe(true)
    expect(hit.entity).toBe(ball)
    frames(a, 60)
    const pos = at(w, ball, grid)
    expect(pos[1]).toBeCloseTo(0.5, 2)
    expect(Math.abs(pos[0]! - 900)).toBeLessThan(1e-3)
  })

  it('puts root-level bodies in the origin frame when the origin is in a grid cell', async () => {
    const a = await app()
    const w = a.world
    // Ground at the root; a ball in a grid whose cell 0 overlaps it; the origin one cell over, so
    // the root frame is 2 km off the origin frame.
    const floor = groundBody(w)
    w.set(floor, Transform, { translation: [0, -0.5, 0] })
    const grid = w.spawn(Grid)
    const ball = w.spawn(
      [RigidBody, { kind: 'dynamic' }],
      [Collider, { shape: 'ball', radius: 0.5 }],
      Transform,
    )
    placeInGrid(w, ball, grid, [0, 3, 0])
    const origin = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, origin, grid, [2000, 0, 0])
    frames(a, 120)
    expect(at(w, ball, grid)[1]).toBeCloseTo(0.5, 2)
    expect(w.get(floor, Transform).translation[1]).toBe(-0.5)
    const p = w.resource(Physics)
    const hit = createRayHit()
    expect(p.raycast([-2000, 5, 0], [0, -1, 0], undefined, hit)).toBe(true)
    expect(hit.entity).toBe(ball)
  })
})
