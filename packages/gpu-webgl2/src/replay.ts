import type { Webgl2BindGroup } from './binding'
import { type CommandStream, layerOf, mipSize, OP } from './commands'
import { TextureUsage } from './constants'
import type { Webgl2Device } from './device'
import { Attachments } from './fbo'
import { GL } from './gl'
import type { Webgl2RenderPipeline } from './pipeline'
import type { Webgl2QuerySet } from './queries'
import { type Webgl2Buffer, Webgl2Texture, type Webgl2TextureView } from './resources'

// Runs recorded commands on the GL context (decision 7 of 0064):
//
// - A pass binds a framebuffer for its attachments, clears what loads with 'clear' (masks open,
//   scissor off), and starts with a full viewport. At its end, multisampled attachments resolve
//   into their resolve targets with a blit, and 'discard' attachments are invalidated.
// - A draw binds what changed: the pipeline's program and state, uniform blocks at their binding
//   points, textures and samplers on their units (each view's mip range as the texture's base and
//   max level), and vertex attributes. WebGL2 has no base vertex or base instance: both move the
//   attribute pointers, and `naga_vs_first_instance` gives the shader its instance index.
// - uint16 index buffers holding 65535 draw from a uint32 copy: WebGL2 always restarts strips at
//   the maximum index, which WebGPU's list topologies don't.
// - A texture sampled while it's the pass's read-only depth attachment (a feedback loop to WebGL)
//   is sampled from a copy made once per pass.

export class Replayer {
  private readonly device: Webgl2Device
  private readonly gl: WebGL2RenderingContext
  private readonly vao: WebGLVertexArrayObject | null
  private readonly attachments = new Attachments()
  private readonly single = new Attachments()
  private stream: CommandStream | undefined
  private i = 0
  private r = 0
  /** The query set timing the pass being replayed. */
  private timed: Webgl2QuerySet | undefined

  // The pass.
  private passFbo: WebGLFramebuffer | null = null
  private passWidth = 0
  private passHeight = 0
  private colorCount = 0
  private readonly colors: (Webgl2TextureView | null)[] = []
  private readonly resolves: (Webgl2TextureView | null)[] = []
  private readonly colorLayers: number[] = []
  private readonly colorDiscard: boolean[] = []
  private depthView: Webgl2TextureView | null = null
  private depthDiscard = false
  private stencilDiscard = false
  private depthReadOnly = false
  private depthCopied = false
  private readonly scratchDepth = new Map<Webgl2Texture, Webgl2Texture>()
  private readonly discards: number[] = []
  private readonly clearFloat = new Float32Array(4)
  private readonly clearUint = new Uint32Array(4)
  private readonly clearInt = new Int32Array(4)

  // Bindings.
  private pipeline: Webgl2RenderPipeline | null = null
  private readonly groups: (Webgl2BindGroup | null)[] = [null, null, null, null]
  private readonly offsets: number[][] = [[], [], [], []]
  private bindingsDirty = true
  private readonly vertexBuffers: (Webgl2Buffer | null)[] = []
  private readonly vertexOffsets: number[] = []
  private attributesDirty = true
  private attributePipeline: Webgl2RenderPipeline | null = null
  private baseVertex = 0
  private firstInstance = 0
  private indexBuffer: Webgl2Buffer | null = null
  private indexBytes = 2
  private indexOffset = 0
  private stencilReference = 0

  // Vertex attribute state, by location.
  private readonly attribBuffer: (WebGLBuffer | null)[] = []
  private readonly attribOffset: number[] = []
  private readonly attribStride: number[] = []
  private readonly attribFormat: number[] = []
  private readonly attribDivisor: number[] = []
  private readonly attribEnabled: boolean[] = []
  private readonly attribStamp: number[] = []
  private stamp = 0
  private element: WebGLBuffer | null = null

  constructor(device: Webgl2Device) {
    this.device = device
    this.gl = device.gl
    this.vao = this.gl.createVertexArray()
  }

  /** Forgets cached bindings: after a context loss, or when GL state was changed elsewhere. */
  reset(): void {
    this.attribBuffer.length = 0
    this.attribOffset.length = 0
    this.attribStride.length = 0
    this.attribFormat.length = 0
    this.attribDivisor.length = 0
    this.attribEnabled.length = 0
    this.attribStamp.length = 0
    this.element = null
  }

