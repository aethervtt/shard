import type { Webgl2PipelineLayout } from './binding'
import type { Webgl2Device } from './device'
import { unsupported } from './errors'
import { GL } from './gl'
import type { GlslTranslation } from './naga'
import { COMPARE } from './resources'

// Shader modules and render pipelines. A pipeline's vertex and fragment entry points go through
// naga to GLSL ES 3.00 (the vertex stage flips y, so framebuffer memory is laid out as WebGPU's;
// front faces flip with it), link into a program, and take their GL binding points from naga's
// reflection: a uniform block point per (group, binding), a texture unit per combined sampler.

let nextId = 1

export class Webgl2ShaderModule {
  readonly id = nextId++
  readonly code: string
  readonly label: string
  constructor(d: GPUShaderModuleDescriptor) {
    this.code = d.code
    this.label = d.label ?? ''
  }

  /** Answered without translating: pipelines report what doesn't translate or link. */
  getCompilationInfo(): Promise<{ messages: readonly unknown[] }> {
    return Promise.resolve({ messages: [] })
  }
}

/** A uniform block of the program, and the group binding that feeds it. */
export interface ProgramBlock {
  group: number
  binding: number
  point: number
}

/** A combined sampler of the program: its texture unit, texture binding and sampler binding. */
export interface ProgramSampler {
  unit: number
  group: number
  binding: number
  /** The sampler's group and binding, or -1 for `texelFetch` reads (no sampler). */
  samplerGroup: number
  samplerBinding: number
}

export interface VertexAttribute {
  location: number
  size: number
  type: number
  normalized: boolean
  integer: boolean
  offset: number
}

export interface VertexBufferLayout {
  stride: number
  instanced: boolean
  attributes: VertexAttribute[]
}

interface BlendState {
  enabled: boolean
  colorOp: number
  colorSrc: number
  colorDst: number
  alphaOp: number
  alphaSrc: number
  alphaDst: number
}

const FACTOR: Record<GPUBlendFactor, number> = {
  zero: GL.ZERO,
  one: GL.ONE,
  src: GL.SRC_COLOR,
  'one-minus-src': GL.ONE_MINUS_SRC_COLOR,
  'src-alpha': GL.SRC_ALPHA,
  'one-minus-src-alpha': GL.ONE_MINUS_SRC_ALPHA,
  dst: GL.DST_COLOR,
  'one-minus-dst': GL.ONE_MINUS_DST_COLOR,
  'dst-alpha': GL.DST_ALPHA,
  'one-minus-dst-alpha': GL.ONE_MINUS_DST_ALPHA,
  'src-alpha-saturated': GL.SRC_ALPHA_SATURATE,
  constant: GL.CONSTANT_COLOR,
  'one-minus-constant': GL.ONE_MINUS_CONSTANT_COLOR,
}

const OPERATION: Record<GPUBlendOperation, number> = {
  add: GL.FUNC_ADD,
  subtract: GL.FUNC_SUBTRACT,
  'reverse-subtract': GL.FUNC_REVERSE_SUBTRACT,
  min: GL.MIN,
  max: GL.MAX,
}

const STENCIL_OP: Record<GPUStencilOperation, number> = {
  keep: GL.KEEP,
  zero: GL.ZERO,
  replace: GL.REPLACE,
  invert: GL.INVERT,
  'increment-clamp': GL.INCR,
  'decrement-clamp': GL.DECR,
  'increment-wrap': GL.INCR_WRAP,
  'decrement-wrap': GL.DECR_WRAP,
}

