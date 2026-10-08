import { GL } from './gl'

// A WebGL2 context for headless tests of the shim: GL objects and bindings as state, texels as
// numbers. Uploads, clears, blits, buffer copies and readPixels really move data (so readbacks can
// be checked byte for byte); draws don't rasterize but record everything bound at the time. Every
// call is logged by name, so tests can also check what a frame didn't do.

export interface FakeBuffer {
  kind: 'buffer'
  id: number
  data: Uint8Array
  deleted: boolean
}

export interface FakeTexture {
  kind: 'texture'
  id: number
  target: number
  internal: number
  width: number
  height: number
  depth: number
  levels: number
  /** Per level: 4 components a texel, every layer. */
  images: Float64Array[]
  params: Map<number, number>
  deleted: boolean
}

export interface FakeRenderbuffer {
  kind: 'renderbuffer'
  id: number
  internal: number
  width: number
  height: number
  samples: number
  image: Float64Array
  deleted: boolean
}

interface Attachment {
  object: FakeTexture | FakeRenderbuffer
  level: number
  layer: number
}

export interface FakeFramebuffer {
  kind: 'framebuffer'
  id: number
  attachments: Map<number, Attachment>
  drawBuffers: number[]
  readBuffer: number
  deleted: boolean
}

export interface FakeProgram {
  kind: 'program'
  id: number
  sources: string[]
  linked: boolean
  blockIndices: Map<string, number>
  blockPoints: Map<number, number>
  uniforms: Map<string, number | number[]>
  deleted: boolean
}

interface FakeAttrib {
  enabled: boolean
  buffer: FakeBuffer | null
  size: number
  type: number
  normalized: boolean
  integer: boolean
  stride: number
  offset: number
  divisor: number
}

interface FakeVao {
  kind: 'vao'
  id: number
  element: FakeBuffer | null
  attribs: FakeAttrib[]
}

export interface DrawRecord {
  call: 'drawArrays' | 'drawElements'
  mode: number
  first: number
  count: number
  type: number
  offset: number
  instances: number
  program: FakeProgram
  framebuffer: FakeFramebuffer | null
  viewport: number[]
  /** Uniform buffer ranges by binding point, for the points the program uses. */
  blocks: Map<number, { buffer: FakeBuffer | null; offset: number; size: number }>
  /** Texture and sampler by unit, for the units the program samples. */
  units: Map<
    number,
    { texture: FakeTexture | null; sampler: object | null; base: number; max: number }
  >
  attribs: (FakeAttrib & { location: number })[]
  element: FakeBuffer | null
  uniforms: Map<string, number | number[]>
  enabled: Set<number>
  colorMask: boolean[]
  depthMask: boolean
  depthFunc: number
  frontFace: number
  cullFace: number
  blend: number[]
}

const COMPONENTS: Record<number, [number, 'unorm' | 'float' | 'uint' | 'depth' | 'stencil']> = {
  [GL.R8]: [1, 'unorm'],
  [GL.RG8]: [2, 'unorm'],
  [GL.RGBA8]: [4, 'unorm'],
  [GL.SRGB8_ALPHA8]: [4, 'unorm'],
  [GL.RGB10_A2]: [4, 'unorm'],
  [GL.R16F]: [1, 'float'],
  [GL.RG16F]: [2, 'float'],
  [GL.RGBA16F]: [4, 'float'],
  [GL.R32F]: [1, 'float'],
  [GL.RG32F]: [2, 'float'],
  [GL.RGBA32F]: [4, 'float'],
  [GL.R11F_G11F_B10F]: [3, 'float'],
  [GL.R8UI]: [1, 'uint'],
  [GL.RGBA8UI]: [4, 'uint'],
  [GL.R16UI]: [1, 'uint'],
  [GL.R32UI]: [1, 'uint'],
  [GL.RG32UI]: [2, 'uint'],
  [GL.RGBA32UI]: [4, 'uint'],
  [GL.DEPTH_COMPONENT16]: [1, 'depth'],
  [GL.DEPTH_COMPONENT24]: [1, 'depth'],
  [GL.DEPTH_COMPONENT32F]: [1, 'depth'],
  [GL.DEPTH24_STENCIL8]: [1, 'depth'],
  [GL.DEPTH32F_STENCIL8]: [1, 'depth'],
  [GL.STENCIL_INDEX8]: [1, 'stencil'],
}

function formatComponents(format: number): number {
  switch (format) {
    case GL.RED:
    case GL.RED_INTEGER:
    case GL.DEPTH_COMPONENT:
      return 1
    case GL.RG:
    case GL.RG_INTEGER:
      return 2
    case GL.RGB:
      return 3
    default:
      return 4
  }
}

function typeSize(type: number): number {
  switch (type) {
    case GL.UNSIGNED_BYTE:
    case GL.BYTE:
      return 1
    case GL.UNSIGNED_SHORT:
    case GL.SHORT:
    case GL.HALF_FLOAT:
      return 2
    default:
      return 4
  }
}

const packed = (type: number) =>
  type === GL.UNSIGNED_INT_10F_11F_11F_REV ||
  type === GL.UNSIGNED_INT_2_10_10_10_REV ||
  type === GL.UNSIGNED_INT_24_8

function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const m = h & 0x3ff
  if (e === 0) return s * m * 2 ** -24
  if (e === 31) return m ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * (1 + m / 1024) * 2 ** (e - 15)
}

