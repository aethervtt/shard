import { BufferUsage, TextureUsage } from './constants'
import type { ReadJob } from './copies'
import type { Webgl2Device } from './device'
import { unsupported } from './errors'
import { formatOf, type GlFormat } from './formats'
import { GL } from './gl'

// Buffers, textures, views and samplers as WebGL2 objects.
//
// - Buffers: one GL buffer each. Index buffers are GL element buffers (WebGL never lets those bind
//   elsewhere) with a CPU copy, so a uint16 buffer holding 65535 (WebGL2 always restarts the strip
//   there) draws from a uint32 copy. Mappable buffers keep their bytes on the CPU.
// - Textures: immutable storage, one GL target for their one binding dimension: 2D, 2D array,
//   cube or 3D. Multisampled textures and stencil-only ones are renderbuffers: WebGL2 can only
//   render into those.

let nextId = 1

/** Compatibility mode's texture field (0064), not yet in TypeScript's WebGPU types. */
type CompatTextureDescriptor = GPUTextureDescriptor & {
  textureBindingViewDimension?: GPUTextureViewDimension
}

export class Webgl2Buffer {
  readonly id = nextId++
  readonly size: number
  readonly usage: number
  readonly label: string
  readonly gl: WebGLBuffer | null
  /** INDEX usage: the GL element buffer, and its bytes on the CPU (the restart check). */
  readonly index: boolean
  shadow: Uint8Array | undefined
  /** A uint32 copy of a uint16 index buffer that holds 65535, made when first drawn from. */
  promoted: WebGLBuffer | null | undefined
  /** Whether the CPU copy holds 65535, as of `restartVersion`. */
  restart = false
  restartVersion = -1
  /** Bumped by every write, so derived copies know they're stale. */
  version = 0
  mapState: GPUBufferMapState = 'unmapped'
  /** MAP_READ: the bytes a finished map hands out, from `mappedOffset`. */
  mapped: ArrayBuffer | undefined
  mappedOffset = 0
  /** Texture reads into this buffer, repacked when it's mapped. */
  readonly reads: ReadJob[] = []
  destroyed = false
  private readonly device: Webgl2Device

  constructor(device: Webgl2Device, descriptor: GPUBufferDescriptor) {
    this.device = device
    this.size = descriptor.size
    this.usage = descriptor.usage
    this.label = descriptor.label ?? ''
    this.index = (descriptor.usage & BufferUsage.INDEX) !== 0
    const gl = device.gl
    this.gl = gl.createBuffer()
    const target = this.index ? GL.ELEMENT_ARRAY_BUFFER : GL.COPY_WRITE_BUFFER
    if (this.index) {
      this.shadow = new Uint8Array(this.size)
      device.state.bindVertexArray(null)
    }
    gl.bindBuffer(target, this.gl)
    const hint = descriptor.usage & BufferUsage.MAP_READ ? GL.STREAM_READ : GL.DYNAMIC_DRAW
    gl.bufferData(target, this.size, hint)
    gl.bindBuffer(target, null)
    if (descriptor.mappedAtCreation) {
      throw unsupported('create a buffer mapped at creation', 'Write it with queue.writeBuffer.')
    }
  }

  /** Where copies read and write this buffer: its own target for index buffers. */
  get target(): number {
    return this.index ? GL.ELEMENT_ARRAY_BUFFER : GL.COPY_WRITE_BUFFER
  }

  /** Writes `data` at `offset`: `dataOffset` and `size` count elements of a typed array (writeBuffer's rule). */
  write(offset: number, data: BufferSource, dataOffset = 0, size?: number): void {
    const gl = this.device.gl
    const target = this.target
    const view = ArrayBuffer.isView(data) && !(data instanceof DataView)
    const unit = view ? (data as Uint8Array).BYTES_PER_ELEMENT : 1
    const total = ArrayBuffer.isView(data) ? data.byteLength / unit : data.byteLength
    const count = size ?? total - dataOffset
    if (count <= 0) return
    if (this.index) this.device.state.bindVertexArray(null)
    gl.bindBuffer(target, this.gl)
    if (view) {
      gl.bufferSubData(target, offset, data as ArrayBufferView, dataOffset, count)
    } else {
      gl.bufferSubData(target, offset, bytesOf(data, dataOffset, count))
    }
    gl.bindBuffer(target, null)
    if (this.shadow) {
      const byteOffset = (ArrayBuffer.isView(data) ? data.byteOffset : 0) + dataOffset * unit
      const buffer = ArrayBuffer.isView(data) ? data.buffer : data
      this.shadow.set(new Uint8Array(buffer, byteOffset, count * unit), offset)
    }
    this.version++
  }

