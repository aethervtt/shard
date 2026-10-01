import { installGpuConstants } from './constants'
import {
  type Translate,
  type Webgl2AdapterInfo,
  type Webgl2Caps,
  Webgl2Device,
  type Webgl2Extensions,
} from './device'
import { GL } from './gl'
import { type GlslTranslation, loadNaga } from './naga'

// The entry point: a `GPU` whose adapter and device run on WebGL2. `createGpuContext` imports this
// module only when WebGPU isn't there (0064), so a WebGPU session never loads it.

export interface Webgl2GpuOptions {
  /**
   * The canvas whose context the device uses: it presents straight into it. Omitted, a detached
   * canvas, and every surface is drawn onto from it.
   */
  canvas?: HTMLCanvasElement | OffscreenCanvas
  /** A context to use as it is (tests pass a fake one). */
  context?: WebGL2RenderingContext
  /**
   * 'minimum' holds the device to WebGL2's floor whatever the GPU has: no clip control, 16 texture
   * units, 2048 texels, 4 draw buffers, no float filtering, no compression.
   */
  profile?: 'native' | 'minimum'
  /** Checks GL errors after every submit. A round trip to the GPU process: for dev and tests. */
  checkErrors?: boolean
  /** How WGSL becomes GLSL. Default: naga, loaded on the first pipeline, with a cache in memory. */
  prepare?: (clipControl: boolean) => Promise<Translate>
}

export interface Webgl2Gpu {
  requestAdapter(options?: GPURequestAdapterOptions): Promise<Webgl2Adapter | null>
  getPreferredCanvasFormat(): GPUTextureFormat
  readonly wgslLanguageFeatures: ReadonlySet<string>
}

/** A WebGPU entry point over WebGL2 (0064). Installs the `GPU*` flag globals the engine reads. */
export function createWebgl2Gpu(options: Webgl2GpuOptions = {}): Webgl2Gpu {
  installGpuConstants()
  return {
    wgslLanguageFeatures: new Set<string>(),
    getPreferredCanvasFormat: () => 'rgba8unorm',
    requestAdapter(request) {
      const opened = openContext(options, request?.powerPreference)
      return Promise.resolve(opened ? new Webgl2Adapter(opened, options) : null)
    },
  }
}

/** Why WebGL2 can't run the baseline tier here, or undefined when it can. */
export function webgl2Unavailable(gl: WebGL2RenderingContext | null): string | undefined {
  if (!gl) return 'no-webgl2'
  if (gl.isContextLost()) return 'context-lost'
  if (!gl.getExtension('EXT_color_buffer_float')) return 'no-float-render-targets'
  return undefined
}

interface Opened {
  gl: WebGL2RenderingContext
  canvas: HTMLCanvasElement | OffscreenCanvas | undefined
  owns: boolean
}

function openContext(
  options: Webgl2GpuOptions,
  powerPreference?: GPUPowerPreference,
): Opened | null {
  if (options.context) {
    if (webgl2Unavailable(options.context)) return null
    const canvas =
      options.canvas ?? (options.context.canvas as HTMLCanvasElement | OffscreenCanvas | undefined)
    return { gl: options.context, canvas, owns: false }
  }
  const canvas = options.canvas ?? detachedCanvas()
  if (!canvas) return null
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    premultipliedAlpha: true,
    preserveDrawingBuffer: false,
    powerPreference: powerPreference === 'low-power' ? 'low-power' : 'high-performance',
  }) as WebGL2RenderingContext | null
  if (webgl2Unavailable(gl)) return null
  return { gl: gl!, canvas, owns: !options.canvas }
}

function detachedCanvas(): HTMLCanvasElement | OffscreenCanvas | undefined {
  const doc = (globalThis as { document?: Document }).document
  if (doc) return doc.createElement('canvas')
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(1, 1)
  return undefined
}

export class Webgl2Adapter {
  readonly features: ReadonlySet<string>
  readonly limits: Readonly<Record<string, number>>
  readonly info: Webgl2AdapterInfo
  readonly isFallbackAdapter = false
  readonly featureLevel = 'compatibility'
  private readonly caps: Webgl2Caps
  private readonly extensions: Webgl2Extensions
  private readonly options: Webgl2GpuOptions
  private opened: Opened | undefined

