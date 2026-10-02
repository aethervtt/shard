import { quat, Rng } from '@aethervtt/shard-core'
import { plane } from '@aethervtt/shard-mesh'
import {
  AmbientLight,
  Camera3d,
  Exposure,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  PointLight,
  RenderPath,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { Texture, Textures } from '@aethervtt/shard-texture'
import { Transform } from '@aethervtt/shard-transform'
import { orbitFrom } from './camera'

/** Leaves: a mask with holes, so alpha testing (and real overdraw) happens. */
function leaves(size = 128): Texture {
  const data = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = (x % 32) - 16
      const cy = (y % 32) - 16
      const leaf = cx * cx + cy * cy * 2 < 150
      const o = (y * size + x) * 4
      data[o] = 90
      data[o + 1] = 160
      data[o + 2] = 70
      data[o + 3] = leaf ? 255 : 0
    }
  }
  return Texture.create({ width: size, height: size, mips: [data], mipmaps: true })
}

/**
 * 1000 point lights over four layers of alpha-tested foliage that cover the screen. `?path=forward`
 * or `?path=deferred` picks the camera's path; compare the HUD's GPU time.
 */
export const deferredPlugin = definePlugin({
  name: 'deferred-demo',
  dependencies: ['render/forward'],
  build() {},
  ready(app) {
    const world = app.world
    const path =
      new URLSearchParams(location.search).get('path') === 'forward' ? 'forward' : 'deferred'
    world.resource(AmbientLight).brightness = 0.5
    world.spawn(
      [Camera3d, { fovY: 60 }],
      [Exposure, { ev100: 4 }],
      [RenderPath, { mode: path }],
      Transform,
      orbitFrom([0, 3, 12], [0, 3, 0]),
    )
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const tex = world.resource(Textures).add(leaves())
    const foliage = materials.add(
      new MaterialAsset({
        baseColorTexture: { texture: tex, scale: [6, 3] },
        alphaMode: 'mask',
        doubleSided: true,
        roughness: 0.8,
      }),
    )
    const wall = meshes.add(plane({ size: 1 }))
    // Four layers of foliage walls, each covering the whole view.
    for (let layer = 0; layer < 4; layer++) {
      world.spawn(
        [Mesh3d, { mesh: wall }],
        [MeshMaterial, { material: foliage }],
        [
          Transform,
          {
            translation: [0, 3, 6 - layer * 3],
            rotation: quat.fromEuler([0, 0, 0, 1], Math.PI / 2, 0, 0) as never,
            scale: [30 + layer * 6, 1, 16 + layer * 3],
          },
        ],
      )
    }
    const back = materials.add(
      new MaterialAsset({ baseColor: [0.5, 0.45, 0.4, 1], roughness: 0.9 }),
    )
    world.spawn(
      [Mesh3d, { mesh: wall }],
      [MeshMaterial, { material: back }],
      [
        Transform,
        {
          translation: [0, 3, -8],
          rotation: quat.fromEuler([0, 0, 0, 1], Math.PI / 2, 0, 0) as never,
          scale: [80, 1, 40],
        },
      ],
    )
    const rng = new Rng(9)
    for (let i = 0; i < 1000; i++) {
      world.spawn(
        [
          PointLight,
          {
            intensity: 120,
            range: 2.5,
            color: [0.5 + 0.5 * rng.float(), 0.5 + 0.5 * rng.float(), 0.5 + 0.5 * rng.float(), 1],
          },
        ],
        [Transform, { translation: [rng.range(-16, 16), rng.range(-2, 8), rng.range(-8, 7)] }],
      )
    }
  },
})
