import { definePlugin } from '@aethervtt/shard-runtime'
import { addRenderFeatures } from './features'
import { type NodeContext, type NodeDescriptor, RenderPhase, type RenderView } from './graph'
import { Gpu, Graph, Shaders } from './plugin'
import { depthTex, idOf, PostCache, sampler, tex } from './post-common'
import { registerShaders } from './shaders'
import { cameraOf } from './view'

// The opaque copy (0097): after opaque geometry and the sky, the scene's HDR color at half
// resolution with mips (for rough refraction) and its depth, single-sample, as `opaque-color` and
// `opaque-depth`. Nodes that draw over the opaque scene and need what's behind them (water, later
// glass and heat haze) read those. The graph culls the copy in views where nothing reads it.

/** Where the copy runs: after opaque geometry, the sky and ground bands, before transparents. */
export const OPAQUE_COPY_PHASE = RenderPhase.Transparent - 30

/** Mips of `opaque-color` at most: the last is 1/32 resolution, enough for rough refraction. */
export const OPAQUE_COPY_MIPS = 5

export const OPAQUE_COPY_SHADERS: Record<string, string> = {
  'shard::opaque_copy': `
import shard::fullscreen::FullscreenOutput;

@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var source_sampler: sampler;

/** Half the size of its source: one bilinear tap between four texels is their mean. */
@fragment fn downsample(in: FullscreenOutput) -> @location(0) vec4f {
  return textureSampleLevel(source, source_sampler, in.uv, 0.0);
}`,
  'shard::opaque_copy::depth': `
@if(MSAA) @group(0) @binding(0) var depth_in: texture_depth_multisampled_2d;
@if(!MSAA) @group(0) @binding(0) var depth_in: texture_depth_2d;

/**
 * The scene's depth (reversed Z) as a float. Multisampled, the nearest sample: a pixel an edge
 * crosses counts as the nearer surface, so what reads it never takes that pixel's color for what's
 * behind.
 */
@fragment fn copy(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let at = vec2i(p.xy);
  var depth = textureLoad(depth_in, at, 0);
  @if(MSAA) for (var i = 1; i < i32(textureNumSamples(depth_in)); i++) {
    depth = max(depth, textureLoad(depth_in, at, i));
  }
  return vec4f(depth, 0.0, 0.0, 1.0);
}`,
}

/** Mips of a view's `opaque-color`: down to 1/32 resolution, and at least one. */
export function opaqueCopyMips(view: RenderView): number {
  const w = Math.max(1, Math.ceil((view.width ?? view.target.width) / 2))
  const h = Math.max(1, Math.ceil((view.height ?? view.target.height) / 2))
  return Math.max(1, Math.min(OPAQUE_COPY_MIPS, Math.floor(Math.log2(Math.min(w, h))) + 1))
}

/**
 * The copy, for one view: depth first (full resolution), then color into mip 0 and each mip from
 * the one above. Full tier: the scene's depth itself, multisampled or not. Baseline (0064): `depth`,
 * the single-sample prepass, since GLSL ES 3.00 can't read a multisampled texture.
 */