/** A vertex format: components, GL type, normalized, read as integers. */
const VERTEX_FORMAT: Record<string, [number, number, boolean, boolean]> = {
  float32: [1, GL.FLOAT, false, false],
  float32x2: [2, GL.FLOAT, false, false],
  float32x3: [3, GL.FLOAT, false, false],
  float32x4: [4, GL.FLOAT, false, false],
  float16x2: [2, GL.HALF_FLOAT, false, false],
  float16x4: [4, GL.HALF_FLOAT, false, false],
  uint32: [1, GL.UNSIGNED_INT, false, true],
  uint32x2: [2, GL.UNSIGNED_INT, false, true],
  uint32x3: [3, GL.UNSIGNED_INT, false, true],
  uint32x4: [4, GL.UNSIGNED_INT, false, true],
  sint32: [1, GL.INT, false, true],
  sint32x2: [2, GL.INT, false, true],
  sint32x3: [3, GL.INT, false, true],
  sint32x4: [4, GL.INT, false, true],
  uint16x2: [2, GL.UNSIGNED_SHORT, false, true],
  uint16x4: [4, GL.UNSIGNED_SHORT, false, true],
  unorm16x2: [2, GL.UNSIGNED_SHORT, true, false],
  unorm16x4: [4, GL.UNSIGNED_SHORT, true, false],
  uint8x2: [2, GL.UNSIGNED_BYTE, false, true],
  uint8x4: [4, GL.UNSIGNED_BYTE, false, true],
  unorm8x2: [2, GL.UNSIGNED_BYTE, true, false],
  unorm8x4: [4, GL.UNSIGNED_BYTE, true, false],
  snorm8x4: [4, GL.BYTE, true, false],
}

/** The fragment stage of a pipeline without one: depth-only passes. */
const EMPTY_FRAGMENT = '#version 300 es\nprecision highp float;\nvoid main() {}\n'

export class Webgl2RenderPipeline {
  readonly id = nextId++
  readonly label: string
  readonly layout: Webgl2PipelineLayout
  program: WebGLProgram | null = null
  readonly blocks: ProgramBlock[] = []
  readonly samplers: ProgramSampler[] = []
  firstInstance: WebGLUniformLocation | null = null
  /** The first instance the program's uniform holds (-1: not set yet). */
  firstInstanceValue = -1
  /** Reads `@builtin(vertex_index)`: a nonzero baseVertex would shift it. */
  readonly vertexIndex: boolean
  readonly vertexBuffers: VertexBufferLayout[]
  readonly topology: number
  readonly cull: number
  readonly frontFace: number
  readonly depthTest: boolean
  readonly depthWrite: boolean
  readonly depthFunc: number
  readonly depthBias: number
  readonly depthSlope: number
  readonly stencil: boolean
  readonly stencilFront: [number, number, number, number]
  readonly stencilBack: [number, number, number, number]
  readonly stencilReadMask: number
  readonly stencilWriteMask: number
  readonly blends: BlendState[]
  readonly masks: number[]
  /** Every target blends and masks alike: one set of GL calls covers them all. */
  readonly uniformTargets: boolean
  readonly targets: number
  readonly sampleCount: number
  private readonly device: Webgl2Device
  private readonly descriptor: GPURenderPipelineDescriptor

