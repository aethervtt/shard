import type { GpuContext } from '@shard/gpu'

/** Where a view renders: the window's swapchain or an offscreen texture. */
export interface RenderTarget {
  readonly label: string
  readonly format: GPUTextureFormat
  readonly width: number
  readonly height: number
  /** The texture to render into this frame. */
  texture(): GPUTexture
}

/** The canvas swapchain. Resizes with the canvas. */
export class WindowTarget implements RenderTarget {
  readonly label = 'window'
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
  }

  get format(): GPUTextureFormat {
    return this.gpu.format
  }

  get width(): number {
    return this.gpu.canvas?.width ?? 1
  }

  get height(): number {
    return this.gpu.canvas?.height ?? 1
  }

  texture(): GPUTexture {
    this.gpu.resize()
    return this.gpu.context!.getCurrentTexture()
  }
}

export interface OffscreenTargetOptions {
  label: string
  width: number
  height: number
  format?: GPUTextureFormat
}

/** A texture render target: headless runs, screenshots, render-to-texture, second cameras. */
export class OffscreenTarget implements RenderTarget {
  readonly label: string
  readonly format: GPUTextureFormat
  width: number
  height: number
  private current: GPUTexture | undefined
  private generation = -1
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext, options: OffscreenTargetOptions) {
    this.gpu = gpu
    this.label = options.label
    this.width = options.width
    this.height = options.height
    this.format = options.format ?? 'rgba8unorm'
  }

  resize(width: number, height: number): void {
    if (width === this.width && height === this.height) return
    this.width = width
    this.height = height
    this.current?.destroy()
    this.current = undefined
  }

  texture(): GPUTexture {
    if (!this.current || this.generation !== this.gpu.generation) {
      this.generation = this.gpu.generation
      this.current = this.gpu.device.createTexture({
        label: this.label,
        size: [this.width, this.height],
        format: this.format,
        usage:
          GPUTextureUsage.RENDER_ATTACHMENT |
          GPUTextureUsage.TEXTURE_BINDING |
          GPUTextureUsage.COPY_SRC,
      })
    }
    return this.current
  }

  destroy(): void {
    this.current?.destroy()
  }
}
