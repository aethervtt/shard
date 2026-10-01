import { ShardError } from '@aethervtt/shard-core'
import { Webgl2BindGroup, Webgl2BindGroupLayout, Webgl2PipelineLayout } from './binding'
import type { BakedTranslations, ShaderCacheStats, Translator } from './cache'
import { CommandStream, type Webgl2CommandBuffer, Webgl2CommandEncoder } from './commands'
import { BufferUsage, MapMode } from './constants'
import { Copier } from './copies'
import { ShimError, unsupported } from './errors'
import { FramebufferCache } from './fbo'
import { CLIP, GL } from './gl'
import { Webgl2RenderPipeline, Webgl2ShaderModule } from './pipeline'
import { Webgl2Queue } from './queue'
import { Replayer } from './replay'
import { Webgl2Buffer, Webgl2Sampler, Webgl2Texture } from './resources'
import { GlState } from './state'

// A GPUDevice over a WebGL2 context: the subset of WebGPU the baseline tier uses (0064), with the
// same objects, the same errors (error scopes, `uncapturederror`), and the same loss (`lost`).

/** What the context can do, read once from GL (or WebGL2's floor, for the 'minimum' profile). */
export interface Webgl2Caps {
  /** The most samples any renderbuffer takes. */
  maxSamples: number
  /** EXT_texture_filter_anisotropic's maximum; 1 without it. */
  anisotropy: number
  /** KHR_parallel_shader_compile: links finish in the background. */
  parallelCompile: boolean
  /** Texture units a fragment shader samples (MAX_TEXTURE_IMAGE_UNITS). */
  textureUnits: number
  vertexTextureUnits: number
  combinedUnits: number
  /** EXT_clip_control: depth in [0, 1] as WebGPU has it. */
  clipControl: boolean
  /** EXT_float_blend: blending into 32-bit float targets. */
  floatBlend: boolean
  /** OES_texture_float_linear: filtering 32-bit float textures. */
  floatLinear: boolean
  maxTextureSize: number
  max3dTextureSize: number
  maxArrayLayers: number
  maxCubeSize: number
  maxDrawBuffers: number
  maxAttributes: number
  /** Varying vectors between the stages. */
  maxVaryings: number
  uniformBlockSize: number
  /** Uniform blocks a stage reads (the smaller of vertex and fragment). */
  uniformBlocks: number
  uniformBindings: number
  uniformAlignment: number
  /** Compressed families whose every format the context has. */
  compression: { bc: boolean; astc: boolean; etc2: boolean }
}

export interface Webgl2AdapterInfo {
  vendor: string
  architecture: string
  device: string
  description: string
}

export interface Webgl2DeviceOptions {
  label?: string
  /** The context's canvas: where loss is heard, and the surface it presents straight into. */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** The shim made the context: `destroy()` loses it (browsers cap live contexts). */
  ownsContext: boolean
  /** Checks GL errors after every submit: a round trip to the GPU process, so dev only. */
  checkErrors: boolean
  features: ReadonlySet<string>
  limits: Readonly<Record<string, number>>
  info: Webgl2AdapterInfo
  /** WGSL to GLSL: memory, a baked set, IndexedDB, then naga. */
  translator: Translator
  extensions: Webgl2Extensions
}

/** Extensions the device calls into, enabled by the adapter. */
export interface Webgl2Extensions {
  clipControl: unknown
  indexed: OES_draw_buffers_indexed | null
  lose: WEBGL_lose_context | null
}

export interface Webgl2DeviceLostInfo {
  reason: 'destroyed' | 'unknown'
  message: string
}

const nextTask = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

