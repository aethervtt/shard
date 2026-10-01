import { GL } from './gl'
import type { Webgl2Texture } from './resources'

// Framebuffers, made once per set of attachments and kept until one of their textures is
// destroyed. A lookup is by what's attached (texture, mip, layer), not by view, so passes that make
// a view every frame (a canvas's current texture) still find theirs without allocating.

/** Attachments to look up: filled in place by a pass, a resolve, a copy or a present. */
export class Attachments {
  count = 0
  readonly colors: (Webgl2Texture | null)[] = []
  readonly colorMips: number[] = []
  /** Array layer, cube face or 3D slice; 0 for a 2D texture. */
  readonly colorLayers: number[] = []
  depth: Webgl2Texture | null = null
  depthMip = 0
  depthLayer = 0

  reset(): void {
    for (let i = 0; i < this.count; i++) this.colors[i] = null
    this.count = 0
    this.depth = null
  }

  color(index: number, texture: Webgl2Texture | null, mip: number, layer: number): void {
    while (this.count <= index) {
      this.colors[this.count] = null
      this.colorMips[this.count] = 0
      this.colorLayers[this.count] = 0
      this.count++
    }
    this.colors[index] = texture
    this.colorMips[index] = mip
    this.colorLayers[index] = layer
  }

  setDepth(texture: Webgl2Texture, mip: number, layer: number): void {
    this.depth = texture
    this.depthMip = mip
    this.depthLayer = layer
  }

  /** The texture a lookup is filed under: the first attached. */
  first(): Webgl2Texture | null {
    for (let i = 0; i < this.count; i++) if (this.colors[i]) return this.colors[i]!
    return this.depth
  }
}

interface FramebufferRecord {
  fbo: WebGLFramebuffer | null
  colors: (Webgl2Texture | null)[]
  colorMips: number[]
  colorLayers: number[]
  depth: Webgl2Texture | null
  depthMip: number
  depthLayer: number
}

function matches(r: FramebufferRecord, a: Attachments): boolean {
  if (r.colors.length !== a.count || r.depth !== a.depth) return false
  if (a.depth && (r.depthMip !== a.depthMip || r.depthLayer !== a.depthLayer)) return false
  for (let i = 0; i < a.count; i++) {
    if (r.colors[i] !== a.colors[i]) return false
    if (
      a.colors[i] &&
      (r.colorMips[i] !== a.colorMips[i] || r.colorLayers[i] !== a.colorLayers[i])
    ) {
      return false
    }
  }
  return true
}

export class FramebufferCache {
  private readonly gl: WebGL2RenderingContext
  private readonly byTexture = new Map<Webgl2Texture, FramebufferRecord[]>()
  /** Framebuffers that failed their completeness check, for the error they raise once. */
  incomplete: ((status: number) => void) | undefined

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl
  }

  /** The framebuffer for `a`, bound to FRAMEBUFFER (read and draw) when it's new. */
  get(a: Attachments): WebGLFramebuffer | null {
    const first = a.first()
    if (!first) return null
    let list = this.byTexture.get(first)
    if (list) {
      for (let i = 0; i < list.length; i++) if (matches(list[i]!, a)) return list[i]!.fbo
    } else {
      list = []
      this.byTexture.set(first, list)
    }
    const record = this.create(a)
    list.push(record)
    return record.fbo
  }

  /** Deletes every framebuffer `texture` is attached to. */
  forget(texture: Webgl2Texture): void {
    for (const [key, list] of this.byTexture) {
      for (let i = list.length - 1; i >= 0; i--) {
        const r = list[i]!
        if (key === texture || r.depth === texture || r.colors.includes(texture)) {
          this.gl.deleteFramebuffer(r.fbo)
          list.splice(i, 1)
        }
      }
      if (list.length === 0) this.byTexture.delete(key)
    }
  }

  clear(): void {
    for (const list of this.byTexture.values())
      for (const r of list) this.gl.deleteFramebuffer(r.fbo)
    this.byTexture.clear()
  }

  private create(a: Attachments): FramebufferRecord {
    const gl = this.gl
    const fbo = gl.createFramebuffer()
    gl.bindFramebuffer(GL.FRAMEBUFFER, fbo)
    const buffers: number[] = []
    for (let i = 0; i < a.count; i++) {
      const t = a.colors[i]
      if (t) attach(gl, GL.COLOR_ATTACHMENT0 + i, t, a.colorMips[i]!, a.colorLayers[i]!)
      buffers.push(t ? GL.COLOR_ATTACHMENT0 + i : GL.NONE)
    }
    if (a.depth) {
      const info = a.depth.info
      const point =
        info.depth && info.stencil
          ? GL.DEPTH_STENCIL_ATTACHMENT
          : info.depth
            ? GL.DEPTH_ATTACHMENT
            : GL.STENCIL_ATTACHMENT
      attach(gl, point, a.depth, a.depthMip, a.depthLayer)
    }
    gl.drawBuffers(buffers)
    if (a.count === 0) gl.readBuffer(GL.NONE)
    if (this.incomplete) {
      const status = gl.checkFramebufferStatus(GL.FRAMEBUFFER)
      if (status !== GL.FRAMEBUFFER_COMPLETE) this.incomplete(status)
    }
    return {
      fbo,
      colors: a.colors.slice(0, a.count),
      colorMips: a.colorMips.slice(0, a.count),
      colorLayers: a.colorLayers.slice(0, a.count),
      depth: a.depth,
      depthMip: a.depthMip,
      depthLayer: a.depthLayer,
    }
  }
}

function attach(
  gl: WebGL2RenderingContext,
  point: number,
  t: Webgl2Texture,
  mip: number,
  layer: number,
): void {
  if (t.renderbuffer) {
    gl.framebufferRenderbuffer(GL.FRAMEBUFFER, point, GL.RENDERBUFFER, t.renderbuffer)
  } else if (t.target === GL.TEXTURE_2D) {
    gl.framebufferTexture2D(GL.FRAMEBUFFER, point, GL.TEXTURE_2D, t.gl, mip)
  } else if (t.target === GL.TEXTURE_CUBE_MAP) {
    gl.framebufferTexture2D(
      GL.FRAMEBUFFER,
      point,
      GL.TEXTURE_CUBE_MAP_POSITIVE_X + layer,
      t.gl,
      mip,
    )
  } else {
    gl.framebufferTextureLayer(GL.FRAMEBUFFER, point, t.gl, mip, layer)
  }
}
