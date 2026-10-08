import { BufferUsage, TextureUsage } from './constants'
import type { Webgl2Device } from './device'
import { unsupported } from './errors'
import { Attachments } from './fbo'
import type { GlFormat } from './formats'
import { GL } from './gl'
import { type ReadFormat, readFormatOf, repack } from './readback'
import { type Webgl2Buffer, Webgl2Texture } from './resources'

// Uploads, copies and readbacks. Queue writes run at once; encoder copies run when their command
// buffer is replayed. Texture-to-buffer copies read with readPixels into a pack buffer on the GPU;
// a format whose WebGPU bytes differ from what readPixels returns is repacked on the CPU when the
// destination is mapped (MAP_READ buffers are only ever mapped, never copied from).

/** A texture read waiting for its buffer to be mapped: where it landed and how to repack it. */
export interface ReadJob {
  pack: WebGLBuffer | null
  packSize: number
  read: ReadFormat
  info: GlFormat
  width: number
  rows: number
  layers: number
  offset: number
  bytesPerRow: number
  rowsPerImage: number
}

type TypedArrayConstructor =
  | Uint8ArrayConstructor
  | Int8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int32ArrayConstructor
  | Float32ArrayConstructor

function arrayFor(type: number): TypedArrayConstructor {
  switch (type) {
    case GL.UNSIGNED_BYTE:
      return Uint8Array
    case GL.BYTE:
      return Int8Array
    case GL.UNSIGNED_SHORT:
    case GL.HALF_FLOAT:
      return Uint16Array
    case GL.INT:
      return Int32Array
    case GL.FLOAT:
      return Float32Array
    default:
      return Uint32Array
  }
}

const DEPTH_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const depthFs = (array: boolean) => `#version 300 es
precision highp float;
precision highp int;
uniform highp ${array ? 'sampler2DArray' : 'sampler2D'} depth_texture;
uniform ivec3 origin;
uniform int level;
out vec4 color;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + origin.xy;
  color = vec4(texelFetch(depth_texture, ${array ? 'ivec3(p, origin.z)' : 'p'}, level).r, 0.0, 0.0, 1.0);
}
`

interface DepthProgram {
  program: WebGLProgram | null
  origin: WebGLUniformLocation | null
  level: WebGLUniformLocation | null
  texture: WebGLUniformLocation | null
}

export class Copier {
  private readonly device: Webgl2Device
  private readonly gl: WebGL2RenderingContext
  private readonly read = new Attachments()
  private readonly draw = new Attachments()
  private rowLength = 0
  private imageHeight = 0
  private readonly views = new Map<TypedArrayConstructor, ArrayBufferView>()
  private viewOffset = 0
  private zeros = new Uint8Array(0)
  private readonly packs: { gl: WebGLBuffer | null; size: number }[] = []
  private depthPrograms: [DepthProgram | undefined, DepthProgram | undefined] = [
    undefined,
    undefined,
  ]
  private depthTarget: Webgl2Texture | undefined

  constructor(device: Webgl2Device) {
    this.device = device
    this.gl = device.gl
  }

  // --- queue writes -----------------------------------------------------------------

