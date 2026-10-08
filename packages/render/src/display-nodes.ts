import { addRenderFeatures } from './features'
// The display stage every 3D view runs (0051): HDR to display with grading and the tonemap curve,
// then the render-scale upscale onto the target. Post effects are a separate plugin.

import type { World } from '@aethervtt/shard-core'
import { Textures } from '@aethervtt/shard-texture'
import { GpuAssetsResource } from './gpu-assets'
import { type NodeDescriptor, RenderPhase } from './graph'
import { Graph } from './plugin'
import { PostEffect } from './post'
import { idOf, PostCache, sampler, scratch, tex, uniform } from './post-common'
import { RenderScale } from './render-scale'
import { cameraOf } from './view'

/** White balance as LMS channel gains (Unity's method, from temperature and tint in −1..1). */
export function whiteBalance(temperature: number, tint: number, out: Float32Array): Float32Array {
  const t1 = (temperature * 100) / 60
  const t2 = (tint * 100) / 60
  const x = 0.31271 - t1 * (t1 < 0 ? 0.1 : 0.05)
  const y = 2.87 * x - 3 * x * x - 0.27509507 + t2 * 0.05
  const X = x / y
  const Z = (1 - x - y) / y
  const L = 0.7328 * X + 0.4296 - 0.1624 * Z
  const M = -0.7036 * X + 1.6975 + 0.0061 * Z
  const S = 0.003 * X + 0.0136 + 0.9834 * Z
  out[0] = 0.949237 / L
  out[1] = 1.03542 / M
  out[2] = 1.08728 / S
  return out
}