function ufloat(bits: number, mantissa: number): number {
  const e = bits >>> mantissa
  const m = bits & ((1 << mantissa) - 1)
  if (e === 0) return (m / (1 << mantissa)) * 2 ** -14
  if (e === 31) return m ? Number.NaN : Number.POSITIVE_INFINITY
  return (1 + m / (1 << mantissa)) * 2 ** (e - 15)
}

export interface FakeGlOptions {
  /** Extensions to leave out (`getExtension` returns null). */
  without?: string[]
  /** getParameter overrides. */
  parameters?: Record<number, number | string>
  /** Sample counts by renderbuffer internal format (default [8, 4, 2]). */
  samples?: Record<number, number[]>
  /** Links pending this many polls of COMPLETION_STATUS_KHR. */
  linkPolls?: number
  /** UNIFORM_BLOCK_DATA_SIZE by block name prefix (default 0: whatever is bound). */
  blockSizes?: Record<string, number>
  /**
   * Offers EXT_disjoint_timer_query_webgl2 (0074): every TIME_ELAPSED query takes `elapsedNs`, and
   * its result is available after `polls` reads of QUERY_RESULT_AVAILABLE (default 0).
   */
  timerQuery?: { elapsedNs: number; polls?: number }
}

export class FakeGl {
  readonly canvas: {
    width: number
    height: number
    listeners: Map<string, EventListener[]>
    addEventListener(type: string, l: EventListener): void
    removeEventListener(type: string, l: EventListener): void
    dispatch(type: string): void
  }
  /** Method names, in call order. */
  readonly calls: string[] = []
  readonly draws: DrawRecord[] = []
  /** Whether draws are recorded (off for allocation checks: a record is an allocation). */
  recordDraws = true
  /** GL errors to hand out from getError. */
  readonly errors: number[] = []
  /** The default framebuffer's texels (the canvas), 4 components each. */
  backbuffer: Float64Array
  lost = false
  /** Calls made on extensions, by name. */
  readonly extensionCalls: string[] = []
  private readonly options: FakeGlOptions
  private next = 1
  private readonly extensions = new Map<string, object>()
  private readonly bound = new Map<number, FakeBuffer | null>()
  private readonly ranges: { buffer: FakeBuffer | null; offset: number; size: number }[] = []
  private readonly defaultVao: FakeVao
  private vao: FakeVao
  private program: FakeProgram | null = null
  private active = 0
  private readonly units: Map<number, FakeTexture | null>[] = []
  private readonly samplers: (object | null)[] = []
  private drawFb: FakeFramebuffer | null = null
  private readFb: FakeFramebuffer | null = null
  private renderbuffer: FakeRenderbuffer | null = null
  private readonly enabled = new Set<number>()
  private readonly pixel = new Map<number, number | boolean>()
  private viewport_ = [0, 0, 300, 150]
  private scissor_ = [0, 0, 300, 150]
  private colorMask_ = [true, true, true, true]
  private depthMask_ = true
  private depthFunc_: number = GL.LESS
  private frontFace_: number = GL.CCW
  private cullFace_: number = GL.BACK
  private blend_: number[] = [GL.FUNC_ADD, GL.FUNC_ADD, GL.ONE, GL.ZERO, GL.ONE, GL.ZERO]
  private clearColor_ = [0, 0, 0, 0]
  private pendingLinks = 0

  constructor(options: FakeGlOptions = {}) {
    this.options = options
    const listeners = new Map<string, EventListener[]>()
    this.canvas = {
      width: 300,
      height: 150,
      listeners,
      addEventListener: (type, l) => listeners.set(type, [...(listeners.get(type) ?? []), l]),
      removeEventListener: (type, l) =>
        listeners.set(
          type,
          (listeners.get(type) ?? []).filter((x) => x !== l),
        ),
      dispatch: (type) => {
        const event = { type, defaultPrevented: false, preventDefault() {} } as unknown as Event
        for (const l of listeners.get(type) ?? []) l(event)
      },
    }
    this.backbuffer = new Float64Array(300 * 150 * 4)
    this.defaultVao = { kind: 'vao', id: 0, element: null, attribs: [] }
    this.vao = this.defaultVao
    const fn = (name: string) => () => this.extensionCalls.push(name)
    const all: Record<string, object> = {
      EXT_color_buffer_float: {},
      EXT_float_blend: {},
      OES_texture_float_linear: {},
      EXT_texture_filter_anisotropic: {},
      KHR_parallel_shader_compile: {},
      EXT_clip_control: { clipControlEXT: fn('clipControlEXT') },
      OES_draw_buffers_indexed: {
        enableiOES: fn('enableiOES'),
        disableiOES: fn('disableiOES'),
        blendEquationSeparateiOES: fn('blendEquationSeparateiOES'),
        blendFuncSeparateiOES: fn('blendFuncSeparateiOES'),
        colorMaskiOES: fn('colorMaskiOES'),
      },
      WEBGL_lose_context: {
        loseContext: () => {
          this.extensionCalls.push('loseContext')
          this.lost = true
        },
        restoreContext: () => {
          this.lost = false
        },
      },
    }
    if (options.timerQuery) all.EXT_disjoint_timer_query_webgl2 = {}
    for (const [name, ext] of Object.entries(all)) {
      if (!options.without?.includes(name)) this.extensions.set(name, ext)
    }
  }

