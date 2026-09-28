// The smallest useful Shard scene: a camera, a directional light with shadows, and 100 cubes of one
// standard material. `three-min` is the same scene in three.js. Shared by main.ts (the browser build
// that's measured) and bake.test.ts (which bakes its shaders headless).
import { quat } from '@aethervtt/shard-core'
import { cube } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  DirectionalLight,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
} from '@aethervtt/shard-render'
import { definePlugin } from '@aethervtt/shard-runtime'
import { lookAt, Transform } from '@aethervtt/shard-transform'

export const scene = definePlugin({
  name: 'size/scene',
  build() {},
  ready(app) {
    const world = app.world
    const mesh = world.resource(Meshes).add(cube({ size: 0.8 }))
    const material = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.8, 0.3, 0.2, 1], roughness: 0.5 }))
    world.spawn(
      [DirectionalLight, { illuminance: 10_000, shadows: true }],
      [Transform, { rotation: quat.fromEuler([0, 0, 0, 1], -0.9, 0.6, 0) as [number, number, number, number] }],
    )
    world.spawn(Camera3d, [Transform, { translation: [0, 12, 16], rotation: lookAt([0, 12, 16], [0, 0, 0]) }])
    for (let i = 0; i < 100; i++) {
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, { translation: [(i % 10) - 4.5, 0, Math.floor(i / 10) - 4.5] }],
      )
    }
  },
})
