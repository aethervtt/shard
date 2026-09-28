import { definePlugin } from '@aethervtt/shard-runtime'
import type { NodeContext, NodeDescriptor, RenderView } from './graph'
import { RenderPhase } from './graph'
import { type PixelPerfectLayout, PixelPerfectPath } from './pixel-perfect'
import { Graph, Shaders } from './plugin'
import { registerShaders } from './shaders'

export const PIXEL_PERFECT_SHADERS: Record<string, string> = {
  'shard::post::pixel_upscale': `
struct Upscale {
  /** offset (xy), scale, 0. */
  params: vec4f,
}

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<uniform> upscale: Upscale;

/** Each texel becomes a scale × scale block; outside the image, black bars. */
@fragment fn fs(@builtin(position) frag: vec4f) -> @location(0) vec4f {
  let p = (frag.xy - upscale.params.xy) / upscale.params.z;
  let size = vec2f(textureDimensions(source));
  if (any(p < vec2f(0.0)) || any(p >= size)) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  return textureLoad(source, vec2i(floor(p)), 0);
}`,
}

const layoutKey = new WeakMap<GPUDevice, GPUBindGroupLayout>()

/** Draws a PixelPerfect camera's image onto its real target, scaled by a whole number. */
export function pixelUpscaleNode(): NodeDescriptor {
  const buffers = new Map<string, GPUBuffer>()
  const groups = new Map<string, { texture: GPUTexture; group: GPUBindGroup }>()
  const pipelines = new Map<string, GPURenderPipeline>()
  const params = new Float32Array(4)
  let generation = -1
  return {
    kind: 'render',
    phase: RenderPhase.Display,
    enabled: (view: RenderView) => view.data.upscale !== undefined,
    writes: ['view-target'],
    color: [{ resource: 'view-target', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx: NodeContext) => {
      const gpu = ctx.gpu
      if (generation !== gpu.generation) {
        generation = gpu.generation
        buffers.clear()
        groups.clear()
        pipelines.clear()
      }
      const layout = ctx.view.data.upscale as PixelPerfectLayout
      const shaders = ctx.world.resource(Shaders)
      const fs = shaders.module(gpu, { root: 'shard::post::pixel_upscale' })
      const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
      if (!fs || !vs) {
        gpu.pipelines.skipped++
        return
      }
      let bindLayout = layoutKey.get(gpu.device)
      if (!bindLayout) {
        bindLayout = gpu.layouts.bindGroupLayout({
          label: 'pixel-upscale',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'unfilterable-float' },
            },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ],
        })
        layoutKey.set(gpu.device, bindLayout)
      }
      const format = ctx.texture('view-target').format
      let pipeline = pipelines.get(format)
      if (!pipeline) {
        pipeline = gpu.pipelines.render({
          label: `pixel-upscale/${format}`,
          layout: gpu.layouts.pipelineLayout({
            label: 'pixel-upscale',
            bindGroupLayouts: [bindLayout],
          }),
          vertex: { module: vs, entryPoint: 'vs' },
          fragment: { module: fs, entryPoint: 'fs', targets: [{ format }] },
        })
        if (!pipeline) return
        pipelines.set(format, pipeline)
      }
      let buffer = buffers.get(ctx.view.name)
      if (!buffer) {
        buffer = gpu.device.createBuffer({
          label: `${ctx.view.name}/upscale`,
          size: 16,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        buffers.set(ctx.view.name, buffer)
      }
      params[0] = layout.offsetX
      params[1] = layout.offsetY
      params[2] = layout.scale
      gpu.device.queue.writeBuffer(buffer, 0, params)
      const source = layout.target.texture()
      let cached = groups.get(ctx.view.name)
      if (!cached || cached.texture !== source) {
        cached = {
          texture: source,
          group: gpu.device.createBindGroup({
            label: 'pixel-upscale',
            layout: bindLayout,
            entries: [
              { binding: 0, resource: source.createView() },
              { binding: 1, resource: { buffer } },
            ],
          }),
        }
        groups.set(ctx.view.name, cached)
      }
      const group = cached.group
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

/**
 * Pixel-perfect cameras (spec 0045): PixelPerfect renders at one texel per pixel and scales up by a
 * whole number. Without it, PixelPerfect cameras render at full resolution.
 */
export const pixelPerfectPlugin = definePlugin({
  name: 'render/pixel-perfect',
  dependencies: ['render/forward'],
  build(app) {
    app.insertResource(PixelPerfectPath, { installed: true })
  },
  ready(app) {
    registerShaders(app.world.resource(Shaders), PIXEL_PERFECT_SHADERS)
    app.world.resource(Graph).addNode('pixel-upscale', pixelUpscaleNode())
  },
})