export class Webgl2Device extends EventTarget {
  label: string
  readonly gl: WebGL2RenderingContext
  readonly caps: Webgl2Caps
  readonly state: GlState
  readonly fbos: FramebufferCache
  readonly copier: Copier
  readonly replayer: Replayer
  readonly queue: Webgl2Queue
  readonly features: ReadonlySet<string>
  readonly limits: Readonly<Record<string, number>>
  readonly adapterInfo: Webgl2AdapterInfo
  readonly canvas: HTMLCanvasElement | OffscreenCanvas | undefined
  readonly lost: Promise<Webgl2DeviceLostInfo>
  onuncapturederror: ((event: Event) => void) | null = null
  /** True once lost or destroyed: calls do nothing. */
  isLost = false
  private resolveLost!: (info: Webgl2DeviceLostInfo) => void
  private readonly options: Webgl2DeviceOptions
  private readonly scopes: { filter: string; error: ShimError | null }[] = []
  private readonly streams: CommandStream[] = []
  private readonly encoders: Webgl2CommandEncoder[] = []
  private readonly fences: { sync: WebGLSync | null; resolve: () => void }[] = []
  private polling = false
  private readonly touched: Webgl2Texture[] = []
  private readonly samples = new Map<number, number>()
  private readonly onContextLost = (event: Event) => {
    // Kept restorable: a new device on this canvas gets the context back.
    event.preventDefault()
    this.lose('unknown', 'The WebGL2 context was lost')
  }

