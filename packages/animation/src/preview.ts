import { AssetServerResource, assetServer, defineAssetPreview } from '@aethervtt/shard-assets'
import { quat, ShardError, vec3 } from '@aethervtt/shard-core'
import {
  captureView,
  forwardPlugin,
  Gpu,
  Materials,
  Meshes,
  OffscreenTarget,
  renderPlugin,
  Shaders,
  Skins,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import {
  loadScene,
  releaseSceneHooks,
  SceneAssets,
  ScenePlugin,
  whenSceneReady,
} from '@aethervtt/shard-scene'
import { Textures } from '@aethervtt/shard-texture'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { animationLayer } from './api'
import { AnimationClips } from './clip'
import { AnimationPlayer } from './components'

/** Frames in a clip preview, left to right. */
const FRAMES = 5

/**
 * A clip on its model (the source file's scene) at 5 evenly spaced times, left to right, in a
 * private world that shares the game's GPU and asset stores. Property clips have no model.
 */
defineAssetPreview('AnimationClip', async (world, path, width, height) => {
  const server = assetServer(world)
  const base = path.split('#')[0]!
  const scenePath = `${base}#Scene`
  if (!path.includes('#') || !server.entry(scenePath)) {
    throw new ShardError('animation/no-model', `${path} has no model to preview it on`, {
      hint: 'Clips from .anim.json animate whatever plays them: preview the scene that uses it with a screenshot.',
    })
  }
  const gpu = world.resource(Gpu)
  const frameWidth = Math.max(1, Math.floor(width / FRAMES))
  const target = new OffscreenTarget(gpu, { label: 'clip-preview', width: frameWidth, height })
  const app = new App()
  app.world.insertResource(AssetServerResource, server)
  for (const def of [Meshes, Materials, Textures, SceneAssets, Skins, AnimationClips] as const) {
    app.world.insertResource(def as never, world.initResource(def as never))
  }
  const { animationPlugin } = await import('./plugin')
  app.addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, target, shaders: world.resource(Shaders) }),
    forwardPlugin(),
    ScenePlugin,
    animationPlugin,
  )
  try {
    await app.init()
    await server.load(path)
    await server.load(scenePath)
    const clipRef = server.resolve(path)!
    const clip = world.resource(AnimationClips).get(clipRef)!
    const bounds = (server.info(scenePath).info as { bounds?: { min: number[]; max: number[] } })
      ?.bounds ?? { min: [-1, 0, -1], max: [1, 2, 1] }
    const center = [0, 1, 2].map((i) => (bounds.min[i]! + bounds.max[i]!) / 2)
    const radius = Math.max(
      1e-3,
      Math.hypot(...[0, 1, 2].map((i) => bounds.max[i]! - bounds.min[i]!)) / 2,
    )
    const fov = 40
    const distance = (radius / Math.sin(((fov / 2) * Math.PI) / 180)) * 1.1
    const dir = vec3.normalize(vec3.create(), vec3.create(1, 0.35, 1.2))
    const eye = [0, 1, 2].map((i) => center[i]! + dir[i]! * distance)
    const rotation = quat.lookRotation(
      quat.create(),
      vec3.create(-dir[0]!, -dir[1]!, -dir[2]!),
      vec3.create(0, 1, 0),
    )
    const { entities } = loadScene(
      app.world,
      {
        version: 1,
        resources: { 'render/AmbientLight': { color: [1, 1, 1], brightness: 3000 } },
        entities: [
          {
            name: 'key',
            components: {
              'render/DirectionalLight': { illuminance: 'daylight' },
              'core/Transform': { rotationEuler: [-45, 35, 0] },
            },
          },
          {
            name: 'model',
            components: {
              'core/Transform': {},
              'scene/SceneInstance': { scene: { path: scenePath } },
            },
          },
          {
            name: 'camera',
            components: {
              'render/Camera3d': {
                fovY: fov,
                near: Math.max(1e-4, distance - radius * 2) / 10,
                clearColor: [0.05, 0.055, 0.07, 1],
              },
              'core/Transform': { translation: eye, rotation: [...rotation] },
            },
          },
        ],
      },
      { id: 'clip-preview' },
    )
    await whenSceneReady(app.world, 'clip-preview')
    const model = entities.get('model')!
    const camera = entities.get('camera')!
    const out = new Uint8Array(frameWidth * FRAMES * height * 4)
    for (let f = 0; f < FRAMES; f++) {
      const time = (clip.duration * f) / (FRAMES - 1)
      app.world.add(model, AnimationPlayer, {
        layers: [animationLayer(clipRef, { time, playing: false, loop: 'once' })],
      })
      for (let i = 0; i < 4; i++) {
        app.update(1 / 60)
        await app.world.resource(Shaders).whenIdle()
        await gpu.pipelines.whenIdle()
      }
      const shot = captureView(app.world, `camera:${camera}`)
      app.update(1 / 60)
      const image = await shot
      for (let y = 0; y < height; y++) {
        out.set(
          image.data.subarray(y * frameWidth * 4, (y + 1) * frameWidth * 4),
          (y * frameWidth * FRAMES + f * frameWidth) * 4,
        )
      }
    }
    return { width: frameWidth * FRAMES, height, data: out }
  } finally {
    releaseSceneHooks(app.world)
    target.destroy()
  }
})