  /** The fake as the context type the shim takes, logging every call. */
  get context(): WebGL2RenderingContext {
    return new Proxy(this, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        if (typeof value !== 'function') return value
        return (...args: unknown[]) => {
          target.calls.push(String(key))
          return (value as (...a: unknown[]) => unknown).apply(target, args)
        }
      },
    }) as unknown as WebGL2RenderingContext
  }

  /** Calls since `mark` (an index into `calls`), by name. */
  callsSince(mark: number): string[] {
    return this.calls.slice(mark)
  }

  /** Texel `(x, y)` of `texture`'s level and layer, 4 components. */
  texel(
    texture: FakeTexture | FakeRenderbuffer,
    x: number,
    y: number,
    level = 0,
    layer = 0,
  ): number[] {
    const [image, w, h] = this.image(texture, level)
    const i = ((layer * h + y) * w + x) * 4
    return [image[i]!, image[i + 1]!, image[i + 2]!, image[i + 3]!]
  }

  // --- context state -----------------------------------------------------------------

  isContextLost(): boolean {
    return this.lost
  }

  getExtension(name: string): object | null {
    return this.extensions.get(name) ?? null
  }

  getParameter(p: number): number | string {
    const o = this.options.parameters?.[p]
    if (o !== undefined) return o
    switch (p) {
      case GL.MAX_TEXTURE_SIZE:
      case GL.MAX_CUBE_MAP_TEXTURE_SIZE:
        return 8192
      case GL.MAX_3D_TEXTURE_SIZE:
        return 2048
      case GL.MAX_ARRAY_TEXTURE_LAYERS:
        return 2048
      case GL.MAX_TEXTURE_IMAGE_UNITS:
      case GL.MAX_VERTEX_TEXTURE_IMAGE_UNITS:
        return 16
      case GL.MAX_COMBINED_TEXTURE_IMAGE_UNITS:
        return 32
      case GL.MAX_DRAW_BUFFERS:
      case GL.MAX_COLOR_ATTACHMENTS:
        return 8
      case GL.MAX_VERTEX_ATTRIBS:
        return 16
      case GL.MAX_VARYING_COMPONENTS:
        return 120
      case GL.MAX_UNIFORM_BLOCK_SIZE:
        return 65536
      case GL.MAX_VERTEX_UNIFORM_BLOCKS:
      case GL.MAX_FRAGMENT_UNIFORM_BLOCKS:
        return 14
      case GL.MAX_UNIFORM_BUFFER_BINDINGS:
        return 72
      case GL.UNIFORM_BUFFER_OFFSET_ALIGNMENT:
        return 256
      case GL.MAX_SAMPLES:
        return 8
      case GL.MAX_TEXTURE_MAX_ANISOTROPY_EXT:
        return 16
      case GL.VENDOR:
      case GL.UNMASKED_VENDOR_WEBGL:
        return 'Shard'
      case GL.RENDERER:
      case GL.UNMASKED_RENDERER_WEBGL:
        return 'Fake WebGL2'
      default:
        return 0
    }
  }

  getInternalformatParameter(_target: number, internal: number, _p: number): Int32Array {
    return new Int32Array(this.options.samples?.[internal] ?? [8, 4, 2])
  }

  getError(): number {
    return this.errors.shift() ?? GL.NO_ERROR
  }

  enable(cap: number): void {
    this.enabled.add(cap)
  }

  disable(cap: number): void {
    this.enabled.delete(cap)
  }

  pixelStorei(p: number, v: number | boolean): void {
    this.pixel.set(p, v)
  }

  viewport(x: number, y: number, w: number, h: number): void {
    const v = this.viewport_
    v[0] = x
    v[1] = y
    v[2] = w
    v[3] = h
  }

  scissor(x: number, y: number, w: number, h: number): void {
    const v = this.scissor_
    v[0] = x
    v[1] = y
    v[2] = w
    v[3] = h
  }

  depthRange(): void {}
  colorMask(r: boolean, g: boolean, b: boolean, a: boolean): void {
    const m = this.colorMask_
    m[0] = r
    m[1] = g
    m[2] = b
    m[3] = a
  }
  depthMask(on: boolean): void {
    this.depthMask_ = on
  }
  depthFunc(f: number): void {
    this.depthFunc_ = f
  }
  frontFace(f: number): void {
    this.frontFace_ = f
  }
  cullFace(f: number): void {
    this.cullFace_ = f
  }
  blendEquationSeparate(c: number, a: number): void {
    this.blend_[0] = c
    this.blend_[1] = a
  }
  blendFuncSeparate(cs: number, cd: number, as: number, ad: number): void {
    this.blend_[2] = cs
    this.blend_[3] = cd
    this.blend_[4] = as
    this.blend_[5] = ad
  }
  blendColor(): void {}
  polygonOffset(): void {}
  stencilOpSeparate(): void {}
  stencilFuncSeparate(): void {}
  stencilMask(): void {}
  clearColor(r: number, g: number, b: number, a: number): void {
    this.clearColor_ = [r, g, b, a]
  }
  flush(): void {}
  hint(): void {}

  // --- buffers --------------------------------------------------------------------

  createBuffer(): FakeBuffer {
    return { kind: 'buffer', id: this.next++, data: new Uint8Array(0), deleted: false }
  }

  deleteBuffer(b: FakeBuffer | null): void {
    if (b) b.deleted = true
  }

  bindBuffer(target: number, b: FakeBuffer | null): void {
    if (target === GL.ELEMENT_ARRAY_BUFFER) this.vao.element = b
    else this.bound.set(target, b)
  }

  private buffer(target: number): FakeBuffer {
    const b = target === GL.ELEMENT_ARRAY_BUFFER ? this.vao.element : this.bound.get(target)
    if (!b) throw new Error(`Fake GL: no buffer bound to 0x${target.toString(16)}`)
    return b
  }

  bufferData(target: number, sizeOrData: number | ArrayBufferView): void {
    const b = this.buffer(target)
    b.data =
      typeof sizeOrData === 'number'
        ? new Uint8Array(sizeOrData)
        : new Uint8Array(
            sizeOrData.buffer.slice(
              sizeOrData.byteOffset,
              sizeOrData.byteOffset + sizeOrData.byteLength,
            ),
          )
  }

  bufferSubData(
    target: number,
    offset: number,
    src: ArrayBufferView | ArrayBuffer,
    srcOffset = 0,
    length = 0,
  ): void {
    const b = this.buffer(target)
    const view = ArrayBuffer.isView(src) ? src : new Uint8Array(src)
    const unit = (view as Uint8Array).BYTES_PER_ELEMENT ?? 1
    const count = length || view.byteLength / unit - srcOffset
    const bytes = new Uint8Array(view.buffer, view.byteOffset + srcOffset * unit, count * unit)
    if (offset + bytes.length > b.data.length)
      throw new Error('Fake GL: bufferSubData out of range')
    b.data.set(bytes, offset)
  }

  copyBufferSubData(
    readTarget: number,
    writeTarget: number,
    readOffset: number,
    writeOffset: number,
    size: number,
  ): void {
    const from = this.buffer(readTarget)
    const to = this.buffer(writeTarget)
    to.data.set(from.data.slice(readOffset, readOffset + size), writeOffset)
  }

  getBufferSubData(
    target: number,
    offset: number,
    dst: ArrayBufferView,
    dstOffset = 0,
    length = 0,
  ): void {
    const b = this.buffer(target)
    const unit = (dst as Uint8Array).BYTES_PER_ELEMENT ?? 1
    const count = (length || dst.byteLength / unit - dstOffset) * unit
    new Uint8Array(dst.buffer, dst.byteOffset + dstOffset * unit, count).set(
      b.data.subarray(offset, offset + count),
    )
  }

  bindBufferRange(
    _target: number,
    point: number,
    b: FakeBuffer | null,
    offset: number,
    size: number,
  ): void {
    let r = this.ranges[point]
    if (!r) {
      r = { buffer: null, offset: 0, size: 0 }
      this.ranges[point] = r
    }
    r.buffer = b
    r.offset = offset
    r.size = size
  }

  // --- textures -------------------------------------------------------------------

  createTexture(): FakeTexture {
    return {
      kind: 'texture',
      id: this.next++,
      target: 0,
      internal: 0,
      width: 0,
      height: 0,
      depth: 0,
      levels: 0,
      images: [],
      params: new Map(),
      deleted: false,
    }
  }

  deleteTexture(t: FakeTexture | null): void {
    if (t) t.deleted = true
  }

  activeTexture(unit: number): void {
    this.active = unit - GL.TEXTURE0
  }

  bindTexture(target: number, t: FakeTexture | null): void {
    let unit = this.units[this.active]
    if (!unit) {
      unit = new Map()
      this.units[this.active] = unit
    }
    unit.set(target, t)
    if (t && !t.target) t.target = target
  }

  private boundTexture(target: number): FakeTexture {
    const base =
      target >= GL.TEXTURE_CUBE_MAP_POSITIVE_X && target < GL.TEXTURE_CUBE_MAP_POSITIVE_X + 6
    const t = this.units[this.active]?.get(base ? GL.TEXTURE_CUBE_MAP : target)
    if (!t) throw new Error(`Fake GL: no texture bound to 0x${target.toString(16)}`)
    return t
  }

  texStorage2D(target: number, levels: number, internal: number, w: number, h: number): void {
    this.storage(
      this.boundTexture(target),
      levels,
      internal,
      w,
      h,
      target === GL.TEXTURE_CUBE_MAP ? 6 : 1,
    )
  }

  texStorage3D(
    target: number,
    levels: number,
    internal: number,
    w: number,
    h: number,
    d: number,
  ): void {
    this.storage(this.boundTexture(target), levels, internal, w, h, d)
  }

  private storage(
    t: FakeTexture,
    levels: number,
    internal: number,
    w: number,
    h: number,
    d: number,
  ): void {
    t.internal = internal
    t.width = w
    t.height = h
    t.depth = d
    t.levels = levels
    for (let l = 0; l < levels; l++) {
      const layers = t.target === GL.TEXTURE_3D ? Math.max(1, d >> l) : d
      t.images.push(new Float64Array(Math.max(1, w >> l) * Math.max(1, h >> l) * layers * 4))
    }
  }

  texParameteri(target: number, p: number, v: number): void {
    this.boundTexture(target).params.set(p, v)
  }

  texSubImage2D(
    target: number,
    level: number,
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    src?: ArrayBufferView | number | object,
    srcOffset = 0,
  ): void {
    const t = this.boundTexture(target)
    const face = target === GL.TEXTURE_2D ? 0 : target - GL.TEXTURE_CUBE_MAP_POSITIVE_X
    this.upload(t, level, x, y, face, w, h, 1, format, type, src, srcOffset)
  }

  texSubImage3D(
    target: number,
    level: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    format: number,
    type: number,
    src?: ArrayBufferView | number | object,
    srcOffset = 0,
  ): void {
    this.upload(this.boundTexture(target), level, x, y, z, w, h, d, format, type, src, srcOffset)
  }

  compressedTexSubImage2D(): void {}
  compressedTexSubImage3D(): void {}

  private upload(
    t: FakeTexture,
    level: number,
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    d: number,
    format: number,
    type: number,
    src: ArrayBufferView | number | object | undefined,
    srcOffset: number,
  ): void {
    let bytes: Uint8Array
    let start: number
    if (typeof src === 'number') {
      bytes = this.buffer(GL.PIXEL_UNPACK_BUFFER).data
      start = src
    } else if (src && ArrayBuffer.isView(src)) {
      bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength)
      start = srcOffset * ((src as Uint8Array).BYTES_PER_ELEMENT ?? 1)
    } else {
      return // a DOM image: nothing to read in Node
    }
    const comps = formatComponents(format)
    const size = typeSize(type)
    const texelBytes = packed(type) ? 4 : comps * size
    const rowLength = (this.pixel.get(GL.UNPACK_ROW_LENGTH) as number) || w
    const imageHeight = (this.pixel.get(GL.UNPACK_IMAGE_HEIGHT) as number) || h
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const [image, iw, ih] = this.image(t, level)
    const integer = COMPONENTS[t.internal]?.[1] === 'uint'
    for (let k = 0; k < d; k++) {
      for (let r = 0; r < h; r++) {
        for (let c = 0; c < w; c++) {
          const at = start + ((k * imageHeight + r) * rowLength + c) * texelBytes
          const o = (((z + k) * ih + y + r) * iw + x + c) * 4
          const values = decode(view, at, comps, type, integer)
          for (let i = 0; i < 4; i++) image[o + i] = values[i]!
        }
      }
    }
  }

  private image(t: FakeTexture | FakeRenderbuffer, level: number): [Float64Array, number, number] {
    if (t.kind === 'renderbuffer') return [t.image, t.width, t.height]
    return [t.images[level]!, Math.max(1, t.width >> level), Math.max(1, t.height >> level)]
  }

  // --- samplers -----------------------------------------------------------------------

  createSampler(): object {
    return { kind: 'sampler', id: this.next++, params: new Map<number, number>() }
  }
  samplerParameteri(s: { params: Map<number, number> }, p: number, v: number): void {
    s.params.set(p, v)
  }
  samplerParameterf(s: { params: Map<number, number> }, p: number, v: number): void {
    s.params.set(p, v)
  }
  bindSampler(unit: number, s: object | null): void {
    this.samplers[unit] = s
  }

  // --- framebuffers -------------------------------------------------------------------

  createRenderbuffer(): FakeRenderbuffer {
    return {
      kind: 'renderbuffer',
      id: this.next++,
      internal: 0,
      width: 0,
      height: 0,
      samples: 0,
      image: new Float64Array(0),
      deleted: false,
    }
  }
  deleteRenderbuffer(r: FakeRenderbuffer | null): void {
    if (r) r.deleted = true
  }
  bindRenderbuffer(_target: number, r: FakeRenderbuffer | null): void {
    this.renderbuffer = r
  }
  renderbufferStorage(_target: number, internal: number, w: number, h: number): void {
    this.renderbufferStorageMultisample(_target, 0, internal, w, h)
  }
  renderbufferStorageMultisample(
    _target: number,
    samples: number,
    internal: number,
    w: number,
    h: number,
  ): void {
    const r = this.renderbuffer!
    r.samples = samples
    r.internal = internal
    r.width = w
    r.height = h
    r.image = new Float64Array(w * h * 4)
  }

  createFramebuffer(): FakeFramebuffer {
    return {
      kind: 'framebuffer',
      id: this.next++,
      attachments: new Map(),
      drawBuffers: [GL.COLOR_ATTACHMENT0],
      readBuffer: GL.COLOR_ATTACHMENT0,
      deleted: false,
    }
  }
  deleteFramebuffer(f: FakeFramebuffer | null): void {
    if (f) f.deleted = true
  }
  bindFramebuffer(target: number, f: FakeFramebuffer | null): void {
    if (target === GL.FRAMEBUFFER || target === GL.DRAW_FRAMEBUFFER) this.drawFb = f
    if (target === GL.FRAMEBUFFER || target === GL.READ_FRAMEBUFFER) this.readFb = f
  }
  framebufferTexture2D(
    _target: number,
    point: number,
    texTarget: number,
    t: FakeTexture | null,
    level: number,
  ): void {
    const face = texTarget === GL.TEXTURE_2D ? 0 : texTarget - GL.TEXTURE_CUBE_MAP_POSITIVE_X
    if (t) this.drawFb!.attachments.set(point, { object: t, level, layer: face })
  }
  framebufferTextureLayer(
    _target: number,
    point: number,
    t: FakeTexture | null,
    level: number,
    layer: number,
  ): void {
    if (t) this.drawFb!.attachments.set(point, { object: t, level, layer })
  }
  framebufferRenderbuffer(
    _target: number,
    point: number,
    _rt: number,
    r: FakeRenderbuffer | null,
  ): void {
    if (r) this.drawFb!.attachments.set(point, { object: r, level: 0, layer: 0 })
  }
  drawBuffers(buffers: number[]): void {
    this.drawFb!.drawBuffers = [...buffers]
  }
  readBuffer(b: number): void {
    this.readFb!.readBuffer = b
  }
  checkFramebufferStatus(): number {
    return GL.FRAMEBUFFER_COMPLETE
  }
  invalidateFramebuffer(): void {}

  /** The attachment a color draw buffer writes, or the depth/stencil one. */
  private attachment(fb: FakeFramebuffer, point: number): Attachment | undefined {
    if (point === GL.DEPTH_ATTACHMENT || point === GL.STENCIL_ATTACHMENT) {
      return fb.attachments.get(point) ?? fb.attachments.get(GL.DEPTH_STENCIL_ATTACHMENT)
    }
    return fb.attachments.get(point)
  }

  private fill(a: Attachment | undefined, values: ArrayLike<number>, mask: boolean[]): void {
    if (!a) return
    const o = a.object
    const image = o.kind === 'renderbuffer' ? o.image : o.images[a.level]!
    const w = o.kind === 'renderbuffer' ? o.width : Math.max(1, o.width >> a.level)
    const h = o.kind === 'renderbuffer' ? o.height : Math.max(1, o.height >> a.level)
    const scissor = this.enabled.has(GL.SCISSOR_TEST)
    const [sx, sy, sw, sh] = this.scissor_
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (scissor && (x < sx! || y < sy! || x >= sx! + sw! || y >= sy! + sh!)) continue
        const at = ((a.layer * h + y) * w + x) * 4
        for (let i = 0; i < 4; i++) if (mask[i] && i < values.length) image[at + i] = values[i]!
      }
    }
  }

  clearBufferfv(buffer: number, drawBuffer: number, values: ArrayLike<number>): void {
    const fb = this.drawFb
    if (!fb) return
    if (buffer === GL.DEPTH)
      this.fill(this.attachment(fb, GL.DEPTH_ATTACHMENT), [values[0]!], [this.depthMask_])
    else
      this.fill(this.attachment(fb, fb.drawBuffers[drawBuffer] ?? GL.NONE), values, this.colorMask_)
  }
  clearBufferuiv(_buffer: number, drawBuffer: number, values: ArrayLike<number>): void {
    const fb = this.drawFb
    if (fb)
      this.fill(this.attachment(fb, fb.drawBuffers[drawBuffer] ?? GL.NONE), values, this.colorMask_)
  }
  clearBufferiv(buffer: number, drawBuffer: number, values: ArrayLike<number>): void {
    const fb = this.drawFb
    if (!fb || buffer === GL.STENCIL) return
    this.fill(this.attachment(fb, fb.drawBuffers[drawBuffer] ?? GL.NONE), values, this.colorMask_)
  }
  clearBufferfi(_buffer: number, _drawBuffer: number, depth: number): void {
    const fb = this.drawFb
    if (fb) this.fill(this.attachment(fb, GL.DEPTH_ATTACHMENT), [depth], [this.depthMask_])
  }
  clear(mask: number): void {
    if (mask & GL.COLOR_BUFFER_BIT && !this.drawFb) {
      const c = this.clearColor_
      for (let i = 0; i < this.backbuffer.length; i += 4) {
        for (let k = 0; k < 4; k++) if (this.colorMask_[k]) this.backbuffer[i + k] = c[k]!
      }
    }
  }

  blitFramebuffer(
    sx0: number,
    sy0: number,
    sx1: number,
    sy1: number,
    dx0: number,
    dy0: number,
    dx1: number,
    dy1: number,
    mask: number,
  ): void {
    const read = this.readFb
    const draw = this.drawFb
    if (!read) throw new Error('Fake GL: blit without a read framebuffer')
    const color = (mask & GL.COLOR_BUFFER_BIT) !== 0
    const from = this.attachment(read, color ? read.readBuffer : GL.DEPTH_ATTACHMENT)
    if (!from) throw new Error('Fake GL: blit from nothing')
    const [src, sw, sh] = this.image(from.object, from.level)
    const targets: { image: Float64Array; w: number; h: number; layer: number }[] = []
    if (!draw) {
      targets.push({
        image: this.backbuffer,
        w: this.canvas.width,
        h: this.canvas.height,
        layer: 0,
      })
    } else if (color) {
      for (const b of draw.drawBuffers) {
        const a = this.attachment(draw, b)
        if (a) {
          const [image, w, h] = this.image(a.object, a.level)
          targets.push({ image, w, h, layer: a.layer })
        }
      }
    } else {
      const a = this.attachment(draw, GL.DEPTH_ATTACHMENT)
      if (a) {
        const [image, w, h] = this.image(a.object, a.level)
        targets.push({ image, w, h, layer: a.layer })
      }
    }
    const width = Math.abs(dx1 - dx0)
    const height = Math.abs(dy1 - dy0)
    for (const t of targets) {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const tx = dx1 > dx0 ? dx0 + x : dx0 - 1 - x
          const ty = dy1 > dy0 ? dy0 + y : dy0 - 1 - y
          const fx = sx0 + Math.floor(((x + 0.5) * (sx1 - sx0)) / width)
          const fy = sy0 + Math.floor(((y + 0.5) * (sy1 - sy0)) / height)
          if (tx < 0 || ty < 0 || tx >= t.w || ty >= t.h || fx >= sw || fy >= sh) continue
          const i = ((from.layer * sh + fy) * sw + fx) * 4
          const o = ((t.layer * t.h + ty) * t.w + tx) * 4
          for (let k = 0; k < 4; k++) t.image[o + k] = src[i + k]!
        }
      }
    }
  }

  readPixels(
    x: number,
    y: number,
    w: number,
    h: number,
    format: number,
    type: number,
    dst: ArrayBufferView | number,
    dstOffset = 0,
  ): void {
    const fb = this.readFb
    if (!fb) throw new Error('Fake GL: readPixels from the canvas')
    const a = this.attachment(fb, fb.readBuffer)
    if (!a) throw new Error('Fake GL: readPixels from no attachment')
    const [image, iw, ih] = this.image(a.object, a.level)
    let bytes: Uint8Array
    let start: number
    if (typeof dst === 'number') {
      bytes = this.buffer(GL.PIXEL_PACK_BUFFER).data
      start = dst
    } else {
      bytes = new Uint8Array(dst.buffer, dst.byteOffset, dst.byteLength)
      start = dstOffset * ((dst as Uint8Array).BYTES_PER_ELEMENT ?? 1)
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const comps = formatComponents(format)
    const size = typeSize(type)
    const rowLength = (this.pixel.get(GL.PACK_ROW_LENGTH) as number) || w
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = ((a.layer * ih + y + r) * iw + x + c) * 4
        const at = start + (r * rowLength + c) * comps * size
        for (let k = 0; k < comps; k++) {
          const v = image[i + k]!
          if (type === GL.UNSIGNED_BYTE)
            view.setUint8(at + k, Math.round(Math.min(1, Math.max(0, v)) * 255))
          else if (type === GL.FLOAT) view.setFloat32(at + k * 4, v, true)
          else if (type === GL.INT) view.setInt32(at + k * 4, v, true)
          else view.setUint32(at + k * 4, v >>> 0, true)
        }
      }
    }
  }

  // --- programs -----------------------------------------------------------------------

  createShader(type: number): { kind: 'shader'; type: number; source: string } {
    return { kind: 'shader', type, source: '' }
  }
  shaderSource(s: { source: string }, source: string): void {
    s.source = source
  }
  compileShader(): void {}
  deleteShader(): void {}
  getShaderInfoLog(s: { source: string }): string {
    return s.source.includes('FAIL_LINK') ? 'fake: FAIL_LINK' : ''
  }

  createProgram(): FakeProgram {
    return {
      kind: 'program',
      id: this.next++,
      sources: [],
      linked: false,
      blockIndices: new Map(),
      blockPoints: new Map(),
      uniforms: new Map(),
      deleted: false,
    }
  }
  attachShader(p: FakeProgram, s: { source: string }): void {
    p.sources.push(s.source)
  }
  linkProgram(p: FakeProgram): void {
    p.linked = !p.sources.some((s) => s.includes('FAIL_LINK'))
    this.pendingLinks = this.options.linkPolls ?? 0
  }
  getProgramParameter(p: FakeProgram, which: number): boolean {
    if (which === GL.COMPLETION_STATUS_KHR) {
      if (this.pendingLinks > 0) {
        this.pendingLinks--
        return false
      }
      return true
    }
    return p.linked
  }
  getProgramInfoLog(p: FakeProgram): string {
    return p.linked ? '' : 'fake: the program did not link'
  }
  deleteProgram(p: FakeProgram | null): void {
    if (p) p.deleted = true
  }
  useProgram(p: FakeProgram | null): void {
    this.program = p
  }
  getUniformBlockIndex(p: FakeProgram, name: string): number {
    if (!p.sources.some((s) => new RegExp(`uniform\\s+${name}\\b`).test(s))) return 0xffffffff
    let index = p.blockIndices.get(name)
    if (index === undefined) {
      index = p.blockIndices.size
      p.blockIndices.set(name, index)
    }
    return index
  }
  getActiveUniformBlockParameter(p: FakeProgram, index: number): number {
    for (const [name, i] of p.blockIndices) {
      if (i !== index) continue
      for (const [prefix, size] of Object.entries(this.options.blockSizes ?? {})) {
        if (name.startsWith(prefix)) return size
      }
    }
    return 0
  }
  uniformBlockBinding(p: FakeProgram, index: number, point: number): void {
    p.blockPoints.set(index, point)
  }
  getUniformLocation(p: FakeProgram, name: string): { program: FakeProgram; name: string } | null {
    return p.sources.some((s) => new RegExp(`\\b${name}\\b`).test(s)) ? { program: p, name } : null
  }
  private setUniform(
    l: { program: FakeProgram; name: string } | null,
    value: number | number[],
  ): void {
    if (!l) return
    if (l.program !== this.program) throw new Error('Fake GL: uniform set on a program not in use')
    l.program.uniforms.set(l.name, value)
  }
  uniform1i(l: { program: FakeProgram; name: string } | null, v: number): void {
    this.setUniform(l, v)
  }
  uniform1ui(l: { program: FakeProgram; name: string } | null, v: number): void {
    this.setUniform(l, v)
  }
  uniform3i(
    l: { program: FakeProgram; name: string } | null,
    x: number,
    y: number,
    z: number,
  ): void {
    this.setUniform(l, [x, y, z])
  }

  // --- vertex arrays and draws ---------------------------------------------------------

  createVertexArray(): FakeVao {
    return { kind: 'vao', id: this.next++, element: null, attribs: [] }
  }
  bindVertexArray(v: FakeVao | null): void {
    this.vao = v ?? this.defaultVao
  }
  private attrib(loc: number): FakeAttrib {
    const known = this.vao.attribs[loc]
    if (known) return known
    const made: FakeAttrib = {
      enabled: false,
      buffer: null,
      size: 4,
      type: GL.FLOAT,
      normalized: false,
      integer: false,
      stride: 0,
      offset: 0,
      divisor: 0,
    }
    this.vao.attribs[loc] = made
    return made
  }
  enableVertexAttribArray(loc: number): void {
    this.attrib(loc).enabled = true
  }
  disableVertexAttribArray(loc: number): void {
    this.attrib(loc).enabled = false
  }
  vertexAttribPointer(
    loc: number,
    size: number,
    type: number,
    normalized: boolean,
    stride: number,
    offset: number,
  ): void {
    this.point(loc, size, type, normalized, false, stride, offset)
  }
  vertexAttribIPointer(
    loc: number,
    size: number,
    type: number,
    stride: number,
    offset: number,
  ): void {
    this.point(loc, size, type, false, true, stride, offset)
  }
  private point(
    loc: number,
    size: number,
    type: number,
    normalized: boolean,
    integer: boolean,
    stride: number,
    offset: number,
  ): void {
    const a = this.attrib(loc)
    a.buffer = this.bound.get(GL.ARRAY_BUFFER) ?? null
    a.size = size
    a.type = type
    a.normalized = normalized
    a.integer = integer
    a.stride = stride
    a.offset = offset
  }
  vertexAttribDivisor(loc: number, divisor: number): void {
    this.attrib(loc).divisor = divisor
  }

  drawArrays(mode: number, first: number, count: number): void {
    this.record('drawArrays', mode, first, count, 0, 0, 1)
  }
  drawArraysInstanced(mode: number, first: number, count: number, instances: number): void {
    this.record('drawArrays', mode, first, count, 0, 0, instances)
  }
  drawElementsInstanced(
    mode: number,
    count: number,
    type: number,
    offset: number,
    instances: number,
  ): void {
    this.record('drawElements', mode, 0, count, type, offset, instances)
  }

  private record(
    call: DrawRecord['call'],
    mode: number,
    first: number,
    count: number,
    type: number,
    offset: number,
    instances: number,
  ): void {
    const program = this.program
    if (!program?.linked) throw new Error('Fake GL: draw without a linked program')
    if (!this.recordDraws) return
    const blocks: DrawRecord['blocks'] = new Map()
    for (const point of program.blockPoints.values()) {
      const r = this.ranges[point]
      blocks.set(point, { buffer: r?.buffer ?? null, offset: r?.offset ?? 0, size: r?.size ?? 0 })
    }
    const units: DrawRecord['units'] = new Map()
    for (const [name, v] of program.uniforms) {
      if (typeof v !== 'number' || name === 'naga_vs_first_instance') continue
      const unit = this.units[v]
      let texture: FakeTexture | null = null
      for (const t of unit?.values() ?? []) if (t) texture = t
      units.set(v, {
        texture,
        sampler: this.samplers[v] ?? null,
        base: texture?.params.get(GL.TEXTURE_BASE_LEVEL) ?? 0,
        max: texture?.params.get(GL.TEXTURE_MAX_LEVEL) ?? 1000,
      })
    }
    this.draws.push({
      call,
      mode,
      first,
      count,
      type,
      offset,
      instances,
      program,
      framebuffer: this.drawFb,
      viewport: [...this.viewport_],
      blocks,
      units,
      attribs: this.vao.attribs.flatMap((a, location) => (a?.enabled ? [{ ...a, location }] : [])),
      element: this.vao.element,
      uniforms: new Map(program.uniforms),
      enabled: new Set(this.enabled),
      colorMask: [...this.colorMask_],
      depthMask: this.depthMask_,
      depthFunc: this.depthFunc_,
      frontFace: this.frontFace_,
      cullFace: this.cullFace_,
      blend: [...this.blend_],
    })
  }

  // --- sync -----------------------------------------------------------------------------

  // --- timer queries (EXT_disjoint_timer_query_webgl2) --------------------------------

  /** Queries begun so far, and the one running. */
  queriesBegun = 0
  private activeQuery: { polls: number; ended: boolean } | null = null

  createQuery(): object {
    return { kind: 'query', id: this.next++, polls: 0, ended: false }
  }

  deleteQuery(): void {}

  beginQuery(_target: number, query: { polls: number; ended: boolean }): void {
    query.polls = this.options.timerQuery?.polls ?? 0
    query.ended = false
    this.activeQuery = query
    this.queriesBegun++
  }

  endQuery(): void {
    if (this.activeQuery) this.activeQuery.ended = true
    this.activeQuery = null
  }

  getQueryParameter(query: { polls: number; ended: boolean }, p: number): number | boolean {
    if (p === 0x8867) {
      if (!query.ended) return false
      if (query.polls > 0) {
        query.polls--
        return false
      }
      return true
    }
    return this.options.timerQuery?.elapsedNs ?? 0
  }

  fenceSync(): object {
    return { kind: 'sync', id: this.next++ }
  }
  getSyncParameter(): number {
    return GL.SIGNALED
  }
  deleteSync(): void {}
}