  /** Drops the depth copies made for `texture`. */
  forget(texture: Webgl2Texture): void {
    const copy = this.scratchDepth.get(texture)
    if (copy) {
      copy.destroy()
      this.scratchDepth.delete(texture)
    }
  }

  run(stream: CommandStream): void {
    this.stream = stream
    this.i = 0
    this.r = 0
    const nums = stream.nums
    const n = stream.n
    try {
      while (this.i < n) {
        const op = nums[this.i++]!
        switch (op) {
          case OP.BEGIN_PASS:
            this.beginPass()
            break
          case OP.END_PASS:
            this.endPass()
            break
          case OP.SET_PIPELINE:
            this.pipeline = this.ref() as Webgl2RenderPipeline
            this.bindingsDirty = true
            this.attributesDirty = true
            break
          case OP.SET_BIND_GROUP: {
            const index = this.num()
            const count = this.num()
            const offsets = this.offsets[index]!
            offsets.length = count
            for (let k = 0; k < count; k++) offsets[k] = this.num()
            this.groups[index] = this.ref() as Webgl2BindGroup | null
            this.bindingsDirty = true
            break
          }
          case OP.SET_VERTEX_BUFFER: {
            const slot = this.num()
            this.vertexOffsets[slot] = this.num()
            this.num()
            this.vertexBuffers[slot] = this.ref() as Webgl2Buffer | null
            this.attributesDirty = true
            break
          }
          case OP.SET_INDEX_BUFFER:
            this.indexBytes = this.num()
            this.indexOffset = this.num()
            this.num()
            this.indexBuffer = this.ref() as Webgl2Buffer
            break
          case OP.DRAW:
            this.draw()
            break
          case OP.DRAW_INDEXED:
            this.drawIndexed()
            break
          case OP.VIEWPORT: {
            const x = this.num()
            const y = this.num()
            const w = this.num()
            const h = this.num()
            this.gl.viewport(x, y, w, h)
            this.gl.depthRange(this.num(), this.num())
            break
          }
          case OP.SCISSOR: {
            const x = this.num()
            const y = this.num()
            const w = this.num()
            const h = this.num()
            this.device.state.enable(GL.SCISSOR_TEST, true)
            this.gl.scissor(x, y, w, h)
            break
          }
          case OP.STENCIL_REFERENCE:
            this.stencilReference = this.num()
            break
          case OP.BLEND_CONSTANT:
            this.gl.blendColor(this.num(), this.num(), this.num(), this.num())
            break
          case OP.COPY_BUFFER: {
            const so = this.num()
            const dO = this.num()
            const size = this.num()
            const src = this.ref() as Webgl2Buffer
            const dst = this.ref() as Webgl2Buffer
            this.device.copier.copyBuffer(src, so, dst, dO, size)
            break
          }
          case OP.COPY_BUFFER_TO_TEXTURE: {
            const offset = this.num()
            const bytesPerRow = this.num()
            const rowsPerImage = this.num()
            const mip = this.num()
            const x = this.num()
            const y = this.num()
            const z = this.num()
            const w = this.num()
            const h = this.num()
            const d = this.num()
            const buffer = this.ref() as Webgl2Buffer
            const texture = this.ref() as Webgl2Texture
            this.device.copier.copyBufferToTexture(
              buffer,
              offset,
              bytesPerRow,
              rowsPerImage,
              texture,
              mip,
              x,
              y,
              z,
              w,
              h,
              d,
            )
            break
          }
          case OP.COPY_TEXTURE_TO_BUFFER: {
            const mip = this.num()
            const x = this.num()
            const y = this.num()
            const z = this.num()
            const offset = this.num()
            const bytesPerRow = this.num()
            const rowsPerImage = this.num()
            const w = this.num()
            const h = this.num()
            const d = this.num()
            const texture = this.ref() as Webgl2Texture
            const buffer = this.ref() as Webgl2Buffer
            this.device.copier.copyTextureToBuffer(
              texture,
              mip,
              x,
              y,
              z,
              buffer,
              offset,
              bytesPerRow,
              rowsPerImage,
              w,
              h,
              d,
            )
            break
          }
          case OP.COPY_TEXTURE: {
            const sm = this.num()
            const sx = this.num()
            const sy = this.num()
            const sz = this.num()
            const dm = this.num()
            const dx = this.num()
            const dy = this.num()
            const dz = this.num()
            const w = this.num()
            const h = this.num()
            const d = this.num()
            const src = this.ref() as Webgl2Texture
            const dst = this.ref() as Webgl2Texture
            this.device.copier.copyTexture(src, sm, sx, sy, sz, dst, dm, dx, dy, dz, w, h, d)
            break
          }
          case OP.CLEAR_BUFFER: {
            const offset = this.num()
            const size = this.num()
            this.device.copier.clearBuffer(this.ref() as Webgl2Buffer, offset, size)
            break
          }
          case OP.BEGIN_QUERY: {
            const pair = this.num()
            const set = this.ref() as Webgl2QuerySet
            set.begin(pair)
            this.timed = set
            break
          }
          case OP.END_QUERY:
            this.timed?.end()
            this.timed = undefined
            break
          case OP.RESOLVE_QUERIES: {
            const first = this.num()
            const count = this.num()
            const offset = this.num()
            const set = this.ref() as Webgl2QuerySet
            set.resolve(first, count, this.ref() as Webgl2Buffer, offset)
            break
          }
          default:
            throw new Error(`Unknown recorded command ${op}`)
        }
      }
    } finally {
      this.stream = undefined
      this.clearBindings()
    }
  }