  mapAsync(mode: number, offset = 0, size?: number): Promise<undefined> {
    return this.device.mapBuffer(this, mode, offset, size ?? this.size - offset)
  }

  getMappedRange(offset = this.mappedOffset, size?: number): ArrayBuffer {
    const mapped = this.mapped
    if (!mapped) throw new Error(`Buffer "${this.label}" isn't mapped`)
    const start = offset - this.mappedOffset
    const length = size ?? mapped.byteLength - start
    return start === 0 && length === mapped.byteLength
      ? mapped
      : mapped.slice(start, start + length)
  }

  unmap(): void {
    this.mapped = undefined
    this.mapState = 'unmapped'
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.device.forgetBuffer(this)
    this.device.gl.deleteBuffer(this.gl)
    if (this.promoted) this.device.gl.deleteBuffer(this.promoted)
    this.shadow = undefined
    this.mapped = undefined
    this.mapState = 'unmapped'
  }
}

function bytesOf(data: BufferSource, byteOffset: number, length: number): Uint8Array {
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset + byteOffset, length)
  return new Uint8Array(data, byteOffset, length)
}

/** The GL target a texture's one binding dimension takes. */
function targetOf(
  dimension: GPUTextureDimension,
  layers: number,
  binding: GPUTextureViewDimension | undefined,
): { target: number; view: GPUTextureViewDimension } {
  if (dimension === '3d') return { target: GL.TEXTURE_3D, view: '3d' }
  if (dimension === '1d') throw unsupported('make a 1D texture')
  const view = binding ?? (layers === 1 ? '2d' : layers === 6 ? '2d-array' : '2d-array')
  if (view === 'cube') return { target: GL.TEXTURE_CUBE_MAP, view }
  if (view === 'cube-array') throw unsupported('bind a cube array')
  if (view === '2d-array') return { target: GL.TEXTURE_2D_ARRAY, view }
  if (layers > 1) {
    throw unsupported(
      `bind a ${layers}-layer texture as '2d'`,
      "Create it with textureBindingViewDimension '2d-array' (or 'cube').",
    )
  }
  return { target: GL.TEXTURE_2D, view: '2d' }
}

export class Webgl2Texture {
  readonly id = nextId++
  readonly label: string
  readonly width: number
  readonly height: number
  readonly depthOrArrayLayers: number
  readonly mipLevelCount: number
  readonly sampleCount: number
  readonly dimension: GPUTextureDimension
  readonly format: GPUTextureFormat
  readonly usage: number
  readonly info: GlFormat
  /** Its one binding dimension (compatibility mode's `textureBindingViewDimension`). */
  readonly bindingDimension: GPUTextureViewDimension
  readonly target: number
  readonly gl: WebGLTexture | null
  readonly renderbuffer: WebGLRenderbuffer | null
  /** The mip range a view last bound (texture parameters, set when it changes). */
  baseLevel = -1
  maxLevel = -1
  destroyed = false
  /** A canvas surface's current texture: presented after the submit that draws it. */
  surface: unknown
  private readonly device: Webgl2Device

