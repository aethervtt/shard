import type { ShardError } from '@shard/core'
import type { GpuContext } from './context'
import { toShardError } from './errors'
import { descriptorKey } from './key'

type PipelineState<T> =
  | { status: 'pending'; promise: Promise<void> }
  | { status: 'ready'; pipeline: T }
  | { status: 'failed'; error: ShardError }

/**
 * Render and compute pipelines, created asynchronously and cached by descriptor. `render()` returns
 * undefined until the pipeline is ready; callers skip that draw for the frame instead of stalling.
 */
export class PipelineCache {
  /** Draws skipped because their pipeline was still compiling. Reset by the renderer each frame. */
  skipped = 0
  private readonly render_ = new Map<string, PipelineState<GPURenderPipeline>>()
  private readonly compute_ = new Map<string, PipelineState<GPUComputePipeline>>()
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  render(descriptor: GPURenderPipelineDescriptor): GPURenderPipeline | undefined {
    return this.get(this.render_, descriptor, (d) => this.gpu.device.createRenderPipelineAsync(d))
  }

  compute(descriptor: GPUComputePipelineDescriptor): GPUComputePipeline | undefined {
    return this.get(this.compute_, descriptor, (d) => this.gpu.device.createComputePipelineAsync(d))
  }

  /** Pipelines still compiling. */
  get pending(): number {
    let n = 0
    for (const s of this.render_.values()) if (s.status === 'pending') n++
    for (const s of this.compute_.values()) if (s.status === 'pending') n++
    return n
  }

  /** Resolves when every pipeline requested so far has finished compiling (or failed). */
  async whenIdle(): Promise<void> {
    const pending: Promise<void>[] = []
    for (const s of [...this.render_.values(), ...this.compute_.values()]) {
      if (s.status === 'pending') pending.push(s.promise)
    }
    await Promise.all(pending)
  }

  /** Errors from pipelines that failed to compile, by label. */
  failures(): ShardError[] {
    const out: ShardError[] = []
    for (const s of [...this.render_.values(), ...this.compute_.values()]) {
      if (s.status === 'failed') out.push(s.error)
    }
    return out
  }

  clear(): void {
    this.render_.clear()
    this.compute_.clear()
  }

  private get<D extends GPUObjectDescriptorBase, T>(
    map: Map<string, PipelineState<T>>,
    descriptor: D,
    create: (d: D) => Promise<T>,
  ): T | undefined {
    const key = descriptorKey(descriptor)
    const state = map.get(key)
    if (state?.status === 'ready') return state.pipeline
    if (state) {
      this.skipped++
      return undefined
    }
    const promise = create(descriptor).then(
      (pipeline) => {
        map.set(key, { status: 'ready', pipeline })
      },
      (err: Error) => {
        const error = toShardError(err, descriptor.label)
        map.set(key, { status: 'failed', error })
        this.gpu.reportError(error)
      },
    )
    map.set(key, { status: 'pending', promise })
    this.skipped++
    return undefined
  }
}

/** Bind group layouts, pipeline layouts, and samplers: equal descriptors give the same object. */
export class LayoutCache {
  private readonly bindGroupLayouts = new Map<string, GPUBindGroupLayout>()
  private readonly pipelineLayouts = new Map<string, GPUPipelineLayout>()
  private readonly samplers = new Map<string, GPUSampler>()
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  bindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): GPUBindGroupLayout {
    return cached(this.bindGroupLayouts, descriptor, () =>
      this.gpu.device.createBindGroupLayout(descriptor),
    )
  }

  pipelineLayout(descriptor: GPUPipelineLayoutDescriptor): GPUPipelineLayout {
    return cached(this.pipelineLayouts, descriptor, () =>
      this.gpu.device.createPipelineLayout(descriptor),
    )
  }

  sampler(descriptor: GPUSamplerDescriptor = {}): GPUSampler {
    return cached(this.samplers, descriptor, () => this.gpu.device.createSampler(descriptor))
  }

  clear(): void {
    this.bindGroupLayouts.clear()
    this.pipelineLayouts.clear()
    this.samplers.clear()
  }
}

function cached<T>(map: Map<string, T>, descriptor: unknown, create: () => T): T {
  const key = descriptorKey(descriptor)
  let value = map.get(key)
  if (!value) {
    value = create()
    map.set(key, value)
  }
  return value
}
