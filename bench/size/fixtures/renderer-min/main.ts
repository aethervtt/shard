// renderer-min: the scene in scene.ts on forwardCorePlugin, with its shaders baked
// (shaders.bake.json, from bake.test.ts), so WESL never loads.
import { forwardCorePlugin, renderPlugin } from '@aethervtt/shard-render'
import type { ShaderBake } from '@aethervtt/shard-shader'
import { App, animationFrameRunner } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { scene } from './scene'
import shaderBake from './shaders.bake.json'

const canvas = document.getElementById('c') as HTMLCanvasElement

const app = new App().addPlugin(
  renderPlugin({ canvas, shaderBake: shaderBake as ShaderBake }),
  TransformPlugin,
  forwardCorePlugin(),
  scene,
)
app.setRunner(animationFrameRunner())
await app.init()
await app.run()
