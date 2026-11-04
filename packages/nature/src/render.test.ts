import { type AssetRef, Rng } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { Mesh, plane } from '@aethervtt/shard-mesh'
import { meshBuilder } from '@aethervtt/shard-procgen'
import {
  AmbientLight,
  Camera3d,
  captureView,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  renderPlugin,
  Shaders,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { Wind } from '@aethervtt/shard-wind'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTree } from './generator'
import { TreeMaterial } from './material'
import { naturePlugin } from './plugin'
import { TREE_PRESETS } from './presets'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

const SIZE = 64
let shots = 0

/** A 2×2 leaf texture: green, fully opaque or fully transparent. */
function leaf(world: App['world'], alpha: number): AssetRef<'Texture'> {
  const px = [40, 200, 40, alpha]
  return world
    .resource(Textures)
    .add(
      Texture.create({ width: 2, height: 2, mips: [new Uint8Array([...px, ...px, ...px, ...px])] }),
    ) as AssetRef<'Texture'>
}

async function frames(app: App, n: number) {
  for (let i = 0; i < n; i++) {
    app.update(1 / 60)
    await app.world.resource(Shaders).whenIdle()
    await gpu.pipelines.whenIdle()
  }
}

/**
 * An oak_small (white bark, the given leaves) under a sun slanting toward +x, with shadows. The
 * camera looks straight down, either at the tree or at the ground beside it where its shadow falls.
 */
async function scene(view: 'tree' | 'shadow', sway = 0) {
  const target = new OffscreenTarget(gpu, { label: 'nature', width: SIZE, height: SIZE })
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target }),
    forwardPlugin({ msaa: 1 }),
    naturePlugin,
  )
  await app.init()
  const world = app.world
  world.resource(AmbientLight).brightness = 1500
  const meshes = world.resource(Meshes)
  const materials = world.resource(Materials)
  if (view === 'shadow') {
    world.spawn(
      [Mesh3d, { mesh: meshes.add(plane({ size: 60 })) }],
      [MeshMaterial, { material: materials.add(new MaterialAsset({ roughness: 1 })) }],
      Transform,
    )
  }
  const opaque = leaf(world, 255)
  const clear = leaf(world, 0)
  const material = new MaterialAsset(
    { alphaMode: 'mask', doubleSided: true, leafTexture: opaque, sway },
    TreeMaterial,
  )
  const data = buildTree(TREE_PRESETS.oak_small, new Rng(4), 1, meshBuilder.finish).mesh
  world.spawn(
    [Mesh3d, { mesh: meshes.add(Mesh.create(data)) }],
    [MeshMaterial, { material: materials.add(material) }],
    Transform,
  )
  world.spawn(
    [DirectionalLight, { illuminance: 30_000, shadows: true }],
    [Transform, { rotation: lookAt([0, 0, 0], [1, -1.4, 0]) }],
  )
  // The shadow view takes in x from 4 to 10 m: past the crown, where its shadow falls.
  const center: [number, number, number] = view === 'tree' ? [0, 30, 0] : [7, 30, 0]
  const camera = world.spawn(
    [Camera3d, { projection: 'orthographic', orthoHeight: view === 'tree' ? 10 : 6, far: 100 }],
    [Exposure, { ev100: 12 }],
    [Transform, { translation: center, rotation: lookAt(center, [center[0], 0, 0.001]) }],
  )
  const shoot = async () => {
    await frames(app, 4)
    const shot = captureView(world, `camera:${camera}`)
    app.update(1 / 60)
    const data = (await shot).data
    if (process.env.NATURE_SHOTS) {
      const { writeFileSync } = await import('node:fs')
      const { pngBytes } = await import('@aethervtt/shard-render/testing')
      writeFileSync(
        `${process.env.NATURE_SHOTS}/${view}-${shots++}.png`,
        pngBytes(data, SIZE, SIZE),
      )
    }
    return data
  }
  return { app, world, material, opaque, clear, shoot }
}

/** Pixels that differ between two shots. */
const changed = (a: Uint8Array, b: Uint8Array) => {
  let n = 0
  for (let i = 0; i < a.length; i += 4)
    if (
      Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) >
      12
    )
      n++
  return n
}

const greenPixels = (image: Uint8Array) => {
  let n = 0
  for (let i = 0; i < image.length; i += 4)
    if (image[i + 1]! > image[i]! + 20 && image[i + 1]! > image[i + 2]! + 20) n++
  return n
}

/** Pixels darker than three quarters of the brightest: ground in shadow. */
const shadowed = (image: Uint8Array) => {
  let max = 0
  for (let i = 0; i < image.length; i += 4)
    max = Math.max(max, image[i]! + image[i + 1]! + image[i + 2]!)
  let n = 0
  for (let i = 0; i < image.length; i += 4)
    if (image[i]! + image[i + 1]! + image[i + 2]! < max * 0.75) n++
  return n
}

describe('nature/Tree material', () => {
  it('draws leaves from leafTexture and cuts them out by its alpha', async () => {
    const s = await scene('tree')
    const leafy = greenPixels(await s.shoot())
    s.material.set({ leafTexture: s.clear })
    const bare = greenPixels(await s.shoot())
    expect(leafy).toBeGreaterThan(SIZE * SIZE * 0.05)
    expect(bare).toBe(0)
  })

  it('cuts leaf shadows out by alpha too', async () => {
    const s = await scene('shadow')
    const leafy = shadowed(await s.shoot())
    s.material.set({ leafTexture: s.clear })
    const bare = shadowed(await s.shoot())
    // Only the branches' thin shadows are left.
    expect(leafy).toBeGreaterThan(SIZE * SIZE * 0.15)
    expect(bare).toBeLessThan(leafy / 4)
  })

  it('sways with wind/Wind when placed by hand, with no wind fields on the material (0096)', async () => {
    const s = await scene('tree', 0.3)
    const wind = s.world.resource(Wind)
    Object.assign(wind, { speed: 0, gustiness: 0 })
    const calm = await s.shoot()
    expect(changed(calm, await s.shoot())).toBe(0)
    wind.speed = 18
    const gale = await s.shoot()
    expect(changed(calm, gale)).toBeGreaterThan(SIZE * SIZE * 0.02)
    await s.app.dispose()
  })
})
