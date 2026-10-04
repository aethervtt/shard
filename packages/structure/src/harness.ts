import type { Entity } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import {
  Camera3d,
  DirectionalLight,
  Exposure,
  forwardPlugin,
  OffscreenTarget,
  RenderTargets,
  renderPlugin,
  Tonemapping,
} from '@aethervtt/shard-render'
import { surfacePlugin } from '@aethervtt/shard-render/surface'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { hostScene } from './fixtures'
import { interiorLightingPlugin } from './interior-plugin'
import { structurePlugin } from './plugin'

// Test rig: an app with structure, a host adapter, an offscreen camera and a sun.

export interface Rig {
  app: App
  host: ReturnType<typeof hostScene>
  camera: Entity
  sun: Entity
  target: OffscreenTarget
  view: string
  frame(): void
  look(eye: [number, number, number], at: [number, number, number]): void
  dispose(): Promise<void>
}

export async function rig(
  gpu: GpuContext,
  options: {
    width?: number
    height?: number
    shadowUpdate?: 'always' | 'on-change'
    shadows?: boolean
    orthoHeight?: number
    /** Adds surfacePlugin (0068), for SurfaceMaterial walls and floors. */
    surface?: boolean
    /** Adds interiorLightingPlugin (0069). */
    interior?: boolean
  } = {},
): Promise<Rig> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    structurePlugin,
  )
  if (options.surface) app.addPlugin(surfacePlugin)
  if (options.interior) app.addPlugin(interiorLightingPlugin)
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, {
    label: 'structure',
    width: options.width ?? 96,
    height: options.height ?? 64,
  })
  const ref = world.resource(RenderTargets).add(target, 'structure')
  const camera = world.spawn(
    [
      Camera3d,
      options.orthoHeight
        ? { target: ref, projection: 'orthographic', orthoHeight: options.orthoHeight, far: 500 }
        : { target: ref, fovY: 50 },
    ],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    Transform,
  )
  const sun = world.spawn(
    [
      DirectionalLight,
      {
        illuminance: 20_000,
        shadows: options.shadows ?? true,
        shadowUpdate: options.shadowUpdate ?? 'always',
      },
    ],
    [Transform, { rotation: lookAt([-3, 8, 2], [0, 0, 0]) }],
  )
  const host = hostScene(world)
  return {
    app,
    host,
    camera,
    sun,
    target,
    view: `camera:${camera}`,
    frame: () => app.update(1 / 60),
    look(eye, at) {
      world.set(camera, Transform, { translation: eye, rotation: lookAt(eye, at) })
    },
    async dispose() {
      await app.dispose()
      target.destroy()
    },
  }
}
