import { defineSystem, Last, PostUpdate, type Query } from '@aethervtt/shard-core'
import { CaptureDebugViews } from '@aethervtt/shard-protocol'
import {
  addRenderFeatures,
  Camera3d,
  cameraOf,
  Gpu,
  Graph,
  RenderSet,
  type RenderView,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin, LogResource, type Plugin } from '@aethervtt/shard-runtime'
import { GlobalTransform, TransformSystems } from '@aethervtt/shard-transform'
import { windPlugin } from '@aethervtt/shard-wind'
import * as bodiesModule from './bodies'
import { gatherWaterBodies, WaterBodies } from './bodies'
import { InfoClipmap } from './clipmap'
import * as componentsModule from './components'
import { waterInfoView } from './debug'
import { waterMethods } from './methods'
import * as opticsModule from './optics'
import { registerOpticsPresets } from './optics'
import * as renderModule from './render'
import { infoNode, WaterGpu, WaterRender, waterDepthNode, waterNode } from './render'
import { WATER_SHADERS } from './shaders'

/**
 * Moves the info clipmap to the first camera and fills the ground that scrolled in (0097), before
 * the frame renders. Nothing while there's no water.
 */
export const prepareWater = defineSystem({
  name: 'water/prepare',
  description:
    'Centres the water info clipmap on the camera, marks levels to redraw, and fills ground texels from the terrain.',
  setup: (world): { cameras: Query } => ({
    cameras: world.query({ with: [Camera3d, GlobalTransform] }),
  }),
  run: (s, world) => {
    const render = world.tryResource(WaterRender)
    const state = world.resource(WaterBodies)
    if (!render || state.count === 0) return
    for (const table of s.cameras.tables) {
      if (table.count === 0) continue
      const m = table.column(GlobalTransform, 'matrix')
      render.clip.rebuilds = 0
      render.clip.update(state, m[3]!, m[11]!)
      return
    }
  },
})

/**
 * Water bodies and surface (0097, part 1): `WaterBody` oceans and lakes, `WaterOptics`
 * (`*.water.json`, with presets), `waterAt` on the CPU, and, when the app renders with the forward
 * renderer, the info clipmap, the shared surface, and the water pass. Costs nothing until a body
 * exists. Adds the wind (0096) when it's missing; the opaque copy comes with `forwardPlugin()`
 * (`opaqueCopyPlugin` with `forwardCorePlugin`).
 */
export function waterPlugin(): Plugin {
  return definePlugin({
    name: 'water',
    provides: [componentsModule, opticsModule, bodiesModule, renderModule],
    build(app) {
      const world = app.world
      world.initResource(WaterBodies)
      if (!app.hasPlugin('wind')) app.addPlugin(windPlugin)
      app.addSystems(PostUpdate, gatherWaterBodies.after(TransformSystems))
      app.addSystems(Last, prepareWater.inSet(RenderSet.Prepare))
      app.addMethod(...waterMethods)
    },
    ready(app) {
      const world = app.world
      registerOpticsPresets(world)
      const gpu = world.tryResource(Gpu)
      const graph = world.tryResource(Graph)
      if (!gpu || !graph || !app.hasPlugin('render/forward')) return
      registerShaders(world.resource(Shaders), WATER_SHADERS)
      const render = { gpu: new WaterGpu(), clip: new InfoClipmap() }
      world.insertResource(WaterRender, render)
      const bodies = () => world.resource(WaterBodies)
      // Nothing runs while there's no water (or no opaque copy to refract).
      const active = (view: RenderView) =>
        bodies().count > 0 && cameraOf(view) !== undefined && graph.hasNode('opaque-copy')
      addRenderFeatures(world, {
        name: 'water',
        description:
          'Water bodies (0097): the info clipmap’s redraws and the water pass (the shared surface, shaded and writing depth).',
        nodes: ['water/info', 'water', 'water/depth'],
        baseline: {
          strategy:
            'The same fragment passes; with MSAA the surface’s depth is drawn into the single-sample depth too',
        },
        components: [componentsModule.WaterBody],
      })
      graph.addNode('water/info', infoNode(render.gpu, render.clip, bodies, active))
      graph.addNode('water', waterNode(render.gpu, render.clip, bodies, active))
      graph.addNode('water/depth', waterDepthNode(render.gpu, gpu.tier === 'baseline', active))
      world.initResource(CaptureDebugViews).set('water-info', waterInfoView)
      if (!app.hasPlugin('render/opaque-copy')) {
        world
          .tryResource(LogResource)
          ?.log(
            'warn',
            "waterPlugin needs the opaque copy, but opaqueCopyPlugin isn't installed; water draws nothing",
            {
              code: 'render/feature-missing',
              hint: "Add opaqueCopyPlugin from '@aethervtt/shard-render' (forwardPlugin includes it).",
            },
          )
      }
    },
  })
}