  constructor(opened: Opened, options: Webgl2GpuOptions) {
    this.opened = opened
    this.options = options
    const { caps, extensions } = capsOf(opened.gl, options.profile ?? 'native')
    this.caps = caps
    this.extensions = extensions
    this.features = featuresOf(opened.gl, caps)
    this.limits = limitsOf(caps)
    this.info = infoOf(opened.gl)
  }

  requestDevice(descriptor: GPUDeviceDescriptor = {}): Promise<Webgl2Device> {
    const missing = [...(descriptor.requiredFeatures ?? [])].filter((f) => !this.features.has(f))
    if (missing.length > 0) {
      return Promise.reject(new TypeError(`WebGL2 doesn't offer ${missing.join(', ')}`))
    }
    const opened = this.opened
    if (!opened) return Promise.reject(new Error('This adapter has already made its device'))
    this.opened = undefined
    const caps = this.caps
    const prepare = this.options.prepare
    const device = new Webgl2Device(opened.gl, caps, {
      label: descriptor.label,
      canvas: opened.canvas,
      ownsContext: opened.owns,
      checkErrors: this.options.checkErrors === true,
      features: new Set<string>(descriptor.requiredFeatures ?? []),
      limits: this.limits,
      info: this.info,
      prepare: prepare ? () => prepare(caps.clipControl) : () => nagaTranslator(caps.clipControl),
      extensions: this.extensions,
    })
    return Promise.resolve(device)
  }
}

/** naga, with translations kept in memory for the session. */
async function nagaTranslator(clipControl: boolean): Promise<Translate> {
  const naga = await loadNaga()
  const cache = new Map<string, GlslTranslation>()
  return (code, entry, stage) => {
    const key = `${stage}\n${entry}\n${code}`
    let hit = cache.get(key)
    if (!hit) {
      hit = naga.translate(code, entry, stage, { clipControl })
      cache.set(key, hit)
    }
    return hit
  }
}

