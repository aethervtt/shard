import { ShardError } from '@aethervtt/shard-core'
import type { BakedTranslations } from '@aethervtt/shard-gpu-webgl2'
import { LayoutCache, PipelineCache } from './caches'
import { type GpuErrorListener, toShardError } from './errors'
import {
  blockOf,
  bufferCategory,
  DATA_TEXTURE_PREFIX,
  type GpuMemory,
  type GpuStats,
  type GpuUploads,
  Ledger,
  SHARED_OWNER,
  textureBytes,
  textureCategory,
} from './ledger'
import { Surface, type SurfaceAlpha, type SurfaceOptions } from './surface'
import {
  capabilitiesOf,
  type GpuBackendName,
  type GpuCapabilities,
  type GpuTier,
  type GraphicsReason,
  isCoreDevice,
  probeHdrSampleCount,
} from './tier'

/** The graphics API to run on (0064): 'auto' tries WebGPU, then WebGL2. */
export type GpuBackendChoice = 'auto' | GpuBackendName

/** WebGL2 settings, for tests and tools. */
export interface Webgl2ContextOptions {
  /** 'minimum' holds the device to WebGL2's floor (tests of the least capable devices). */
  profile?: 'native' | 'minimum'
  /** Checks GL errors after every submit: a round trip to the GPU process, so for dev and tests. */
  checkErrors?: boolean
  /** A context to use as it is: tests pass a fake one. */
  context?: WebGL2RenderingContext
  /**
   * A baked translation set (`shard shaders bake`), or where it's served: with every shader in it,
   * naga, the WGSL translator, never loads.
   */
  shaders?: string | URL | BakedTranslations
  /** Keeps translations in IndexedDB across sessions. Default true where there is IndexedDB. */
  persist?: boolean
}

/** Where WebGL2's translations came from this session (0064's shader cache). */
export interface ShaderCacheStats {
  hits: { memory: number; baked: number; stored: number }
  misses: { entry: string; stage: 'vertex' | 'fragment'; ms: number }[]
  nagaLoadMs: number | undefined
  baked: number
}

export interface CreateGpuContextOptions {
  /**
   * The graphics API (0064). 'auto' (default): WebGPU when it gives a device, through exactly the
   * request Shard has always made; else WebGL2, running the baseline tier. 'webgpu' never falls
   * back; 'webgl2' doesn't try WebGPU.
   */
  backend?: GpuBackendChoice
  /** WebGL2 settings, when it's the backend. */
  webgl2?: Webgl2ContextOptions
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
  /**
   * How a lost device is replaced (0061): up to `attempts` tries, `intervalMs` apart, before the
   * context gives up (`status: 'failed'`). Default 3 tries, 1 s apart.
   */
  recovery?: { attempts?: number; intervalMs?: number }
  /**
   * `'baseline'` runs the baseline tier (0064) even where the full one would: on WebGPU, a
   * compatibility-mode device. Omitted, the device decides: `full` on a core WebGPU device,
   * `baseline` on a compatibility-mode one (asked for only when no core adapter is found).
   */
  tier?: 'baseline'
}

