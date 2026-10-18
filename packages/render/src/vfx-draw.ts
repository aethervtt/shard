import { assetServer } from '@aethervtt/shard-assets'
import type { World } from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { Textures } from '@aethervtt/shard-texture'
import type { DecalRecord } from './decals'
import { GpuAssetsResource } from './gpu-assets'
import { type NodeContext, type NodeDescriptor, RenderPhase } from './graph'
import { InstanceSlot } from './instances'
import { Shaders, Views } from './plugin'
import { bindingDimension } from './tier'
import type { VfxRecord } from './vfx-state'
import { cameraOf } from './view'

export const VFX_SHADERS = {
  'shard::vfx::ribbon': `
struct View { vp: mat4x4f, eye: vec4f, forward: vec4f, params: vec4f, tint: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(0) @binding(1) var image: texture_2d<f32>;
@group(0) @binding(2) var image_sampler: sampler;
struct Input {
 @location(0) position: vec3f,
 @location(1) tangent: vec3f,
 @location(2) uv: vec2f,
 @location(3) color: vec4f,
 @location(4) width_side: vec2f,
}
struct Output { @builtin(position) position: vec4f, @location(0) uv: vec2f, @location(1) color: vec4f }
@vertex fn vs(in: Input) -> Output {
 var out: Output;
 var pos = in.position;
 if (in.width_side.x > 0.0) {
   var toward = view.eye.xyz - pos;
   if (view.eye.w > 0.5) { toward = -view.forward.xyz; }
   var side = cross(in.tangent, toward);
   if (dot(side, side) < 1e-12) { side = cross(in.tangent, vec3f(0.0, 1.0, 0.0)); }
   if (dot(side, side) < 1e-12) { side = vec3f(1.0, 0.0, 0.0); }
   pos += normalize(side) * in.width_side.x * in.width_side.y;
 }
 out.position = view.vp * vec4f(pos, 1.0);
 out.uv = in.uv;
 out.color = in.color * view.tint;
 return out;
}
@fragment fn fs(in: Output) -> @location(0) vec4f {
 let c = textureSample(image, image_sampler, in.uv) * in.color;
 let alpha = c.a * view.params.x;
 if (alpha <= 0.00001) { discard; }
 return vec4f(c.rgb * alpha, alpha);
}`,
}
interface DrawRecord {
  source: VfxRecord
  view: string
  vertices: GpuBuffer
  uniform: GpuBuffer
  data: Float32Array
  group: GPUBindGroup | undefined
  texture: GPUTextureView | undefined
  version: number
  generation: number
}
const OVER: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
  alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
}
const ADD: GPUBlendState = {
  color: { srcFactor: 'one', dstFactor: 'one' },
  alpha: { srcFactor: 'zero', dstFactor: 'one' },
}
const BUFFERS: GPUVertexBufferLayout[] = [
  {
    arrayStride: 56,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x2' },
      { shaderLocation: 3, offset: 32, format: 'float32x4' },
      { shaderLocation: 4, offset: 48, format: 'float32x2' },
    ],
  },
]
/** Per-world, per-view uniforms: two cameras never overwrite one another before submit. */
export class VfxRenderer {
  readonly draws: DrawRecord[] = []
  private generation = -1
  private layout: GPUBindGroupLayout | undefined
  private pipelines: (GPURenderPipeline | undefined)[] = [undefined, undefined]
  private white: GPUTexture | undefined
  private whiteView: GPUTextureView | undefined
  private sampler: GPUSampler | undefined
  private readonly decal: boolean
  private readonly records: VfxRecord[]
  constructor(records: VfxRecord[], decal: boolean) {
    this.records = records
    this.decal = decal
  }
  dispose(): void {
    for (let i = 0; i < this.draws.length; i++) {
      this.draws[i]!.vertices.destroy()
      this.draws[i]!.uniform.destroy()
    }
    this.draws.length = 0
    this.white?.destroy()
    this.white = undefined
    this.whiteView = undefined
  }
  prune(world: World): void {
    const views = world.resource(Views).list
    for (let i = this.draws.length - 1; i >= 0; i--) {
      const d = this.draws[i]!
      let view = false
      for (let j = 0; j < views.length; j++)
        if (views[j]!.name === d.view) {
          view = true
          break
        }
      if (!view || !d.source.count || !this.records.includes(d.source)) {
        d.vertices.destroy()
        d.uniform.destroy()
        this.draws.splice(i, 1)
      }
    }
  }
  private init(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.dispose()
    this.generation = gpu.generation
    this.pipelines[0] = undefined
    this.pipelines[1] = undefined
    this.layout = gpu.layouts.bindGroupLayout({
      label: 'vfx',
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
          buffer: { type: 'uniform' },
        },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
      ],
    })
    this.white = gpu.device.createTexture({
      label: 'vfx/white',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      ...bindingDimension(gpu, '2d'),
    })
    gpu.device.queue.writeTexture(
      { texture: this.white },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1],
    )
    this.whiteView = this.white.createView()
    this.sampler = gpu.device.createSampler({
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: this.decal ? 'clamp-to-edge' : 'repeat',
      addressModeV: 'clamp-to-edge',
    })
  }
  node(): NodeDescriptor {
    return {
      kind: 'render',
      phase: RenderPhase.Resolve + (this.decal ? 5 : 15),
      reads: ['depth'],
      writes: ['hdr'],
      color: [{ resource: 'hdr' }],
      depth: { resource: 'depth', readOnly: true },
      enabled: (view) => {
        const cam = cameraOf(view)
        if (!cam) return false
        for (let i = 0; i < this.records.length; i++) {
          const r = this.records[i]!
          if (r.count && r.visible && r.opacity > 0 && r.layers & cam.layers) return true
        }
        return false
      },
      run: (ctx) => this.draw(ctx),
    }
  }
  private draw(ctx: NodeContext): void {
    const gpu = ctx.gpu,
      cam = cameraOf(ctx.view)!,
      pass = ctx.renderPass!
    this.init(gpu)
    const textures = ctx.world.resource(Textures),
      assets = ctx.world.resource(GpuAssetsResource)
    for (let i = 0; i < this.records.length; i++) {
      const r = this.records[i]!
      if (!r.count || !r.visible || r.opacity <= 0 || !(r.layers & cam.layers)) continue
      const index = r.additive ? 1 : 0
      let pipeline = this.pipelines[index]
      if (!pipeline) {
        const module = ctx.world.resource(Shaders).module(gpu, { root: 'shard::vfx::ribbon' })
        if (!module) {
          gpu.pipelines.skipped++
          continue
        }
        pipeline = gpu.pipelines.render({
          label: index ? 'vfx/additive' : 'vfx/alpha',
          layout: gpu.layouts.pipelineLayout({ bindGroupLayouts: [this.layout!] }),
          vertex: { module, entryPoint: 'vs', buffers: BUFFERS },
          fragment: {
            module,
            entryPoint: 'fs',
            targets: [{ format: 'rgba16float', blend: index ? ADD : OVER }],
          },
          primitive: { topology: 'triangle-list', cullMode: 'none' },
          depthStencil: {
            format: 'depth32float',
            depthWriteEnabled: false,
            depthCompare: 'greater-equal',
            // Resolved MSAA depth comes from a subsample, not the fragment center.
            // Positive reversed-Z slope bias keeps coplanar decals visible on every adapter.
            depthBias: this.decal ? 1 : 0,
            depthBiasSlopeScale: this.decal ? 1 : 0,
          },
        })
        if (!pipeline) {
          gpu.pipelines.skipped++
          continue
        }
        this.pipelines[index] = pipeline
      }
      let d: DrawRecord | undefined
      for (let j = 0; j < this.draws.length; j++)
        if (this.draws[j]!.source === r && this.draws[j]!.view === ctx.view.name) {
          d = this.draws[j]
          break
        }
      if (!d) {
        d = {
          source: r,
          view: ctx.view.name,
          vertices: new GpuBuffer(gpu, {
            label: 'vfx/vertices',
            usage: GPUBufferUsage.VERTEX,
            size: r.vertices.byteLength,
          }),
          uniform: new GpuBuffer(gpu, {
            label: 'vfx/view',
            usage: GPUBufferUsage.UNIFORM,
            size: 128,
          }),
          data: new Float32Array(32),
          group: undefined,
          texture: undefined,
          version: -1,
          generation: gpu.generation,
        }
        this.draws.push(d)
      }
      if (d.version !== r.version) {
        d.vertices.write(r.vertices, 0, 0, r.count * 14)
        d.version = r.version
      }
      const texture = r.texture ? textures.get(r.texture) : undefined,
        gt = texture ? assets.texture(texture) : undefined
      r.textureState = !r.texture
        ? 'none'
        : gt
          ? 'ready'
          : assetServer(ctx.world).entry(r.texture)
            ? 'loading'
            : 'missing'
      const image = gt ? (texture!.usage === 'color' ? gt.srgb : gt.linear) : this.whiteView!
      if (!d.group || d.texture !== image) {
        d.texture = image
        d.group = gpu.device.createBindGroup({
          label: 'vfx/draw',
          layout: this.layout!,
          entries: [
            { binding: 0, resource: { buffer: d.uniform.buffer } },
            { binding: 1, resource: image },
            { binding: 2, resource: this.sampler! },
          ],
        })
      }
      d.data.set(cam.viewProj)
      d.data.set(cam.position, 16)
      d.data[19] = cam.orthographic ? 1 : 0
      d.data.set(cam.forward, 20)
      d.data[24] = r.opacity
      if (this.decal) {
        const colors = r.columns.color as Float32Array
        for (let k = 0; k < 4; k++) d.data[28 + k] = colors[r.row * 4 + k]!
      } else {
        d.data[28] = 1
        d.data[29] = 1
        d.data[30] = 1
        d.data[31] = 1
      }
      d.uniform.write(d.data)
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, d.group)
      pass.setVertexBuffer(0, d.vertices.buffer)
      if (this.decal) {
        const ranges = (r as DecalRecord).ranges
        for (let j = 0; j < ranges.length; j++) {
          const range = ranges[j]!
          if (!(range.layers & cam.layers)) continue
          if (cam.hidden && ctx.world.has(range.entity, InstanceSlot)) {
            const table = ctx.world.entityTableUnchecked(range.entity),
              row = ctx.world.entityRowUnchecked(range.entity),
              slot = (table.column(InstanceSlot, 'slot')[row] as number) - 1
            if (slot >= 0 && (cam.hidden.bits[slot >> 5] ?? 0) & (1 << (slot & 31))) continue
          }
          pass.draw(range.count, 1, range.start)
        }
      } else pass.draw(r.count)
    }
  }
}