  constructor(device: Webgl2Device, descriptor: GPUTextureDescriptor) {
    this.device = device
    const size = descriptor.size as number[] | GPUExtent3DDict
    this.width = Array.isArray(size) ? size[0]! : (size as GPUExtent3DDict).width
    this.height = (Array.isArray(size) ? size[1] : (size as GPUExtent3DDict).height) ?? 1
    this.depthOrArrayLayers =
      (Array.isArray(size) ? size[2] : (size as GPUExtent3DDict).depthOrArrayLayers) ?? 1
    this.mipLevelCount = descriptor.mipLevelCount ?? 1
    this.sampleCount = descriptor.sampleCount ?? 1
    this.dimension = descriptor.dimension ?? '2d'
    this.format = descriptor.format
    this.usage = descriptor.usage
    this.label = descriptor.label ?? ''
    this.info = formatOf(descriptor.format)
    if (descriptor.viewFormats?.some((f) => f !== descriptor.format)) {
      throw unsupported(
        `view "${this.label}" in another format (${descriptor.viewFormats.join(', ')})`,
        'Baseline textures have one format: the asset layer makes a twin for the other.',
      )
    }
    if (this.usage & TextureUsage.STORAGE_BINDING) {
      throw unsupported(
        `make "${this.label}" a storage texture`,
        'Storage textures are compute: the full tier only.',
      )
    }
    const gl = device.gl
    const onlyAttachment =
      (this.usage & ~(TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC)) === 0
    if (this.sampleCount > 1 || (this.info.kind === 'stencil' && onlyAttachment)) {
      if (this.usage & TextureUsage.TEXTURE_BINDING) {
        throw unsupported(
          `sample the multisampled texture "${this.label}"`,
          'Resolve it, then sample the resolve target.',
        )
      }
      this.renderbuffer = gl.createRenderbuffer()
      this.gl = null
      this.target = GL.RENDERBUFFER
      this.bindingDimension = '2d'
      gl.bindRenderbuffer(GL.RENDERBUFFER, this.renderbuffer)
      if (this.sampleCount > 1) {
        const most = device.samplesFor(this.info.internal)
        if (this.sampleCount > most) {
          device.raise(
            'validation',
            `"${this.label}" asks for ${this.sampleCount} samples of ${this.format}; this device renders at most ${most}`,
          )
        }
        gl.renderbufferStorageMultisample(
          GL.RENDERBUFFER,
          Math.min(this.sampleCount, most),
          this.info.internal,
          this.width,
          this.height,
        )
      } else {
        gl.renderbufferStorage(GL.RENDERBUFFER, this.info.internal, this.width, this.height)
      }
      gl.bindRenderbuffer(GL.RENDERBUFFER, null)
      return
    }
    if (this.info.kind === 'stencil')
      throw unsupported(`sample the stencil texture "${this.label}"`)
    const t = targetOf(
      this.dimension,
      this.depthOrArrayLayers,
      (descriptor as CompatTextureDescriptor).textureBindingViewDimension,
    )
    this.target = t.target
    this.bindingDimension = t.view
    this.renderbuffer = null
    this.gl = gl.createTexture()
    device.state.bindTexture(this.target, this.gl)
    if (this.target === GL.TEXTURE_2D || this.target === GL.TEXTURE_CUBE_MAP) {
      gl.texStorage2D(this.target, this.mipLevelCount, this.info.internal, this.width, this.height)
    } else {
      gl.texStorage3D(
        this.target,
        this.mipLevelCount,
        this.info.internal,
        this.width,
        this.height,
        this.depthOrArrayLayers,
      )
    }
    // Integer and unfilterable textures read with texelFetch or NEAREST: never a filtering default.
    gl.texParameteri(this.target, GL.TEXTURE_MIN_FILTER, GL.NEAREST)
    gl.texParameteri(this.target, GL.TEXTURE_MAG_FILTER, GL.NEAREST)
    this.baseLevel = 0
    this.maxLevel = this.mipLevelCount - 1
    gl.texParameteri(this.target, GL.TEXTURE_BASE_LEVEL, 0)
    gl.texParameteri(this.target, GL.TEXTURE_MAX_LEVEL, this.maxLevel)
  }

  /** The compatibility-mode attribute. */
  get textureBindingViewDimension(): GPUTextureViewDimension {
    return this.bindingDimension
  }

  createView(descriptor: GPUTextureViewDescriptor = {}): Webgl2TextureView {
    return new Webgl2TextureView(this, descriptor)
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (this.gl) this.device.gl.deleteTexture(this.gl)
    if (this.renderbuffer) this.device.gl.deleteRenderbuffer(this.renderbuffer)
    this.device.forgetTexture(this)
  }
}

export class Webgl2TextureView {
  readonly id = nextId++
  readonly texture: Webgl2Texture
  readonly dimension: GPUTextureViewDimension
  readonly baseMipLevel: number
  readonly mipLevelCount: number
  readonly baseArrayLayer: number
  readonly arrayLayerCount: number
  readonly label: string