  private num(): number {
    return this.stream!.nums[this.i++]!
  }

  private ref(): unknown {
    return this.stream!.refs[this.r++]
  }

  private clearBindings(): void {
    this.pipeline = null
    for (let g = 0; g < 4; g++) this.groups[g] = null
    for (let s = 0; s < this.vertexBuffers.length; s++) this.vertexBuffers[s] = null
    this.indexBuffer = null
    for (let c = 0; c < this.colorCount; c++) {
      this.colors[c] = null
      this.resolves[c] = null
    }
    this.depthView = null
    this.bindingsDirty = true
    this.attributesDirty = true
  }

  // --- passes ----------------------------------------------------------------------

  private beginPass(): void {
    const gl = this.gl
    const state = this.device.state
    const a = this.attachments
    a.reset()
    const count = this.num()
    this.colorCount = count
    let width = 0
    let height = 0
    let clears = 0
    for (let c = 0; c < count; c++) {
      if (this.num() === 0) {
        this.colors[c] = null
        this.resolves[c] = null
        a.color(c, null, 0, 0)
        continue
      }
      const view = this.ref() as Webgl2TextureView
      const resolve = this.ref() as Webgl2TextureView | null
      const clear = this.num() === 1
      this.colorDiscard[c] = this.num() === 1
      const layer = layerOf(view, this.num())
      this.colors[c] = view
      this.resolves[c] = resolve
      this.colorLayers[c] = layer
      a.color(c, view.texture, view.baseMipLevel, layer)
      width = mipSize(view.texture.width, view.baseMipLevel)
      height = mipSize(view.texture.height, view.baseMipLevel)
      const r = this.num()
      const g = this.num()
      const b = this.num()
      const al = this.num()
      if (clear) clears |= 1 << c
      // Cleared once the framebuffer is bound.
      this.pending[c * 4] = r
      this.pending[c * 4 + 1] = g
      this.pending[c * 4 + 2] = b
      this.pending[c * 4 + 3] = al
    }
    let depthClear = false
    let stencilClear = false
    let depthValue = 0
    let stencilValue = 0
    if (this.num() === 1) {
      const view = this.ref() as Webgl2TextureView
      depthClear = this.num() === 1
      this.depthDiscard = this.num() === 1
      depthValue = this.num()
      this.depthReadOnly = this.num() === 1
      stencilClear = this.num() === 1
      this.stencilDiscard = this.num() === 1
      stencilValue = this.num()
      this.num()
      this.depthView = view
      a.setDepth(view.texture, view.baseMipLevel, view.baseArrayLayer)
      if (width === 0) {
        width = mipSize(view.texture.width, view.baseMipLevel)
        height = mipSize(view.texture.height, view.baseMipLevel)
      }
    } else {
      this.depthView = null
      this.depthReadOnly = false
    }
    this.depthCopied = false
    this.passWidth = width
    this.passHeight = height
    this.passFbo = this.device.fbos.get(a)
    gl.bindFramebuffer(GL.FRAMEBUFFER, this.passFbo)
    if (clears !== 0 || depthClear || stencilClear) {
      state.prepareClear()
      for (let c = 0; c < count; c++) {
        if ((clears & (1 << c)) === 0) continue
        const kind = this.colors[c]!.texture.info.kind
        const p = this.pending
        if (kind === 'uint') {
          const v = this.clearUint
          v[0] = p[c * 4]!
          v[1] = p[c * 4 + 1]!
          v[2] = p[c * 4 + 2]!
          v[3] = p[c * 4 + 3]!
          gl.clearBufferuiv(GL.COLOR, c, v)
        } else if (kind === 'sint') {
          const v = this.clearInt
          v[0] = p[c * 4]!
          v[1] = p[c * 4 + 1]!
          v[2] = p[c * 4 + 2]!
          v[3] = p[c * 4 + 3]!
          gl.clearBufferiv(GL.COLOR, c, v)
        } else {
          const v = this.clearFloat
          v[0] = p[c * 4]!
          v[1] = p[c * 4 + 1]!
          v[2] = p[c * 4 + 2]!
          v[3] = p[c * 4 + 3]!
          gl.clearBufferfv(GL.COLOR, c, v)
        }
      }
      const info = this.depthView?.texture.info
      if (info?.depth && info.stencil && depthClear && stencilClear) {
        gl.clearBufferfi(GL.DEPTH_STENCIL, 0, depthValue, stencilValue)
      } else {
        if (depthClear && info?.depth) {
          this.clearFloat[0] = depthValue
          gl.clearBufferfv(GL.DEPTH, 0, this.clearFloat)
        }
        if (stencilClear && info?.stencil) {
          this.clearInt[0] = stencilValue
          gl.clearBufferiv(GL.STENCIL, 0, this.clearInt)
        }
      }
    }
    gl.viewport(0, 0, width, height)
    gl.depthRange(0, 1)
    state.enable(GL.SCISSOR_TEST, false)
    this.stencilReference = 0
    this.bindingsDirty = true
    this.attributesDirty = true
  }