  constructor(gl: WebGL2RenderingContext, caps: Webgl2Caps, options: Webgl2DeviceOptions) {
    super()
    this.gl = gl
    this.caps = caps
    this.options = options
    this.label = options.label ?? ''
    this.canvas = options.canvas
    this.features = options.features
    this.limits = options.limits
    this.adapterInfo = options.info
    this.lost = new Promise((resolve) => {
      this.resolveLost = resolve
    })
    this.state = new GlState(gl, options.extensions.indexed)
    this.state.scratchUnit = caps.combinedUnits - 1
    this.fbos = new FramebufferCache(gl)
    if (options.checkErrors) {
      this.fbos.incomplete = (status) =>
        this.raise('validation', `A framebuffer is incomplete (0x${status.toString(16)})`)
    }
    this.copier = new Copier(this)
    this.replayer = new Replayer(this)
    this.queue = new Webgl2Queue(this)
    // Start from known state: the context may have served a device before this one.
    gl.pixelStorei(GL.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(GL.PACK_ALIGNMENT, 1)
    gl.pixelStorei(GL.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(GL.UNPACK_IMAGE_HEIGHT, 0)
    gl.pixelStorei(GL.PACK_ROW_LENGTH, 0)
    gl.disable(GL.DITHER)
    const clip = options.extensions.clipControl as {
      clipControlEXT(origin: number, depth: number): void
    } | null
    if (caps.clipControl && clip) clip.clipControlEXT(CLIP.LOWER_LEFT_EXT, CLIP.ZERO_TO_ONE_EXT)
    this.canvas?.addEventListener('webglcontextlost', this.onContextLost as EventListener)
  }

  // --- objects ----------------------------------------------------------------------

  createBuffer(descriptor: GPUBufferDescriptor): Webgl2Buffer {
    return new Webgl2Buffer(this, descriptor)
  }

  createTexture(descriptor: GPUTextureDescriptor): Webgl2Texture {
    return new Webgl2Texture(this, descriptor)
  }

  createSampler(descriptor?: GPUSamplerDescriptor): Webgl2Sampler {
    return new Webgl2Sampler(this, descriptor)
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): Webgl2BindGroupLayout {
    return new Webgl2BindGroupLayout(descriptor)
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): Webgl2PipelineLayout {
    return new Webgl2PipelineLayout(descriptor)
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): Webgl2BindGroup {
    return new Webgl2BindGroup(descriptor)
  }

  createShaderModule(descriptor: GPUShaderModuleDescriptor): Webgl2ShaderModule {
    return new Webgl2ShaderModule(descriptor)
  }

  /**
   * Translates and links now, from translations already in memory (or the baked set). Otherwise
   * the pipeline is invalid and raises a validation error: the engine makes its pipelines with
   * createRenderPipelineAsync, which can load what it needs.
   */
  createRenderPipeline(descriptor: GPURenderPipelineDescriptor): Webgl2RenderPipeline {
    const pipeline = new Webgl2RenderPipeline(this, descriptor)
    const t = this.options.translator
    const { vertex, fragment } = pipeline.stages()
    const v = t.cached(vertex.code, vertex.entry, 'vertex')
    const f = fragment && t.cached(fragment.code, fragment.entry, 'fragment')
    if (!v || (fragment && !f)) {
      this.raise(
        'validation',
        `"${pipeline.label}" has no translation yet: make it with createRenderPipelineAsync`,
      )
      return pipeline
    }
    try {
      pipeline.build(v, f)
      pipeline.finish()
    } catch (err) {
      this.raise('validation', (err as Error).message)
    }
    return pipeline
  }

  async createRenderPipelineAsync(
    descriptor: GPURenderPipelineDescriptor,
  ): Promise<Webgl2RenderPipeline> {
    const pipeline = new Webgl2RenderPipeline(this, descriptor)
    const t = this.options.translator
    const { vertex, fragment } = pipeline.stages()
    const [v, f] = await Promise.all([
      t.translate(vertex.code, vertex.entry, 'vertex'),
      fragment ? t.translate(fragment.code, fragment.entry, 'fragment') : undefined,
    ])
    if (this.isLost) throw new ShardError('gpu-webgl2/lost', 'The device was lost')
    pipeline.build(v, f)
    while (!pipeline.linked()) await nextTask()
    pipeline.finish()
    return pipeline
  }

  createComputePipeline(descriptor: GPUComputePipelineDescriptor): never {
    throw unsupported(
      `make the compute pipeline "${descriptor.label ?? ''}"`,
      'Compute is the full tier: a feature that needs it registers baseline "unsupported" (0064).',
    )
  }

  createComputePipelineAsync(descriptor: GPUComputePipelineDescriptor): Promise<never> {
    return Promise.reject(
      unsupported(
        `make the compute pipeline "${descriptor.label ?? ''}"`,
        'Compute is the full tier: a feature that needs it registers baseline "unsupported" (0064).',
      ),
    )
  }

  createQuerySet(descriptor: GPUQuerySetDescriptor): never {
    throw unsupported(`make a ${descriptor.type} query set`)
  }

  createRenderBundleEncoder(): never {
    throw unsupported('record render bundles')
  }

  importExternalTexture(): never {
    throw unsupported('import external textures', 'Copy the frame with copyExternalImageToTexture.')
  }

  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): Webgl2CommandEncoder {
    const stream = this.streams.pop() ?? new CommandStream()
    const encoder = this.encoders.pop() ?? new Webgl2CommandEncoder()
    return encoder.begin(stream, descriptor?.label ?? '')
  }

  // --- errors and loss --------------------------------------------------------------

  pushErrorScope(filter: GPUErrorFilter): void {
    this.scopes.push({ filter, error: null })
  }

  popErrorScope(): Promise<ShimError | null> {
    const scope = this.scopes.pop()
    if (!scope) return Promise.reject(new Error('popErrorScope: no error scope to pop'))
    return Promise.resolve(scope.error)
  }

  /** Reports an error as WebGPU would: to the innermost scope that filters it, else uncaptured. */
  raise(kind: ShimError['kind'], message: string): void {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const scope = this.scopes[i]!
      if (scope.filter !== kind) continue
      scope.error ??= new ShimError(kind, message)
      return
    }
    const event = Object.assign(new Event('uncapturederror'), {
      error: new ShimError(kind, message),
    })
    queueMicrotask(() => {
      this.dispatchEvent(event)
      this.onuncapturederror?.(event)
    })
  }

  destroy(): void {
    if (this.isLost) return
    this.fbos.clear()
    this.copier.clear()
    this.lose('destroyed', 'The device was destroyed')
    if (this.options.ownsContext) this.options.extensions.lose?.loseContext()
  }

