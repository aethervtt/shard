/**
 * WebGPU in Node through Dawn (the `webgpu` package). For the CLI, headless runs, and GPU tests.
 * Kept out of the main entry so browser bundles never see the native module.
 */
import { create, globals } from 'webgpu'
import { type CreateGpuContextOptions, createGpuContext, type GpuContext } from './context'

let installed = false

/** Defines `GPUBufferUsage`, `GPUTextureUsage`, etc. on globalThis, as browsers do. */
export function installWebGpuGlobals(): void {
  if (installed) return
  Object.assign(globalThis, globals)
  installed = true
}

/**
 * `SHARD_DAWN_OPTIONS` passes Dawn options, `;`-separated: CI's Windows job picks the software
 * rasterizer with `adapter=Microsoft Basic Render Driver`, and `backend=vulkan` picks a backend.
 */
export function nodeGpu(): GPU {
  installWebGpuGlobals()
  const options = process.env.SHARD_DAWN_OPTIONS?.split(';').filter(Boolean) ?? []
  return create(options) as GPU
}

/**
 * A device through Dawn. `SHARD_TIER=baseline` runs every one at the baseline tier (0064), on a
 * compatibility-mode device: the whole suite, checked against what baseline can do.
 */
export function createNodeGpuContext(
  options: Omit<CreateGpuContextOptions, 'gpu'> = {},
): Promise<GpuContext> {
  const tier = options.tier ?? (process.env.SHARD_TIER === 'baseline' ? 'baseline' : undefined)
  return createGpuContext({ ...options, tier, gpu: nodeGpu() })
}

/** What a headless canvas's WebGPU context was told, for tests to check. */
export interface HeadlessCanvasContext extends GPUCanvasContext {
  /** The last `configure` call's configuration; undefined while unconfigured. */
  readonly configuration: GPUCanvasConfiguration | undefined
  /** `configure` calls so far. */
  readonly configures: number
}

export interface HeadlessCanvas extends OffscreenCanvas {
  readonly gpuContext: HeadlessCanvasContext
}

/**
 * A canvas for headless tests (Node has none): its WebGPU context renders into a texture on the
 * configured device, so a surface on it can be drawn into and captured like a real one.
 */
export function headlessCanvas(width: number, height: number): HeadlessCanvas {
  let configuration: GPUCanvasConfiguration | undefined
  let configures = 0
  let current: GPUTexture | undefined
  const canvas = { width, height } as { width: number; height: number; gpuContext: unknown }
  const context = {
    get canvas() {
      return canvas
    },
    get configuration() {
      return configuration
    },
    get configures() {
      return configures
    },
    configure(config: GPUCanvasConfiguration) {
      configuration = config
      configures++
      current = undefined
    },
    unconfigure() {
      configuration = undefined
      current?.destroy()
      current = undefined
    },
    getConfiguration: () => configuration ?? null,
    getCurrentTexture(): GPUTexture {
      if (!configuration) throw new Error('getCurrentTexture on an unconfigured canvas')
      if (!current || current.width !== canvas.width || current.height !== canvas.height) {
        current?.destroy()
        const device = configuration.device
        // A swapchain texture isn't one of the app's objects: make it past the accounting.
        const create = Object.getPrototypeOf(device).createTexture as GPUDevice['createTexture']
        current = create.call(device, {
          label: 'headless-canvas',
          size: [canvas.width, canvas.height],
          format: configuration.format,
          usage: configuration.usage ?? GPUTextureUsage.RENDER_ATTACHMENT,
        })
      }
      return current
    },
  }
  canvas.gpuContext = context
  return Object.assign(canvas, {
    getContext: (kind: string) => (kind === 'webgpu' ? context : null),
  }) as unknown as HeadlessCanvas
}
