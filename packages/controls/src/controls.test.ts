import { defineSystem, type Entity, mat4, Update, type World } from '@aethervtt/shard-core'
import {
  Gesture,
  type GestureEvent,
  Gestures,
  gesturesPlugin,
  inputPlugin,
  type SimulatedGesture,
  simulateGestures,
} from '@aethervtt/shard-input'
import { Camera3d } from '@aethervtt/shard-render'
import { App, definePlugin, FrameDemand, type Plugin } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { ControlsSettings, MapControls, OrbitControls } from './components'
import { DragEnded, type DragEndedEvent, DragMoved, PlaneDrag } from './drag'
import { controlsPlugin, describeControls } from './plugin'
import { syncViews } from './sync'

const W = 1000
const H = 600
const DEG = Math.PI / 180

async function setup(...plugins: Plugin[]) {
  const app = new App().addPlugin(
    TransformPlugin,
    inputPlugin(),
    gesturesPlugin,
    controlsPlugin,
    ...plugins,
  )
  await app.init()
  app.world.resource(ControlsSettings).viewport = [W, H]
  const frame = () => app.update(1 / 60)
  const play = (gestures: SimulatedGesture[], after?: () => void) => {
    const n = simulateGestures(app.world, gestures)
    for (let i = 0; i < n; i++) {
      frame()
      after?.()
    }
  }
  return { app, world: app.world, frame, play }
}

function orbitCamera(world: World, fields: Partial<Record<string, unknown>> = {}, active = true) {
  return world.spawn(
    [Camera3d, { projection: 'perspective', fovY: 50, active }],
    [OrbitControls, { target: [1, 0, -2], distance: 20, yaw: 30, pitch: 50, ...fields }],
  )
}

function mapCamera(world: World, fields: Partial<Record<string, unknown>> = {}, active = true) {
  return world.spawn(
    [Camera3d, { projection: 'orthographic', near: 0.1, far: 200, active }],
    [MapControls, { target: [3, 0, 4], height: 20, zoom: 1, ...fields }],
  )
}

// Projection the way render/extract-cameras builds it, from the camera's Transform: independent
// of the controls' own view math.
function viewProj(world: World, camera: Entity): Float32Array {
  const t = world.get(camera, Transform)
  const c = world.get(camera, Camera3d)
  const model = mat4.fromTRS(mat4.create(), t.translation, t.rotation, [1, 1, 1])
  const view = mat4.invert(mat4.create(), model)!
  const aspect = W / H
  const proj = mat4.create()
  if (c.projection === 'perspective') mat4.perspectiveReversedZ(proj, c.fovY * DEG, aspect, c.near)
  else {
    const h = c.orthoHeight / 2
    mat4.orthographicReversedZ(proj, -h * aspect, h * aspect, -h, h, c.near, c.far)
  }
  return mat4.multiply(mat4.create(), proj, view)
}

function toScreen(world: World, camera: Entity, p: ArrayLike<number>): [number, number] {
  const m = viewProj(world, camera)
  const x = m[0]! * p[0]! + m[4]! * p[1]! + m[8]! * p[2]! + m[12]!
  const y = m[1]! * p[0]! + m[5]! * p[1]! + m[9]! * p[2]! + m[13]!
  const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!
  return [((x / w) * 0.5 + 0.5) * W, (0.5 - (y / w) * 0.5) * H]
}

function floorUnder(
  world: World,
  camera: Entity,
  x: number,
  y: number,
  axis: 1 | 2 = 1,
): [number, number, number] {
  const inv = mat4.invert(mat4.create(), viewProj(world, camera))!
  const nx = (x / W) * 2 - 1
  const ny = 1 - (y / H) * 2
  const at = (d: number) => {
    const w = inv[3]! * nx + inv[7]! * ny + inv[11]! * d + inv[15]!
    return [0, 1, 2].map(
      (k) => (inv[k]! * nx + inv[4 + k]! * ny + inv[8 + k]! * d + inv[12 + k]!) / w,
    )
  }
  const a = at(1)
  const b = at(0.5)
  const t = -a[axis]! / (b[axis]! - a[axis]!)
  const p = [0, 1, 2].map((k) => a[k]! + (b[k]! - a[k]!) * t) as [number, number, number]
  p[axis] = 0
  return p
}

function distance(a: ArrayLike<number>, b: ArrayLike<number>): number {
  return Math.sqrt((a[0]! - b[0]!) ** 2 + (a[1]! - b[1]!) ** 2)
}

// The orbit camera, the map looking down, the map tilted as Aether's is, and a 2D world's.
const KINDS = ['orbit', 'map', 'map-tilted', 'map-2d'] as const

