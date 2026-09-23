import { ShardError } from '@shard/core'

export interface GpuContext {
  readonly adapter: GPUAdapter
  readonly device: GPUDevice
  readonly context: GPUCanvasContext
  readonly format: GPUTextureFormat
  readonly canvas: HTMLCanvasElement
  /** Match the canvas backing size to its CSS size. Returns true if it changed. */
  resize(): boolean
}

export interface CreateGpuContextOptions {
  canvas: HTMLCanvasElement
  powerPreference?: GPUPowerPreference
}

export async function createGpuContext(options: CreateGpuContextOptions): Promise<GpuContext> {
  const { canvas } = options
  if (!('gpu' in navigator)) {
    throw new ShardError('gpu/unsupported', 'WebGPU is not available in this environment', {
      hint: 'Use a browser or webview with WebGPU enabled.',
    })
  }

  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? 'high-performance',
  })
  if (!adapter) {
    throw new ShardError('gpu/no-adapter', 'No WebGPU adapter was found')
  }

  const device = await adapter.requestDevice()
  device.lost.then((info) => {
    if (info.reason !== 'destroyed') console.error(`[shard] GPU device lost: ${info.message}`)
  })

  const context = canvas.getContext('webgpu')
  if (!context) {
    throw new ShardError('gpu/no-context', 'Could not get a WebGPU canvas context')
  }

  const format = navigator.gpu.getPreferredCanvasFormat()
  context.configure({ device, format, alphaMode: 'opaque' })

  const resize = () => {
    const dpr = globalThis.devicePixelRatio ?? 1
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr))
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr))
    if (canvas.width === width && canvas.height === height) return false
    canvas.width = width
    canvas.height = height
    return true
  }
  resize()

  return { adapter, device, context, format, canvas, resize }
}
