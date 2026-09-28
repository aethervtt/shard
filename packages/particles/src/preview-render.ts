import { assetServer, type PreviewImage } from '@aethervtt/shard-assets'
import type { World } from '@aethervtt/shard-core'
import {
  Camera3d,
  captureView,
  Exposure,
  forwardPlugin,
  Gpu,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
} from '@aethervtt/shard-render'
import { App } from '@aethervtt/shard-runtime'
import { Textures } from '@aethervtt/shard-texture'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { ParticleSystem } from './components'
import { ParticleEffect, ParticleEffects } from './effect'

/** An effect after one second of seeded, fixed-step simulation, in a private world. */
export async function renderEffectPreview(
  world: World,
  path: string,
  width: number,
  height: number,
): Promise<PreviewImage> {
  const server = assetServer(world)
  const artifact = await server.artifact(path)
  const effect = ParticleEffect.fromJson(artifact.json, (p) => server.resolve(p))
  const gpu = world.resource(Gpu)
  const { particlesPlugin } = await import('./plugin')
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    particlesPlugin,
  )
  await app.init()
  const w = app.world
  // Textures come from the game's store: the private world only borrows them.
  const textures = world.resource(Textures)
  for (const e of effect.emitters) {
    const guid = e.render.texture?.guid
    const t = guid ? textures.byGuid(guid) : undefined
    if (guid && t) w.resource(Textures).set(guid, t)
  }
  const target = new OffscreenTarget(gpu, { label: 'particle-preview', width, height })
  const targetRef = w.resource(RenderTargets).add(target, 'particle-preview')
  const ref = w.resource(ParticleEffects).add(effect)
  w.spawn([ParticleSystem, { effect: ref, seed: 1 }], Transform)
  const reach = Math.max(
    1,
    ...effect.emitters.map(
      (e) => e.bounds || e.shape.radius + e.init.speed[1] * e.init.lifetime[1],
    ),
  )
  const eye: [number, number, number] = [0, reach * 0.6, reach * 2.2]
  const cam = w.spawn(
    [Camera3d, { target: targetRef as never, fovY: 45, clearColor: [0.01, 0.01, 0.02, 1] }],
    [Exposure, { ev100: 10 }],
    [Transform, { translation: eye, rotation: lookAt(eye, [0, reach * 0.3, 0]) }],
  )
  try {
    for (let i = 0; i < 60; i++) {
      app.update(1 / 60)
      await gpu.pipelines.whenIdle()
    }
    const shot = captureView(w, `camera:${cam}`)
    app.update(1 / 60)
    const image = await shot
    return { width: image.width, height: image.height, data: image.data }
  } finally {
    target.destroy()
  }
}
