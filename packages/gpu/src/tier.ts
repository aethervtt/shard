// Backends and tiers (0064). The tier is what the engine runs: `full` needs a core WebGPU device
// (storage in the vertex and fragment stages, any view of any texture, compute); anything else that
// can run the baseline subset runs `baseline`. It's read off the device, not the request: asking for
// a compatibility adapter can still give a core one.

export type GpuBackendName = 'webgpu' | 'webgl2'
export type GpuTier = 'full' | 'baseline'

/** What the device can do, as far as the tiers care. */
export interface GpuCapabilities {
  /** A WebGPU core device (`core-features-and-limits`). */
  core: boolean
  compute: boolean
  storageBuffersPerStage: { vertex: number; fragment: number; compute: number }
  /** Any format or dimension view of any texture (core only). */
  arbitraryTextureViews: boolean
  maxTextureDimension2D: number
  maxColorAttachments: number
  maxUniformBufferBindingSize: number
  /**
   * The most samples an HDR scene target (`rgba16float`) takes: 4, or 1 where float targets can't
   * multisample (some compatibility-mode devices and WebGL2 implementations).
   */
  hdrSampleCount: 1 | 4
}

/** Why a better option was skipped: `{ backend: 'webgpu', code: 'no-adapter', … }`. */
export interface GraphicsReason {
  backend: GpuBackendName
  code: string
  message: string
}

/**
 * Whether a device follows core WebGPU's rules. Core devices carry `core-features-and-limits`;
 * browsers from before compatibility mode know neither the feature nor its per-stage storage
 * limits, and every device they make is core.
 */
export function isCoreDevice(device: GPUDevice): boolean {
  if (device.features.has('core-features-and-limits')) return true
  return device.limits.maxStorageBuffersInVertexStage === undefined
}

export function capabilitiesOf(
  device: GPUDevice,
  backend: GpuBackendName,
  hdrSampleCount: 1 | 4 = 4,
): GpuCapabilities {
  const limits = device.limits
  const core = backend === 'webgpu' && isCoreDevice(device)
  const perStage = limits.maxStorageBuffersPerShaderStage
  return {
    core,
    compute: backend === 'webgpu',
    storageBuffersPerStage: {
      vertex: backend === 'webgl2' ? 0 : (limits.maxStorageBuffersInVertexStage ?? perStage),
      fragment: backend === 'webgl2' ? 0 : (limits.maxStorageBuffersInFragmentStage ?? perStage),
      compute: backend === 'webgl2' ? 0 : perStage,
    },
    arbitraryTextureViews: core,
    maxTextureDimension2D: limits.maxTextureDimension2D,
    maxColorAttachments: limits.maxColorAttachments,
    maxUniformBufferBindingSize: limits.maxUniformBufferBindingSize,
    hdrSampleCount,
  }
}

/**
 * Whether `rgba16float` targets multisample 4×: always on a core device (checked without asking
 * it anything), else found by creating one in an error scope.
 */
export async function probeHdrSampleCount(device: GPUDevice): Promise<1 | 4> {
  if (isCoreDevice(device)) return 4
  device.pushErrorScope('validation')
  const texture = device.createTexture({
    label: 'shard/msaa-probe',
    size: [1, 1],
    format: 'rgba16float',
    sampleCount: 4,
    usage: GPUTextureUsage.RENDER_ATTACHMENT,
  })
  const error = await device.popErrorScope()
  texture.destroy()
  return error ? 1 : 4
}
