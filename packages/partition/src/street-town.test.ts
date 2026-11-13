import type { Entity } from '@aethervtt/shard-core'
import { Rng } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  Cameras,
  Culler,
  captureView,
  DirectionalLight,
  DynamicCaster,
  Exposure,
  ForwardStateResource,
  forwardPlugin,
  Instances,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  type OcclusionBuffer,
  OcclusionCulling,
  OcclusionPath,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  visibleSlots,
} from '@aethervtt/shard-render'
import { Roof, structurePlugin } from '@aethervtt/shard-structure'
import { lookAt, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { moveTo, spawnSource, spawnTown, steps, townApp } from './fixtures/apps'
import { defineStreetTown, streetAt } from './fixtures/street-town'

// 0116 on the street town: draws, instances and dynamic shadow casters with occlusion against
// without, from street level, on the CPU cull (exact counts). Two cameras share every transform;
// only one has OcclusionCulling.

const TOWN = defineStreetTown()

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('occlusion at street level in the street town (0116)', () => {
  it('draws fewer meshes, instances and dynamic shadows, and renders the same', {
    timeout: timeout(600_000),
  }, async () => {
    const app = await townApp({
      extra: [
        renderPlugin({ gpu, windowView: false }),
        forwardPlugin({ msaa: 1 }),
        structurePlugin,
      ],
    })
    const world = app.world
    world.resource(Culler).enabled = false
    const targets = world.resource(RenderTargets)
    const target = (label: string) => {
      const t = new OffscreenTarget(gpu, { label, width: 160, height: 90 })
      return { t, ref: targets.add(t, label) }
    }
    const a = target('street/occluded')
    const b = target('street/plain')
    const camera = (ref: unknown, occlusion: boolean) =>
      world.spawn(
        [Camera3d, { target: ref as never, fovY: 60 }],
        [Exposure, { ev100: 12 }],
        Transform,
        ...(occlusion ? [[OcclusionCulling, {}] as const] : []),
      )
    const occludedCam = camera(a.ref, true)
    const plainCam = camera(b.ref, false)
    world.spawn(
      [DirectionalLight, { illuminance: 20_000, shadows: true, shadowUpdate: 'on-change' }],
      [Transform, { rotation: lookAt([0, 0, 0], [-0.5, -0.7, 0.4]) }],
    )
    spawnTown(world, TOWN)
    const start = streetAt(-2, 0)
    const source = spawnSource(world, start[0], start[2])
    const place = (eye: [number, number, number], at: [number, number, number]) => {
      for (const cam of [occludedCam, plainCam])
        world.set(cam, Transform, { translation: eye, rotation: lookAt(eye, at) })
    }
    place(start, [start[0] + 20, 1.5, start[2]])
    await steps(app, 120)
    // Indoor furniture (static) and characters (dynamic) along the walk.
    const meshes = world.resource(Meshes)
    const material = world.resource(Materials).add(new MaterialAsset({ roughness: 0.8 }))
    const prop = meshes.add(cube({ size: 0.8 }))
    const body = meshes.add(cube({ size: 1 }))
    const rng = new Rng(3)
    // House footprints, from their roofs: furniture and half the characters go indoors.
    const houses: [number, number, number, number][] = []
    for (const e of world.query({ with: [Roof] }).entities()) {
      const pts = world.get(e, Roof).points as [number, number][]
      const xs = pts.map((p) => p[0])
      const zs = pts.map((p) => p[1])
      houses.push([
        Math.min(...xs) + 0.6,
        Math.min(...zs) + 0.6,
        Math.max(...xs) - 0.6,
        Math.max(...zs) - 0.6,
      ])
    }
    expect(houses.length).toBeGreaterThan(20)
    const inside = (): [number, number] => {
      const h = houses[rng.int(0, houses.length - 1)]!
      return [rng.range(h[0], h[2]), rng.range(h[1], h[3])]
    }
    for (const h of houses) {
      for (let i = 0; i < 12; i++) {
        const [x, z] = [rng.range(h[0], h[2]), rng.range(h[1], h[3])]
        world.spawn(
          [Mesh3d, { mesh: prop }],
          [MeshMaterial, { material }],
          [Transform, { translation: [x, 0.4, z] }],
        )
      }
    }
    const characters: Entity[] = []
    for (let i = 0; i < 300; i++) {
      // Half on the streets of the five nearest rows of cells, half indoors.
      const row = rng.int(-2, 2) * 64
      const [x, z] = i % 2 === 0 ? [rng.range(-192, 192), row + rng.range(1, 11)] : inside()
      characters.push(
        world.spawn(
          [Mesh3d, { mesh: body }],
          [MeshMaterial, { material }],
          [Transform, { translation: [x, 0.9, z], scale: [0.5, 1.8, 0.5] }],
          DynamicCaster,
        ),
      )
    }
    const store = world.resource(Instances)
    const fwd = world.resource(ForwardStateResource)
    const cams = world.resource(Cameras)
    const dynamicIn = (cam: Entity): number => {
      const pv = fwd.views.get(`camera:${cam}`)
      if (!pv) return 0
      let n = 0
      for (let i = 0; i < pv.cascades.count; i++) {
        const v = pv.cascades.dynamic[i]!
        if (!v.redraw) continue
        n += visibleSlots(store, v.draws).size
      }
      return n
    }
    const totals = { draws: [0, 0], instances: [0, 0], shadows: [0, 0] }
    const ms: number[] = []
    let identical = 0
    // The walk: along the street, looking ahead, then across into the lots, then back.
    const length = timingMode === 'bench' ? 512 : 192
    const samples = 24
    for (let k = 0; k < samples; k++) {
      const t = k / (samples - 1)
      const x = start[0] + t * length
      const eye: [number, number, number] = [x, 2.6, start[2]]
      const yaw = (k % 6) * (Math.PI / 3)
      place(eye, [x + Math.cos(yaw) * 20, 1.5, start[2] + Math.sin(yaw) * 20])
      moveTo(world, source, x, start[2])
      // Characters shuffle about (indoors, they stay inside).
      for (const c of characters) {
        const p = world.get(c, Transform).translation
        const step: [number, number, number] = [
          p[0] + rng.range(-0.1, 0.1),
          0.9,
          p[2] + rng.range(-0.1, 0.1),
        ]
        world.set(c, Transform, { translation: step, scale: [0.5, 1.8, 0.5] })
      }
      await steps(app, 8)
      const capture = k % 8 === 0
      const shots = capture
        ? [captureView(world, `camera:${occludedCam}`), captureView(world, `camera:${plainCam}`)]
        : undefined
      app.update(1 / 60)
      const [ca, cb] = [cams.get(occludedCam)!, cams.get(plainCam)!]
      totals.draws[0]! += ca.draws.length
      totals.draws[1]! += cb.draws.length
      totals.instances[0]! += ca.draws.visible
      totals.instances[1]! += cb.draws.visible
      totals.shadows[0]! += dynamicIn(occludedCam)
      totals.shadows[1]! += dynamicIn(plainCam)
      ms.push(
        (world.resource(OcclusionPath).bufferOf(occludedCam) as OcclusionBuffer | undefined)?.ms ??
          0,
      )
      if (shots) {
        const [ia, ib] = await Promise.all(shots)
        expect(ia!.data, `frame ${k}: the same picture with occlusion`).toEqual(ib!.data)
        identical++
      }
    }
    const ratio = (pair: number[]) => pair[0]! / Math.max(1, pair[1]!)
    expect(identical).toBeGreaterThan(0)
    // Occlusion culls at street level, always; by how much is the bench's budget. Measured over this
    // walk (Apple M5 Max, 2026-11-13): draws 0.19x, instances 0.15x, dynamic shadow casters 0.57x;
    // occlusion 0.6 ms median per frame.
    expect(totals.draws[0]).toBeLessThan(totals.draws[1]!)
    expect(totals.instances[0]).toBeLessThan(totals.instances[1]!)
    expect(totals.shadows[0]).toBeLessThanOrEqual(totals.shadows[1]!)
    expect(ratio(totals.draws)).toBeLessThanOrEqual(budget('render/occlusion-draws'))
    expect(ratio(totals.instances)).toBeLessThanOrEqual(budget('render/occlusion-instances'))
    expect(ratio(totals.shadows)).toBeLessThanOrEqual(budget('render/occlusion-shadow-instances'))
    ms.sort((x, y) => x - y)
    expect(ms[Math.floor(ms.length * 0.95)]!).toBeLessThanOrEqual(budget('render/occlusion'))
    await app.dispose()
    a.t.destroy()
    b.t.destroy()
  })
})