  writeTexture(
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    z: number,
    data: BufferSource,
    offset: number,
    bytesPerRow: number | undefined,
    rowsPerImage: number | undefined,
    width: number,
    height: number,
    depth: number,
  ): void {
    if (!texture.gl) throw unsupported(`write into "${texture.label}" (it's only an attachment)`)
    const gl = this.gl
    const info = texture.info
    const buffer = ArrayBuffer.isView(data) ? data.buffer : data
    const base = (ArrayBuffer.isView(data) ? data.byteOffset : 0) + offset
    this.device.state.bindTexture(texture.target, texture.gl)
    if (info.compressed) {
      const blocksWide = Math.ceil(width / 4)
      const blocksHigh = Math.ceil(height / 4)
      const tight = blocksWide * info.bytes
      const stride = bytesPerRow ?? tight
      const image = (rowsPerImage ?? height) / 4
      for (let layer = 0; layer < depth; layer++) {
        const start = base + layer * image * stride
        if (stride === tight) {
          this.compressed(
            texture,
            mip,
            x,
            y,
            z + layer,
            width,
            height,
            new Uint8Array(buffer, start, tight * blocksHigh),
          )
        } else {
          for (let row = 0; row < blocksHigh; row++) {
            const h = Math.min(4, height - row * 4)
            this.compressed(
              texture,
              mip,
              x,
              y + row * 4,
              z + layer,
              width,
              h,
              new Uint8Array(buffer, start + row * stride, tight),
            )
          }
        }
      }
      return
    }
    const rowBytes = bytesPerRow ?? width * info.bytes
    if (rowBytes % info.bytes !== 0) {
      // Rows that aren't a whole number of texels apart: a row at a time.
      for (let layer = 0; layer < depth; layer++) {
        for (let row = 0; row < height; row++) {
          const start = base + (layer * (rowsPerImage ?? height) + row) * rowBytes
          const bytes = new Uint8Array(buffer, start, width * info.bytes).slice()
          this.writeTexture(
            texture,
            mip,
            x,
            y + row,
            z + layer,
            bytes,
            0,
            undefined,
            undefined,
            width,
            1,
            1,
          )
        }
      }
      return
    }
    const view = this.view(info.type, buffer, base)
    const rows = rowsPerImage ?? height
    this.unpack(rowBytes / info.bytes, rows)
    const at = this.viewOffset
    if (texture.target === GL.TEXTURE_2D) {
      gl.texSubImage2D(GL.TEXTURE_2D, mip, x, y, width, height, info.format, info.type, view, at)
    } else if (texture.target === GL.TEXTURE_CUBE_MAP) {
      const step = (rows * rowBytes) / (view as Uint8Array).BYTES_PER_ELEMENT
      for (let layer = 0; layer < depth; layer++) {
        gl.texSubImage2D(
          GL.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer,
          mip,
          x,
          y,
          width,
          height,
          info.format,
          info.type,
          view,
          at + layer * step,
        )
      }
    } else {
      gl.texSubImage3D(
        texture.target,
        mip,
        x,
        y,
        z,
        width,
        height,
        depth,
        info.format,
        info.type,
        view,
        at,
      )
    }
  }

