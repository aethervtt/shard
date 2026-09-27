import { ChildOf, type Entity, quat, Update } from '@aethervtt/shard-core'
import { App } from '@aethervtt/shard-runtime'
import { describe, expect, it } from 'vitest'
import {
  distance64,
  FloatingOrigin,
  GlobalTransform,
  Grid,
  GridCell,
  OriginShift,
  type OriginShiftData,
  placeInGrid,
  propagateSubtree,
  reparentToGrid,
  Transform,
  TransformPlugin,
  worldPosition,
  worldPosition64,
} from './index'

async function makeApp() {
  const app = new App().addPlugin(TransformPlugin)
  await app.init()
  return app
}

const matrix = (app: App, e: Entity) => Array.from(app.world.get(e, GlobalTransform).matrix)

function spinY(radians: number): [number, number, number, number] {
  return quat.fromAxisAngle([0, 0, 0, 1], [0, 1, 0], radians) as [number, number, number, number]
}

describe('grids and the floating origin (spec 0040)', () => {
  it('puts a cube 10¹² m out, 3 m from the origin camera, where a cube 3 m from the origin goes', async () => {
    const far = await makeApp()
    const grid = far.world.spawn(Grid)
    const cell = 500_000_000 // × 2000 m = 10¹² m
    const cube = far.world.spawn(
      [Transform, { translation: [3, 0, 0], rotation: spinY(0.3) }],
      [GridCell, { cell: [cell, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    far.world.spawn(
      Transform,
      FloatingOrigin,
      [GridCell, { cell: [cell, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    far.update(1 / 60)

    const near = await makeApp()
    const nearCube = near.world.spawn([Transform, { translation: [3, 0, 0], rotation: spinY(0.3) }])
    near.update(1 / 60)
    expect(matrix(far, cube)).toEqual(matrix(near, nearCube))
  })

  it('measures 1 mm between entities 10¹² m out, wherever the origin is', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn([Grid, { cellSize: 2000 }])
    const a = w.spawn(
      [Transform, { translation: [999.9995, 0, 0] }],
      [GridCell, { cell: [500_000_000, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    const b = w.spawn(
      [Transform, { translation: [-1000.0005, 0, 0] }],
      [GridCell, { cell: [500_000_001, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    const expected = 2000 - 1000.0005 - 999.9995
    const f32 = Math.fround(-1000.0005) - Math.fround(999.9995) + 2000
    expect(Math.abs(distance64(w, a, b) - f32)).toBeLessThan(1e-9)
    expect(Math.abs(distance64(w, a, b) - expected)).toBeLessThan(1e-4)
    // Moving the origin doesn't change anything: the cells subtract as integers.
    const origin = w.spawn(Transform, FloatingOrigin, [ChildOf, { parent: grid }])
    for (const c of [0, 12_345, 500_000_000, -2_000_000_000]) {
      w.add(origin, GridCell, { cell: [c, 7, -3] })
      app.update(1 / 60)
      expect(Math.abs(distance64(w, a, b) - f32)).toBeLessThan(1e-9)
    }
    // 1 mm apart, exactly, in f32 offsets.
    const c = w.spawn(
      [Transform, { translation: [0.5, 0, 0] }],
      [GridCell, { cell: [500_000_000, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    const d = w.spawn(
      [Transform, { translation: [0.501, 0, 0] }],
      [GridCell, { cell: [500_000_000, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    expect(Math.abs(distance64(w, c, d) - 0.001)).toBeLessThan(1e-6)
  })

  it('flies at 5 km/s for 60 s across 150 cells without a jump, shifting the origin each time', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn(Grid)
    const camera = w.spawn(Transform, FloatingOrigin, GridCell, [ChildOf, { parent: grid }])
    const escort = w.spawn([Transform, { translation: [0.25, -1.5, -10] }], GridCell, [
      ChildOf,
      { parent: grid },
    ])
    const beacon = w.spawn([Transform, { translation: [40, 3, -20] }], GridCell, [
      ChildOf,
      { parent: grid },
    ])
    const shifts: OriginShiftData[] = []
    w.observe(OriginShift, ({ data }) => shifts.push(data))
    const speed = 5000
    const dt = 1 / 60
    let x = 0
    let worst = 0
    let worstBeacon = 0
    app.update(dt)
    let prevBeacon = worldPosition(w, beacon)
    let prevCam = worldPosition(w, camera)
    for (let frame = 0; frame < 3600; frame++) {
      x += speed * dt
      placeInGrid(w, camera, grid, [x, 0, 0])
      placeInGrid(w, escort, grid, [x + 0.25, -1.5, -10])
      const shiftsBefore = shifts.length
      app.update(dt)
      const cam = worldPosition(w, camera)
      const esc = worldPosition(w, escort)
      worst = Math.max(
        worst,
        Math.abs(esc[0] - cam[0] - 0.25),
        Math.abs(esc[1] - cam[1] + 1.5),
        Math.abs(esc[2] - cam[2] + 10),
      )
      // Relative to the camera, the static beacon moves back by exactly the camera's motion.
      const b = worldPosition(w, beacon)
      const shift = shifts.length > shiftsBefore ? shifts.at(-1)!.offset[0] : 0
      const expectedStep = x - (x - speed * dt) // the camera's step
      const step = b[0] - cam[0] - (prevBeacon[0] - prevCam[0])
      worstBeacon = Math.max(worstBeacon, Math.abs(step + expectedStep))
      void shift
      prevBeacon = b
      prevCam = cam
    }
    expect(w.get(camera, GridCell).cell[0]).toBe(150)
    expect(shifts.length).toBe(150)
    expect(shifts[0]!.delta).toEqual([-1, 0, 0])
    expect(shifts[0]!.offset).toEqual([-2000, 0, 0])
    // The escort stays put relative to the camera to well under 0.01 px (≈ 1e-5 of 10 m).
    expect(worst).toBeLessThan(1e-4)
    // The beacon ends 300 km away, where f32 spacing is ~3 cm; one step never jumps beyond that.
    expect(worstBeacon).toBeLessThan(0.05)
  })

  it('keeps the escort exact and the origin shift counted when crossing one cell', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn([Grid, { cellSize: 100, hysteresis: 10 }])
    const ship = w.spawn(Transform, FloatingOrigin, GridCell, [ChildOf, { parent: grid }])
    const received: OriginShiftData[] = []
    const reader = w.reader(OriginShift)
    // Inside the hysteresis band: stays in cell 0.
    w.set(ship, Transform, { translation: [59, 0, 0] })
    app.update(1 / 60)
    expect(w.get(ship, GridCell).cell).toEqual([0, 0, 0])
    w.set(ship, Transform, { translation: [61, 0, 0] })
    app.update(1 / 60)
    expect(w.get(ship, GridCell).cell).toEqual([1, 0, 0])
    expect(w.get(ship, Transform).translation[0]).toBeCloseTo(-39, 5)
    received.push(...reader.read())
    expect(received).toEqual([{ grid, delta: [-1, 0, 0], offset: [-100, 0, 0] }])
    // Back by only a little: hysteresis keeps it in cell 1.
    w.set(ship, Transform, { translation: [-55, 0, 0] })
    app.update(1 / 60)
    expect(w.get(ship, GridCell).cell).toEqual([1, 0, 0])
    // The ship is the origin, so it sits at its offset from its own cell.
    expect(worldPosition(w, ship)[0]).toBeCloseTo(-55, 5)
  })

  it('places entities on a spinning planet grid inside a system grid', async () => {
    const app = await makeApp()
    const w = app.world
    const system = w.spawn(Grid)
    const planet = w.spawn(
      Grid,
      [GridCell, { cell: [75_000, 0, 0] }],
      [Transform, { rotation: spinY(Math.PI / 2) }],
      [ChildOf, { parent: system }],
    )
    // A rock on the planet's surface, 6 000 km out along the planet's +X.
    const rock = w.spawn(
      [Transform, { translation: [0, 0, 0] }],
      [GridCell, { cell: [3000, 0, 0] }],
      [ChildOf, { parent: planet }],
    )
    const ship = w.spawn(
      [Transform, { translation: [0, 0, 0] }],
      FloatingOrigin,
      [GridCell, { cell: [75_000, 0, -3001] }],
      [ChildOf, { parent: system }],
    )
    app.update(1 / 60)
    // Planet spun 90° about Y, so its +X points at the system's -Z: the rock is at system
    // (150 000 km, 0, -6 000 km), 2 km from the ship along +Z. Worked out in f64 from the planet's
    // f32 quaternion, which isn't exactly 90°.
    const [, qy, , qw] = Array.from(w.get(planet, Transform).rotation)
    const r = 6_000_000
    const rx = (1 - 2 * qy! * qy!) * r
    const rz = -2 * qy! * qw! * r
    const rel = worldPosition(w, rock)
    expect(rel[0]).toBeCloseTo(rx, 2)
    expect(rel[1]).toBeCloseTo(0, 3)
    expect(rel[2]).toBeCloseTo(rz + 6_002_000, 2)
    expect(Math.abs(rel[2] - 2000)).toBeLessThan(1)
    const p = worldPosition64(w, rock, new Float64Array(3), system)
    expect(p[0]).toBeCloseTo(150_000_000 + rx, 3)
    expect(p[2]).toBeCloseTo(rz, 3)
    // Origin inside the planet grid instead: the ship sees the system through the planet's spin.
    reparentToGrid(w, ship, planet)
    app.update(1 / 60)
    expect(w.get(ship, ChildOf).parent).toBe(planet)
    const after = worldPosition(w, rock)
    expect(Math.hypot(after[0], after[1], after[2])).toBeCloseTo(2000, 3)
    void ship
  })

  it('reparentToGrid moves a ship into a rotating planet grid with under 1 mm of pose change', async () => {
    const app = await makeApp()
    const w = app.world
    const system = w.spawn(Grid)
    const planet = w.spawn(
      Grid,
      [GridCell, { cell: [75_000, 20, 0] }],
      [Transform, { rotation: spinY(1.234) }],
      [ChildOf, { parent: system }],
    )
    const ship = w.spawn(
      [Transform, { translation: [123.456, -78.9, 432.1], rotation: spinY(0.5) }],
      [GridCell, { cell: [75_003, 21, -2] }],
      [ChildOf, { parent: system }],
    )
    const camera = w.spawn([Transform, { translation: [0, 2, 8] }], [ChildOf, { parent: ship }])
    // The origin stays on a station nearby, so the origin frame itself doesn't change.
    w.spawn(
      Transform,
      FloatingOrigin,
      [GridCell, { cell: [75_002, 21, -2] }],
      [ChildOf, { parent: system }],
    )
    app.update(1 / 60)
    const before = matrix(app, ship)
    const cameraBefore = worldPosition(w, camera)
    const before64 = worldPosition64(w, ship, new Float64Array(3), system)
    reparentToGrid(w, ship, planet)
    app.update(1 / 60)
    const after = matrix(app, ship)
    for (let i = 0; i < 12; i++) expect(Math.abs(after[i]! - before[i]!)).toBeLessThan(1e-3)
    const after64 = worldPosition64(w, ship, new Float64Array(3), system)
    for (let i = 0; i < 3; i++) expect(Math.abs(after64[i]! - before64[i]!)).toBeLessThan(1e-3)
    // The camera, a child of the ship, comes along.
    const cam = worldPosition(w, camera)
    for (let i = 0; i < 3; i++) expect(Math.abs(cam[i]! - cameraBefore[i]!)).toBeLessThan(1e-3)
  })

  it('emits an origin shift when the origin changes grids', async () => {
    const app = await makeApp()
    const w = app.world
    const system = w.spawn(Grid)
    const planet = w.spawn(Grid, [GridCell, { cell: [10, 0, 0] }], [ChildOf, { parent: system }])
    const ship = w.spawn(
      [Transform, { translation: [5, 0, 0] }],
      FloatingOrigin,
      [GridCell, { cell: [9, 0, 0] }],
      [ChildOf, { parent: system }],
    )
    const still = w.spawn(
      [Transform, { translation: [7, 0, 0] }],
      [GridCell, { cell: [9, 0, 0] }],
      [ChildOf, { parent: system }],
    )
    app.update(1 / 60)
    const before = worldPosition(w, still)
    const shifts: OriginShiftData[] = []
    w.observe(OriginShift, ({ data }) => shifts.push(data))
    reparentToGrid(w, ship, planet)
    app.update(1 / 60)
    expect(shifts).toHaveLength(1)
    const after = worldPosition(w, still)
    for (let i = 0; i < 3; i++) {
      expect(after[i]! - before[i]!).toBeCloseTo(shifts[0]!.offset[i]!, 3)
    }
  })

  it('places an entity by f64 position and reads it back exactly', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn([Grid, { cellSize: 2000 }])
    const moon = w.spawn(Transform)
    placeInGrid(w, moon, grid, [3.84e8, 1234.5678, -9.87e7])
    expect(w.get(moon, GridCell).cell).toEqual([192_000, 1, -49_350])
    const p = worldPosition64(w, moon, new Float64Array(3), grid)
    expect(p[0]).toBe(3.84e8)
    expect(Math.abs(p[1]! - 1234.5678)).toBeLessThan(1e-4)
    expect(p[2]).toBe(-9.87e7)
  })

  it('reports cell 0 and identity for entities without GridCell or grids', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn([Grid, { cellSize: 10 }])
    const plain = w.spawn([Transform, { translation: [1, 2, 3] }], [ChildOf, { parent: grid }])
    const root = w.spawn([Transform, { translation: [4, 5, 6] }])
    app.update(1 / 60)
    expect(worldPosition(w, plain)).toEqual([1, 2, 3])
    expect(worldPosition(w, root)).toEqual([4, 5, 6])
    // Origin in the grid, cell (1, 0, 0): both shift by −10 m.
    const cam = w.spawn(
      Transform,
      FloatingOrigin,
      [GridCell, { cell: [1, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    app.update(1 / 60)
    expect(worldPosition(w, plain)).toEqual([-9, 2, 3])
    expect(worldPosition(w, root)).toEqual([-6, 5, 6])
    // Removing every grid puts the root frame back.
    w.despawn(grid)
    app.update(1 / 60)
    expect(worldPosition(w, root)).toEqual([4, 5, 6])
    void cam
  })

  it('leaves static grids alone on frames where the origin stays in its cell', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn(Grid)
    const e = w.spawn([Transform, { translation: [1, 0, 0] }], GridCell, [
      ChildOf,
      { parent: grid },
    ])
    w.spawn(Transform, FloatingOrigin, GridCell, [ChildOf, { parent: grid }])
    app.update(1 / 60)
    const tick = w.entityTable(e).changedTicks(GlobalTransform)[w.entityRow(e)]
    app.update(1 / 60)
    app.update(1 / 60)
    expect(w.entityTable(e).changedTicks(GlobalTransform)[w.entityRow(e)]).toBe(tick)
  })

  it('propagateSubtree uses the grid frame for direct grid children', async () => {
    const app = await makeApp()
    const w = app.world
    const grid = w.spawn(Grid)
    const e = w.spawn(
      [Transform, { translation: [1, 0, 0] }],
      [GridCell, { cell: [1_000_000, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    w.spawn(
      Transform,
      FloatingOrigin,
      [GridCell, { cell: [1_000_000, 0, 0] }],
      [ChildOf, { parent: grid }],
    )
    app.update(1 / 60)
    const table = w.entityTable(e)
    table.column(Transform, 'translation')[w.entityRow(e) * 3] = 2.5
    propagateSubtree(w, e)
    expect(worldPosition(w, e)).toEqual([2.5, 0, 0])
  })
})

void Update