  constructor(texture: Webgl2Texture, d: GPUTextureViewDescriptor) {
    this.texture = texture
    this.label = d.label ?? texture.label
    if (d.format && d.format !== texture.format) {
      throw unsupported(
        `view "${texture.label}" (${texture.format}) as ${d.format}`,
        'Baseline textures have one format: the asset layer makes a twin for the other.',
      )
    }
    this.baseMipLevel = d.baseMipLevel ?? 0
    this.mipLevelCount = d.mipLevelCount ?? texture.mipLevelCount - this.baseMipLevel
    this.baseArrayLayer = d.baseArrayLayer ?? 0
    const layers = texture.dimension === '3d' ? 1 : texture.depthOrArrayLayers
    this.arrayLayerCount = d.arrayLayerCount ?? layers - this.baseArrayLayer
    // As compatibility mode has it: a view of every layer is the texture's binding dimension.
    const whole = this.baseArrayLayer === 0 && this.arrayLayerCount === layers
    this.dimension =
      d.dimension ??
      (texture.dimension === '3d'
        ? '3d'
        : whole
          ? texture.bindingDimension
          : this.arrayLayerCount > 1
            ? '2d-array'
            : '2d')
  }

  /** Whether binding this view reads the texture as its one binding dimension (baseline's rule). */
  bindable(): boolean {
    const t = this.texture
    if (t.renderbuffer) return false
    if (this.dimension !== t.bindingDimension) return false
    const layers = t.dimension === '3d' ? 1 : t.depthOrArrayLayers
    return this.baseArrayLayer === 0 && this.arrayLayerCount === layers
  }
}

const WRAP: Record<GPUAddressMode, number> = {
  'clamp-to-edge': GL.CLAMP_TO_EDGE,
  repeat: GL.REPEAT,
  'mirror-repeat': GL.MIRRORED_REPEAT,
}

export const COMPARE: Record<GPUCompareFunction, number> = {
  never: GL.NEVER,
  less: GL.LESS,
  equal: GL.EQUAL,
  'less-equal': GL.LEQUAL,
  greater: GL.GREATER,
  'not-equal': GL.NOTEQUAL,
  'greater-equal': GL.GEQUAL,
  always: GL.ALWAYS,
}

export class Webgl2Sampler {
  readonly id = nextId++
  readonly gl: WebGLSampler | null
  readonly label: string
  readonly compare: boolean

  constructor(device: Webgl2Device, d: GPUSamplerDescriptor = {}) {
    const gl = device.gl
    this.label = d.label ?? ''
    this.gl = gl.createSampler()
    this.compare = d.compare !== undefined
    const mip = d.mipmapFilter ?? 'nearest'
    const min =
      d.minFilter === 'linear'
        ? mip === 'linear'
          ? GL.LINEAR_MIPMAP_LINEAR
          : GL.LINEAR_MIPMAP_NEAREST
        : mip === 'linear'
          ? GL.NEAREST_MIPMAP_LINEAR
          : GL.NEAREST_MIPMAP_NEAREST
    gl.samplerParameteri(this.gl!, GL.TEXTURE_MIN_FILTER, min)
    gl.samplerParameteri(
      this.gl!,
      GL.TEXTURE_MAG_FILTER,
      d.magFilter === 'linear' ? GL.LINEAR : GL.NEAREST,
    )
    gl.samplerParameteri(this.gl!, GL.TEXTURE_WRAP_S, WRAP[d.addressModeU ?? 'clamp-to-edge'])
    gl.samplerParameteri(this.gl!, GL.TEXTURE_WRAP_T, WRAP[d.addressModeV ?? 'clamp-to-edge'])
    gl.samplerParameteri(this.gl!, GL.TEXTURE_WRAP_R, WRAP[d.addressModeW ?? 'clamp-to-edge'])
    gl.samplerParameterf(this.gl!, GL.TEXTURE_MIN_LOD, d.lodMinClamp ?? 0)
    gl.samplerParameterf(this.gl!, GL.TEXTURE_MAX_LOD, d.lodMaxClamp ?? 32)
    if (d.compare) {
      gl.samplerParameteri(this.gl!, GL.TEXTURE_COMPARE_MODE, GL.COMPARE_REF_TO_TEXTURE)
      gl.samplerParameteri(this.gl!, GL.TEXTURE_COMPARE_FUNC, COMPARE[d.compare])
    }
    const anisotropy = d.maxAnisotropy ?? 1
    if (anisotropy > 1 && device.caps.anisotropy > 1) {
      gl.samplerParameterf(
        this.gl!,
        GL.TEXTURE_MAX_ANISOTROPY_EXT,
        Math.min(anisotropy, device.caps.anisotropy),
      )
    }
  }
}
