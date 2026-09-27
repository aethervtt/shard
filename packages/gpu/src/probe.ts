import { ShardError } from '@aethervtt/shard-core'

export interface ProbeWebGpuOptions {
  /** The WebGPU entry point. Defaults to `navigator.gpu`; in Node pass the `webgpu` package's. */
  gpu?: GPU
  /** Features the app can't run without. Missing any makes the result unsupported. */
  requiredFeatures?: GPUFeatureName[]
  powerPreference?: GPUPowerPreference
  /** Gives up after this long: some drivers never answer `requestAdapter`. Default 5000 ms. */
  timeoutMs?: number
}

export type WebGpuUnsupportedReason =
  | 'no-webgpu'
  | 'no-adapter'
  | 'missing-feature'
  | 'device-failed'
  | 'timeout'

export interface WebGpuSupport {
  supported: boolean
  /** Why not, when unsupported. */
  reason?: WebGpuUnsupportedReason
  /** The same failure as a ShardError, with a hint a host can show. */
  error?: ShardError
  adapter?: { vendor: string; architecture: string; description: string }
  /** Every feature the adapter offers. */
  features: string[]
  /** Required features the adapter lacks. */
  missing: string[]
  limits?: {
    maxTextureDimension2D: number
    maxBufferSize: number
    maxStorageBufferBindingSize: number
  }
}

const HINTS: Record<WebGpuUnsupportedReason, string> = {
  'no-webgpu':
    'This browser has no WebGPU. Use a current Chrome, Edge, or Safari, or enable WebGPU in its settings.',
  'no-adapter': 'WebGPU is present but found no usable GPU. It may be blocklisted or disabled.',
  'missing-feature': 'The GPU lacks a feature this app requires.',
  'device-failed': 'The GPU was found but refused to create a device.',
  timeout: 'The GPU did not answer in time. Try reloading, or updating the graphics driver.',
}

const MESSAGES: Record<WebGpuUnsupportedReason, string> = {
  'no-webgpu': 'WebGPU is not available in this environment',
  'no-adapter': 'No WebGPU adapter was found',
  'missing-feature': 'The GPU lacks required features',
  'device-failed': 'Could not create a WebGPU device',
  timeout: 'WebGPU did not respond in time',
}

/**
 * Checks, before mounting anything, whether this client can run Shard: WebGPU present, an
 * adapter, the required features, and a device that really opens (it's destroyed again). Never
 * throws, so a host can show an honest message instead of a blank canvas.
 */
export async function probeWebGpu(options: ProbeWebGpuOptions = {}): Promise<WebGpuSupport> {
  const gpu = options.gpu ?? (globalThis.navigator as Navigator | undefined)?.gpu
  const required = options.requiredFeatures ?? []
  if (!gpu) return unsupported('no-webgpu', [], [])

  const timeoutMs = options.timeoutMs ?? 5000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    const adapter = await Promise.race([
      gpu.requestAdapter({ powerPreference: options.powerPreference ?? 'high-performance' }),
      timeout,
    ]).catch(() => null)
    if (adapter === 'timeout') return unsupported('timeout', [], [])
    if (!adapter) return unsupported('no-adapter', [], [])

    const features = [...adapter.features].map(String).sort()
    const missing = required.filter((f) => !adapter.features.has(f))
    const info = adapter.info
    const base = {
      features,
      missing,
      adapter: {
        vendor: info?.vendor ?? '',
        architecture: info?.architecture ?? '',
        description: info?.description ?? '',
      },
      limits: {
        maxTextureDimension2D: adapter.limits.maxTextureDimension2D,
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      },
    }
    if (missing.length > 0) {
      return {
        ...unsupported('missing-feature', features, missing, missing.join(', ')),
        adapter: base.adapter,
        limits: base.limits,
      }
    }

    const device = await Promise.race([
      adapter.requestDevice({ label: 'shard-probe', requiredFeatures: required }),
      timeout,
    ]).catch(() => null)
    if (device === 'timeout') return { ...unsupported('timeout', features, []), ...base }
    if (!device) return { ...unsupported('device-failed', features, []), ...base }
    device.destroy()
    return { supported: true, ...base }
  } finally {
    clearTimeout(timer)
  }
}

function unsupported(
  reason: WebGpuUnsupportedReason,
  features: string[],
  missing: string[],
  detail?: string,
): WebGpuSupport {
  const message = detail ? `${MESSAGES[reason]}: ${detail}` : MESSAGES[reason]
  return {
    supported: false,
    reason,
    error: new ShardError(`gpu/${reason}`, message, { hint: HINTS[reason] }),
    features,
    missing,
  }
}
