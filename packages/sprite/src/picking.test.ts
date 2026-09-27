import { type Entity, mat4, ray } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  cameraOf,
  DebugOverlays,
  forwardPlugin,
  Gpu,
  Lod,
  Mesh3d,
  Meshes,
  OffscreenTarget,
  pick,
  RenderTargets,
  renderPlugin,
  Views,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { spritePlugin } from './plugin'
import { Sprite } from './sprite'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

describe('GPU picking (spec 0027)', () => {
  it('returns the entity, path, and position (within 1 cm) for 20 pixels of instanced, LOD, and sprite entities', async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
      spritePlugin,
    )
    await app.init()
    const world = app.world
    const W = 160
    const H = 120
    const target = world
      .resource(RenderTargets)
      .add(new OffscreenTarget(gpu, { label: 'pick', width: W, height: H }), 'pick')
    const names = new Map<Entity, string>()
    const box = world.resource(Meshes).add(cube({ size: 1 }))
    // Front faces (and sprite planes) facing the camera, at these depths.
    const faceZ = new Map<Entity, number>()
    for (let i = 0; i < 6; i++) {
      const e = world.spawn(
        [Mesh3d, { mesh: box }],
        [Transform, { translation: [-3.75 + i * 1.5, 1.6, 0] }],
      )
      names.set(e, `crates/${i}`)
      faceZ.set(e, 0.5)
    }
    for (let i = 0; i < 3; i++) {
      const e = world.spawn(
        [Mesh3d, { mesh: box }],
        [
          Lod,
          {
            levels: [
              { mesh: box, screenSize: 0.5 },
              { mesh: box, screenSize: 0 },
            ],
          },
        ],
        [Transform, { translation: [-2.5 + i * 2.5, 0, -1] }],
      )
      names.set(e, `rocks/${i}`)
      faceZ.set(e, -0.5)
    }
    const white = world
      .resource(Textures)
      .add(Texture.create({ width: 4, height: 4, mips: [new Uint8Array(64).fill(255)] }))
    for (let i = 0; i < 4; i++) {
      const e = world.spawn(
        [Sprite, { texture: white as never, size: [1, 1] }],
        [Transform, { translation: [-3 + i * 2, -1.6, 0.2] }],
      )
      names.set(e, `signs/${i}`)
      faceZ.set(e, 0.2)
    }
    world.resource(DebugOverlays).name = (_, e) => names.get(e)
    const cam = world.spawn(
      [Camera3d, { target: target as never }],
      [Transform, { translation: [0, 0, 10] }],
    )
    await settle(app)

    const view = world.resource(Views).list.find((v) => v.name === `camera:${cam}`)!
    const c = cameraOf(view)!
    const toPixel = (x: number, y: number, z: number): [number, number] => {
      const m = c.viewProjNoJitter
      const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!
      const nx = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w
      const ny = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w
      return [Math.floor((nx * 0.5 + 0.5) * W), Math.floor((0.5 - ny * 0.5) * H)]
    }
    // Every entity's center, six more off center, and one background pixel: 20 samples.
    const samples: { x: number; y: number; expect: Entity | undefined }[] = []
    for (const [e] of names) {
      const t = world.get(e, Transform).translation
      const [x, y] = toPixel(t[0]!, t[1]!, faceZ.get(e)!)
      samples.push({ x, y, expect: e })
    }
    for (const [e] of [...names].slice(0, 6)) {
      const t = world.get(e, Transform).translation
      const [x, y] = toPixel(t[0]! + 0.3, t[1]! - 0.3, faceZ.get(e)!)
      samples.push({ x, y, expect: e })
    }
    samples.push({ x: 2, y: 2, expect: undefined })
    expect(samples).toHaveLength(20)

    const picks = samples.map((s) => pick(world, cam, s.x, s.y))
    let done = false
    const all = Promise.all(picks).finally(() => {
      done = true
    })
    for (let i = 0; i < 60 && !done; i++) {
      app.update(1 / 60)
      await world.resource(Gpu).pipelines.whenIdle()
      await new Promise((r) => setTimeout(r, 0))
    }
    const hits = await all

    const inv = mat4.invert(mat4.create(), c.viewProjNoJitter)!
    const r = ray.create()
    samples.forEach((s, i) => {
      const hit = hits[i]
      if (s.expect === undefined) {
        expect(hit).toBeUndefined()
        return
      }
      expect(hit?.entity, `pixel ${s.x},${s.y}`).toBe(s.expect)
      expect(hit!.path).toBe(names.get(s.expect))
      // Analytic: the pixel-center ray against the face's plane.
      ray.fromScreen(r, s.x + 0.5, s.y + 0.5, W, H, inv)
      const z = faceZ.get(s.expect)!
      const t = (z - r[2]!) / r[5]!
      const want = [r[0]! + r[3]! * t, r[1]! + r[4]! * t, z]
      for (let k = 0; k < 3; k++) expect(Math.abs(hit!.position[k]! - want[k]!)).toBeLessThan(0.01)
      expect(hit!.normal[2]).toBeGreaterThan(0.99)
      expect(hit!.distance).toBeCloseTo(Math.hypot(want[0]!, want[1]!, want[2]! - 10), 2)
    })
  })
})