function spawnKind(world: World, kind: (typeof KINDS)[number]): Entity {
  if (kind === 'orbit') return orbitCamera(world)
  if (kind === 'map') return mapCamera(world)
  if (kind === 'map-tilted') return mapCamera(world, { pitch: 70 })
  return mapCamera(world, { plane: 'xy', target: [3, 4, 0] })
}

describe('controls (0060)', () => {
  for (const kind of KINDS) {
    const axis = kind === 'map-2d' ? 2 : 1
    it(`${kind}: wheel zoom and pinch keep the floor point under the cursor within 0.5 px`, async () => {
      const { world, frame, play } = await setup()
      const camera = spawnKind(world, kind)
      frame()
      const cursor: [number, number] = [780, 410]
      const p = floorUnder(world, camera, ...cursor, axis)
      for (const dy of [100, 100, -300, 40, -120]) {
        play([{ wheel: { at: cursor, dy } }])
        expect(distance(toScreen(world, camera, p), cursor)).toBeLessThan(0.5)
      }
      const center: [number, number] = [300, 220]
      const q = floorUnder(world, camera, ...center, axis)
      play([{ pinch: { center, from: 120, to: 260, frames: 8 } }])
      expect(distance(toScreen(world, camera, q), center)).toBeLessThan(0.5)
      play([{ pinch: { center, from: 300, to: 90, frames: 8 } }])
      expect(distance(toScreen(world, camera, q), center)).toBeLessThan(0.5)
      // A trackpad pinch (a ctrl wheel) zooms the same way.
      play([{ wheel: { at: cursor, dy: -30, modifiers: 2 } }])
      expect(distance(toScreen(world, camera, p), cursor)).toBeLessThan(0.5)
    })

    it(`${kind}: panning keeps the grabbed floor point under the pointer over a 400 px drag`, async () => {
      const { world, frame, play } = await setup()
      const camera = spawnKind(world, kind)
      frame()
      const from: [number, number] = [300, 350]
      const to: [number, number] = [620, 110] // 400 px
      const grabbed = floorUnder(world, camera, ...from, axis)
      const steps = 20
      let step = -1
      play([{ drag: { from, to, button: 'middle', frames: steps } }], () => {
        step++
        if (step < 1 || step > steps) return
        const at = [
          from[0] + ((to[0] - from[0]) * step) / steps,
          from[1] + ((to[1] - from[1]) * step) / steps,
        ]
        expect(distance(toScreen(world, camera, grabbed), at)).toBeLessThan(0.5)
      })
      expect(distance(toScreen(world, camera, grabbed), to)).toBeLessThan(0.5)
      // A left drag on empty floor pans too (nothing else claimed it).
      const left = floorUnder(world, camera, 500, 300, axis)
      if (kind !== 'orbit') {
        play([{ drag: { from: [500, 300], to: [400, 250] } }])
        expect(distance(toScreen(world, camera, left), [400, 250])).toBeLessThan(0.5)
      }
    })
  }

  it('orbit: right drag orbits, Shift+right pans, twist yaws', async () => {
    const { world, frame, play } = await setup()
    const camera = orbitCamera(world)
    frame()
    play([{ drag: { from: [500, 300], to: [600, 250], button: 'right' } }])
    const o = world.get(camera, OrbitControls)
    expect(o.yaw).toBeCloseTo(30 - 100 * 0.3, 3)
    expect(o.pitch).toBeCloseTo(50 - 50 * 0.3, 3)
    const target = [...o.target]
    play([{ drag: { from: [500, 300], to: [520, 300], button: 'right', modifiers: 1 } }])
    expect(world.get(camera, OrbitControls).yaw).toBeCloseTo(0, 3)
    expect(world.get(camera, OrbitControls).target).not.toEqual(target)
    play([{ pinch: { center: [500, 300], from: 200, to: 200, twist: Math.PI / 4, frames: 6 } }])
    expect(world.get(camera, OrbitControls).yaw).toBeCloseTo(45, 1)
  })

  it('a drag on an inactive camera moves nothing; switching active changes neither control', async () => {
    const { world, frame, play } = await setup()
    const map = mapCamera(world)
    const table = orbitCamera(world, {}, false)
    frame()
    const before = { map: world.get(map, MapControls), table: world.get(table, OrbitControls) }
    const tableTransform = world.get(table, Transform)
    play([
      { drag: { from: [500, 300], to: [600, 250], button: 'right' } },
      { wheel: { at: [500, 300], dy: 200 } },
    ])
    expect(world.get(table, OrbitControls)).toEqual(before.table)
    expect(world.get(table, Transform)).toEqual(tableTransform)
    const mapAfter = world.get(map, MapControls)
    expect(mapAfter.zoom).not.toBe(before.map.zoom) // the active one zoomed
    world.set(map, Camera3d, { active: false })
    world.set(table, Camera3d, { active: true })
    frame()
    frame()
    expect(world.get(map, MapControls)).toEqual(mapAfter)
    expect(world.get(table, OrbitControls)).toEqual(before.table)
  })

  it('syncViews from Map to Tabletop keeps the target and the visible floor width within 10%', async () => {
    const { world, frame } = await setup()
    const map = mapCamera(world, { zoom: 2.5, target: [7, 0, -3] })
    const table = orbitCamera(world, { pitch: 35, yaw: 70 }, false)
    frame()
    const width = (camera: Entity) => {
      const a = floorUnder(world, camera, 0, H / 2)
      const b = floorUnder(world, camera, W, H / 2)
      return Math.sqrt((a[0] - b[0]) ** 2 + (a[2] - b[2]) ** 2)
    }
    const mapWidth = width(map)
    syncViews(world, map, table)
    world.set(map, Camera3d, { active: false })
    world.set(table, Camera3d, { active: true })
    frame()
    expect(world.get(table, OrbitControls).target).toEqual([7, 0, -3])
    expect(Math.abs(width(table) / mapWidth - 1)).toBeLessThan(0.1)
    // And back.
    world.set(table, OrbitControls, { distance: 33 })
    frame()
    const tableWidth = width(table)
    syncViews(world, table, map)
    world.set(table, Camera3d, { active: false })
    world.set(map, Camera3d, { active: true })
    frame()
    expect(Math.abs(width(map) / tableWidth - 1)).toBeLessThan(0.1)
  })

  it('pitch and zoom stay within their limits under any input sequence', async () => {
    let seed = 12345
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 2 ** 32
    }
    const point = (): [number, number] => [rand() * W, rand() * H]
    const { world, frame, play } = await setup()
    const orbit = orbitCamera(world, {
      minDistance: 4,
      maxDistance: 60,
      minPitch: 15,
      maxPitch: 80,
    })
    frame()
    const map = mapCamera(world, { minZoom: 0.5, maxZoom: 4 }, false)
    for (let round = 0; round < 2; round++) {
      for (let i = 0; i < 60; i++) {
        const r = rand()
        const g: SimulatedGesture =
          r < 0.3
            ? { wheel: { at: point(), dy: (rand() - 0.5) * 4000 } }
            : r < 0.6
              ? {
                  drag: {
                    from: point(),
                    to: point(),
                    button: (['left', 'middle', 'right'] as const)[Math.floor(rand() * 3)],
                    frames: 3,
                  },
                }
              : r < 0.8
                ? {
                    pinch: {
                      center: point(),
                      from: 20 + rand() * 400,
                      to: 20 + rand() * 400,
                      twist: rand() * 3,
                      frames: 3,
                    },
                  }
                : { wheel: { at: point(), dy: (rand() - 0.5) * 400, modifiers: 2 } }
        play([g], () => {
          const o = world.get(orbit, OrbitControls)
          expect(o.pitch).toBeGreaterThanOrEqual(15 - 1e-4)
          expect(o.pitch).toBeLessThanOrEqual(80 + 1e-4)
          expect(o.distance).toBeGreaterThanOrEqual(4 - 1e-4)
          expect(o.distance).toBeLessThanOrEqual(60 + 1e-4)
          const m = world.get(map, MapControls)
          expect(m.zoom).toBeGreaterThanOrEqual(0.5 - 1e-6)
          expect(m.zoom).toBeLessThanOrEqual(4 + 1e-6)
        })
      }
      world.set(orbit, Camera3d, { active: false })
      world.set(map, Camera3d, { active: true })
    }
  })

  it('smoothing eases the camera and holds frames only while it moves', async () => {
    const { world, frame, play } = await setup()
    const camera = orbitCamera(world, { smoothing: 0.1 })
    frame()
    const start = world.get(camera, Transform).translation
    play([{ wheel: { at: [500, 300], dy: 400 } }])
    const demand = world.resource(FrameDemand)
    expect(demand.isHeld('controls')).toBe(true)
    const mid = world.get(camera, Transform).translation
    expect(mid).not.toEqual(start)
    for (let i = 0; i < 200 && demand.isHeld('controls'); i++) frame()
    expect(demand.isHeld('controls')).toBe(false)
    const end = world.get(camera, Transform).translation
    expect(end).not.toEqual(mid)
    // Reduced motion: at once.
    world.resource(ControlsSettings).reducedMotion = true
    play([{ wheel: { at: [500, 300], dy: -400 } }])
    expect(demand.isHeld('controls')).toBe(false)
    // A turntable holds frames while it turns.
    world.set(camera, OrbitControls, { autoRotate: 10 })
    frame()
    const yaw = world.get(camera, OrbitControls).yaw
    frame()
    expect(world.get(camera, OrbitControls).yaw).toBeCloseTo(yaw + 10 / 60, 3)
    expect(demand.isHeld('controls')).toBe(true)
    const described = describeControls(world)
    expect(described.controls[0]).toMatchObject({ kind: 'orbit', active: true, moving: true })
  })
})

