import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  Exposure,
  forwardPlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { renderView } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { loadScene, ScenePlugin } from '@aethervtt/shard-scene'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind as SharedWind, WindZone } from '@aethervtt/shard-wind'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Wind } from './foliage'
import { Vegetation } from './material'
import { scatterPlugin } from './plugin'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu?.destroy())

const SIZE = 128
/** Metres the camera sees across (and up). */
const VIEW = 20
/** Blades stand at these x (metres), 4 m tall; the camera looks at them side on. */
const BLADES = [-6, 0, 6]

/** A 0.3 × 4 m blade: part code (uv1.x) 0 at the root, 1 at the tip. */
function blade(): Mesh {
  const positions = new Float32Array([-0.15, 0, 0, 0.15, 0, 0, 0.15, 4, 0, -0.15, 4, 0])
  return Mesh.create({
    positions,
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    uvs: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
    uvs1: new Float32Array([0, 0.5, 0, 0.5, 1, 0.5, 1, 0.5]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  })
}

async function scene() {
  const target = new OffscreenTarget(gpu, { label: 'wind', width: SIZE, height: SIZE })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    scatterPlugin(),
    ScenePlugin,
  )
  await app.init()
  const world = app.world
  // No wind fields on the material: sway comes from wind/Wind alone.
  const material = world.resource(Materials).add(
    new MaterialAsset(
      {
        baseColor: [0, 0, 0, 1],
        emissive: [1, 1, 1, 1],
        emissiveLuminance: 4000,
        doubleSided: true,
        sway: 1,
      },
      Vegetation,
    ),
  )
  const mesh = world.resource(Meshes).add(blade())
  for (const x of BLADES) {
    world.spawn(
      [Mesh3d, { mesh }],
      [MeshMaterial, { material }],
      [Transform, { translation: [x, -4, 0] }],
    )
  }
  const camera = world.spawn(
    [
      Camera3d,
      {
        projection: 'orthographic',
        orthoHeight: VIEW,
        target: world.resource(RenderTargets).add(target, 'wind'),
      },
    ],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 0, 20], rotation: lookAt([0, 0, 20], [0, 0, 0]) }],
  )
  // Steady wind along +x, no gusts: how far a tip leans is the speed's doing.
  Object.assign(world.resource(SharedWind), { direction: [1, 0, 0], speed: 0, gustiness: 0 })
  const shoot = async () => {
    const image = await renderView(app, `camera:${camera}`)
    expect(world.resource(Gpu).errors).toEqual([])
    return image
  }
  return { app, world, shoot }
}

/** Per blade, its furthest lit pixel downwind (+x), in metres: where its tip is. */
function tips(image: { width: number; data: ArrayLike<number> }): number[] {
  const px = SIZE / VIEW
  return BLADES.map((x) => {
    const center = SIZE / 2 + x * px
    let far = Number.NaN
    for (let y = 0; y < SIZE; y++) {
      for (let c = Math.round(center - 2.9 * px); c < center + 2.9 * px; c++) {
        if (image.data[(y * image.width + c) * 4]! > 128 && !(c <= far)) far = c
      }
    }
    return far / px
  })
}

describe('grass sways with wind/Wind (0096)', () => {
  it('leans downwind with the wind speed, from Vegetation without wind fields', async () => {
    const s = await scene()
    const calm = tips(await s.shoot())
    s.world.resource(SharedWind).speed = 6
    const breeze = tips(await s.shoot())
    s.world.resource(SharedWind).speed = 18
    const gale = tips(await s.shoot())
    for (let i = 0; i < BLADES.length; i++) {
      // 0.675 m at a breeze per metre of sway (0045's tuning), three times that in a gale, give or
      // take the flutter (±11%) and the bend down.
      expect(breeze[i]! - calm[i]!).toBeGreaterThan(0.4)
      expect(breeze[i]! - calm[i]!).toBeLessThan(0.9)
      expect(gale[i]! - calm[i]!).toBeGreaterThan(1.4)
    }
    await s.app.dispose()
  })

  it('stills inside a WindZone with speedScale 0, blending over its falloff', async () => {
    const s = await scene()
    const calm = tips(await s.shoot())
    s.world.resource(SharedWind).speed = 18
    // Around the first blade; the second is 5 m past its edge, inside the 8 m falloff; the third
    // is past it.
    s.world.spawn(
      [WindZone, { shape: 'box', size: [2, 20, 20], falloff: 8, speedScale: 0 }],
      [Transform, { translation: [-6, 0, 0] }],
    )
    const gale = tips(await s.shoot())
    const lean = gale.map((t, i) => t - calm[i]!)
    expect(Math.abs(lean[0]!)).toBeLessThan(0.05)
    expect(lean[2]!).toBeGreaterThan(1.4)
    // 1 − 5/8 of the way to still: 0.625 of the gale, give or take flutter.
    expect(lean[1]! / lean[2]!).toBeGreaterThan(0.35)
    expect(lean[1]! / lean[2]!).toBeLessThan(0.9)
    await s.app.dispose()
  })

  it('reads old scenes that set scatter/Wind as wind/Wind (strength × 6 m/s)', async () => {
    const s = await scene()
    await loadScene(s.world, {
      version: 1,
      resources: { 'scatter/Wind': { strength: 2, gustScale: 0.08, direction: [0, 0, 1] } },
      entities: [],
    })
    expect(s.world.resource(SharedWind)).toMatchObject({
      speed: 12,
      gustScale: 0.08,
      direction: [0, 0, 1],
    })
    expect(s.world.resource(Wind).strength).toBe(2)
    s.world.resource(Wind).strength = 0.5
    expect(s.world.resource(SharedWind).speed).toBe(3)
    await s.app.dispose()
  })
})
