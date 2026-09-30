import { ShardError } from '@aethervtt/shard-core'
import { LayoutCache, PipelineCache } from './caches'
import { type GpuErrorListener, toShardError } from './errors'
import {
  bufferCategory,
  type GpuMemory,
  type GpuStats,
  type GpuUploads,
  Ledger,
  SHARED_OWNER,
  textureBytes,
  textureCategory,
} from './ledger'
import { Surface, type SurfaceAlpha, type SurfaceOptions } from './surface'

export interface CreateGpuContextOptions {
  /** A canvas to add as the first surface. Omit for a device only (headless, or surfaces later). */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** The canvas surface's alpha mode. Default 'opaque'. */
  alpha?: SurfaceAlpha
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

/**
 * Optional features the renderer uses when present, requested whenever the adapter has them:
 * an 11/11/10 float G-buffer target, indirect draws with a first instance (GPU culling), and
 * filterable 32-bit float textures.
 */
const RENDERER_FEATURES: GPUFeatureName[] = [
  'rg11b10ufloat-renderable',
  'indirect-first-instance',
  'float32-filterable',
]

export interface DeviceLostInfo {
  reason: string
  message: string
}

const MAX_ERRORS = 50

/**
 * The adapter and device, the canvases it draws into (surfaces), and the caches every renderer
 * needs. Several apps can share one (0052): each counts its buffers and textures under its own
 * owner. After a device loss, `recreate()` gets a new device and bumps `generation`; `GpuBuffer`s,
 * caches, and surfaces rebuild against it.
 */
export class GpuContext {
  adapter: GPUAdapter
  device: GPUDevice
  readonly format: GPUTextureFormat
  readonly features: ReadonlySet<string>
  readonly pipelines: PipelineCache
  readonly layouts: LayoutCache
  /** Increments when the device is replaced. */
  generation = 0
  /**
   * How long the first adapter and device request took, in ms (0062's `coldStart.device`). Set by
   * `createGpuContext`; 0 for a context built directly.
   */
  deviceMs = 0
  /**
   * Who new buffers and textures count against. An app sets it to its owner while it runs (the
   * render plugin's scope); otherwise it's `'gpu'`, the device's own.
   */
  owner = SHARED_OWNER
  /** Most recent GPU errors, newest last. */
  readonly errors: ShardError[] = []
  private readonly options: CreateGpuContextOptions
  private readonly errorListeners = new Set<GpuErrorListener>()
  private readonly lostListeners = new Set<(info: DeviceLostInfo) => void>()
  private readonly surfaces_: Surface[] = []
  private readonly ledger = new Ledger()
  private readonly shared_ = new Map<string, unknown>()
  private recreating: Promise<void> | undefined
  private destroyed = false

  constructor(
    options: CreateGpuContextOptions,
    adapter: GPUAdapter,
    device: GPUDevice,
    format: GPUTextureFormat,
  ) {
    this.options = options
    this.adapter = adapter
    this.device = device
    this.format = format
    this.features = new Set(device.features as unknown as Iterable<string>)
    this.pipelines = new PipelineCache(this)
    this.layouts = new LayoutCache(this)
    this.attach(device)
  }

  // --- surfaces ----------------------------------------------------------------

  /** The canvases this device draws into, in the order they were added. */
  get surfaces(): readonly Surface[] {
    return this.surfaces_
  }

  /** Configures a canvas as a surface of this device. `surface.remove()` gives it back. */
  addSurface(canvas: HTMLCanvasElement | OffscreenCanvas, options: SurfaceOptions = {}): Surface {
    const context = canvas.getContext('webgpu') as GPUCanvasContext | null
    if (!context) throw new ShardError('gpu/no-context', 'Could not get a WebGPU canvas context')
    if (this.surfaces_.some((s) => s.canvas === canvas)) {
      throw new ShardError('gpu/duplicate-surface', 'This canvas is already a surface', {
        hint: 'Share the Surface itself (renderPlugin({ gpu, surface })), or remove it first.',
      })
    }
    const n = this.surfaces_.length
    const surface = new Surface(this, canvas, context, {
      alpha: options.alpha ?? 'opaque',
      label: options.label ?? (n === 0 ? 'surface' : `surface-${n + 1}`),
    })
    this.surfaces_.push(surface)
    return surface
  }