  copyExternal(
    source: GPUCopyExternalImageSourceInfo,
    destination: GPUCopyExternalImageDestInfo,
    width: number,
    height: number,
  ): void {
    const texture = destination.texture as unknown as Webgl2Texture
    if (!texture.gl)
      throw unsupported(`copy an image into "${texture.label}" (it's only an attachment)`)
    const gl = this.gl
    const info = texture.info
    const o = destination.origin as GPUOrigin3DDict | number[] | undefined
    const dx = (Array.isArray(o) ? o[0] : o?.x) ?? 0
    const dy = (Array.isArray(o) ? o[1] : o?.y) ?? 0
    const dz = (Array.isArray(o) ? o[2] : o?.z) ?? 0
    const so = source.origin as GPUOrigin2DDict | number[] | undefined
    const sx = (Array.isArray(so) ? so[0] : so?.x) ?? 0
    const sy = (Array.isArray(so) ? so[1] : so?.y) ?? 0
    this.device.state.bindTexture(texture.target, texture.gl)
    this.unpack(0, 0)
    gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, source.flipY === true)
    gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, destination.premultipliedAlpha === true)
    gl.pixelStorei(GL.UNPACK_SKIP_PIXELS, sx)
    gl.pixelStorei(GL.UNPACK_SKIP_ROWS, sy)
    const image = source.source as TexImageSource
    const mip = destination.mipLevel ?? 0
    try {
      if (texture.target === GL.TEXTURE_2D) {
        gl.texSubImage2D(GL.TEXTURE_2D, mip, dx, dy, width, height, info.format, info.type, image)
      } else if (texture.target === GL.TEXTURE_CUBE_MAP) {
        gl.texSubImage2D(
          GL.TEXTURE_CUBE_MAP_POSITIVE_X + dz,
          mip,
          dx,
          dy,
          width,
          height,
          info.format,
          info.type,
          image,
        )
      } else {
        gl.texSubImage3D(
          texture.target,
          mip,
          dx,
          dy,
          dz,
          width,
          height,
          1,
          info.format,
          info.type,
          image,
        )
      }
    } finally {
      gl.pixelStorei(GL.UNPACK_FLIP_Y_WEBGL, false)
      gl.pixelStorei(GL.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
      gl.pixelStorei(GL.UNPACK_SKIP_PIXELS, 0)
      gl.pixelStorei(GL.UNPACK_SKIP_ROWS, 0)
    }
    this.device.touch(texture)
  }

  // --- encoder copies ------------------------------------------------------------------

  copyBuffer(
    src: Webgl2Buffer,
    srcOffset: number,
    dst: Webgl2Buffer,
    dstOffset: number,
    size: number,
  ): void {
    const gl = this.gl
    gl.bindBuffer(GL.COPY_READ_BUFFER, src.gl)
    gl.bindBuffer(GL.COPY_WRITE_BUFFER, dst.gl)
    gl.copyBufferSubData(GL.COPY_READ_BUFFER, GL.COPY_WRITE_BUFFER, srcOffset, dstOffset, size)
    // Timer query results not in yet travel with the copy (0074).
    if (src.queryReads.length > 0) {
      for (let i = src.queryReads.length - 1; i >= 0; i--) {
        const read = src.queryReads[i]!
        if (read.offset < srcOffset || read.offset >= srcOffset + size) continue
        src.queryReads.splice(i, 1)
        dst.queryReads.push({ offset: read.offset - srcOffset + dstOffset, queries: read.queries })
      }
    }
    if (dst.shadow) {
      if (src.shadow) dst.shadow.set(src.shadow.subarray(srcOffset, srcOffset + size), dstOffset)
      else gl.getBufferSubData(GL.COPY_WRITE_BUFFER, dstOffset, dst.shadow, dstOffset, size)
      dst.version++
    }
    gl.bindBuffer(GL.COPY_READ_BUFFER, null)
    gl.bindBuffer(GL.COPY_WRITE_BUFFER, null)
  }

  clearBuffer(buffer: Webgl2Buffer, offset: number, size: number): void {
    if (size <= 0) return
    if (this.zeros.length < size) this.zeros = new Uint8Array(size)
    buffer.write(offset, this.zeros, 0, size)
  }

  copyBufferToTexture(
    buffer: Webgl2Buffer,
    offset: number,
    bytesPerRow: number,
    rowsPerImage: number,
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
  ): void {
    if (!texture.gl) throw unsupported(`copy into "${texture.label}" (it's only an attachment)`)
    const gl = this.gl
    const info = texture.info
    this.device.state.bindTexture(texture.target, texture.gl)
    gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, buffer.gl)
    try {
      if (info.compressed) {
        const blocksWide = Math.ceil(width / 4)
        const blocksHigh = Math.ceil(height / 4)
        const tight = blocksWide * info.bytes
        for (let layer = 0; layer < depth; layer++) {
          const start = offset + layer * (rowsPerImage / 4) * bytesPerRow
          if (bytesPerRow === tight) {
            this.compressedAt(
              texture,
              mip,
              x,
              y,
              z + layer,
              width,
              height,
              tight * blocksHigh,
              start,
            )
          } else {
            for (let row = 0; row < blocksHigh; row++) {
              const h = Math.min(4, height - row * 4)
              this.compressedAt(
                texture,
                mip,
                x,
                y + row * 4,
                z + layer,
                width,
                h,
                tight,
                start + row * bytesPerRow,
              )
            }
          }
        }
        return
      }
      this.unpack(bytesPerRow / info.bytes, rowsPerImage)
      if (texture.target === GL.TEXTURE_2D) {
        gl.texSubImage2D(GL.TEXTURE_2D, mip, x, y, width, height, info.format, info.type, offset)
      } else if (texture.target === GL.TEXTURE_CUBE_MAP) {
        for (let layer = 0; layer < depth; layer++) {
          const face = GL.TEXTURE_CUBE_MAP_POSITIVE_X + z + layer
          const at = offset + layer * rowsPerImage * bytesPerRow
          gl.texSubImage2D(face, mip, x, y, width, height, info.format, info.type, at)
        }
      } else {
        gl.texSubImage3D(
          texture.target,
          mip,
          x,
          y,
          z,
          width,
          height,
          depth,
          info.format,
          info.type,
          offset,
        )
      }
    } finally {
      gl.bindBuffer(GL.PIXEL_UNPACK_BUFFER, null)
    }
    this.device.touch(texture)
  }

  copyTextureToBuffer(
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    z: number,
    buffer: Webgl2Buffer,
    offset: number,
    bytesPerRow: number,
    rowsPerImage: number,
    width: number,
    height: number,
    depth: number,
  ): void {
    const gl = this.gl
    const info = texture.info
    if (info.compressed) throw unsupported(`read back the compressed texture "${texture.label}"`)
    if (info.kind === 'stencil' || texture.sampleCount > 1) {
      throw unsupported(`read back "${texture.label}" (${texture.format}, ${texture.sampleCount}×)`)
    }
    const read = readFormatOf(info)
    const direct = read.direct && bytesPerRow % read.bytes === 0
    const tight = width * height * read.bytes
    const mapped = (buffer.usage & BufferUsage.MAP_READ) !== 0
    let pack: { gl: WebGLBuffer | null; size: number } | undefined
    if (!direct) pack = this.pack(tight * depth)
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, direct ? buffer.gl : pack!.gl)
    gl.pixelStorei(GL.PACK_ROW_LENGTH, direct ? bytesPerRow / read.bytes : 0)
    for (let layer = 0; layer < depth; layer++) {
      const at = direct ? offset + layer * rowsPerImage * bytesPerRow : layer * tight
      if (info.depth) {
        this.readDepth(texture, mip, x, y, z + layer, width, height, at)
      } else {
        this.bindRead(texture, mip, z + layer)
        gl.readPixels(x, y, width, height, read.format, read.type, at)
      }
    }
    gl.pixelStorei(GL.PACK_ROW_LENGTH, 0)
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, null)
    if (direct) return
    const job: ReadJob = {
      pack: pack!.gl,
      packSize: pack!.size,
      read,
      info,
      width,
      rows: height,
      layers: depth,
      offset,
      bytesPerRow,
      rowsPerImage,
    }
    if (mapped) {
      buffer.reads.push(job)
      return
    }
    // Not mappable (a copy source, say): repack now, at the cost of a stall.
    const bytes = new Uint8Array(rowsPerImage * bytesPerRow * (depth - 1) + bytesPerRow * height)
    this.finishRead(job, bytes, -offset)
    buffer.write(offset, bytes, 0, bytes.length)
  }

  /** Repacks a finished read into `out`, at the job's offset plus `shift`, and frees its pack buffer. */
  finishRead(job: ReadJob, out: Uint8Array, shift: number): void {
    const gl = this.gl
    const size = job.width * job.rows * job.read.bytes * job.layers
    const src = new Uint8Array(size)
    gl.bindBuffer(GL.COPY_READ_BUFFER, job.pack)
    gl.getBufferSubData(GL.COPY_READ_BUFFER, 0, src)
    gl.bindBuffer(GL.COPY_READ_BUFFER, null)
    const layerBytes = job.width * job.rows * job.read.bytes
    for (let layer = 0; layer < job.layers; layer++) {
      repack(
        src.subarray(layer * layerBytes, (layer + 1) * layerBytes),
        job.read,
        job.info,
        job.width,
        job.rows,
        out,
        job.offset + shift + layer * job.rowsPerImage * job.bytesPerRow,
        job.bytesPerRow,
      )
    }
    this.releaseRead(job)
  }

  releaseRead(job: ReadJob): void {
    if (!job.pack) return
    this.packs.push({ gl: job.pack, size: job.packSize })
    job.pack = null
  }

  copyTexture(
    src: Webgl2Texture,
    srcMip: number,
    sx: number,
    sy: number,
    sz: number,
    dst: Webgl2Texture,
    dstMip: number,
    dx: number,
    dy: number,
    dz: number,
    width: number,
    height: number,
    depth: number,
  ): void {
    const gl = this.gl
    const info = src.info
    if (info.compressed || dst.info.compressed) {
      throw unsupported(`copy the compressed texture "${src.label}" on the GPU`)
    }
    const mask = info.depth
      ? GL.DEPTH_BUFFER_BIT | (info.stencil ? GL.STENCIL_BUFFER_BIT : 0)
      : info.kind === 'stencil'
        ? GL.STENCIL_BUFFER_BIT
        : GL.COLOR_BUFFER_BIT
    for (let layer = 0; layer < depth; layer++) {
      this.read.reset()
      this.draw.reset()
      if (mask === GL.COLOR_BUFFER_BIT) {
        this.read.color(0, src, srcMip, sz + layer)
        this.draw.color(0, dst, dstMip, dz + layer)
      } else {
        this.read.setDepth(src, srcMip, sz + layer)
        this.draw.setDepth(dst, dstMip, dz + layer)
      }
      const from = this.device.fbos.get(this.read)
      const to = this.device.fbos.get(this.draw)
      gl.bindFramebuffer(GL.READ_FRAMEBUFFER, from)
      gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, to)
      this.device.state.enable(GL.SCISSOR_TEST, false)
      gl.blitFramebuffer(
        sx,
        sy,
        sx + width,
        sy + height,
        dx,
        dy,
        dx + width,
        dy + height,
        mask,
        GL.NEAREST,
      )
    }
    this.device.touch(dst)
  }

  /** Binds `texture`'s mip and layer as the read framebuffer. */
  bindRead(texture: Webgl2Texture, mip: number, layer: number): void {
    this.read.reset()
    if (texture.info.depth || texture.info.kind === 'stencil')
      this.read.setDepth(texture, mip, layer)
    else this.read.color(0, texture, mip, layer)
    this.gl.bindFramebuffer(GL.READ_FRAMEBUFFER, this.device.fbos.get(this.read))
  }

  /** Forgets GL objects of a lost or destroyed device. */
  clear(): void {
    for (const p of this.packs) this.gl.deleteBuffer(p.gl)
    this.packs.length = 0
    this.depthTarget?.destroy()
    this.depthTarget = undefined
    for (const p of this.depthPrograms) if (p) this.gl.deleteProgram(p.program)
    this.depthPrograms = [undefined, undefined]
  }

  // --- helpers ---------------------------------------------------------------------

  private unpack(rowLength: number, imageHeight: number): void {
    if (this.rowLength !== rowLength) {
      this.rowLength = rowLength
      this.gl.pixelStorei(GL.UNPACK_ROW_LENGTH, rowLength)
    }
    if (this.imageHeight !== imageHeight) {
      this.imageHeight = imageHeight
      this.gl.pixelStorei(GL.UNPACK_IMAGE_HEIGHT, imageHeight)
    }
  }

  /**
   * A typed array of the upload type over all of `buffer`, kept while uploads come from the same
   * buffer; `viewOffset` is where `byteOffset` falls in it, in elements.
   */
  private view(type: number, buffer: ArrayBufferLike, byteOffset: number): ArrayBufferView {
    const Array_ = arrayFor(type)
    const size = Array_.BYTES_PER_ELEMENT
    if (byteOffset % size !== 0) {
      // Misaligned for its type: copy to an aligned array.
      const copy = new Uint8Array(buffer, byteOffset).slice()
      this.viewOffset = 0
      return new Array_(copy.buffer, 0, Math.floor(copy.byteLength / size))
    }
    let view = this.views.get(Array_)
    if (!view || view.buffer !== buffer) {
      view = new Array_(buffer as ArrayBuffer, 0, Math.floor(buffer.byteLength / size))
      this.views.set(Array_, view)
    }
    this.viewOffset = byteOffset / size
    return view
  }

  private compressed(
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    bytes: Uint8Array,
  ): void {
    const gl = this.gl
    const internal = texture.info.internal
    if (texture.target === GL.TEXTURE_2D) {
      gl.compressedTexSubImage2D(GL.TEXTURE_2D, mip, x, y, width, height, internal, bytes)
    } else if (texture.target === GL.TEXTURE_CUBE_MAP) {
      gl.compressedTexSubImage2D(
        GL.TEXTURE_CUBE_MAP_POSITIVE_X + z,
        mip,
        x,
        y,
        width,
        height,
        internal,
        bytes,
      )
    } else {
      gl.compressedTexSubImage3D(texture.target, mip, x, y, z, width, height, 1, internal, bytes)
    }
  }

  private compressedAt(
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    size: number,
    offset: number,
  ): void {
    const gl = this.gl
    const internal = texture.info.internal
    if (texture.target === GL.TEXTURE_2D) {
      gl.compressedTexSubImage2D(GL.TEXTURE_2D, mip, x, y, width, height, internal, size, offset)
    } else if (texture.target === GL.TEXTURE_CUBE_MAP) {
      gl.compressedTexSubImage2D(
        GL.TEXTURE_CUBE_MAP_POSITIVE_X + z,
        mip,
        x,
        y,
        width,
        height,
        internal,
        size,
        offset,
      )
    } else {
      gl.compressedTexSubImage3D(
        texture.target,
        mip,
        x,
        y,
        z,
        width,
        height,
        1,
        internal,
        size,
        offset,
      )
    }
  }

  private pack(size: number): { gl: WebGLBuffer | null; size: number } {
    for (let i = 0; i < this.packs.length; i++) {
      if (this.packs[i]!.size >= size) return this.packs.splice(i, 1)[0]!
    }
    const gl = this.gl
    const buffer = gl.createBuffer()
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, buffer)
    gl.bufferData(GL.PIXEL_PACK_BUFFER, size, GL.STREAM_READ)
    gl.bindBuffer(GL.PIXEL_PACK_BUFFER, null)
    return { gl: buffer, size }
  }

  /**
   * Reads depth (which readPixels can't) by drawing it into an R32F target with texelFetch, then
   * reading that as floats into the bound pack buffer at `at`.
   */
  private readDepth(
    texture: Webgl2Texture,
    mip: number,
    x: number,
    y: number,
    layer: number,
    width: number,
    height: number,
    at: number,
  ): void {
    const gl = this.gl
    const device = this.device
    const state = device.state
    if (!texture.gl) throw unsupported(`read back the depth attachment "${texture.label}"`)
    const array = texture.target !== GL.TEXTURE_2D
    const program = this.depthProgram(array)
    let target = this.depthTarget
    if (!target || target.width < width || target.height < height) {
      target?.destroy()
      target = new Webgl2Texture(device, {
        label: 'shard/depth-readback',
        size: [Math.max(width, target?.width ?? 0), Math.max(height, target?.height ?? 0)],
        format: 'r32float',
        usage: TextureUsage.RENDER_ATTACHMENT,
      })
      this.depthTarget = target
    }
    this.draw.reset()
    this.draw.color(0, target, 0, 0)
    gl.bindFramebuffer(GL.FRAMEBUFFER, device.fbos.get(this.draw))
    state.prepareClear()
    state.enable(GL.DEPTH_TEST, false)
    state.enable(GL.CULL_FACE, false)
    state.enable(GL.BLEND, false)
    state.enable(GL.STENCIL_TEST, false)
    state.useProgram(program.program)
    state.bindVertexArray(null)
    state.bindUnit(0, texture.target, texture.gl)
    state.bindSampler(0, null)
    device.levels(texture, 0, texture.mipLevelCount - 1)
    gl.uniform1i(program.texture, 0)
    gl.uniform3i(program.origin, x, y, layer)
    gl.uniform1i(program.level, mip)
    gl.viewport(0, 0, width, height)
    gl.drawArrays(GL.TRIANGLES, 0, 3)
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, device.fbos.get(this.draw))
    gl.readPixels(0, 0, width, height, GL.RGBA, GL.FLOAT, at)
  }

  private depthProgram(array: boolean): DepthProgram {
    const i = array ? 1 : 0
    const cached = this.depthPrograms[i]
    if (cached) return cached
    const gl = this.gl
    const program = gl.createProgram()
    const compile = (type: number, source: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, source)
      gl.compileShader(s)
      gl.attachShader(program!, s)
      return s
    }
    const vs = compile(GL.VERTEX_SHADER, DEPTH_VS)
    const fs = compile(GL.FRAGMENT_SHADER, depthFs(array))
    gl.linkProgram(program!)
    if (!gl.getProgramParameter(program!, GL.LINK_STATUS)) {
      throw new Error(`The depth readback program didn't link: ${gl.getProgramInfoLog(program!)}`)
    }
    gl.deleteShader(vs)
    gl.deleteShader(fs)
    const made: DepthProgram = {
      program,
      origin: gl.getUniformLocation(program!, 'origin'),
      level: gl.getUniformLocation(program!, 'level'),
      texture: gl.getUniformLocation(program!, 'depth_texture'),
    }
    this.depthPrograms[i] = made
    return made
  }
}
