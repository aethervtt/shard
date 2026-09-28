import type { GpuContext } from './context'

/**
 * How a surface composites over the page. premultiplied: its pixels are premultiplied RGBA, so a
 * clear alpha of 0 shows what's under the canvas (0052).
 */
export type SurfaceAlpha = 'opaque' | 'premultiplied'

export interface SurfaceOptions {
  /** Default 'opaque'. */
  alpha?: SurfaceAlpha
  /** Names it in errors and `render.describe`. Default `surface`, `surface-2`, … */
  label?: string
}

/**
 * A configured canvas on a `GpuContext` (0052): its own canvas context and alpha mode, sized from a
 * ResizeObserver, reconfigured after a device loss. It's a render target: cameras without a target
 * render into their app's surface.
 */
export class Surface {
  readonly label: string
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  readonly alpha: SurfaceAlpha
  readonly context: GPUCanvasContext
  /** Cameras showing on a surface render at the RenderScale and are upscaled (0051). */
  readonly renderScale = true
  /** Canvas pixels per CSS pixel (devicePixelRatio) at the last resize. */
  pixelRatio = 1
  /** The device it's configured for. */
  readonly gpu: GpuContext
  private readonly observer: ResizeObserver | undefined
  private readonly resizeListeners = new Set<() => void>()
  private removed_ = false

  /** @internal Made by `GpuContext.addSurface`. */
  constructor(
    gpu: GpuContext,
    canvas: HTMLCanvasElement | OffscreenCanvas,
    context: GPUCanvasContext,
    options: Required<SurfaceOptions>,
  ) {
    this.gpu = gpu
    this.canvas = canvas
    this.context = context
    this.alpha = options.alpha
    this.label = options.label
    this.configure()
    this.measure()
    const Observer = globalThis.ResizeObserver
    if (Observer && isElement(canvas)) {
      this.observer = new Observer((entries) => this.onObserved(entries))
      try {
        this.observer.observe(canvas, { box: 'device-pixel-content-box' })
      } catch {
        // Safari has no device-pixel box: CSS pixels times devicePixelRatio it is.
        this.observer.observe(canvas)
      }
    }
  }

  get format(): GPUTextureFormat {
    return this.gpu.format
  }

  get width(): number {
    return this.canvas.width
  }

  get height(): number {
    return this.canvas.height
  }

  /** True once `remove()` was called. */
  get removed(): boolean {
    return this.removed_
  }

  /** The texture to render into this frame. */
  texture(): GPUTexture {
    // Without a ResizeObserver (old engines), follow the element's size the old way.
    if (!this.observer) this.measure()
    return this.context.getCurrentTexture()
  }

  /** Calls `listener` after the canvas's backing size changes. Returns an unsubscribe function. */
  onResize(listener: () => void): () => void {
    this.resizeListeners.add(listener)
    return () => this.resizeListeners.delete(listener)
  }

  /** Unconfigures the canvas, stops observing it, and takes it off the device. Idempotent. */
  remove(): void {
    if (this.removed_) return
    this.removed_ = true
    this.observer?.disconnect()
    this.resizeListeners.clear()
    this.context.unconfigure()
    this.gpu.forgetSurface(this)
  }

  /** @internal Configures the canvas for the current device, keeping its alpha mode. */
  configure(): void {
    this.context.configure({
      device: this.gpu.device,
      format: this.gpu.format,
      alphaMode: this.alpha,
      // COPY_SRC lets the renderer capture screenshots straight from the swapchain.
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
  }

  /** Sizes the backing store from the element's CSS size (no-op for an OffscreenCanvas). */
  private measure(): void {
    const canvas = this.canvas
    if (!isElement(canvas)) return
    const dpr = globalThis.devicePixelRatio ?? 1
    this.resize(canvas.clientWidth * dpr, canvas.clientHeight * dpr, dpr)
  }

  private onObserved(entries: readonly ResizeObserverEntry[]): void {
    const entry = entries[entries.length - 1]
    if (!entry || this.removed_) return
    const dpr = globalThis.devicePixelRatio ?? 1
    const exact = entry.devicePixelContentBoxSize?.[0]
    if (exact) this.resize(exact.inlineSize, exact.blockSize, dpr)
    else {
      const box = entry.contentBoxSize?.[0]
      const w = box ? box.inlineSize : entry.contentRect.width
      const h = box ? box.blockSize : entry.contentRect.height
      this.resize(w * dpr, h * dpr, dpr)
    }
  }

  private resize(w: number, h: number, dpr: number): void {
    this.pixelRatio = dpr
    const width = Math.max(1, Math.floor(w))
    const height = Math.max(1, Math.floor(h))
    const canvas = this.canvas
    if (canvas.width === width && canvas.height === height) return
    canvas.width = width
    canvas.height = height
    for (const listener of this.resizeListeners) listener()
  }
}

function isElement(canvas: HTMLCanvasElement | OffscreenCanvas): canvas is HTMLCanvasElement {
  return 'clientWidth' in canvas
}