  constructor(device: Webgl2Device, d: GPURenderPipelineDescriptor) {
    this.device = device
    this.descriptor = d
    this.label = d.label ?? ''
    if (d.layout === 'auto') throw unsupported(`make "${this.label}" with layout 'auto'`)
    this.layout = d.layout as unknown as Webgl2PipelineLayout
    const vs = d.vertex.module as unknown as Webgl2ShaderModule
    this.vertexIndex = /@builtin\(\s*vertex_index\s*\)/.test(vs.code)
    this.vertexBuffers = (d.vertex.buffers ?? []).map((b) => ({
      stride: b?.arrayStride ?? 0,
      instanced: b?.stepMode === 'instance',
      attributes: (b ? [...b.attributes] : []).map((a) => {
        const f = VERTEX_FORMAT[a.format]
        if (!f) throw unsupported(`read the vertex format ${a.format}`)
        return {
          location: a.shaderLocation,
          size: f[0],
          type: f[1],
          normalized: f[2],
          integer: f[3],
          offset: a.offset,
        }
      }),
    }))
    const p = d.primitive ?? {}
    const topology = p.topology ?? 'triangle-list'
    this.topology =
      topology === 'triangle-list'
        ? GL.TRIANGLES
        : topology === 'triangle-strip'
          ? GL.TRIANGLE_STRIP
          : topology === 'line-list'
            ? GL.LINES
            : topology === 'line-strip'
              ? GL.LINE_STRIP
              : GL.POINTS
    this.cull = p.cullMode === 'front' ? GL.FRONT : p.cullMode === 'back' ? GL.BACK : 0
    // y is flipped in the vertex stage: what WebGPU calls counter-clockwise is clockwise here.
    this.frontFace = (p.frontFace ?? 'ccw') === 'ccw' ? GL.CW : GL.CCW
    const ds = d.depthStencil
    this.depthTest =
      ds !== undefined &&
      ((ds.depthCompare ?? 'always') !== 'always' || ds.depthWriteEnabled === true)
    this.depthWrite = ds?.depthWriteEnabled === true
    this.depthFunc = COMPARE[ds?.depthCompare ?? 'always']
    this.depthBias = ds?.depthBias ?? 0
    this.depthSlope = ds?.depthBiasSlopeScale ?? 0
    const face = (s: GPUStencilFaceState | undefined): [number, number, number, number] => [
      COMPARE[s?.compare ?? 'always'],
      STENCIL_OP[s?.failOp ?? 'keep'],
      STENCIL_OP[s?.depthFailOp ?? 'keep'],
      STENCIL_OP[s?.passOp ?? 'keep'],
    ]
    this.stencilFront = face(ds?.stencilFront)
    this.stencilBack = face(ds?.stencilBack)
    this.stencilReadMask = ds?.stencilReadMask ?? 0xff
    this.stencilWriteMask = ds?.stencilWriteMask ?? 0xff
    this.stencil =
      ds !== undefined &&
      (ds.format === 'stencil8' || ds.format.includes('stencil')) &&
      (ds.stencilFront !== undefined || ds.stencilBack !== undefined)
    if (d.multisample?.alphaToCoverageEnabled)
      throw unsupported(`use alpha to coverage ("${this.label}")`)
    this.sampleCount = d.multisample?.count ?? 1
    const targets = d.fragment ? [...d.fragment.targets] : []
    this.targets = targets.length
    this.blends = targets.map((t) => {
      const b = t?.blend
      return {
        enabled: b !== undefined,
        colorOp: OPERATION[b?.color.operation ?? 'add'],
        colorSrc: FACTOR[b?.color.srcFactor ?? 'one'],
        colorDst: FACTOR[b?.color.dstFactor ?? 'zero'],
        alphaOp: OPERATION[b?.alpha.operation ?? 'add'],
        alphaSrc: FACTOR[b?.alpha.srcFactor ?? 'one'],
        alphaDst: FACTOR[b?.alpha.dstFactor ?? 'zero'],
      }
    })
    this.masks = targets.map((t) => t?.writeMask ?? 0xf)
    const same = (a: BlendState, b: BlendState) =>
      a.enabled === b.enabled &&
      a.colorOp === b.colorOp &&
      a.colorSrc === b.colorSrc &&
      a.colorDst === b.colorDst &&
      a.alphaOp === b.alphaOp &&
      a.alphaSrc === b.alphaSrc &&
      a.alphaDst === b.alphaDst
    this.uniformTargets = this.blends.every(
      (b, i) => same(b, this.blends[0]!) && this.masks[i] === this.masks[0],
    )
  }