  private readonly pending: number[] = []

  private endPass(): void {
    const gl = this.gl
    const device = this.device
    const w = this.passWidth
    const h = this.passHeight
    let resolved = false
    for (let c = 0; c < this.colorCount; c++) {
      const target = this.resolves[c]
      if (!target) continue
      const s = this.single
      s.reset()
      s.color(0, target.texture, target.baseMipLevel, layerOf(target, -1))
      const to = device.fbos.get(s)
      gl.bindFramebuffer(GL.READ_FRAMEBUFFER, this.passFbo)
      gl.readBuffer(GL.COLOR_ATTACHMENT0 + c)
      gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, to)
      device.state.enable(GL.SCISSOR_TEST, false)
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, GL.COLOR_BUFFER_BIT, GL.NEAREST)
      device.touch(target.texture)
      resolved = true
    }
    if (resolved) gl.bindFramebuffer(GL.FRAMEBUFFER, this.passFbo)
    const discards = this.discards
    discards.length = 0
    for (let c = 0; c < this.colorCount; c++) {
      const view = this.colors[c]
      if (!view) continue
      if (this.colorDiscard[c]) discards.push(GL.COLOR_ATTACHMENT0 + c)
      else device.touch(view.texture)
    }
    const depth = this.depthView
    if (depth && !this.depthReadOnly) {
      const info = depth.texture.info
      if (info.depth && info.stencil && this.depthDiscard && this.stencilDiscard) {
        discards.push(GL.DEPTH_STENCIL_ATTACHMENT)
      } else if (info.depth && this.depthDiscard && !info.stencil) {
        discards.push(GL.DEPTH_ATTACHMENT)
      } else if (!info.depth && info.stencil && this.stencilDiscard) {
        discards.push(GL.STENCIL_ATTACHMENT)
      }
    }
    if (discards.length > 0) gl.invalidateFramebuffer(GL.FRAMEBUFFER, discards)
  }

  // --- draws ----------------------------------------------------------------------

  private draw(): void {
    const count = this.num()
    const instances = this.num()
    const first = this.num()
    const firstInstance = this.num()
    if (count === 0 || instances === 0) return
    const p = this.prepare(0, firstInstance)
    if (!p) return
    this.gl.drawArraysInstanced(p.topology, first, count, instances)
  }

  private drawIndexed(): void {
    const count = this.num()
    const instances = this.num()
    const firstIndex = this.num()
    const baseVertex = this.num()
    const firstInstance = this.num()
    if (count === 0 || instances === 0) return
    const p = this.pipeline
    if (p && baseVertex !== 0 && p.vertexIndex) {
      this.device.raise(
        'validation',
        `"${p.label}" reads vertex_index with a base vertex of ${baseVertex}: WebGL2 can't offset vertex_index`,
      )
      return
    }
    const ib = this.indexBuffer
    if (!p || !ib) return
    let buffer = ib.gl
    let type = this.indexBytes === 4 ? GL.UNSIGNED_INT : GL.UNSIGNED_SHORT
    let offset = this.indexOffset + firstIndex * this.indexBytes
    if (
      type === GL.UNSIGNED_SHORT &&
      p.topology !== GL.TRIANGLE_STRIP &&
      p.topology !== GL.LINE_STRIP
    ) {
      // Before binding the draw's vertex array: making the copy binds an element buffer outside it.
      const promoted = promote(this.device, ib)
      if (promoted) {
        buffer = promoted
        type = GL.UNSIGNED_INT
        offset *= 2
      }
    }
    if (!this.prepare(baseVertex, firstInstance)) return
    if (this.element !== buffer) {
      this.element = buffer
      this.gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, buffer)
    }
    this.gl.drawElementsInstanced(p.topology, count, type, offset, instances)
  }

  /** Binds what the draw needs. Undefined when there's nothing valid to draw with. */
  private prepare(baseVertex: number, firstInstance: number): Webgl2RenderPipeline | undefined {
    const p = this.pipeline
    if (!p?.program) return undefined
    const state = this.device.state
    state.applyPipeline(p)
    state.applyStencil(p, this.stencilReference)
    if (this.bindingsDirty) {
      if (!this.bind(p)) return undefined
      this.bindingsDirty = false
    }
    state.bindVertexArray(this.vao)
    if (
      this.attributesDirty ||
      this.attributePipeline !== p ||
      this.baseVertex !== baseVertex ||
      this.firstInstance !== firstInstance
    ) {
      this.attributes(p, baseVertex, firstInstance)
    }
    if (p.firstInstance && p.firstInstanceValue !== firstInstance) {
      p.firstInstanceValue = firstInstance
      this.gl.uniform1ui(p.firstInstance, firstInstance)
    }
    return p
  }

  /** Uniform blocks and textures from the bound groups. False if a group the pipeline reads is missing. */
  private bind(p: Webgl2RenderPipeline): boolean {
    const device = this.device
    const state = device.state
    const blocks = p.blocks
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i]!
      const group = this.groups[b.group]
      const bound = group?.buffers[b.binding]
      if (!group || !bound) {
        device.raise(
          'validation',
          `"${p.label}" draws without bind group ${b.group} binding ${b.binding}`,
        )
        return false
      }
      let offset = bound.offset
      const dynamic = group.dynamic
      for (let k = 0; k < dynamic.length; k++) {
        if (dynamic[k] === b.binding) {
          offset += this.offsets[b.group]![k] ?? 0
          break
        }
      }
      // At least the GLSL block's size (std140 rounds it up), within what the buffer holds.
      const size = Math.min(Math.max(bound.size, b.size), bound.buffer.allocated - offset)
      state.bindUniformBuffer(b.point, bound.buffer.gl, offset, size)
    }
    const samplers = p.samplers
    for (let i = 0; i < samplers.length; i++) {
      const s = samplers[i]!
      const group = this.groups[s.group]
      const view = group?.views[s.binding]
      if (!group || !view) {
        device.raise(
          'validation',
          `"${p.label}" draws without bind group ${s.group} binding ${s.binding}`,
        )
        return false
      }
      let texture = view.texture
      if (this.depthReadOnly && this.depthView?.texture === texture)
        texture = this.depthCopy(texture)
      state.bindUnit(s.unit, texture.target, texture.gl)
      device.levels(texture, view.baseMipLevel, view.baseMipLevel + view.mipLevelCount - 1)
      const sampler =
        s.samplerGroup >= 0 ? this.groups[s.samplerGroup]?.samplers[s.samplerBinding] : undefined
      state.bindSampler(s.unit, sampler ? sampler.gl : null)
    }
    return true
  }

  /** A copy of the read-only depth attachment for sampling, refreshed once per pass. */
  private depthCopy(texture: Webgl2Texture): Webgl2Texture {
    let copy = this.scratchDepth.get(texture)
    if (!copy) {
      copy = new Webgl2Texture(this.device, {
        label: `${texture.label} (sampled copy)`,
        size: [texture.width, texture.height],
        format: texture.format,
        usage: TextureUsage.TEXTURE_BINDING | TextureUsage.RENDER_ATTACHMENT,
      })
      this.scratchDepth.set(texture, copy)
    }
    if (!this.depthCopied) {
      const gl = this.gl
      const s = this.single
      s.reset()
      s.setDepth(copy, 0, 0)
      const to = this.device.fbos.get(s)
      gl.bindFramebuffer(GL.READ_FRAMEBUFFER, this.passFbo)
      gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, to)
      this.device.state.enable(GL.SCISSOR_TEST, false)
      const w = texture.width
      const h = texture.height
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, GL.DEPTH_BUFFER_BIT, GL.NEAREST)
      gl.bindFramebuffer(GL.FRAMEBUFFER, this.passFbo)
      this.depthCopied = true
    }
    return copy
  }

  /** Points each attribute of `p` at its buffer, moved by the base vertex or first instance. */
  private attributes(p: Webgl2RenderPipeline, baseVertex: number, firstInstance: number): void {
    const gl = this.gl
    const stamp = ++this.stamp
    const layouts = p.vertexBuffers
    let bound: WebGLBuffer | null | undefined
    for (let slot = 0; slot < layouts.length; slot++) {
      const layout = layouts[slot]!
      const buffer = this.vertexBuffers[slot]
      if (!buffer) continue
      const base =
        (this.vertexOffsets[slot] ?? 0) +
        (layout.instanced ? firstInstance : baseVertex) * layout.stride
      const attributes = layout.attributes
      for (let k = 0; k < attributes.length; k++) {
        const a = attributes[k]!
        const loc = a.location
        this.attribStamp[loc] = stamp
        if (!this.attribEnabled[loc]) {
          gl.enableVertexAttribArray(loc)
          this.attribEnabled[loc] = true
        }
        const offset = base + a.offset
        const format =
          a.size | (a.type << 3) | (a.normalized ? 1 << 20 : 0) | (a.integer ? 1 << 21 : 0)
        if (
          this.attribBuffer[loc] !== buffer.gl ||
          this.attribOffset[loc] !== offset ||
          this.attribStride[loc] !== layout.stride ||
          this.attribFormat[loc] !== format
        ) {
          if (bound !== buffer.gl) {
            gl.bindBuffer(GL.ARRAY_BUFFER, buffer.gl)
            bound = buffer.gl
          }
          if (a.integer) gl.vertexAttribIPointer(loc, a.size, a.type, layout.stride, offset)
          else gl.vertexAttribPointer(loc, a.size, a.type, a.normalized, layout.stride, offset)
          this.attribBuffer[loc] = buffer.gl
          this.attribOffset[loc] = offset
          this.attribStride[loc] = layout.stride
          this.attribFormat[loc] = format
        }
        const divisor = layout.instanced ? 1 : 0
        if (this.attribDivisor[loc] !== divisor) {
          gl.vertexAttribDivisor(loc, divisor)
          this.attribDivisor[loc] = divisor
        }
      }
    }
    for (let loc = 0; loc < this.attribEnabled.length; loc++) {
      if (this.attribEnabled[loc] && this.attribStamp[loc] !== stamp) {
        gl.disableVertexAttribArray(loc)
        this.attribEnabled[loc] = false
      }
    }
    this.attributesDirty = false
    this.attributePipeline = p
    this.baseVertex = baseVertex
    this.firstInstance = firstInstance
  }
}

/**
 * The uint32 copy of a uint16 index buffer that holds 65535, made from its CPU copy when its
 * contents change. Null when the buffer has no 65535 (it draws as it is).
 */
function promote(device: Webgl2Device, buffer: Webgl2Buffer): WebGLBuffer | null {
  if (buffer.restartVersion !== buffer.version) {
    buffer.restartVersion = buffer.version
    const shadow = buffer.shadow!
    const indices = new Uint16Array(shadow.buffer, shadow.byteOffset, shadow.byteLength >> 1)
    buffer.restart = indices.includes(0xffff)
    if (buffer.restart) {
      const gl = device.gl
      const wide = new Uint32Array(indices)
      device.state.bindVertexArray(null)
      const target = buffer.promoted ?? gl.createBuffer()
      gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, target)
      gl.bufferData(GL.ELEMENT_ARRAY_BUFFER, wide, GL.STATIC_DRAW)
      gl.bindBuffer(GL.ELEMENT_ARRAY_BUFFER, null)
      buffer.promoted = target
    }
  }
  return buffer.restart ? buffer.promoted! : null
}