export function opaqueCopyNode(baseline: boolean): NodeDescriptor {
  const source = baseline ? 'depth' : 'scene-depth'
  const cache = new PostCache()
  const layouts: { gen: number; color?: GPUBindGroupLayout; depth?: GPUBindGroupLayout } = {
    gen: -1,
  }
  const layoutsMsaa: { depth?: GPUBindGroupLayout } = {}
  const views = new WeakMap<GPUTexture, GPUTextureView[]>()
  const mipView = (t: GPUTexture, mip: number): GPUTextureView => {
    let list = views.get(t)
    if (!list) {
      list = []
      for (let k = 0; k < t.mipLevelCount; k++)
        list.push(t.createView({ baseMipLevel: k, mipLevelCount: 1 }))
      views.set(t, list)
    }
    return list[mip]!
  }
  const attachment: GPURenderPassColorAttachment = {
    view: undefined as unknown as GPUTextureView,
    loadOp: 'clear',
    clearValue: { r: 0, g: 0, b: 0, a: 0 },
    storeOp: 'store',
  }
  const passDescriptor: GPURenderPassDescriptor = { label: '', colorAttachments: [attachment] }
  const begin = (ctx: NodeContext, label: string, view: GPUTextureView, timed: boolean) => {
    attachment.view = view
    passDescriptor.label = label
    passDescriptor.timestampWrites = timed ? ctx.timestamps('opaque-copy') : undefined
    return ctx.encoder.beginRenderPass(passDescriptor)
  }
  return {
    kind: 'raw',
    phase: OPAQUE_COPY_PHASE,
    enabled: (view) => cameraOf(view) !== undefined,
    reads: ['hdr', source],
    writes: [
      {
        name: 'opaque-color',
        format: 'rgba16float',
        size: { divide: 2 },
        mipLevelCount: opaqueCopyMips,
      },
      { name: 'opaque-depth', format: 'r32float' },
    ],
    run: (ctx) => {
      const cam = cameraOf(ctx.view)
      if (!cam) return
      const gpu = ctx.gpu
      if (layouts.gen !== gpu.generation) {
        layouts.gen = gpu.generation
        layouts.color = gpu.layouts.bindGroupLayout({
          label: 'opaque-copy',
          entries: [tex(0), sampler(1)],
        })
        layouts.depth = gpu.layouts.bindGroupLayout({
          label: 'opaque-copy/depth',
          entries: [depthTex(gpu, 0)],
        })
        layoutsMsaa.depth = gpu.layouts.bindGroupLayout({
          label: 'opaque-copy/depth-msaa',
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: 'depth', multisampled: true },
            },
          ],
        })
      }
      const msaa = cam.msaa > 1 && !baseline
      const depthLayout = msaa ? layoutsMsaa.depth! : layouts.depth!
      const copyDepth = cache.render(
        ctx,
        msaa ? 'opaque-copy/depth-msaa' : 'opaque-copy/depth',
        'shard::opaque_copy::depth',
        'copy',
        [depthLayout],
        [{ format: 'r32float' }],
        { MSAA: msaa },
      )
      const down = cache.render(
        ctx,
        'opaque-copy/color',
        'shard::opaque_copy',
        'downsample',
        [layouts.color!],
        [{ format: 'rgba16float' }],
      )
      if (!copyDepth || !down) return
      const depthIn = ctx.texture(source)
      const depthOut = ctx.texture('opaque-depth')
      const hdr = ctx.texture('hdr')
      const color = ctx.texture('opaque-color')
      const name = ctx.view.name
      let pass = begin(ctx, 'opaque-copy/depth', mipView(depthOut, 0), true)
      pass.setPipeline(copyDepth)
      pass.setBindGroup(
        0,
        cache.group(gpu, `${name}/opaque-copy/depth`, `${idOf(depthIn)}`, depthLayout, () => [
          { binding: 0, resource: depthIn.createView() },
        ]),
      )
      pass.draw(3)
      pass.end()
      const linear = cache.sampler(gpu)
      for (let k = 0; k < color.mipLevelCount; k++) {
        const from = k === 0 ? hdr : color
        pass = begin(ctx, 'opaque-copy/color', mipView(color, k), false)
        pass.setPipeline(down)
        pass.setBindGroup(
          0,
          cache.group(
            gpu,
            `${name}/opaque-copy/${k}`,
            `${idOf(from)}/${idOf(color)}`,
            layouts.color!,
            () => [
              { binding: 0, resource: k === 0 ? hdr.createView() : mipView(color, k - 1) },
              { binding: 1, resource: linear },
            ],
          ),
        )
        pass.draw(3)
        pass.end()
      }
    },
  }
}

/**
 * The opaque copy (0097): half-resolution HDR color with mips and single-sample depth after opaque
 * geometry, as `opaque-color` and `opaque-depth`, for nodes that declare
 * `reads: ['opaque-color', 'opaque-depth']`. It runs only in views where something reads it.
 */
export const opaqueCopyPlugin = definePlugin({
  name: 'render/opaque-copy',
  dependencies: ['render/forward'],
  build() {},
  ready(app) {
    const world = app.world
    registerShaders(world.resource(Shaders), OPAQUE_COPY_SHADERS)
    addRenderFeatures(world, {
      name: 'render/opaque-copy',
      description:
        'A half-resolution copy of the opaque scene with mips, and its depth, for water and refraction.',
      nodes: ['opaque-copy'],
      baseline: {
        strategy: 'The same blits as fragment passes; depth from the single-sample depth prepass',
      },
    })
    world
      .resource(Graph)
      .addNode('opaque-copy', opaqueCopyNode(world.resource(Gpu).tier === 'baseline'))
  },
})