  /** @internal Called by `Surface.remove()`. */
  forgetSurface(surface: Surface): void {
    const i = this.surfaces_.indexOf(surface)
    if (i !== -1) this.surfaces_.splice(i, 1)
  }

  // --- accounting ----------------------------------------------------------------

  /** Runs `fn` with new buffers and textures counted against `owner`. */
  withOwner<T>(owner: string, fn: () => T): T {
    const previous = this.owner
    this.owner = owner
    try {
      return fn()
    } finally {
      this.owner = previous
    }
  }

  /** Live buffers and textures this device made for `owner`, or for everyone (0052). */
  stats(owner?: string): GpuStats {
    return this.ledger.stats(owner)
  }

  /** Live bytes for `owner` (or everyone) by what they're for: targets, textures, geometry... (0062). */
  memory(owner?: string): GpuMemory {
    return this.ledger.memory(owner)
  }

  /**
   * Bytes `owner` has written to the GPU since the device was made, by upload category, and the
   * buffers and textures it created (0055). Cumulative: diff two reads for a frame's worth.
   */
  uploads(owner: string): GpuUploads {
    return this.ledger.uploads(owner)
  }

  /** Owners with live objects, sorted. */
  owners(): string[] {
    return this.ledger.names()
  }

  /** Destroys every buffer and texture `owner` still has. Returns how many. */
  release(owner: string): number {
    return this.ledger.release(owner)
  }

  /**
   * A per-device object every app on this device shares, made once by `create` and counted against
   * the device, not whichever app asked first. Made again after a device loss.
   */
  shared<T>(key: string, create: (device: GPUDevice) => T): T {
    if (this.shared_.has(key)) return this.shared_.get(key) as T
    const value = this.withOwner(SHARED_OWNER, () => create(this.device))
    this.shared_.set(key, value)
    return value
  }

  // --- errors and loss -------------------------------------------------------------

