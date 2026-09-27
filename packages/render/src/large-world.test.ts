import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ChildOf, defineSystem, type Entity, mat4, quat, Update } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import {
  FloatingOrigin,
  GlobalTransform,
  Grid,
  GridCell,
  OriginShift,
  type OriginShiftData,
  placeInGrid,
  Transform,
  TransformPlugin,
} from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { forwardPlugin } from './forward'
import { Gizmos } from './gizmos'
import { INSTANCE_FLOATS, InstanceSlot, Instances, Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { setOverlays } from './overlays'
import { captureBuffer, Gpu, renderPlugin } from './plugin'
import { Antialiasing } from './post'
import { RenderCounters } from './stats'
import { OffscreenTarget } from './target'
import { compareGolden, renderView, settle } from './testing'
import { Cameras, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const here = dirname(fileURLToPath(import.meta.url))

async function scene(width: number, height: number) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const target = new OffscreenTarget(gpu, { label: 'large-world', width, height })
  const targetRef = app.world.resource(RenderTargets).add(target, 'large-world')
  return { app, world: app.world, targetRef }
}

type World = Awaited<ReturnType<typeof scene>>['world']

function camera(world: World, targetRef: unknown, extra: unknown[]) {
  return world.spawn(
    [Camera3d, { target: targetRef as never, fovY: 45, clearColor: [0.02, 0.02, 0.03, 1] }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    ...(extra as []),
  )
}

/** A lit cube with a floor-less sun: the part of the frame 0040 cares about. */
function litCube(world: World, extra: unknown[]) {
  world.resource(AmbientLight).brightness = 1500
  const mesh = world.resource(Meshes).add(cube({ size: 1 }))
  const material = world
    .resource(Materials)
    .add(new MaterialAsset({ baseColor: [0.8, 0.3, 0.2, 1], roughness: 0.5 }))
  world.spawn(
    [DirectionalLight, { illuminance: 10_000, shadows: true }],
    [
      Transform,
      {
        rotation: quat.fromEuler([0, 0, 0, 1], -0.7, 0.8, 0) as [number, number, number, number],
      },
    ],
  )
  return world.spawn(
    [Mesh3d, { mesh }],
    [MeshMaterial, { material }],
    [
      Transform,
      {
        rotation: quat.fromEuler([0, 0, 0, 1], 0.5, 0.6, 0) as [number, number, number, number],
      },
    ],
    ...(extra as []),
  )
}

/** Pixel coordinates of a world point through a column-major view-projection (f64 math). */
function screen(
  vp: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
  w: number,
  h: number,
): [number, number] {
  const cx = vp[0]! * x + vp[4]! * y + vp[8]! * z + vp[12]!
  const cy = vp[1]! * x + vp[5]! * y + vp[9]! * z + vp[13]!
  const cw = vp[3]! * x + vp[7]! * y + vp[11]! * z + vp[15]!
  return [(cx / cw + 1) * 0.5 * w, (1 - cy / cw) * 0.5 * h]
}

describe('large-world rendering (spec 0040)', () => {
  it('renders a cube 10¹² m out, 3 m from a FloatingOrigin camera, like one 3 m from the origin', async () => {
    const size = 96
    const cell = 500_000_000 // × 2000 m = 10¹² m from the root frame's origin
    const far = await scene(size, size)
    const grid = far.world.spawn(Grid)
    litCube(far.world, [
      [GridCell, { cell: [cell, 0, 0] }],
      [ChildOf, { parent: grid }],
    ])
    const farCam = camera(far.world, far.targetRef, [
      [Transform, { translation: [0, 0, 3] }],
      [GridCell, { cell: [cell, 0, 0] }],
      [ChildOf, { parent: grid }],
      FloatingOrigin,
    ])
    const near = await scene(size, size)
    litCube(near.world, [])
    const nearCam = camera(near.world, near.targetRef, [[Transform, { translation: [0, 0, 3] }]])

    const a = await renderView(far.app, `camera:${farCam}`)
    const b = await renderView(near.app, `camera:${nearCam}`)
    for (const w of [far.world, near.world]) {
      expect(w.resource(Gpu).errors).toEqual([])
      expect(w.resource(LogResource).errors()).toEqual([])
    }
    // Something drew: the cube covers the middle of the frame.
    const mid = ((size / 2) * size + size / 2) * 4
    expect(a.data[mid]!).toBeGreaterThan(40)
    let diff = 0
    for (let i = 0; i < a.data.length; i++) diff = Math.max(diff, Math.abs(a.data[i]! - b.data[i]!))
    expect(diff).toBe(0)
    expect(compareGolden(here, 'large-world-cube', a).mean).toBeLessThan(0.5)
  }, 60_000)

  it('flies at 5 km/s for 60 s across 150 cells: no screen jump, continuous motion vectors, no TAA reset', async () => {
    const W = 128
    const H = 128
    const { app, world, targetRef } = await scene(W, H)
    const cs = 2000
    const grid = world.spawn([Grid, { cellSize: cs }])
    const cam = camera(world, targetRef, [
      Transform,
      GridCell,
      [ChildOf, { parent: grid }],
      FloatingOrigin,
      [Antialiasing, { mode: 'taa' }],
    ])
    const mesh = world.resource(Meshes).add(cube({ size: 60 }))
    // A static beacon at every cell boundary the flight crosses, 2 km ahead: in view across it.
    const DEPTH = 2000
    const beacons: Entity[] = []
    for (let k = 0; k <= 150; k++) {
      const b = world.spawn([Mesh3d, { mesh }], Transform, GridCell, [ChildOf, { parent: grid }])
      placeInGrid(world, b, grid, [(k + 0.5) * cs, 0, -DEPTH])
      beacons.push(b)
    }
    const shifts: OriginShiftData[] = []
    world.observe(OriginShift, ({ data }) => shifts.push(data))
    await settle(app)
    expect(world.resource(Gpu).errors).toEqual([])
    const counters = world.resource(RenderCounters)
    const resetsBefore = counters.taaResets
    expect(resetsBefore).toBe(1) // the history's first frame
    const store = world.resource(Instances)
    const camData = () => world.resource(Cameras).get(cam)!
    const exactProj = mat4.perspectiveReversedZ(mat4.create(), (45 * Math.PI) / 180, W / H, 0.1)

    const speed = 5000
    const dt = 1 / 60
    let x = 0
    const prevVp = new Float64Array(16)
    let prev: { k: number; render: [number, number]; exact: [number, number]; pos: number[] }[] = []
    let worstStep = 0
    let worstReproject = 0
    let worstPrevRow = 0
    let checked = 0
    let crossingsChecked = 0
    let velocityChecked = false
    for (let frame = 0; frame < 3600; frame++) {
      x += speed * dt
      placeInGrid(world, cam, grid, [x, 0, 0])
      const before = shifts.length
      // The beacon nearest the camera: its instance record before this frame's update.
      const kNear = Math.max(0, Math.min(150, Math.round(x / cs - 0.5)))
      const slot = world.get(beacons[kNear]!, InstanceSlot).slot - 1
      const oldRow = Array.from(
        store.f32.subarray(slot * INSTANCE_FLOATS, slot * INSTANCE_FLOATS + 12),
      )
      // On the first crossing, read the GPU's motion vectors too.
      const crossing = Math.round(x / cs) !== Math.round((x - speed * dt) / cs)
      const velocity =
        crossing && !velocityChecked ? captureBuffer(world, `camera:${cam}`, 'velocity') : undefined
      app.update(dt)
      const shifted = shifts.length > before
      const off = shifted ? shifts.at(-1)!.offset : [0, 0, 0]
      if (shifted) {
        // Last frame's transform, moved into the new frame, is this frame's previous transform.
        for (const r of [3, 7, 11]) {
          const expected = oldRow[r]! + off[r === 3 ? 0 : r === 7 ? 1 : 2]!
          worstPrevRow = Math.max(worstPrevRow, Math.abs(store.prev[slot * 12 + r]! - expected))
        }
      }
      const c = camData()
      const cell = world.get(cam, GridCell).cell
      const camAbs = cell[0]! * cs + world.get(cam, Transform).translation[0]!
      const now: typeof prev = []
      for (let k = Math.max(0, kNear - 1); k <= Math.min(150, kNear + 1); k++) {
        const g = world.get(beacons[k]!, GlobalTransform).matrix
        const relExact = (k + 0.5) * cs - camAbs
        if (Math.abs(relExact) > 600) continue // off screen
        const render = screen(c.viewProjNoJitter, g[3]!, g[7]!, g[11]!, W, H)
        const exact = screen(exactProj, relExact, 0, -DEPTH, W, H)
        const pos = [g[3]!, g[7]!, g[11]!]
        now.push({ k, render, exact, pos })
        const p = prev.find((q) => q.k === k)
        if (!p) continue
        // Beyond the camera's motion (the exact step), the rendered step adds under 0.01 px.
        for (let a = 0; a < 2; a++) {
          const step = render[a]! - p.render[a]! - (exact[a]! - p.exact[a]!)
          worstStep = Math.max(worstStep, Math.abs(step))
        }
        // Reprojection: this frame's previous view-projection puts the beacon where it was.
        const back = screen(c.prevViewProj, pos[0]!, pos[1]!, pos[2]!, W, H)
        const was = screen(prevVp, p.pos[0]!, p.pos[1]!, p.pos[2]!, W, H)
        for (let a = 0; a < 2; a++)
          worstReproject = Math.max(worstReproject, Math.abs(back[a]! - was[a]!))
        checked++
        if (shifted) crossingsChecked++
      }
      prev = now
      prevVp.set(c.viewProjNoJitter)
      if (velocity) {
        app.update(0) // the capture resolves after the frame it was requested in
        const v = await velocity
        const k = Math.round(x / cs - 0.5)
        const g = world.get(beacons[k]!, GlobalTransform).matrix
        const c = camData()
        // Where the beacon is this frame, and how far it moved on screen since the last one.
        const now = screen(c.prevViewProj, g[3]!, g[7]!, g[11]!, W, H)
        const px = Math.round(now[0]!)
        const py = Math.round(now[1]!)
        const o = (py * W + px) * 4
        // The pixel shows the cube's front face, 30 m nearer than its centre.
        const exactStep = ((-speed * dt * exactProj[0]!) / (DEPTH - 30) / 2) * W
        expect(v.data[o]! * W).toBeCloseTo(exactStep, 1)
        expect(Math.abs(v.data[o + 1]! * H)).toBeLessThan(0.05)
        velocityChecked = true
      }
    }
    expect(world.get(cam, GridCell).cell[0]).toBe(150)
    expect(shifts.length).toBe(150)
    expect(velocityChecked).toBe(true)
    expect(counters.originShifts).toBe(150)
    expect(counters.taaResets).toBe(resetsBefore)
    expect(crossingsChecked).toBeGreaterThanOrEqual(150)
    expect(checked).toBeGreaterThan(1000)
    expect(worstStep).toBeLessThan(0.01)
    expect(worstReproject).toBeLessThan(0.01)
    // f32 spacing at ~1 km is 6e-5 m.
    expect(worstPrevRow).toBeLessThan(2e-4)
    expect(world.resource(Gpu).errors).toEqual([])
  }, 120_000)

  it('shifts retained gizmo lines with the origin and draws the grids overlay', async () => {
    const { app, world } = await scene(32, 32)
    const cs = 100
    const grid = world.spawn([Grid, { cellSize: cs, hysteresis: 10 }])
    const ship = world.spawn(Transform, GridCell, [ChildOf, { parent: grid }], FloatingOrigin)
    let draw = true
    app.addSystems(
      Update,
      defineSystem({
        name: 'test/draw-trail',
        run: (_, w) => {
          if (!draw) return
          draw = false
          const g = w.resource(Gizmos)
          g.line([40, 0, 0], [50, 1, 2], [1, 0, 0, 1], { duration: 10 })
          g.label([45, 0, 0], 'mark', [1, 1, 1, 1], { duration: 10 })
        },
      }),
    )
    app.update(1 / 60)
    const g = world.resource(Gizmos)
    expect(g.describe().lines[0]!.from).toEqual([40, 0, 0])
    // Cross into cell 1: the origin moves +100 m, so what was at x = 40 is now at x = -60.
    world.set(ship, Transform, { translation: [120, 0, 0] })
    app.update(1 / 60)
    expect(Array.from(world.get(ship, GridCell).cell)).toEqual([1, 0, 0])
    const d = g.describe()
    expect(d.lines[0]!.from).toEqual([-60, 0, 0])
    expect(d.lines[0]!.to).toEqual([-50, 1, 2])
    expect(d.labels[0]!.position).toEqual([-55, 0, 0])

    setOverlays(world, { grids: true })
    app.update(1 / 60)
    const lines = g.describe(10_000).lines.filter((l) => l.width === 2.5)
    expect(lines).toHaveLength(12)
    for (const l of lines)
      for (const v of [...l.from, ...l.to]) expect(Math.abs(v)).toBeCloseTo(cs / 2, 5)
    expect(g.overlay.lineCount).toBe(12 + 48)
    setOverlays(world, { grids: false })
    app.update(1 / 60)
    expect(g.overlay.lineCount).toBe(0)
  })
})