function capsOf(
  gl: WebGL2RenderingContext,
  profile: 'native' | 'minimum',
): { caps: Webgl2Caps; extensions: Webgl2Extensions } {
  const minimum = profile === 'minimum'
  const ext = (name: string) => (minimum ? null : gl.getExtension(name))
  const p = (e: number) => gl.getParameter(e) as number
  const anisotropic = ext('EXT_texture_filter_anisotropic')
  const parallel = gl.getExtension('KHR_parallel_shader_compile')
  const clipControl = ext('EXT_clip_control')
  const floatBlend = gl.getExtension('EXT_float_blend')
  const floatLinear = ext('OES_texture_float_linear')
  const indexed = ext('OES_draw_buffers_indexed') as OES_draw_buffers_indexed | null
  const lose = gl.getExtension('WEBGL_lose_context')
  const bc =
    ext('WEBGL_compressed_texture_s3tc') !== null &&
    ext('WEBGL_compressed_texture_s3tc_srgb') !== null &&
    ext('EXT_texture_compression_rgtc') !== null &&
    ext('EXT_texture_compression_bptc') !== null
  const caps: Webgl2Caps = {
    maxSamples: minimum ? Math.min(4, p(GL.MAX_SAMPLES)) : p(GL.MAX_SAMPLES),
    anisotropy: anisotropic ? p(GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : 1,
    parallelCompile: parallel !== null,
    textureUnits: minimum ? 16 : p(GL.MAX_TEXTURE_IMAGE_UNITS),
    vertexTextureUnits: minimum ? 16 : p(GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
    combinedUnits: minimum ? 32 : p(GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
    clipControl: clipControl !== null,
    floatBlend: floatBlend !== null,
    floatLinear: floatLinear !== null,
    maxTextureSize: minimum ? 2048 : p(GL.MAX_TEXTURE_SIZE),
    max3dTextureSize: minimum ? 256 : p(GL.MAX_3D_TEXTURE_SIZE),
    maxArrayLayers: minimum ? 256 : p(GL.MAX_ARRAY_TEXTURE_LAYERS),
    maxCubeSize: minimum ? 2048 : p(GL.MAX_CUBE_MAP_TEXTURE_SIZE),
    maxDrawBuffers: minimum ? 4 : Math.min(p(GL.MAX_DRAW_BUFFERS), p(GL.MAX_COLOR_ATTACHMENTS)),
    maxAttributes: minimum ? 16 : p(GL.MAX_VERTEX_ATTRIBS),
    maxVaryings: minimum ? 15 : Math.floor(p(GL.MAX_VARYING_COMPONENTS) / 4),
    uniformBlockSize: minimum ? 16384 : p(GL.MAX_UNIFORM_BLOCK_SIZE),
    uniformBlocks: minimum
      ? 12
      : Math.min(p(GL.MAX_VERTEX_UNIFORM_BLOCKS), p(GL.MAX_FRAGMENT_UNIFORM_BLOCKS)),
    uniformBindings: minimum ? 24 : p(GL.MAX_UNIFORM_BUFFER_BINDINGS),
    uniformAlignment: p(GL.UNIFORM_BUFFER_OFFSET_ALIGNMENT),
    compression: {
      bc,
      astc: ext('WEBGL_compressed_texture_astc') !== null,
      etc2: ext('WEBGL_compressed_texture_etc') !== null,
    },
  }
  return { caps, extensions: { clipControl, indexed, lose } }
}

function featuresOf(gl: WebGL2RenderingContext, caps: Webgl2Caps): ReadonlySet<string> {
  const features = new Set<string>(['depth32float-stencil8'])
  if (caps.compression.bc) features.add('texture-compression-bc')
  if (caps.compression.astc) features.add('texture-compression-astc')
  if (caps.compression.etc2) features.add('texture-compression-etc2')
  if (caps.floatLinear) features.add('float32-filterable')
  if (caps.floatBlend) features.add('float32-blendable')
  // WebGPU's feature includes multisampling it.
  const samples = gl.getInternalformatParameter(
    GL.RENDERBUFFER,
    GL.R11F_G11F_B10F,
    GL.SAMPLES,
  ) as Int32Array | null
  if (samples && samples.length > 0 && Math.max(...samples) >= 4)
    features.add('rg11b10ufloat-renderable')
  return features
}

function limitsOf(caps: Webgl2Caps): Readonly<Record<string, number>> {
  const sampled = Math.min(caps.textureUnits, caps.vertexTextureUnits)
  return {
    maxTextureDimension1D: caps.maxTextureSize,
    maxTextureDimension2D: caps.maxTextureSize,
    maxTextureDimension3D: caps.max3dTextureSize,
    maxTextureArrayLayers: caps.maxArrayLayers,
    maxBindGroups: 4,
    maxBindGroupsPlusVertexBuffers: 24,
    maxBindingsPerBindGroup: 1000,
    maxDynamicUniformBuffersPerPipelineLayout: 8,
    maxDynamicStorageBuffersPerPipelineLayout: 0,
    maxSampledTexturesPerShaderStage: sampled,
    maxSamplersPerShaderStage: sampled,
    maxStorageBuffersPerShaderStage: 0,
    maxStorageBuffersInVertexStage: 0,
    maxStorageBuffersInFragmentStage: 0,
    maxStorageTexturesPerShaderStage: 0,
    maxStorageTexturesInVertexStage: 0,
    maxStorageTexturesInFragmentStage: 0,
    maxUniformBuffersPerShaderStage: caps.uniformBlocks,
    maxUniformBufferBindingSize: caps.uniformBlockSize,
    maxStorageBufferBindingSize: 0,
    minUniformBufferOffsetAlignment: Math.max(256, caps.uniformAlignment),
    minStorageBufferOffsetAlignment: 256,
    maxVertexBuffers: 8,
    maxBufferSize: 256 * 1024 * 1024,
    maxVertexAttributes: caps.maxAttributes,
    // WebGL's vertexAttribPointer stride limit.
    maxVertexBufferArrayStride: 255,
    maxInterStageShaderVariables: caps.maxVaryings,
    maxColorAttachments: caps.maxDrawBuffers,
    maxColorAttachmentBytesPerSample: 32,
    maxComputeWorkgroupStorageSize: 0,
    maxComputeInvocationsPerWorkgroup: 0,
    maxComputeWorkgroupSizeX: 0,
    maxComputeWorkgroupSizeY: 0,
    maxComputeWorkgroupSizeZ: 0,
    maxComputeWorkgroupsPerDimension: 0,
  }
}

function infoOf(gl: WebGL2RenderingContext): Webgl2AdapterInfo {
  const debug = gl.getExtension('WEBGL_debug_renderer_info')
  const vendor = String(gl.getParameter(debug ? GL.UNMASKED_VENDOR_WEBGL : GL.VENDOR) ?? '')
  const renderer = String(gl.getParameter(debug ? GL.UNMASKED_RENDERER_WEBGL : GL.RENDERER) ?? '')
  return { vendor, architecture: '', device: renderer, description: `WebGL2: ${renderer}` }
}