  onError(listener: GpuErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  onDeviceLost(listener: (info: DeviceLostInfo) => void): () => void {
    this.lostListeners.add(listener)
    return () => this.lostListeners.delete(listener)
  }

  /** Error and device-loss listeners, for teardown tests. */
  get listenerCount(): { error: number; lost: number } {
    return { error: this.errorListeners.size, lost: this.lostListeners.size }
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

  /**
   * Gets a fresh adapter and device after a loss and reconfigures every surface with its alpha
   * mode. Apps sharing the device all call it; they share one recreation.
   */
  recreate(): Promise<void> {
    this.recreating ??= this.replaceDevice().finally(() => {
      this.recreating = undefined
    })
    return this.recreating
  }

  /** For tests and debugging: destroys the device and reports it as an unexpected loss. */
  simulateDeviceLoss(): void {
    this.handleLoss({ reason: 'unknown', message: 'Simulated device loss' })
    this.device.destroy()
  }

  /** Removes every surface and destroys the device. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.lostListeners.clear()
    this.errorListeners.clear()
    for (const surface of [...this.surfaces_]) surface.remove()
    this.ledger.clear()
    this.shared_.clear()
    this.device.destroy()
  }

  private async replaceDevice(): Promise<void> {
    const { adapter, device } = await requestDevice(this.options)
    this.adapter = adapter
    this.device = device
    // Everything counted lived on the old device.
    this.ledger.clear()
    this.shared_.clear()
    this.pipelines.clear()
    this.layouts.clear()
    this.generation++
    this.attach(device)
    for (const surface of this.surfaces_) surface.configure()
  }

  private attach(device: GPUDevice): void {
    this.instrument(device)
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

  /**
   * Counts every buffer and texture the device makes against the current owner, and every byte
   * written into one against its owner and upload category.
   */
  private instrument(device: GPUDevice): void {
    const ledger = this.ledger
    const createBuffer = device.createBuffer.bind(device)
    const createTexture = device.createTexture.bind(device)
    device.createBuffer = (descriptor) => {
      const buffer = createBuffer(descriptor)
      const category = bufferCategory(descriptor.usage)
      ledger.track(buffer, this.owner, false, descriptor.size, category, descriptor.label)
      return buffer
    }
    device.createTexture = (descriptor) => {
      const texture = createTexture(descriptor)
      const category = textureCategory(descriptor.usage)
      ledger.track(texture, this.owner, true, textureBytes(descriptor), category, descriptor.label)
      return texture
    }
    const queue = device.queue
    const writeBuffer = queue.writeBuffer.bind(queue)
    const writeTexture = queue.writeTexture.bind(queue)
    const copyExternal = queue.copyExternalImageToTexture?.bind(queue)
    queue.writeBuffer = (buffer, offset, data, dataOffset, size) => {
      writeBuffer(buffer, offset, data, dataOffset, size)
      ledger.upload(buffer, writtenBytes(data, dataOffset, size))
    }
    queue.writeTexture = (destination, data, layout, size) => {
      writeTexture(destination, data, layout, size as GPUExtent3D)
      ledger.upload(destination.texture, textureWriteBytes(data, layout, size))
    }
    if (copyExternal) {
      queue.copyExternalImageToTexture = (source, destination, size) => {
        copyExternal(source, destination, size as GPUExtent3D)
        const [w, h, d] = extent(size)
        ledger.upload(destination.texture, w * h * d * 4)
      }
    }
  }

  private handleLoss(info: DeviceLostInfo): void {
    for (const listener of this.lostListeners) listener(info)
  }
}

/** Bytes a `writeBuffer` call copies: offsets and sizes are in elements for typed arrays. */
function writtenBytes(
  data: unknown,
  dataOffset: number | undefined,
  size: number | undefined,
): number {
  if (ArrayBuffer.isView(data)) {
    const unit = (data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
    return (size ?? data.byteLength / unit - (dataOffset ?? 0)) * unit
  }
  return size ?? (data as ArrayBuffer).byteLength - (dataOffset ?? 0)
}

function extent(size: unknown): [number, number, number] {
  if (Symbol.iterator in (size as object)) {
    const a = [...(size as Iterable<number>)]
    return [a[0] ?? 1, a[1] ?? 1, a[2] ?? 1]
  }
  const d = size as GPUExtent3DDict
  return [d.width, d.height ?? 1, d.depthOrArrayLayers ?? 1]
}

/** Bytes a `writeTexture` call copies: the rows it reads, capped by the data's size. */
function textureWriteBytes(data: unknown, layout: GPUTexelCopyBufferLayout, size: unknown): number {
  const [w, h, d] = extent(size)
  const bytes = ArrayBuffer.isView(data) ? data.byteLength : (data as ArrayBuffer).byteLength
  const total = bytes - (layout.offset ?? 0)
  const rows = (layout.rowsPerImage ?? h) * d
  const perRow = layout.bytesPerRow ?? w * 4
  return Math.min(total, perRow * rows)
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
      ...RENDERER_FEATURES,
      ...(options.compressedTextures === false ? [] : COMPRESSED_TEXTURE_FEATURES),
    ].filter((f, i, all) => all.indexOf(f) === i && adapter.features.has(f)),
  ]
  const device = await adapter.requestDevice({ label: 'shard', requiredFeatures })
  return { adapter, device }
}

/** A device, plus a first surface when `options.canvas` is given. */
export async function createGpuContext(options: CreateGpuContextOptions = {}): Promise<GpuContext> {
  const start = performance.now()
  const { adapter, device } = await requestDevice(options)
  const gpu = options.gpu ?? (globalThis.navigator as Navigator).gpu
  const format = gpu.getPreferredCanvasFormat()
  const result = new GpuContext(options, adapter, device, format)
  result.deviceMs = performance.now() - start
  if (options.canvas) result.addSurface(options.canvas, { alpha: options.alpha })
  return result
}
