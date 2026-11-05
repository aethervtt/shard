import { PostUpdate } from '@aethervtt/shard-core'
import { CaptureDebugViews } from '@aethervtt/shard-protocol'
import {
  addRenderFeatures,
  cameraOf,
  Gpu,
  Graph,
  type RenderView,
  registerShaders,
  Shaders,
} from '@aethervtt/shard-render'
import { definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { gatherWaterBodies, WaterBodies } from '../bodies'
import { WaterDescribers } from '../methods'
import { WaterSurfaceWaves } from '../render'
import { WaveGpu, wavesNode } from './gpu'
import { describeWaves, waterCascadesView, waterFoamView, waveMethods } from './methods'
import { WaveRender } from './render-state'
import * as seaModule from './sea'
import { updateWaves, WaveSets } from './sea'
import { WAVE_KERNELS } from './shaders'
import * as spectrumModule from './spectrum'
import { OceanWaves } from './spectrum'
import { surfaceWaves } from './surface'

/**
 * Ocean waves (0098) on water bodies with `OceanWaves`: a JONSWAP wind sea and swell per body,
 * the same at every tick on every machine, in `waterAt`, and on the GPU as FFT cascades the water
 * pass displaces, shades and foams with. Needs waterPlugin.
 */
export function oceanWavesPlugin(): Plugin {
  return definePlugin({
    name: 'water/waves',
    dependencies: ['water'],
    provides: [spectrumModule, seaModule, WaveRender],
    build(app) {
      app.world.initResource(WaveSets)
      app.world.initResource(WaterDescribers).set('waves', describeWaves)
      app.addSystems(PostUpdate, updateWaves.after(gatherWaterBodies))
      app.addMethod(...waveMethods)
    },
    async ready(app) {
      const world = app.world
      const gpu = world.tryResource(Gpu)
      const graph = world.tryResource(Graph)
      if (!gpu || !graph?.hasNode('water')) return
      const w = new WaveGpu()
      if (gpu.tier === 'baseline') {
        w.baseline = await import('../baseline/waves')
        registerShaders(world.resource(Shaders), w.baseline.BASELINE_WAVE_KERNELS)
      }
      registerShaders(world.resource(Shaders), WAVE_KERNELS)
      world.insertResource(WaveRender, w)
      world.insertResource(WaterSurfaceWaves, surfaceWaves(w))
      addRenderFeatures(world, {
        name: 'water/waves',
        description:
          'Ocean waves (0098): FFT cascades evolved, inverse-transformed and resolved into displacement, derivatives and foam each frame.',
        nodes: ['water-waves'],
        baseline: {
          strategy:
            'The same image kernels as fragment passes (fragmentKernel), one layer of one stage a pass',
        },
        components: [OceanWaves],
      })
      const active = (view: RenderView) =>
        cameraOf(view) !== undefined && world.resource(WaterBodies).count > 0
      graph.addNode(
        'water-waves',
        wavesNode(w, () => world.resource(WaveSets), active),
      )
      const views = world.initResource(CaptureDebugViews)
      views.set('water-cascades', waterCascadesView)
      views.set('water-foam', waterFoamView)
    },
  })
}
