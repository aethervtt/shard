import { GL } from './gl'
import type { Webgl2RenderPipeline } from './pipeline'

// What the GL context has bound and enabled, so replaying commands only makes the calls that change
// something. Everything that binds in the shim goes through here, so the cache stays true.

export class GlState {
  private readonly gl: WebGL2RenderingContext
  private program: WebGLProgram | null = null
  private vao: WebGLVertexArrayObject | null | undefined = undefined
  private activeUnit = -1
  private readonly textures: (WebGLTexture | null)[] = []
  private readonly targets: number[] = []
  private readonly samplers: (WebGLSampler | null)[] = []
  private readonly ubo: (WebGLBuffer | null)[] = []
  private readonly uboOffset: number[] = []
  private readonly uboSize: number[] = []
  private readonly enabled = new Map<number, boolean>()
  private pipeline: Webgl2RenderPipeline | undefined
  private stencilRef = -1
  /** OES_draw_buffers_indexed: per-target blending, for pipelines whose targets differ. */
  private readonly indexed: OES_draw_buffers_indexed | null

  constructor(gl: WebGL2RenderingContext, indexed: OES_draw_buffers_indexed | null) {
    this.gl = gl
    this.indexed = indexed
  }

  /** After a context loss or anything outside the cache touched the context. */
  reset(): void {
    this.program = null
    this.vao = undefined
    this.activeUnit = -1
    this.textures.length = 0
    this.targets.length = 0
    this.samplers.length = 0
    this.ubo.length = 0
    this.uboOffset.length = 0
    this.uboSize.length = 0
    this.enabled.clear()
    this.pipeline = undefined
    this.stencilRef = -1
  }

  forgetProgram(): void {
    this.program = null
    this.pipeline = undefined
  }

  useProgram(program: WebGLProgram | null): void {
    if (this.program === program) return
    this.program = program
    this.gl.useProgram(program)
  }

  bindVertexArray(vao: WebGLVertexArrayObject | null): void {
    if (this.vao === vao) return
    this.vao = vao
    this.gl.bindVertexArray(vao)
  }

  /** The unit uploads and parameter changes bind on. Draws bind their own units over it. */
  scratchUnit = 15

  /** Binds on the scratch unit, for uploads and parameters. */
  bindTexture(target: number, texture: WebGLTexture | null): void {
    this.bindUnit(this.scratchUnit, target, texture)
  }

  /** Binds `texture` on `unit` and leaves that unit active (texture parameters apply to it). */
  bindUnit(unit: number, target: number, texture: WebGLTexture | null): void {
    this.activate(unit)
    if (this.textures[unit] === texture && this.targets[unit] === target) return
    // A unit holds one texture per target: clear the one it had on another.
    const old = this.targets[unit]
    if (old !== undefined && old !== target && this.textures[unit]) this.gl.bindTexture(old, null)
    this.gl.bindTexture(target, texture)
    this.textures[unit] = texture
    this.targets[unit] = target
  }

  activate(unit: number): void {
    if (this.activeUnit === unit) return
    this.activeUnit = unit
    this.gl.activeTexture(GL.TEXTURE0 + unit)
  }

  /** Forgets a deleted texture wherever it's bound. */
  forgetTexture(texture: WebGLTexture | null): void {
    for (let i = 0; i < this.textures.length; i++)
      if (this.textures[i] === texture) this.textures[i] = null
  }

  bindSampler(unit: number, sampler: WebGLSampler | null): void {
    if (this.samplers[unit] === sampler) return
    this.samplers[unit] = sampler
    this.gl.bindSampler(unit, sampler)
  }

  bindUniformBuffer(point: number, buffer: WebGLBuffer | null, offset: number, size: number): void {
    if (
      this.ubo[point] === buffer &&
      this.uboOffset[point] === offset &&
      this.uboSize[point] === size
    )
      return
    this.ubo[point] = buffer
    this.uboOffset[point] = offset
    this.uboSize[point] = size
    this.gl.bindBufferRange(GL.UNIFORM_BUFFER, point, buffer, offset, size)
  }

