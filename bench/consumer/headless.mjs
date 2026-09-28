// Runs the installed packages in plain Node: a headless frame on Dawn, and noise sampled on the
// worker pool (a worker module that has to survive the release at its relative path).
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cube } from '@aethervtt/shard-mesh'
import { NoiseGraph, sampleGrid2dAsync } from '@aethervtt/shard-noise'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import {
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardCorePlugin,
  Gpu,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { renderView } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'

const fail = (message) => {
  console.error(`consumer check: ${message}`)
  process.exit(1)
}

const gpu = await createNodeGpuContext()
const app = new App().addPlugin(
  TransformPlugin,
  renderPlugin({ gpu, windowView: false }),
  forwardCorePlugin({ msaa: 1 }),
)
await app.init()
const world = app.world
const target = new OffscreenTarget(gpu, { label: 'consumer', width: 64, height: 64 })
const targetRef = world.resource(RenderTargets).add(target, 'consumer')
const material = world.resource(Materials).add(new MaterialAsset({ baseColor: [0.9, 0.3, 0.2, 1] }))
world.spawn(
  [Mesh3d, { mesh: world.resource(Meshes).add(cube({ size: 1 })) }],
  [MeshMaterial, { material }],
  Transform,
)
world.spawn(
  [DirectionalLight, { illuminance: 10_000 }],
  [Transform, { translation: [2, 3, 4], rotation: lookAt([2, 3, 4], [0, 0, 0]) }],
)
const cam = world.spawn(
  [Camera3d, { target: targetRef }],
  [Exposure, { ev100: 12 }],
  [Transform, { translation: [2, 2, 3], rotation: lookAt([2, 2, 3], [0, 0, 0]) }],
)
const image = await renderView(app, `camera:${cam}`)
if (world.resource(Gpu).errors.length > 0)
  fail(`GPU errors: ${world.resource(Gpu).errors[0].message}`)
const center = (32 * 64 + 32) * 4
if (image.data[center] < 40) fail(`the cube didn't render (center red is ${image.data[center]})`)
target.destroy()
gpu.destroy()

const workers = createNodeWorkers(2)
const graph = await NoiseGraph.create({ output: 'n', nodes: { n: { simplex: { frequency: 2 } } } })
const values = new Float32Array(16 * 16)
await sampleGrid2dAsync(
  workers,
  graph,
  7,
  { origin: [0, 0], size: [1, 1], resolution: [16, 16] },
  values,
)
workers.dispose()
if (!values.some((v) => v !== 0)) fail('noise sampled on the worker pool came back all zero')

console.log('consumer check: rendered a frame and sampled noise on the worker pool')