/** Whether the device works: `lost` between a loss and its replacement, `failed` if that gave up. */
export type GpuStatus = 'ok' | 'lost' | 'failed'

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
  /** The graphics API the device runs on (0064). */
  readonly backend: GpuBackendName
  /**
   * The tier the engine runs at (0064): `full` on a core WebGPU device, `baseline` on anything
   * else that runs the baseline subset. Kept across device replacement.
   */
  readonly tier: GpuTier
  /** What the device can do, as far as the tiers care. */
  capabilities: GpuCapabilities
  /** Why better options were skipped while opening the device (no core adapter, say). */
  readonly reasons: readonly GraphicsReason[]
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
  /** Whether the device works now (0061). */
  status: GpuStatus = 'ok'
  private readonly options: CreateGpuContextOptions
  private readonly errorListeners = new Set<GpuErrorListener>()
  private readonly lostListeners = new Set<(info: DeviceLostInfo) => void>()
  private readonly surfaces_: Surface[] = []
  private readonly ledger = new Ledger()
  private readonly shared_ = new Map<string, unknown>()
  private recreating: Promise<void> | undefined
  private destroyed = false
  /** The WebGL2 shim's canvas contexts, when that's the backend. */
  private readonly canvasContext:
    | ((canvas: HTMLCanvasElement | OffscreenCanvas) => unknown)
    | undefined

  constructor(
    options: CreateGpuContextOptions,
    adapter: GPUAdapter,
    device: GPUDevice,
    format: GPUTextureFormat,
    opened: {
      backend?: GpuBackendName
      tier?: GpuTier
      reasons?: GraphicsReason[]
      hdrSampleCount?: 1 | 4
      canvasContext?: (canvas: HTMLCanvasElement | OffscreenCanvas) => unknown
    } = {},
  ) {
    this.options = options
    this.adapter = adapter
    this.device = device
    this.format = format
    this.features = new Set(device.features as unknown as Iterable<string>)
    this.backend = opened.backend ?? 'webgpu'
    this.tier = opened.tier ?? (isCoreDevice(device) ? 'full' : 'baseline')
    this.capabilities = capabilitiesOf(device, this.backend, opened.hdrSampleCount)
    this.reasons = opened.reasons ?? []
    this.canvasContext = opened.canvasContext
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
    const context = (
      this.canvasContext ? this.canvasContext(canvas) : canvas.getContext('webgpu')
    ) as GPUCanvasContext | null
    if (!context) {
      const api = this.backend === 'webgl2' ? 'WebGL2' : 'WebGPU'
      throw new ShardError('gpu/no-context', `Could not get a ${api} canvas context`)
    }
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

  /** WebGL2: where shader translations came from, and what naga translated (0064). */
  shaderCache(): ShaderCacheStats | undefined {
    return (this.device as { shaderCache?: ShaderCacheStats }).shaderCache
  }

  /**
   * WebGL2: every shader translation this session used, as a baked set to ship as
   * `webgl2.shaders` (0064). Undefined on WebGPU.
   */
  exportShaderCache(): BakedTranslations | undefined {
    return (this.device as { exportShaders?: () => BakedTranslations }).exportShaders?.()
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
    this.recreating ??= this.recover().finally(() => {
      this.recreating = undefined
    })
    return this.recreating
  }

  /** Replaces the device, retrying as `options.recovery` says; `failed` once every try failed. */
  private async recover(): Promise<void> {
    const attempts = Math.max(1, this.options.recovery?.attempts ?? 3)
    const interval = this.options.recovery?.intervalMs ?? 1000
    this.status = 'lost'
    let last: unknown
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await new Promise((resolve) => setTimeout(resolve, interval))
      if (this.destroyed) return
      try {
        await this.replaceDevice()
        this.status = 'ok'
        return
      } catch (err) {
        last = err
      }
    }
    this.status = 'failed'
    const error = new ShardError(
      'gpu/recovery-failed',
      `The GPU device couldn't be replaced after ${attempts} tries`,
      { hint: 'Tell the user 3D is unavailable; reloading the page tries again.', cause: last },
    )
    this.reportError(error)
    throw error
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
    // The same tier as before: the engine's pipelines and data layouts were made for it.
    const { adapter, device, hdrSampleCount } = await openDevice(
      this.options,
      this.tier,
      this.backend,
    )
    this.adapter = adapter
    this.device = device
    this.capabilities = capabilitiesOf(device, this.backend, hdrSampleCount)
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
      const data = descriptor.label?.startsWith(DATA_TEXTURE_PREFIX) === true
      const category = data ? 'storage' : textureCategory(descriptor.usage)
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
      ledger.upload(destination.texture, textureWriteBytes(destination.texture, data, layout, size))
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
    this.status = 'lost'
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

/**
 * Bytes a `writeTexture` call copies: the texels of its extent, capped by the data's size (not
 * `bytesPerRow` a row: a narrow write into a wide layout copies only its texels).
 */
function textureWriteBytes(
  texture: GPUTexture,
  data: unknown,
  layout: GPUTexelCopyBufferLayout,
  size: unknown,
): number {
  const [w, h, d] = extent(size)
  const bytes = ArrayBuffer.isView(data) ? data.byteLength : (data as ArrayBuffer).byteLength
  const total = bytes - (layout.offset ?? 0)
  const [bw, bh, blockBytes] = blockOf(texture.format)
  return Math.min(total, Math.ceil(w / bw) * Math.ceil(h / bh) * blockBytes * d)
}

export interface OpenedDevice {
  adapter: GPUAdapter
  device: GPUDevice
  backend: GpuBackendName
  tier: GpuTier
  reasons: GraphicsReason[]
  /** See `GpuCapabilities.hdrSampleCount`. */
  hdrSampleCount: 1 | 4
  /** The entry point the device came from (its preferred canvas format). */
  gpu: Pick<GPU, 'getPreferredCanvasFormat'>
  /** WebGL2: the shim's canvas contexts. */
  canvasContext?: (canvas: HTMLCanvasElement | OffscreenCanvas) => unknown
}

/**
 * The device for `options` (0064): on WebGPU, a core device through exactly the request Shard has
 * always made, else a compatibility-mode one; failing both (or asked to), a WebGL2 one. Both of
 * the latter run the baseline tier. `keep` and `keepBackend` replace a lost device as it was: a
 * core device isn't swapped for a compatibility one mid-session, or WebGPU for WebGL2.
 */
export async function openDevice(
  options: CreateGpuContextOptions,
  keep?: GpuTier,
  keepBackend?: GpuBackendName,
): Promise<OpenedDevice> {
  const choice = keepBackend ?? options.backend ?? 'auto'
  const reasons: GraphicsReason[] = []
  if (choice !== 'webgl2') {
    const gpu = options.gpu ?? (globalThis.navigator as Navigator | undefined)?.gpu
    if (gpu) {
      try {
        // Its own reasons (no core adapter, say) matter only if WebGPU opens after all.
        return await openWebGpu(gpu, options, keep, [])
      } catch (err) {
        if (choice === 'webgpu') throw err
        const error = err instanceof ShardError ? err : undefined
        reasons.push({
          backend: 'webgpu',
          code: error?.code.replace(/^gpu\//, '') ?? 'device-failed',
          message: error?.message ?? String(err),
        })
      }
    } else if (choice === 'webgpu') {
      throw new ShardError('gpu/unsupported', 'WebGPU is not available in this environment', {
        hint: 'Use a browser or webview with WebGPU, or pass `gpu` (e.g. from the `webgpu` package in Node).',
      })
    } else {
      reasons.push({ backend: 'webgpu', code: 'no-webgpu', message: 'This browser has no WebGPU' })
    }
  }
  return openWebgl2(options, reasons)
}

/** WebGPU: a core device, else a compatibility-mode one. */
async function openWebGpu(
  gpu: GPU,
  options: CreateGpuContextOptions,
  keep: GpuTier | undefined,
  reasons: GraphicsReason[],
): Promise<OpenedDevice> {
  const powerPreference = options.powerPreference ?? 'high-performance'
  const baseline = options.tier === 'baseline' || keep === 'baseline'
  if (!baseline) {
    const adapter = await gpu.requestAdapter({ powerPreference })
    if (adapter) {
      const device = await requestDevice(adapter, options)
      const hdrSampleCount = await probeHdrSampleCount(device)
      return {
        adapter,
        device,
        backend: 'webgpu',
        tier: tierOf(device, false),
        reasons,
        hdrSampleCount,
        gpu,
      }
    }
    if (keep === 'full') throw new ShardError('gpu/no-adapter', 'No WebGPU adapter was found')
    reasons.push({
      backend: 'webgpu',
      code: 'no-core-adapter',
      message: 'No core WebGPU adapter; asking for a compatibility-mode one',
    })
  }
  // A compatibility-mode device: one that enforces its stricter rules, since it's asked for
  // without `core-features-and-limits` (a browser without the mode answers with a core adapter).
  const adapter = await gpu.requestAdapter({ featureLevel: 'compatibility', powerPreference })
  if (!adapter) throw new ShardError('gpu/no-adapter', 'No WebGPU adapter was found')
  const device = await requestDevice(adapter, options)
  const hdrSampleCount = await probeHdrSampleCount(device)
  return {
    adapter,
    device,
    backend: 'webgpu',
    tier: tierOf(device, baseline),
    reasons,
    hdrSampleCount,
    gpu,
  }
}

/**
 * WebGL2 through the shim (0064), loaded only now: a WebGPU session never fetches it. The device
 * lives on `options.canvas` when there is one, presenting straight into it.
 */
async function openWebgl2(
  options: CreateGpuContextOptions,
  reasons: GraphicsReason[],
): Promise<OpenedDevice> {
  const webgl2 = await import('@aethervtt/shard-gpu-webgl2')
  const settings = options.webgl2 ?? {}
  const gpu = webgl2.createWebgl2Gpu({
    canvas: options.canvas,
    context: settings.context,
    profile: settings.profile,
    checkErrors: settings.checkErrors,
    shaders: settings.shaders,
    persist: settings.persist,
  })
  const powerPreference = options.powerPreference ?? 'high-performance'
  const adapter = await gpu.requestAdapter({ powerPreference })
  if (!adapter) {
    const code = gpu.unavailable ?? 'no-webgl2'
    reasons.push({ backend: 'webgl2', code, message: WEBGL2_MESSAGES[code] ?? code })
    throw new ShardError('gpu/unsupported', 'Neither WebGPU nor WebGL2 can run Shard here', {
      hint: reasons.map((r) => `${r.backend}: ${r.message}`).join('; '),
      // Each backend's reason, its backend as the path (probeGraphics reads them back).
      details: reasons.map((r) => new ShardError(`gpu/${r.code}`, r.message, { path: r.backend })),
    })
  }
  const device = await requestDevice(adapter as unknown as GPUAdapter, options)
  const hdrSampleCount = await probeHdrSampleCount(device)
  return {
    adapter: adapter as unknown as GPUAdapter,
    device,
    backend: 'webgl2',
    tier: 'baseline',
    reasons,
    hdrSampleCount,
    gpu,
    canvasContext: webgl2.canvasContext,
  }
}

const WEBGL2_MESSAGES: Record<string, string> = {
  'no-webgl2': 'This browser has no WebGL2',
  'context-lost': 'The WebGL2 context is lost',
  'no-float-render-targets': 'WebGL2 here has no float render targets (EXT_color_buffer_float)',
}

function tierOf(device: GPUDevice, baseline: boolean): GpuTier {
  return baseline || !isCoreDevice(device) ? 'baseline' : 'full'
}

async function requestDevice(adapter: GPUAdapter, options: CreateGpuContextOptions) {
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
  return adapter.requestDevice({ label: 'shard', requiredFeatures })
}

/**
 * A device, plus a first surface when `options.canvas` is given. On WebGPU without a core adapter
 * it opens a compatibility-mode device and runs the baseline tier (`gpu.tier`, 0064).
 */
export async function createGpuContext(options: CreateGpuContextOptions = {}): Promise<GpuContext> {
  const start = performance.now()
  const opened = await openDevice(options)
  const format = opened.gpu.getPreferredCanvasFormat()
  const result = new GpuContext(options, opened.adapter, opened.device, format, opened)
  result.deviceMs = performance.now() - start
  if (options.canvas) result.addSurface(options.canvas, { alpha: options.alpha })
  return result
}
