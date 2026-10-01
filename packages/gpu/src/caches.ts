import type { ShardError } from '@aethervtt/shard-core'
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
  /** Compiles in flight, and when the current run of them started (0062's `coldStart.pipelines`). */
  private compiling = 0
  private busySince = 0
  private busyTotal = 0

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  /**
   * Wall time, in ms, during which at least one pipeline was compiling, counted since the cache was
   * made. Compiles that overlap count once.
   */
  busyMs(now = performance.now()): number {
    return this.busyTotal + (this.compiling > 0 ? now - this.busySince : 0)
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

  /** Why the pipeline for `descriptor` failed, if it did (0061): callers draw a fallback instead. */
  failure(
    descriptor: GPURenderPipelineDescriptor | GPUComputePipelineDescriptor,
  ): ShardError | undefined {
    const key = descriptorKey(descriptor)
    const state = this.render_.get(key) ?? this.compute_.get(key)
    return state?.status === 'failed' ? state.error : undefined
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
    // A failed pipeline never compiles: not a skipped draw, since callers draw a fallback (0061).
    if (state?.status === 'failed') return undefined
    if (state) {
      this.skipped++
      return undefined
    }
    if (this.compiling++ === 0) this.busySince = performance.now()
    const promise = create(descriptor).then(
      (pipeline) => {
        this.compiled()
        map.set(key, { status: 'ready', pipeline })
      },
      (err: Error) => {
        this.compiled()
        const error = toShardError(err, descriptor.label)
        map.set(key, { status: 'failed', error })
        this.gpu.reportError(error)
      },
    )
    map.set(key, { status: 'pending', promise })
    this.skipped++
    return undefined
  }

  private compiled(): void {
    if (--this.compiling === 0) this.busyTotal += performance.now() - this.busySince
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
