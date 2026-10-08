import type { AssetRef } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { box, plane } from '@aethervtt/shard-mesh'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { FoliageLayer, FoliageLayers } from './foliage'
import { Mesh3d, MeshMaterial } from './instances'
import { AmbientLight, DirectionalLight } from './lights'
import { Gpu, renderPlugin } from './plugin'
import { forwardPlugin } from './standard'
import { OffscreenTarget } from './target'
import { pixel, renderView, settle } from './testing'
import { RenderPath, Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const W = 96
const H = 96
/** Metres across the top-down view. */
const SPAN = 20
/** The patch: 16 m square, 33 × 33 vertices, centred on the origin. */
const SIDE = 16
const GRID = 33

function patch(density: (x: number, z: number) => number) {
  const n = GRID * GRID
  const positions = new Float32Array(n * 3)
  const normals = new Float32Array(n * 3)
  const dens = new Float32Array(n)
  for (let j = 0; j < GRID; j++)
    for (let i = 0; i < GRID; i++) {
      const k = i + j * GRID
      const x = -SIDE / 2 + (i / (GRID - 1)) * SIDE
      const z = -SIDE / 2 + (j / (GRID - 1)) * SIDE
      positions[k * 3] = x
      positions[k * 3 + 2] = z
      normals[k * 3 + 1] = 1
      dens[k] = density(x, z)
    }
  return { grid: GRID, positions, normals, density: dens }
}

async function scene(options: { deferred?: boolean } = {}) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'foliage', width: W, height: H })
  const ref = world.resource(RenderTargets).add(target, 'foliage') as AssetRef<'RenderTarget'>
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  world.spawn(
    [Mesh3d, { mesh: meshes.add(plane({ size: 40 })) }],
    [
      MeshMaterial,
      { material: materials.add(new MaterialAsset({ baseColor: [0.3, 0.3, 0.3, 1] })) },
    ],
    Transform,
  )
  Object.assign(world.resource(AmbientLight), { brightness: 1500 })
  world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: true }],
    [Transform, { rotation: lookAt([-2, 8, 3], [0, 0, 0]) }],
  )
  const eye: [number, number, number] = [0, 20, 0.0001]
  const camera = world.spawn(
    [Camera3d, { target: ref, projection: 'orthographic', orthoHeight: SPAN, far: 100 }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, 0, 0]) }],
  )
  if (options.deferred) world.add(camera, RenderPath, { mode: 'deferred' })
  const green = materials.add(new MaterialAsset({ baseColor: [0.1, 0.9, 0.1, 1], roughness: 1 }))
  const tuft = meshes.add(box({ x: 0.3, y: 0.4, z: 0.3 })) as AssetRef<'Mesh'>
  const layer = world.resource(FoliageLayers).add(
    new FoliageLayer({
      label: 'test',
      meshes: [tuft],
      weights: [1],
      material: green as AssetRef<'Material'>,
      seed: 9,
      cells: 32,
      range: 60,
      shadowRange: 30,
      scale: [0.8, 1.2],
      align: 0,
    }),
  )
  const slot = layer.allocate()
  // Grass only where x > 0.
  layer.setChunk(slot, {
    ...patch((x) => (x > 0 ? 1 : 0)),
    cell0: [0, 0],
    domain: 0,
    accept: 0.6,
    jitter: 0.6,
  })
  layer.setTransform(slot, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  return {
    app,
    world,
    layer,
    view: `camera:${camera}`,
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}

const isGreen = (p: ArrayLike<number>) => p[1]! > p[0]! * 1.3 && p[1]! > p[2]! * 1.3

/** Green pixels in a band of columns (x from x0 to x1 metres), within the patch's rows. */
function greenShare(image: { width: number; data: ArrayLike<number> }, x0: number, x1: number) {
  const ppm = H / SPAN
  let green = 0
  let all = 0
  for (let y = Math.ceil(H / 2 - (SIDE / 2) * ppm) + 2; y < H / 2 + (SIDE / 2) * ppm - 2; y++)
    for (let x = Math.ceil(W / 2 + x0 * ppm); x < W / 2 + x1 * ppm; x++) {
      all++
      if (isGreen(pixel(image, x, y))) green++
    }
  return green / all
}

describe('GPU foliage', () => {
  for (const deferred of [false, true]) {
    it(`places instances on the GPU where the patch's density allows, and draws them (${deferred ? 'deferred' : 'forward'})`, async () => {
      const s = await scene({ deferred })
      if (!s.world.resource(Gpu).features.has('indirect-first-instance')) {
        await s.dispose()
        return
      }
      const image = await renderView(s.app, s.view)
      const right = greenShare(image, 1, SIDE / 2 - 0.5)
      const left = greenShare(image, -SIDE / 2 + 0.5, -1)
      expect(right).toBeGreaterThan(0.1)
      expect(left).toBe(0)
      // The read-back count: about accept × the right half's cells.
      await settle(s.app)
      const { drawn, shadows } = s.layer.visible(s.view)
      const expected = (0.6 * (32 * 32)) / 2
      expect(drawn).toBeGreaterThan(expected * 0.8)
      expect(drawn).toBeLessThan(expected * 1.2)
      // Casters: only within the nearest cascade.
      expect(shadows).toBeLessThanOrEqual(drawn)
      await s.dispose()
    })
  }

  it('stops drawing a removed chunk', async () => {
    const s = await scene()
    if (!s.world.resource(Gpu).features.has('indirect-first-instance')) {
      await s.dispose()
      return
    }
    await renderView(s.app, s.view)
    s.layer.removeChunk(0)
    const image = await renderView(s.app, s.view)
    expect(greenShare(image, 1, SIDE / 2 - 0.5)).toBe(0)
    await s.dispose()
  })
})