function decode(
  view: DataView,
  at: number,
  comps: number,
  type: number,
  integer: boolean,
): number[] {
  const out = [0, 0, 0, 1]
  if (type === GL.UNSIGNED_INT_10F_11F_11F_REV) {
    const v = view.getUint32(at, true)
    return [ufloat(v & 0x7ff, 6), ufloat((v >>> 11) & 0x7ff, 6), ufloat((v >>> 22) & 0x3ff, 5), 1]
  }
  if (type === GL.UNSIGNED_INT_2_10_10_10_REV) {
    const v = view.getUint32(at, true)
    return [
      (v & 0x3ff) / 1023,
      ((v >>> 10) & 0x3ff) / 1023,
      ((v >>> 20) & 0x3ff) / 1023,
      (v >>> 30) / 3,
    ]
  }
  for (let i = 0; i < comps; i++) {
    switch (type) {
      case GL.UNSIGNED_BYTE: {
        const b = view.getUint8(at + i)
        out[i] = integer ? b : b / 255
        break
      }
      case GL.HALF_FLOAT:
        out[i] = halfToFloat(view.getUint16(at + i * 2, true))
        break
      case GL.FLOAT:
        out[i] = view.getFloat32(at + i * 4, true)
        break
      case GL.UNSIGNED_SHORT: {
        const s = view.getUint16(at + i * 2, true)
        out[i] = integer ? s : s / 65535
        break
      }
      case GL.INT:
        out[i] = view.getInt32(at + i * 4, true)
        break
      default:
        out[i] = view.getUint32(at + i * 4, true)
    }
  }
  return out
}