  forgetBuffer(buffer: WebGLBuffer | null): void {
    for (let i = 0; i < this.ubo.length; i++) if (this.ubo[i] === buffer) this.ubo[i] = null
  }

  enable(cap: number, on: boolean): void {
    if (this.enabled.get(cap) === on) return
    this.enabled.set(cap, on)
    if (on) this.gl.enable(cap)
    else this.gl.disable(cap)
  }

  /** A pipeline's fixed-function state: only what differs from the last pipeline's. */
  applyPipeline(p: Webgl2RenderPipeline): void {
    this.useProgram(p.program)
    const last = this.pipeline
    if (last === p) return
    this.pipeline = p
    const gl = this.gl
    this.enable(GL.CULL_FACE, p.cull !== 0)
    if (p.cull !== 0 && (!last || last.cull !== p.cull)) gl.cullFace(p.cull)
    if (!last || last.frontFace !== p.frontFace) gl.frontFace(p.frontFace)
    this.enable(GL.DEPTH_TEST, p.depthTest)
    if (p.depthTest) {
      gl.depthFunc(p.depthFunc)
      gl.depthMask(p.depthWrite)
    }
    const bias = p.depthBias !== 0 || p.depthSlope !== 0
    this.enable(GL.POLYGON_OFFSET_FILL, bias)
    if (bias) gl.polygonOffset(p.depthSlope, p.depthBias)
    this.enable(GL.STENCIL_TEST, p.stencil)
    if (p.stencil) {
      gl.stencilOpSeparate(GL.FRONT, p.stencilFront[1], p.stencilFront[2], p.stencilFront[3])
      gl.stencilOpSeparate(GL.BACK, p.stencilBack[1], p.stencilBack[2], p.stencilBack[3])
      gl.stencilMask(p.stencilWriteMask)
      this.stencilRef = -1 // the functions take the reference: set with it
    }
    const x = this.indexed
    if (p.uniformTargets || !x) {
      // Without the extension, every target blends as the first does.
      const blend = p.blends[0]
      this.enable(GL.BLEND, blend?.enabled === true)
      if (blend?.enabled) {
        gl.blendEquationSeparate(blend.colorOp, blend.alphaOp)
        gl.blendFuncSeparate(blend.colorSrc, blend.colorDst, blend.alphaSrc, blend.alphaDst)
      }
      const m = p.masks[0] ?? 0xf
      gl.colorMask((m & 1) !== 0, (m & 2) !== 0, (m & 4) !== 0, (m & 8) !== 0)
      return
    }
    this.enabled.delete(GL.BLEND)
    for (let i = 0; i < p.blends.length; i++) {
      const b = p.blends[i]!
      if (b.enabled) {
        x.enableiOES(GL.BLEND, i)
        x.blendEquationSeparateiOES(i, b.colorOp, b.alphaOp)
        x.blendFuncSeparateiOES(i, b.colorSrc, b.colorDst, b.alphaSrc, b.alphaDst)
      } else {
        x.disableiOES(GL.BLEND, i)
      }
      const m = p.masks[i]!
      x.colorMaskiOES(i, (m & 1) !== 0, (m & 2) !== 0, (m & 4) !== 0, (m & 8) !== 0)
    }
  }

  /** The stencil reference, for the pipeline's compare functions. */
  applyStencil(p: Webgl2RenderPipeline, reference: number): void {
    if (!p.stencil || this.stencilRef === reference) return
    this.stencilRef = reference
    this.gl.stencilFuncSeparate(GL.FRONT, p.stencilFront[0], reference, p.stencilReadMask)
    this.gl.stencilFuncSeparate(GL.BACK, p.stencilBack[0], reference, p.stencilReadMask)
  }

  /** Clears ignore masks and the scissor in GL: open them, and let the next pipeline set them. */
  prepareClear(): void {
    const gl = this.gl
    this.enable(GL.SCISSOR_TEST, false)
    gl.colorMask(true, true, true, true)
    gl.depthMask(true)
    gl.stencilMask(0xff)
    this.pipeline = undefined
  }
}
