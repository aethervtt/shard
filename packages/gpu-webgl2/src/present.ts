import { TextureUsage } from './constants'
import type { Webgl2Device } from './device'
import { unsupported } from './errors'
import { Attachments } from './fbo'
import { GL } from './gl'
import { Webgl2Texture } from './resources'

// Canvas contexts (decision 8 of 0064). A canvas's current texture is an ordinary texture; after
// a submit draws into it, it's shown. On the device's own canvas that's a blit into the default
// framebuffer, flipped (the texture is laid out as WebGPU's, top row first). On any other canvas,
// the device's canvas is sized to it, blitted into, and drawn onto the canvas's 2D context: one
// device serves several canvases (0052) without WebGL on OffscreenCanvas.

const contexts = new WeakMap<object, Webgl2CanvasContext>()

/** The canvas context for `canvas`: one per canvas, as `getContext` gives. */
export function canvasContext(canvas: HTMLCanvasElement | OffscreenCanvas): Webgl2CanvasContext {
  let context = contexts.get(canvas)
  if (!context) {
    context = new Webgl2CanvasContext(canvas)
    contexts.set(canvas, context)
  }
  return context
}

export class Webgl2CanvasContext {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private device: Webgl2Device | undefined
  private configuration: GPUCanvasConfiguration | undefined
  private texture: Webgl2Texture | undefined
  private target: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null | undefined
  private readonly read = new Attachments()

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas
  }

  configure(configuration: GPUCanvasConfiguration): void {
    if (configuration.format !== 'rgba8unorm') {
      throw unsupported(
        `present ${configuration.format}`,
        "Configure the canvas with getPreferredCanvasFormat() ('rgba8unorm' on WebGL2).",
      )
    }
    this.texture?.destroy()
    this.texture = undefined
    this.device = configuration.device as unknown as Webgl2Device
    this.configuration = configuration
  }

  getConfiguration(): GPUCanvasConfiguration | null {
    return this.configuration ?? null
  }

  unconfigure(): void {
    this.texture?.destroy()
    this.texture = undefined
    this.device = undefined
    this.configuration = undefined
  }

  getCurrentTexture(): Webgl2Texture {
    const device = this.device
    const configuration = this.configuration
    if (!device || !configuration)
      throw new Error('getCurrentTexture: the canvas context is not configured')
    const width = Math.max(1, this.canvas.width)
    const height = Math.max(1, this.canvas.height)
    let texture = this.texture
    if (!texture || texture.destroyed || texture.width !== width || texture.height !== height) {
      texture?.destroy()
      texture = new Webgl2Texture(device, {
        label: 'canvas',
        size: [width, height],
        format: 'rgba8unorm',
        usage:
          (configuration.usage ?? TextureUsage.RENDER_ATTACHMENT) | TextureUsage.RENDER_ATTACHMENT,
      })
      texture.surface = this
      this.texture = texture
    }
    return texture
  }

  /** @internal Shows `texture` on the canvas. */
  present(texture: Webgl2Texture): void {
    const device = this.device
    if (!device || device.isLost || texture !== this.texture) return
    const gl = device.gl
    const glCanvas = device.canvas
    if (!glCanvas) return
    const w = texture.width
    const h = texture.height
    const own = glCanvas === this.canvas
    if (!own) {
      if (glCanvas.width !== w) glCanvas.width = w
      if (glCanvas.height !== h) glCanvas.height = h
    }
    this.read.reset()
    this.read.color(0, texture, 0, 0)
    gl.bindFramebuffer(GL.READ_FRAMEBUFFER, device.fbos.get(this.read))
    gl.bindFramebuffer(GL.DRAW_FRAMEBUFFER, null)
    device.state.enable(GL.SCISSOR_TEST, false)
    gl.blitFramebuffer(0, 0, w, h, 0, h, w, 0, GL.COLOR_BUFFER_BIT, GL.NEAREST)
    const opaque = this.configuration?.alphaMode !== 'premultiplied'
    if (opaque) {
      gl.bindFramebuffer(GL.FRAMEBUFFER, null)
      device.state.prepareClear()
      gl.colorMask(false, false, false, true)
      gl.clearColor(0, 0, 0, 1)
      gl.clear(GL.COLOR_BUFFER_BIT)
      gl.colorMask(true, true, true, true)
    }
    if (own) return
    if (this.target === undefined) {
      this.target = this.canvas.getContext('2d', { alpha: !opaque }) as
        | CanvasRenderingContext2D
        | OffscreenCanvasRenderingContext2D
        | null
    }
    if (!this.target) return
    this.target.globalCompositeOperation = 'copy'
    this.target.drawImage(glCanvas, 0, 0)
  }
}