  /** Translates both stages and links the program. Throws what naga or the driver reports. */
  build(
    translate: (code: string, entry: string, stage: 'vertex' | 'fragment') => GlslTranslation,
  ): WebGLProgram {
    const d = this.descriptor
    const gl = this.device.gl
    const vsModule = d.vertex.module as unknown as Webgl2ShaderModule
    const vsEntry = d.vertex.entryPoint ?? entryOf(vsModule.code, 'vertex')
    const v = translate(vsModule.code, vsEntry, 'vertex')
    let f: GlslTranslation | undefined
    if (d.fragment) {
      const fsModule = d.fragment.module as unknown as Webgl2ShaderModule
      f = translate(
        fsModule.code,
        d.fragment.entryPoint ?? entryOf(fsModule.code, 'fragment'),
        'fragment',
      )
    }
    const program = gl.createProgram()!
    const shader = (type: number, source: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, source)
      gl.compileShader(s)
      gl.attachShader(program, s)
      return s
    }
    const vsShader = shader(GL.VERTEX_SHADER, v.glsl)
    const fsShader = shader(GL.FRAGMENT_SHADER, f?.glsl ?? EMPTY_FRAGMENT)
    gl.linkProgram(program)
    this.program = program
    this.link = { vs: vsShader, fs: fsShader, v, f }
    return program
  }

  /** The shaders and translations of a program still linking. */
  private link:
    | { vs: WebGLShader; fs: WebGLShader; v: GlslTranslation; f: GlslTranslation | undefined }
    | undefined

  /** Whether the driver has finished linking (KHR_parallel_shader_compile), or can't say. */
  linked(): boolean {
    if (!this.device.caps.parallelCompile || !this.program) return true
    return this.device.gl.getProgramParameter(this.program, GL.COMPLETION_STATUS_KHR) as boolean
  }

  /** After linking: the status, and the binding points and units from the reflection. */
  finish(): void {
    const gl = this.device.gl
    const program = this.program!
    const link = this.link!
    this.link = undefined
    if (!gl.getProgramParameter(program, GL.LINK_STATUS)) {
      const log = [
        gl.getShaderInfoLog(link.vs),
        gl.getShaderInfoLog(link.fs),
        gl.getProgramInfoLog(program),
      ]
        .filter(Boolean)
        .join('\n')
      gl.deleteProgram(program)
      this.program = null
      throw new Error(`GLSL for "${this.label}" didn't link: ${log}`)
    }
    gl.deleteShader(link.vs)
    gl.deleteShader(link.fs)
    // Uniform blocks: a binding point per (group, binding). naga names a block per stage, so the
    // vertex and fragment blocks of one binding share a point.
    const points = new Map<string, number>()
    for (const u of [...link.v.uniforms, ...(link.f?.uniforms ?? [])]) {
      const index = gl.getUniformBlockIndex(program, u.name)
      if (index === 0xffffffff) continue // optimized out
      const key = `${u.group}:${u.binding}`
      let point = points.get(key)
      if (point === undefined) {
        point = points.size
        points.set(key, point)
        this.blocks.push({ group: u.group, binding: u.binding, point })
      }
      gl.uniformBlockBinding(program, index, point)
    }
    // Combined samplers: a texture unit per (texture, sampler) pair, shared by both stages.
    gl.useProgram(program)
    const units = new Map<string, number>()
    for (const t of [...link.v.textures, ...(link.f?.textures ?? [])]) {
      const location = gl.getUniformLocation(program, t.name)
      if (!location) continue
      const key = `${t.group}:${t.binding}:${t.sampler ? t.sampler.join(':') : '-'}`
      let unit = units.get(key)
      if (unit === undefined) {
        unit = units.size
        units.set(key, unit)
        this.samplers.push({
          unit,
          group: t.group,
          binding: t.binding,
          samplerGroup: t.sampler ? t.sampler[0] : -1,
          samplerBinding: t.sampler ? t.sampler[1] : -1,
        })
      }
      gl.uniform1i(location, unit)
    }
    // The last unit is the shim's own, for uploads.
    if (units.size > this.device.caps.combinedUnits - 1) {
      throw new Error(
        `"${this.label}" samples ${units.size} textures; this device binds ${this.device.caps.combinedUnits - 1}`,
      )
    }
    this.firstInstance = link.v.firstInstance
      ? gl.getUniformLocation(program, 'naga_vs_first_instance')
      : null
    this.device.state.forgetProgram()
  }

  getBindGroupLayout(index: number): unknown {
    return this.layout.groups[index]
  }
}

/** The one entry point of a stage when the descriptor names none. */
function entryOf(code: string, stage: 'vertex' | 'fragment'): string {
  const m = new RegExp(`@${stage}\\s+fn\\s+([A-Za-z_]\\w*)`).exec(code)
  if (!m) throw new Error(`No @${stage} entry point`)
  return m[1]!
}