  private lose(reason: Webgl2DeviceLostInfo['reason'], message: string): void {
    if (this.isLost) return
    this.isLost = true
    // A replacement device listens on this canvas now.
    this.canvas?.removeEventListener('webglcontextlost', this.onContextLost as EventListener)
    for (const f of this.fences.splice(0)) f.resolve()
    this.resolveLost({ reason, message })
  }

  // --- submission ---------------------------------------------------------------------

  /** @internal Replays command buffers, then shows the canvases they drew. */
  submit(buffers: Iterable<Webgl2CommandBuffer>): void {
    if (this.isLost) return
    if (Array.isArray(buffers)) {
      const list = buffers as Webgl2CommandBuffer[]
      for (let i = 0; i < list.length; i++) this.replay(list[i]!)
    } else {
      for (const b of buffers) this.replay(b)
    }
    const touched = this.touched
    for (let i = 0; i < touched.length; i++) {
      const surface = touched[i]!.surface as { present(texture: Webgl2Texture): void } | undefined
      surface?.present(touched[i]!)
    }
    touched.length = 0
    if (this.options.checkErrors) this.checkErrors('a submit')
  }

  private replay(buffer: Webgl2CommandBuffer): void {
    const stream = buffer.stream
    if (!stream) {
      this.raise('validation', `Command buffer "${buffer.label}" was already submitted`)
      return
    }
    buffer.stream = undefined
    try {
      this.replayer.run(stream)
    } finally {
      stream.reset()
      this.streams.push(stream)
      this.encoders.push(buffer.encoder)
    }
  }

  /** @internal Notes a canvas texture drawn this submit: it's shown when the submit ends. */
  touch(texture: Webgl2Texture): void {
    if (texture.surface && !this.touched.includes(texture)) this.touched.push(texture)
  }

  /** Resolves once the GPU has run everything submitted so far. */
  afterGpu(): Promise<void> {
    if (this.isLost) return Promise.resolve()
    const gl = this.gl
    const sync = gl.fenceSync(GL.SYNC_GPU_COMMANDS_COMPLETE, 0)
    gl.flush()
    return new Promise((resolve) => {
      this.fences.push({ sync, resolve })
      this.schedulePoll()
    })
  }

  private schedulePoll(): void {
    if (this.polling) return
    this.polling = true
    setTimeout(this.poll, 0)
  }

  private readonly poll = (): void => {
    this.polling = false
    const gl = this.gl
    while (this.fences.length > 0) {
      const f = this.fences[0]!
      if (
        f.sync &&
        gl.getSyncParameter(f.sync, GL.SYNC_STATUS) !== GL.SIGNALED &&
        !gl.isContextLost()
      )
        break
      this.fences.shift()
      if (f.sync) gl.deleteSync(f.sync)
      f.resolve()
    }
    if (this.fences.length > 0) this.schedulePoll()
  }

  /** @internal `buffer.mapAsync`: reads its bytes once the GPU is done writing them. */
  mapBuffer(buffer: Webgl2Buffer, mode: number, offset: number, size: number): Promise<undefined> {
    if (mode & MapMode.WRITE) {
      return Promise.reject(
        unsupported('map a buffer for writing', 'Write it with queue.writeBuffer.'),
      )
    }
    if (
      (buffer.usage & BufferUsage.MAP_READ) === 0 ||
      buffer.mapState !== 'unmapped' ||
      buffer.destroyed
    ) {
      const error = new Error(`Buffer "${buffer.label}" can't be mapped for reading now`)
      error.name = 'OperationError'
      return Promise.reject(error)
    }
    buffer.mapState = 'pending'
    return this.afterGpu().then(() => {
      if (buffer.destroyed || buffer.mapState !== 'pending') {
        const error = new Error(`Mapping "${buffer.label}" was aborted`)
        error.name = 'AbortError'
        throw error
      }
      const bytes = new Uint8Array(size)
      if (!this.isLost) {
        const gl = this.gl
        gl.bindBuffer(GL.COPY_READ_BUFFER, buffer.gl)
        gl.getBufferSubData(GL.COPY_READ_BUFFER, offset, bytes)
        gl.bindBuffer(GL.COPY_READ_BUFFER, null)
        for (const job of buffer.reads) {
          // The read's last byte: whole rows and images before it, then one row of texels.
          const last =
            job.bytesPerRow * (job.rowsPerImage * (job.layers - 1) + job.rows - 1) +
            job.width * job.info.bytes
          if (job.offset >= offset && job.offset + last <= offset + size) {
            this.copier.finishRead(job, bytes, -offset)
          } else {
            this.copier.releaseRead(job)
          }
        }
        buffer.reads.length = 0
      }
      buffer.mapped = bytes.buffer
      buffer.mappedOffset = offset
      buffer.mapState = 'mapped'
      return undefined
    })
  }