/** HDR → display: grading, vignette, the tonemap curve, an optional LUT, dithering. */
function tonemapNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  let white: GPUTexture | undefined
  const u = new Uint32Array(scratch.buffer)
  const balance = new Float32Array(3)
  return {
    kind: 'render',
    phase: RenderPhase.Tonemap,
    enabled: (view) => cameraOf(view) !== undefined,
    // Bloom's chain, when the view blooms: the glow is composited here (see the 'bloom' node).
    reads: ['post-hdr', 'bloom'],
    writes: ['ldr'],
    color: [{ resource: 'ldr', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const gpu = ctx.gpu
      const cam = cameraOf(ctx.view)!
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'tonemap',
          entries: [tex(0, 'unfilterable-float'), uniform(1), tex(2), sampler(3), tex(4)],
        })
        white = gpu.device.createTexture({
          label: 'tonemap/no-lut',
          size: [1, 1],
          format: 'rgba8unorm',
          usage: GPUTextureUsage.TEXTURE_BINDING,
        })
      }
      const format = ctx.texture('ldr').format
      const srgb = format.endsWith('-srgb')
      const alpha = cam.alphaOutput
      const bloom = (cam.post.effects & PostEffect.Bloom) !== 0
      const pipeline = cache.render(
        ctx,
        `tonemap/${format}${alpha ? '/alpha' : ''}${bloom ? '/bloom' : ''}`,
        'shard::post::tonemap',
        'fs',
        [layout],
        [{ format }],
        {
          SRGB_TARGET: srgb,
          TRANSPARENT: alpha,
          BLOOM: bloom,
        },
      )
      if (!pipeline) return
      const post = cam.post
      const g = post.grading
      let flags = 0
      if (post.effects & PostEffect.Grading) flags |= 1
      if (post.effects & PostEffect.Vignette) flags |= 2
      let lut: GPUTextureView | undefined
      if (post.effects & PostEffect.Grading && g.lut) {
        const texture = ctx.world.resource(Textures).get(g.lut as never)
        const gt = texture ? ctx.world.resource(GpuAssetsResource).texture(texture) : undefined
        if (gt) {
          lut = gt.linear
          flags |= 4
        }
      }
      scratch.fill(0, 0, 36)
      u[0] = cam.curve
      u[1] = cam.dither ? 1 : 0
      u[2] = flags
      whiteBalance(g.temperature, g.tint, balance)
      scratch[4] = balance[0]!
      scratch[5] = balance[1]!
      scratch[6] = balance[2]!
      scratch[8] = g.saturation
      scratch[9] = g.contrast
      scratch.set(g.lift, 12)
      scratch.set(g.gamma, 16)
      scratch.set(g.gain, 20)
      scratch[24] = post.vignette.intensity
      scratch[25] = post.vignette.smoothness
      scratch[26] = cam.width / Math.max(1, cam.height)
      scratch[28] = 1 / cam.width
      scratch[29] = 1 / cam.height
      // The chain's level count is the bloom node's: the texture has one mip per level.
      const chain = bloom ? ctx.texture('bloom') : undefined
      if (chain) {
        const b = post.bloom
        scratch[32] = b.intensity
        scratch[33] = chain.mipLevelCount
        scratch[34] = b.threshold > 0 ? 0 : 1
      }
      const params = cache.buffer(gpu, `${ctx.view.name}/tonemap`, 144)
      params.write(scratch, 0, 0, 36)
      const hdr = ctx.texture('post-hdr')
      const group = cache.group(
        gpu,
        `${ctx.view.name}/tonemap`,
        `${idOf(hdr)}/${params.version}/${lut ? idOf(lut) : 0}/${chain ? idOf(chain) : 0}`,
        layout,
        () => [
          { binding: 0, resource: hdr.createView() },
          { binding: 1, resource: { buffer: params.buffer } },
          { binding: 2, resource: lut ?? white!.createView() },
          { binding: 3, resource: cache.sampler(gpu) },
          {
            binding: 4,
            resource: chain ? chain.createView({ mipLevelCount: 1 }) : white!.createView(),
          },
        ],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

// --- render-scale upscale (0051) ---------------------------------------------------------------

const upscaleScratch = new Float32Array(4)

/** Scaled views: the render-resolution `display` image onto the target, sharpened. */
function upscaleNode(): NodeDescriptor {
  const cache = new PostCache()
  let layout: GPUBindGroupLayout | undefined
  let layoutGen = -1
  return {
    kind: 'render',
    phase: RenderPhase.Display + 10,
    enabled: (view) => view.width !== undefined && cameraOf(view) !== undefined,
    reads: ['display'],
    writes: ['view-target'],
    color: [{ resource: 'view-target', clear: { r: 0, g: 0, b: 0, a: 1 } }],
    run: (ctx) => {
      const gpu = ctx.gpu
      if (!layout || layoutGen !== gpu.generation) {
        layoutGen = gpu.generation
        layout = gpu.layouts.bindGroupLayout({
          label: 'upscale',
          entries: [tex(0), sampler(1), uniform(2)],
        })
      }
      const input = ctx.texture('display')
      const target = ctx.texture('view-target')
      const format = target.format
      const alpha = cameraOf(ctx.view)!.alphaOutput
      const pipeline = cache.render(
        ctx,
        `upscale/${format}${alpha ? '/alpha' : ''}`,
        'shard::post::upscale',
        'fs',
        [layout],
        [{ format }],
        { TRANSPARENT: alpha },
      )
      if (!pipeline) return
      const settings = ctx.world.tryResource(RenderScale)
      upscaleScratch[0] = 1 / target.width
      upscaleScratch[1] = 1 / target.height
      upscaleScratch[2] = Math.min(1, Math.max(0, settings?.sharpen ?? 0))
      const params = cache.buffer(gpu, `${ctx.view.name}/upscale`, 16)
      params.write(upscaleScratch, 0, 0, 4)
      const group = cache.group(
        gpu,
        `${ctx.view.name}/upscale`,
        `${idOf(input)}/${params.version}`,
        layout,
        () => [
          { binding: 0, resource: input.createView() },
          { binding: 1, resource: cache.sampler(gpu) },
          { binding: 2, resource: { buffer: params.buffer } },
        ],
      )
      const pass = ctx.renderPass!
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.draw(3)
    },
  }
}

/** Adds the display stage (tonemap, upscale) to the graph. */
export function addDisplayNodes(world: World): void {
  const graph = world.resource(Graph)
  graph.declare({ name: 'display', format: 'view' })
  addRenderFeatures(world, {
    name: 'render/display',
    description: 'Tonemapping and the upscale to the display.',
    nodes: ['tonemap', 'post/upscale'],
    baseline: { strategy: 'The same fragment passes' },
  })
  graph.addNode('tonemap', tonemapNode())
  graph.addNode('post/upscale', upscaleNode())
}
