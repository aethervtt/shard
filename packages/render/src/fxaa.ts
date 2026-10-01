import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import { type NodeDescriptor, RenderPhase } from './graph'
import { Graph, Shaders } from './plugin'
import { hasEffect, PostEffect, PostFeatures } from './post'
import { idOf, PostCache, sampler, tex } from './post-common'
import { FXAA_SHADERS } from './post-shaders'
import { registerShaders } from './shaders'
import { cameraOf } from './view'

// --- FXAA --------------------------------------------------------------------------------------

function fxaaNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'render',
    phase: RenderPhase.Display,
    enabled: hasEffect(PostEffect.Fxaa),
    reads: ['ldr'],
    writes: ['display'],
    color: [{ resource: 'display', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({ label: 'fxaa', entries: [tex(0), sampler(1)] })
      }
      const input = ctx.texture('ldr')
      const format = ctx.texture('display').format
      const alpha = cameraOf(ctx.view)?.alphaOutput === true
      const pipeline = cache.render(
        ctx,
        `fxaa/${format}${alpha ? '/alpha' : ''}`,
        'shard::post::fxaa',
        'fs',
        [layout],
        [{ format }],
        {
          SRGB_TARGET: format.endsWith('-srgb'),
          TRANSPARENT: alpha,
        },
      )
      if (!pipeline) return
      const group = cache.group(gpu, `${ctx.view.name}/fxaa`, `${idOf(input)}`, layout, () => [
        { binding: 0, resource: input.createView() },
        { binding: 1, resource: cache.sampler(gpu) },
      ])
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

/** FXAA for cameras with `Antialiasing { mode: 'fxaa' }`. */
export const fxaaPlugin = definePlugin({
  name: 'render/fxaa',
  dependencies: ['render/forward'],
  build(app) {
    app.world.initResource(PostFeatures).effects |= PostEffect.Fxaa
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), FXAA_SHADERS)
    const graph = app.world.resource(Graph)
    graph.declare({ name: 'fxaa-in', format: 'view' })
    addRenderFeatures(app.world, {
      name: 'render/fxaa',
      description: 'Fast approximate anti-aliasing.',
      nodes: ['post/fxaa'],
      baseline: { strategy: 'The same fragment pass' },
    })
    graph.addNode('post/fxaa', fxaaNode())
  },
})
