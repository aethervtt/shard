import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import { ForwardStateResource, type ViewGpu } from './forward'
import type { NodeContext } from './graph'
import { Shaders } from './plugin'
import { depthReadEntry } from './tier'
import { type CameraData, cameraOf } from './view'

// Plumbing shared by the display stage (tonemap, upscale) and the post effects.

const textureIds = new WeakMap<object, number>()
let nextId = 1
export function idOf(o: object): number {
  let id = textureIds.get(o)
  if (id === undefined) {
    id = nextId++
    textureIds.set(o, id)
  }
  return id
}

export const F = () => GPUShaderStage.FRAGMENT
export const tex = (binding: number, sampleType: GPUTextureSampleType = 'float') => ({
  binding,
  visibility: F(),
  texture: { sampleType },
})
/** Depth read without comparison, in the fragment stage (a float texture on baseline, 0064). */
export const depthTex = (gpu: GpuContext, binding: number) => depthReadEntry(gpu, binding, F())
export const uniform = (binding: number, visibility = F()) => ({
  binding,
  visibility,
  buffer: { type: 'uniform' as const },
})
export const sampler = (binding: number) => ({
  binding,
  visibility: F(),
  sampler: { type: 'filtering' as const },
})

/** Per-node caches: pipelines by key, bind groups by slot, uniform buffers by view. */
export class PostCache {
  private generation = -1
  private readonly pipelines = new Map<string, GPURenderPipeline | GPUComputePipeline>()
  private readonly groups = new Map<string, { key: string; group: GPUBindGroup }>()
  private readonly buffers = new Map<string, GpuBuffer>()
  private linear: GPUSampler | undefined

  check(gpu: GpuContext): void {
    if (this.generation === gpu.generation) return
    this.generation = gpu.generation
    this.pipelines.clear()
    this.groups.clear()
    this.buffers.clear()
    this.linear = undefined
  }

  /** A fullscreen render pipeline: `shard::fullscreen` vertex stage and `root`'s `entry`. */
  render(
    ctx: NodeContext,
    key: string,
    root: string,
    entry: string,
    layouts: GPUBindGroupLayout[],
    targets: GPUColorTargetState[],
    defines?: Record<string, boolean>,
  ): GPURenderPipeline | undefined {
    const gpu = ctx.gpu
    this.check(gpu)
    const cached = this.pipelines.get(key) as GPURenderPipeline | undefined
    if (cached) return cached
    const shaders = ctx.world.resource(Shaders)
    const fs = shaders.module(gpu, { root, defines })
    const vs = shaders.module(gpu, { root: 'shard::fullscreen' })
    if (!fs || !vs) {
      gpu.pipelines.skipped++
      return undefined
    }
    const pipeline = gpu.pipelines.render({
      label: key,
      layout: gpu.layouts.pipelineLayout({ label: key, bindGroupLayouts: layouts }),
      vertex: { module: vs, entryPoint: 'vs' },
      fragment: { module: fs, entryPoint: entry, targets },
    })
    if (pipeline) this.pipelines.set(key, pipeline)
    return pipeline
  }

  compute(
    ctx: NodeContext,
    key: string,
    root: string,
    entry: string,
    layouts: GPUBindGroupLayout[],
    defines?: Record<string, boolean>,
  ): GPUComputePipeline | undefined {
    const gpu = ctx.gpu
    this.check(gpu)
    const cached = this.pipelines.get(key) as GPUComputePipeline | undefined
    if (cached) return cached
    const module = ctx.world.resource(Shaders).module(gpu, defines ? { root, defines } : { root })
    if (!module) {
      gpu.pipelines.skipped++
      return undefined
    }
    const pipeline = gpu.pipelines.compute({
      label: key,
      layout: gpu.layouts.pipelineLayout({ label: key, bindGroupLayouts: layouts }),
      compute: { module, entryPoint: entry },
    })
    if (pipeline) this.pipelines.set(key, pipeline)
    return pipeline
  }

  /** A bind group, rebuilt when `key` (the ids of what it binds) changes. */
  group(
    gpu: GpuContext,
    slot: string,
    key: string,
    layout: GPUBindGroupLayout,
    entries: () => GPUBindGroupEntry[],
  ): GPUBindGroup {
    this.check(gpu)
    let g = this.groups.get(slot)
    if (!g || g.key !== key) {
      g = { key, group: gpu.device.createBindGroup({ label: slot, layout, entries: entries() }) }
      this.groups.set(slot, g)
    }
    return g.group
  }

  buffer(gpu: GpuContext, name: string, size: number): GpuBuffer {
    this.check(gpu)
    let b = this.buffers.get(name)
    if (!b) {
      b = new GpuBuffer(gpu, { label: name, usage: GPUBufferUsage.UNIFORM, size })
      this.buffers.set(name, b)
    }
    return b
  }

  sampler(gpu: GpuContext): GPUSampler {
    this.check(gpu)
    this.linear ??= gpu.device.createSampler({
      label: 'post/linear',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    })
    return this.linear
  }
}

export function forwardView(ctx: NodeContext): { cam: CameraData; pv: ViewGpu } | undefined {
  const cam = cameraOf(ctx.view)
  const pv = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)
  return cam && pv ? { cam, pv } : undefined
}

/** A fullscreen pass the node begins itself (raw nodes with several passes). */
export function beginPass(
  ctx: NodeContext,
  name: string,
  view: GPUTextureView,
  load = false,
): GPURenderPassEncoder {
  return ctx.encoder.beginRenderPass({
    label: `${ctx.view.name}/${name}`,
    colorAttachments: [
      {
        view,
        loadOp: load ? 'load' : 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        storeOp: 'store',
      },
    ],
    timestampWrites: ctx.timestamps(name),
  })
}

export const HDR: GPUColorTargetState[] = [{ format: 'rgba16float' }]
export const scratch = new Float32Array(64)
