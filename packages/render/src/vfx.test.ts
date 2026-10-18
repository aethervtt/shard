import { ChildOf, defineComponent, PostUpdate, t } from '@aethervtt/shard-core'
import { cube, Mesh } from '@aethervtt/shard-mesh'
import { App, FrameDemand } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin, TransformSystems } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { Materials, Meshes } from './assets'
import { clipPlane, DECAL_TRIANGLE_BUDGET, Decals, describeDecals, updateDecals } from './decals'
import { Mesh3d, SkinnedMesh } from './instances'
import { describeRibbons, Ribbons, shiftRibbons, updateRibbons } from './ribbons'
import { Beam, Decal, DecalReceiver, Trail } from './vfx'
import { computeVisibility, Visibility } from './visibility'

const Extra = defineComponent('vfx-test/Extra', { value: t.f32() })
async function setup() {
  const app = new App().addPlugin(TransformPlugin)
  const w = app.world
  w.initResource(Ribbons)
  w.initResource(Decals)
  w.initResource(Meshes)
  w.initResource(Materials)
  app.addSystems(
    PostUpdate,
    computeVisibility.after(TransformSystems),
    updateRibbons.after(computeVisibility),
    updateDecals.after(computeVisibility),
  )
  await app.init()
  return { app, w }
}
function surface(w: App['world'], mask = 1) {
  const mesh = Mesh.create({
    positions: new Float32Array([-2, -2, 0, 2, -2, 0, 2, 2, 0, -2, 2, 0]),
    indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
  })
  return w.spawn(
    Transform,
    [Mesh3d, { mesh: w.resource(Meshes).add(mesh) }],
    [DecalReceiver, { mask }],
  )
}
it('uses schema bounds and retains finite bounded trail geometry through lifetime, pause, stops and teleports', async () => {
  const { app, w } = await setup()
  expect(Trail.validate({ capacity: 1 })).not.toHaveLength(0)
  const entity = w.spawn([
    Trail,
    {
      capacity: 4,
      lifetime: 1,
      minDistance: 0.01,
      breakDistance: 5,
      widthCurve: [
        { at: 0, value: 1 },
        { at: 1, value: 0 },
      ],
    },
  ])
  for (let i = 0; i < 8; i++) {
    w.set(entity, Transform, { translation: [i * 0.1, 0, 0] })
    app.update(0.05)
  }
  const r = w.resource(Ribbons).records[0]!
  expect(r.pointsCount).toBe(4)
  expect(r.count).toBe(18)
  expect(Array.from(r.vertices).every(Number.isFinite)).toBe(true)
  app.update(0)
  expect(r.pointsCount).toBe(4)
  w.set(entity, Trail, { paused: true })
  app.update(2)
  expect(r.pointsCount).toBe(4)
  w.set(entity, Trail, { paused: false, playing: false })
  app.update(0.4)
  expect(r.pointsCount).toBeGreaterThan(0)
  app.update(1)
  expect(r.pointsCount).toBe(0)
  expect(r.count).toBe(0)
  w.set(entity, Trail, { playing: true })
  app.update(0.01)
  w.set(entity, Transform, { translation: [100, 0, 0] })
  app.update(0.01)
  expect(r.pointsCount).toBe(1)
  w.set(entity, Trail, { capacity: 8 })
  app.update(0)
  expect(r.capacity).toBe(8)
  expect(r.pointsCount).toBe(1)
  w.remove(entity, Trail)
  app.update(0)
  expect(describeRibbons(w).records).toEqual([])
  await app.dispose()
})
it('follows bones/parents, rebinds moved archetypes, shifts history and isolates worlds', async () => {
  const { app, w } = await setup(),
    other = await setup()
  const parent = w.spawn([Transform, { translation: [5, 2, 0] }])
  const tip = w.spawn([ChildOf, { parent }], [Trail, { offset: [1, 0, 0] }])
  app.update(0.01)
  const r = w.resource(Ribbons).records[0]!
  expect(Array.from(r.points.slice(0, 3))).toEqual([6, 2, 0])
  w.add(tip, Extra)
  w.set(parent, Transform, { translation: [6, 2, 0] })
  app.update(0.01)
  expect(r.pointsCount).toBe(2)
  shiftRibbons(w, -5, 0, 0)
  expect(r.points[0]).toBe(1)
  w.set(parent, Transform, { translation: [1, 2, 0] })
  app.update(0)
  expect(r.pointsCount).toBe(2)
  expect(other.w.resource(Ribbons).records).toEqual([])
  w.despawn(tip)
  app.update(0)
  expect(w.resource(Ribbons).records).toHaveLength(0)
  await app.dispose()
  await other.app.dispose()
})
it('builds seeded beams with live targets, polylines, duplicate points and curve diagnostics', async () => {
  const { app, w } = await setup()
  const target = w.spawn([Transform, { translation: [3, 2, 0] }])
  const entity = w.spawn([Beam, { target, end: [0, 0, 0], noise: 0.2, seed: 17, segments: 8 }])
  app.update(0.01)
  const r = w.resource(Ribbons).records[0]!,
    original = r.vertices.slice()
  expect(r.pointsCount).toBe(9)
  expect(Array.from(r.points.slice(40, 43))).toEqual([3, 2, 0])
  app.update(0.01)
  expect(r.vertices).toEqual(original)
  w.set(target, Transform, { translation: [4, 2, 0] })
  app.update(0)
  expect(r.points[40]).toBe(4)
  w.despawn(target)
  app.update(0)
  expect(r.error).toBe('render/beam-target')
  expect(r.count).toBe(0)
  w.set(entity, Beam, {
    points: [
      [0, 0, 0],
      [0, 0, 0],
      [2, 0, 0],
    ],
  })
  app.update(0)
  expect(r.count).toBe(6)
  expect(Array.from(r.vertices).every(Number.isFinite)).toBe(true)
  w.set(entity, Beam, {
    widthCurve: [
      { at: 0.8, value: 1 },
      { at: 0.2, value: 0 },
    ],
  })
  app.update(0)
  expect(r.error).toBe('render/ribbon-curve')
  expect(r.count).toBe(0)
  await app.dispose()
})
it('clips decals to all box planes, caches projection and applies masks, transforms, fades and removals', async () => {
  const { app, w } = await setup()
  const receiver = surface(w)
  const entity = w.spawn([Decal, { size: [1, 1, 0.5], lifetime: 2, fadeOut: 1 }])
  app.update(0.1)
  const r = w.resource(Decals).records[0]!
  expect(r.count).toBeGreaterThan(0)
  for (let v = 0; v < r.count; v++) {
    expect(Math.abs(r.vertices[v * 14]!)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(r.vertices[v * 14 + 1]!)).toBeLessThanOrEqual(0.5)
    expect(r.vertices[v * 14 + 6]!).toBeGreaterThanOrEqual(0)
    expect(r.vertices[v * 14 + 7]!).toBeLessThanOrEqual(1)
  }
  const builds = r.rebuilds
  app.update(0.2)
  expect(r.rebuilds).toBe(builds)
  w.set(entity, Decal, { color: [1, 0, 0, 1], opacity: 0.8 })
  app.update(0)
  expect(r.rebuilds).toBe(builds)
  w.set(entity, Decal, { paused: true })
  app.update(3)
  expect(r.age).toBeCloseTo(0.3)
  w.set(entity, Decal, { paused: false })
  app.update(1.2)
  expect(r.opacity).toBeCloseTo(0.4)
  w.set(receiver, Transform, { translation: [0, 0, 2] })
  app.update(0)
  expect(r.count).toBe(0)
  w.set(receiver, Transform, { translation: [0, 0, 0] })
  w.set(entity, Decal, { receiverMask: 2 })
  app.update(0)
  expect(r.count).toBe(0)
  w.set(entity, Decal, { receiverMask: 1 })
  app.update(0)
  expect(r.count).toBeGreaterThan(0)
  w.add(receiver, Visibility, { mode: 'hidden' })
  app.update(0)
  expect(r.count).toBe(0)
  w.set(receiver, Visibility, { mode: 'visible' })
  app.update(0)
  expect(r.count).toBeGreaterThan(0)
  app.update(1)
  expect(r.count).toBe(0)
  w.despawn(entity)
  app.update(0)
  expect(describeDecals(w).records).toEqual([])
  await app.dispose()
})
it('rejects unsupported receivers, singular projectors and output overflow without partial marks', async () => {
  const { app, w } = await setup(),
    receiver = surface(w)
  const entity = w.spawn([Decal, { maxVertices: 3 }])
  app.update(0)
  const r = w.resource(Decals).records[0]!
  expect(r.error).toBe('render/decal-output-budget')
  expect(r.count).toBe(0)
  w.set(entity, Decal, { maxVertices: 128 })
  w.add(receiver, SkinnedMesh)
  app.update(0)
  expect(r.error).toBe('render/decal-unsupported-receiver')
  w.remove(receiver, SkinnedMesh)
  w.set(entity, Transform, { scale: [0, 1, 1] })
  app.update(0)
  expect(r.error).toBe('render/decal-singular')
  w.set(entity, Transform, { scale: [1, 1, 1] })
  w.set(entity, Decal, { size: [-1, 1, 1] })
  app.update(0)
  expect(r.error).toBe('render/decal-size')
  await app.dispose()
})
it('projects across multiple angled surfaces and rebuilds when mesh versions change', async () => {
  const { app, w } = await setup()
  const mesh = cube({ size: 1 }),
    ref = w.resource(Meshes).add(mesh)
  const receiver = w.spawn(Transform, [Mesh3d, { mesh: ref }], DecalReceiver)
  const entity = w.spawn(
    [Transform, { rotation: [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)] }],
    [Decal, { size: [2, 2, 2] }],
  )
  app.update(0)
  const r = w.resource(Decals).records[0]!
  expect(r.count).toBeGreaterThanOrEqual(12)
  const b = r.rebuilds
  mesh.update({ positions: mesh.positions.slice(), indices: mesh.indices })
  app.update(0)
  expect(r.rebuilds).toBe(b + 1)
  w.despawn(receiver)
  app.update(0)
  expect(r.count).toBe(0)
  expect(w.resource(FrameDemand)).toBeDefined()
  w.despawn(entity)
  app.update(0)
  await app.dispose()
})

