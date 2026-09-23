import { ShardError } from '@shard/core'
import { LayoutCache, PipelineCache } from './caches'
import { type GpuErrorListener, toShardError } from './errors'

export interface CreateGpuContextOptions {
  /** Omit for offscreen/headless rendering. */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** The WebGPU entry point. Defaults to `navigator.gpu`; in Node pass the `webgpu` package's. */
  gpu?: GPU
  /** Requested if the adapter supports them. */
  features?: GPUFeatureName[]
  /** Fails with `gpu/missing-feature` if the adapter lacks any. */
  requiredFeatures?: GPUFeatureName[]
  powerPreference?: GPUPowerPreference
  /**
   * Request block-compressed texture formats (BC, ASTC, ETC2) when the adapter has them. Default
   * true; Basis textures transcode to whichever the device ends up with.
   */
  compressedTextures?: boolean
}

const COMPRESSED_TEXTURE_FEATURES: GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-astc',
  'texture-compression-etc2',
]

export interface DeviceLostInfo {
  reason: string
  message: string
}

const MAX_ERRORS = 50

/**
 * The adapter, device, and optional canvas, plus the caches every renderer needs. After a device
 * loss, `recreate()` gets a new device and bumps `generation`; `GpuBuffer`s and caches rebuild
 * against it.
 */
export class GpuContext {
  adapter: GPUAdapter
  device: GPUDevice
  readonly format: GPUTextureFormat
  readonly canvas: HTMLCanvasElement | OffscreenCanvas | undefined
  readonly context: GPUCanvasContext | undefined
  readonly features: ReadonlySet<string>
  readonly pipelines: PipelineCache
  readonly layouts: LayoutCache
  /** Increments when the device is replaced. */
  generation = 0
  /** Most recent GPU errors, newest last. */
  readonly errors: ShardError[] = []
  private readonly options: CreateGpuContextOptions
  private readonly errorListeners = new Set<GpuErrorListener>()
  private readonly lostListeners = new Set<(info: DeviceLostInfo) => void>()

  constructor(
    options: CreateGpuContextOptions,
    adapter: GPUAdapter,
    device: GPUDevice,
    format: GPUTextureFormat,
    context: GPUCanvasContext | undefined,
  ) {
    this.options = options
    this.adapter = adapter
    this.device = device
    this.format = format
    this.canvas = options.canvas
    this.context = context
    this.features = new Set(device.features as unknown as Iterable<string>)
    this.pipelines = new PipelineCache(this)
    this.layouts = new LayoutCache(this)
    this.attach(device)
  }

  /** Match the canvas backing size to its CSS size. Returns true if it changed. */
  resize(): boolean {
    const canvas = this.canvas
    if (!canvas || !('clientWidth' in canvas)) return false
    const dpr = globalThis.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    return true
  }

  onError(listener: GpuErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onDeviceLost(listener: (info: DeviceLostInfo) => void): () => void {
    this.lostListeners.add(listener)
    return () => this.lostListeners.delete(listener)
  }

  reportError(error: ShardError): void {
    this.errors.push(error)
    if (this.errors.length > MAX_ERRORS) this.errors.shift()
    for (const listener of this.errorListeners) listener(error)
  }

  /**
   * Runs `fn` inside a validation error scope. Errors are reported asynchronously (WebGPU
   * resolves error scopes later) with `label` naming the object.
   */
  validate<T>(label: string, fn: () => T): T {
    this.device.pushErrorScope('validation')
    const result = fn()
    void this.device.popErrorScope().then((error) => {
      if (error) this.reportError(toShardError(error, label))
    })
    return result
  }

  /** Gets a fresh adapter and device after a loss, and reconfigures the canvas. */
  async recreate(): Promise<void> {
    const { adapter, device } = await requestDevice(this.options)
    this.adapter = adapter
    this.device = device
    this.context?.configure(canvasConfig(device, this.format))
    this.pipelines.clear()
    this.layouts.clear()
    this.generation++
    this.attach(device)
  }

  /** For tests and debugging: destroys the device and reports it as an unexpected loss. */
  simulateDeviceLoss(): void {
    this.handleLoss({ reason: 'unknown', message: 'Simulated device loss' })
    this.device.destroy()
  }

  destroy(): void {
    this.lostListeners.clear()
    this.device.destroy()
  }

  private attach(device: GPUDevice): void {
    device.addEventListener('uncapturederror', (event) => {
      this.reportError(toShardError((event as GPUUncapturedErrorEvent).error, undefined))
    })
    void device.lost.then((info) => {
      // Our own destroy() calls report 'destroyed'; only unexpected losses matter.
      if (info.reason !== 'destroyed' && device === this.device) {
        this.handleLoss({ reason: info.reason, message: info.message })
      }
    })
  }

  private handleLoss(info: DeviceLostInfo): void {
    for (const listener of this.lostListeners) listener(info)
  }
}

function canvasConfig(device: GPUDevice, format: GPUTextureFormat): GPUCanvasConfiguration {
  return {
    device,
    format,
    alphaMode: 'opaque',
    // COPY_SRC lets the renderer capture screenshots straight from the swapchain.
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  }
}

async function requestDevice(options: CreateGpuContextOptions) {
  const gpu = options.gpu ?? (globalThis.navigator as Navigator | undefined)?.gpu
  if (!gpu) {
    throw new ShardError('gpu/unsupported', 'WebGPU is not available in this environment', {
      hint: 'Use a browser or webview with WebGPU, or pass `gpu` (e.g. from the `webgpu` package in Node).',
    })
  }
  const adapter = await gpu.requestAdapter({
    powerPreference: options.powerPreference ?? 'high-performance',
  })
  if (!adapter) throw new ShardError('gpu/no-adapter', 'No WebGPU adapter was found')

  const missing = (options.requiredFeatures ?? []).filter((f) => !adapter.features.has(f))
  if (missing.length > 0) {
    throw new ShardError(
      'gpu/missing-feature',
      `The GPU lacks required features: ${missing.join(', ')}`,
    )
  }
  const requiredFeatures = [
    ...(options.requiredFeatures ?? []),
    ...[
      ...(options.features ?? []),
      ...(options.compressedTextures === false ? [] : COMPRESSED_TEXTURE_FEATURES),
    ].filter((f, i, all) => all.indexOf(f) === i && adapter.features.has(f)),
  ]
  const device = await adapter.requestDevice({ label: 'shard', requiredFeatures })
  return { adapter, device }
}

export async function createGpuContext(options: CreateGpuContextOptions = {}): Promise<GpuContext> {
  const { adapter, device } = await requestDevice(options)
  const gpu = options.gpu ?? (globalThis.navigator as Navigator).gpu
  const format = gpu.getPreferredCanvasFormat()
  let context: GPUCanvasContext | undefined
  if (options.canvas) {
    const ctx = options.canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!ctx) throw new ShardError('gpu/no-context', 'Could not get a WebGPU canvas context')
    ctx.configure(canvasConfig(device, format))
    context = ctx
  }
  const result = new GpuContext(options, adapter, device, format, context)
  result.resize()
  return result
}
