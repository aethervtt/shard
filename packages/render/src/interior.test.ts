import type { AssetRef } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import {
  COVER_SCALE,
  COVER_ZERO,
  INTERIOR_GROUND,
  InteriorLightingResource,
  ROW_CLEAR,
  ROW_SCALE,
  ROW_ZERO,
  VISIBILITY_MAX,
} from './interior-plugin'
import { AmbientLight, Lights, PointLight, setLightRow } from './lights'
import { describeRender, Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'
import { Cameras, RenderPath, Tonemapping } from './view'

// Interior lighting's render half (0069), filled by hand: structure's tests fill it from a plan.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 64
const H = 64
/** World units across the top-down view. */
const SPAN = 8

/** A grey floor seen from above under uniform ambient, and a torch over its left half. */
async function scene(o: { deferred?: boolean; torch?: boolean } = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'interior', width: W, height: H })
  const ref = world.resource(RenderTargets).add(target, 'interior') as AssetRef<'RenderTarget'>
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 20 })) }],
    [
      MeshMaterial,
      {
        material: materials.add(new MaterialAsset({ baseColor: [0.6, 0.6, 0.6, 1], roughness: 1 })),
      },
    ],
    Transform,
  )
  Object.assign(world.resource(AmbientLight), { brightness: o.torch ? 0 : 2000 })
  const torch = o.torch
    ? world.spawn(
        [
          PointLight,
          { intensity: 30_000, range: 10, falloff: 'tabletop', bright: 6, blockedByWalls: true },
        ],
        [Transform, { translation: [-2, 1, 0] }],
      )
    : undefined
  world.spawn(
    [Camera3d, { target: ref, projection: 'orthographic', orthoHeight: SPAN, far: 100 }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    ...(o.deferred ? [[RenderPath, { mode: 'deferred' }] as const] : []),
    [Transform, { translation: [0, 20, 0.0001], rotation: lookAt([0, 20, 0.0001], [0, 0, 0]) }],
  )
  // Something blocking-sized, so the scene isn't only a plane.
  world.spawn(
    [Mesh3d, { mesh: world.resource(Meshes).add(box({ x: 0.2, y: 0.2, z: 0.2 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.9, 0.1, 0.1, 1] })) },
    ],
    [Transform, { translation: [3.5, 0.1, 3.5] }],
  )
  await settle(app)
  return {
    app,
    world,
    torch,
    view: async () => renderView(app, `camera:${[...world.resource(Cameras).keys()][0]}`),
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}

const luma = (img: { width: number; data: ArrayLike<number> }, x: number, y: number) => {
  const p = pixel(img, x, y)
  return p[0]! + p[1]! + p[2]!
}

/**
 * A field over x, z in [-4, 4] at 0.5 m: the right half (x > 0) covered at y 3 with visibility
 * `inside`, the left half uncovered. One layer, the ground level's.
 */
function fillField(world: App['world'], inside: number) {
  const s = world.resource(InteriorLightingResource)
  const n = 16
  s.configure(n, n, 1, 0, 0)
  const data = new Uint32Array(n * n)
  for (let z = 0; z < n; z++)
    for (let x = 0; x < n; x++) {
      const covered = x >= n / 2
      const vis = covered ? inside : 1
      const cover = covered ? COVER_ZERO + 3 * COVER_SCALE : 0
      data[z * n + x] = ((Math.round(vis * VISIBILITY_MAX) << 2) | (cover << 16)) >>> 0
    }
  s.writeField(0, 0, 0, n, n, data)
  s.setGrid(-4, -4, 0.5, n, n, 16, 1)
  s.setLevelCount(0)
  s.setLevel(INTERIOR_GROUND, -1e9, 1e9, 0, 0, [0, 0, 0], 0)
  s.writeTable()
  s.sky = true
  s.provided = true
}

describe('interior lighting (render half)', () => {
  it('links nothing new and binds nothing new while off', {
    timeout: timeout(60_000),
  }, async () => {
    const r = await scene()
    const before = await r.view()
    const s = r.world.resource(InteriorLightingResource)
    expect(s.mode).toBe(0)
    // A field written but not switched on changes nothing.
    fillField(r.world, 0)
    s.sky = false
    await settle(r.app, 4)
    expect((await r.view()).data).toEqual(before.data)
    expect(r.world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })

  for (const deferred of [false, true]) {
    it(`scales ambient by sky visibility${deferred ? ' (deferred)' : ''}`, {
      timeout: timeout(60_000),
    }, async () => {
      const r = await scene({ deferred })
      const before = await r.view()
      fillField(r.world, 0)
      await settle(r.app)
      const after = await r.view()
      // The uncovered half is as it was; the covered half (visibility 0, no interior ambient) is black.
      expect(luma(after, 8, 32)).toBe(luma(before, 8, 32))
      expect(luma(before, 56, 32)).toBeGreaterThan(100)
      expect(luma(after, 56, 32)).toBe(0)
      fillField(r.world, 0.5)
      await settle(r.app)
      const half = luma(await r.view(), 56, 32)
      expect(half).toBeGreaterThan(20)
      expect(half).toBeLessThan(luma(before, 56, 32))
      const described = describeRender(r.world) as { interior?: { sky: boolean } }
      expect(described.interior?.sky).toBe(true)
      expect(r.world.resource(Gpu).errors).toEqual([])
      await r.dispose()
    })
  }

  it('occludes a blocked light through its row', { timeout: timeout(60_000) }, async () => {
    const r = await scene({ torch: true })
    const s = r.world.resource(InteriorLightingResource)
    const bins = 64
    s.configure(0, 0, 0, bins, 4)
    s.setGrid(-4, -4, 0.5, 1, 1, bins, 1)
    s.setLevelCount(0)
    s.setLevel(INTERIOR_GROUND, -1e9, 1e9, 0, 0, [0, 0, 0], 0)
    s.writeTable()
    // A barrier 1 m from the torch in every direction toward +x (bins whose angle is within 60°),
    // 3 m tall.
    const row = new Uint32Array(bins)
    for (let b = 0; b < bins; b++) {
      const angle = -Math.PI + ((b + 0.5) / bins) * 2 * Math.PI
      row[b] =
        Math.abs(angle) < Math.PI / 3
          ? ((ROW_ZERO + 2 * ROW_SCALE) << 16) | (1 * ROW_SCALE)
          : ROW_CLEAR
    }
    s.writeRow(2, row)
    const before = await r.view()
    s.blocked = true
    s.provided = true
    const store = r.world.resource(Lights)
    setLightRow(store, store.byEntity.get(r.torch!)!, 2)
    await settle(r.app)
    const after = await r.view()
    // Torch at x = -2 (pixel 16): left of it lit as before; 2 m right of it (x = 0) dark now.
    expect(luma(after, 8, 32)).toBe(luma(before, 8, 32))
    expect(luma(before, 32, 32)).toBeGreaterThan(50)
    expect(luma(after, 32, 32)).toBe(0)
    expect(r.world.resource(Gpu).errors).toEqual([])
    await r.dispose()
  })
})