it('initializes paused beams and enforces world record limits', async () => {
  const { app, w } = await setup()
  const beam = w.spawn([Beam, { paused: true }])
  app.update(0)
  const first = w.resource(Ribbons).records[0]!
  expect(first.count).toBeGreaterThan(0)
  const geometry = first.vertices.slice()
  w.set(beam, Transform, { translation: [9, 0, 0] })
  app.update(1)
  expect(first.vertices).toEqual(geometry)
  for (let i = 0; i < 256; i++) w.spawn(Trail)
  for (let i = 0; i < 65; i++) w.spawn(Decal)
  app.update(0)
  expect(w.resource(Ribbons).records).toHaveLength(256)
  expect(w.resource(Ribbons).rejected).toBe(1)
  expect(w.resource(Decals).records).toHaveLength(64)
  expect(w.resource(Decals).rejected).toBe(1)
  await app.dispose()
})
it('clips crossing and outside triangles on each of the six planes', () => {
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const input = new Float64Array(48),
        output = new Float64Array(48)
      input[axis] = 2 * sign
      input[3 + axis] = -sign
      input[6 + axis] = -sign
      input[3 + ((axis + 1) % 3)] = 2
      input[6 + ((axis + 1) % 3)] = -2
      const count = clipPlane(input, 3, output, axis, sign, 0.5)
      expect(count).toBe(4)
      for (let i = 0; i < count; i++) {
        expect(sign * output[i * 3 + axis]!).toBeLessThanOrEqual(0.5)
        expect(Array.from(output.slice(i * 3, i * 3 + 3)).every(Number.isFinite)).toBe(true)
      }
      input[3 + axis] = 2 * sign
      input[6 + axis] = 2 * sign
      expect(clipPlane(input, 3, output, axis, sign, 0.5)).toBe(0)
    }
  }
})
it('rejects excessive input triangles before projection', async () => {
  const { app, w } = await setup()
  const indices = new Uint32Array((DECAL_TRIANGLE_BUDGET + 1) * 3)
  for (let i = 0; i < indices.length; i++) indices[i] = i % 3
  const mesh = Mesh.create({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), indices })
  w.spawn(Transform, [Mesh3d, { mesh: w.resource(Meshes).add(mesh) }], DecalReceiver)
  w.spawn(Decal)
  app.update(0)
  expect(w.resource(Decals).records[0]!.error).toBe('render/decal-input-budget')
  expect(w.resource(Decals).records[0]!.count).toBe(0)
  await app.dispose()
})