describe('PlaneDrag (0060)', () => {
  // The host: on a left drag-start, drag the token if the pointer is on it (a stand-in for pick),
  // snapping to 1 m cells. `delay` frames of deciding model an async pick.
  function hostPlugin(token: () => Entity, camera: () => Entity, delay = 0): Plugin {
    const pending: { event: GestureEvent; frames: number }[] = []
    const host = defineSystem({
      name: 'test/host',
      setup: (world) => world.reader(Gesture),
      run: (reader, world) => {
        for (const e of reader.read()) {
          if (e.kind !== 'drag-start' || e.button !== 'left') continue
          const at = toScreen(world, camera(), world.get(token(), Transform).translation)
          if (distance(at, [e.startX, e.startY]) > 20) continue
          if (delay > 0) world.resource(Gestures).hold(e.id)
          pending.push({ event: { ...e }, frames: delay })
        }
        for (let i = pending.length - 1; i >= 0; i--) {
          const p = pending[i]!
          if (p.frames-- > 0) continue
          pending.splice(i, 1)
          world.resource(PlaneDrag).begin({
            entity: token(),
            gesture: p.event,
            snap: (q) => {
              q[0] = Math.floor(q[0]) + 0.5
              q[2] = Math.floor(q[2]) + 0.5
            },
          })
          if (delay > 0) world.resource(Gestures).release(p.event.id)
        }
      },
    })
    return definePlugin({
      name: 'test/host',
      build(app) {
        app.addSystems(Update, host)
      },
    })
  }

  async function dragSetup(delay = 0) {
    let token = 0 as Entity
    let camera = 0 as Entity
    const s = await setup(
      hostPlugin(
        () => token,
        () => camera,
        delay,
      ),
    )
    camera = mapCamera(s.world, { target: [0, 0, 0] })
    token = s.world.spawn([Transform, { translation: [0.5, 0, 0.5] }])
    s.frame()
    const ended: DragEndedEvent[] = []
    const moved = s.world.reader(DragMoved)
    const endReader = s.world.reader(DragEnded)
    let moves = 0
    const collect = () => {
      moves += moved.read().length
      for (const e of endReader.read()) ended.push({ ...e })
    }
    return { ...s, token, camera, ended, collect, moves: () => moves }
  }

  it('drags along the floor, snapping to cell centers, without panning the map', async () => {
    const { world, play, token, camera, ended, collect, moves } = await dragSetup()
    const cameraBefore = world.get(camera, Transform)
    const from = toScreen(world, camera, [0.5, 0, 0.5])
    play([{ drag: { from, to: [from[0] + 157, from[1] + 93], frames: 12 } }], collect)
    const p = world.get(token, Transform).translation
    expect((p[0] - 0.5) % 1).toBeCloseTo(0)
    expect((p[2] - 0.5) % 1).toBeCloseTo(0)
    expect(p[0]).toBeGreaterThan(5)
    expect(p[2]).toBeGreaterThan(2)
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ entity: token, cancelled: false, start: [0.5, 0, 0.5] })
    expect(ended[0]!.position).toEqual([...p])
    expect(moves()).toBeGreaterThan(1)
    expect(world.get(camera, Transform)).toEqual(cameraBefore)
  })

  it('Escape mid-drag restores the start transform and ends cancelled', async () => {
    const { world, play, token, ended, collect, camera } = await dragSetup()
    const from = toScreen(world, camera, [0.5, 0, 0.5])
    play([{ drag: { from, to: [from[0] + 200, from[1]], frames: 6, cancel: true } }], collect)
    expect(world.get(token, Transform).translation).toEqual([0.5, 0, 0.5])
    expect(ended).toHaveLength(1)
    expect(ended[0]).toMatchObject({ cancelled: true, position: [0.5, 0, 0.5] })
  })

  it('a host that decides asynchronously holds the drag: the map waits, the drag catches up', async () => {
    const { world, play, token, camera, ended, collect } = await dragSetup(3)
    const cameraBefore = world.get(camera, Transform)
    const from = toScreen(world, camera, [0.5, 0, 0.5])
    play([{ drag: { from, to: [from[0] + 100, from[1]], frames: 8 } }], collect)
    expect(world.get(camera, Transform)).toEqual(cameraBefore)
    expect(ended).toHaveLength(1)
    expect(ended[0]!.cancelled).toBe(false)
    expect(world.get(token, Transform).translation[0]).toBeGreaterThan(3)
  })
})