  // --- helpers for the objects ------------------------------------------------------

  /** Sets a texture's base and max level, the mip range a view reads (the texture is bound and active). */
  levels(texture: Webgl2Texture, base: number, max: number): void {
    if (!texture.gl) return
    if (texture.baseLevel !== base) {
      this.gl.texParameteri(texture.target, GL.TEXTURE_BASE_LEVEL, base)
      texture.baseLevel = base
    }
    if (texture.maxLevel !== max) {
      this.gl.texParameteri(texture.target, GL.TEXTURE_MAX_LEVEL, max)
      texture.maxLevel = max
    }
  }

  /** The most samples a renderbuffer of `internal` format takes. */
  samplesFor(internal: number): number {
    let n = this.samples.get(internal)
    if (n === undefined) {
      const counts = this.gl.getInternalformatParameter(
        GL.RENDERBUFFER,
        internal,
        GL.SAMPLES,
      ) as Int32Array | null
      n = Math.min(counts && counts.length > 0 ? Math.max(...counts) : 0, this.caps.maxSamples)
      this.samples.set(internal, n)
    }
    return n
  }

  /** @internal Forgets a destroyed texture's framebuffers, bindings and copies. */
  forgetTexture(texture: Webgl2Texture): void {
    this.state.forgetTexture(texture.gl)
    this.fbos.forget(texture)
    this.replayer.forget(texture)
    const i = this.touched.indexOf(texture)
    if (i !== -1) this.touched.splice(i, 1)
  }

  /** @internal Forgets a destroyed buffer's bindings and pending reads. */
  forgetBuffer(buffer: Webgl2Buffer): void {
    this.state.forgetBuffer(buffer.gl)
    for (const job of buffer.reads) this.copier.releaseRead(job)
    buffer.reads.length = 0
  }

  /** Raises GL errors since the last check. */
  checkErrors(where: string): void {
    const gl = this.gl
    for (let n = 0; n < 8; n++) {
      const e = gl.getError()
      if (e === GL.NO_ERROR || e === GL.CONTEXT_LOST_WEBGL) return
      this.raise(
        e === GL.OUT_OF_MEMORY ? 'out-of-memory' : 'validation',
        `WebGL error ${GL_ERRORS[e] ?? `0x${e.toString(16)}`} in ${where}`,
      )
    }
  }

  /** Where translations came from, and what naga translated this session (0064). */
  get shaderCache(): ShaderCacheStats {
    return this.options.translator.stats
  }

  /** The translations this device used, as a baked set (see `Translator.export`). */
  exportShaders(): BakedTranslations {
    return this.options.translator.export()
  }
}

const GL_ERRORS: Record<number, string> = {
  [GL.INVALID_ENUM]: 'INVALID_ENUM',
  [GL.INVALID_VALUE]: 'INVALID_VALUE',
  [GL.INVALID_OPERATION]: 'INVALID_OPERATION',
  [GL.INVALID_FRAMEBUFFER_OPERATION]: 'INVALID_FRAMEBUFFER_OPERATION',
  [GL.OUT_OF_MEMORY]: 'OUT_OF_MEMORY',
}
