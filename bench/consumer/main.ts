// The renderer-min scene, written against the installed packages: this has to typecheck against
// their .d.ts files and build with Vite and Bun.
import { cube } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  DirectionalLight,
  forwardCorePlugin,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App, animationFrameRunner, definePlugin } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'

const canvas = document.getElementById('c') as HTMLCanvasElement

const scene = definePlugin({
  name: 'consumer/scene',
  build() {},
  ready(app) {
    const world = app.world
    const mesh = world.resource(Meshes).add(cube({ size: 0.8 }))
    const material = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0.8, 0.3, 0.2, 1], roughness: 0.5 }))
    const sun: [number, number, number] = [-2, 4, -3]
    world.spawn(
      [DirectionalLight, { illuminance: 10_000, shadows: true }],
      [Transform, { translation: sun, rotation: lookAt(sun, [0, 0, 0]) }],
    )
    world.spawn(Camera3d, [
      Transform,
      { translation: [0, 12, 16], rotation: lookAt([0, 12, 16], [0, 0, 0]) },
    ])
    for (let i = 0; i < 100; i++) {
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, { translation: [(i % 10) - 4.5, 0, Math.floor(i / 10) - 4.5] }],
      )
    }
  },
})

const app = new App().addPlugin(
  renderPlugin({ canvas }),
  TransformPlugin,
  forwardCorePlugin(),
  scene,
)
app.setRunner(animationFrameRunner())
await app.init()
await app.run()
