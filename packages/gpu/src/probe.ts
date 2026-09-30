import { ShardError } from '@aethervtt/shard-core'
import { openDevice } from './context'
import {
  capabilitiesOf,
  type GpuBackendName,
  type GpuCapabilities,
  type GpuTier,
  type GraphicsReason,
} from './tier'

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

export interface ProbeGraphicsOptions {
  /** The WebGPU entry point. Defaults to `navigator.gpu`; in Node pass the `webgpu` package's. */
  gpu?: GPU
  /** `'baseline'`: classify the device the baseline tier would get (a compatibility-mode one). */
  tier?: 'baseline'
  powerPreference?: GPUPowerPreference
  /** Gives up after this long: some drivers never answer. Default 5000 ms. */
  timeoutMs?: number
}

/** What `probeGraphics` found: the backend and tier an app would get, and why not better (0064). */
export interface GraphicsSupport {
  backend: GpuBackendName | 'none'
  tier: GpuTier | 'none'
  /** Undefined when nothing opened. */
  capabilities: GpuCapabilities | undefined
  /** Why a better option was skipped, or why none opened. */
  reasons: GraphicsReason[]
  adapter?: { vendor: string; architecture: string; description: string }
}

/**
 * Opens the device an app would get, the same way `createGpuContext` does, classifies it from what
 * it can actually do, and destroys it again. Never throws: an honest `none` with reasons instead.
 */
export async function probeGraphics(options: ProbeGraphicsOptions = {}): Promise<GraphicsSupport> {
  const timeoutMs = options.timeoutMs ?? 5000
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  const opening = openDevice({
    gpu: options.gpu,
    tier: options.tier,
    powerPreference: options.powerPreference,
  })
  try {
    const opened = await Promise.race([opening, timeout])
    if (opened === 'timeout') {
      // A late device isn't left open.
      void opening.then((o) => o.device.destroy()).catch(() => {})
      return none([{ backend: 'webgpu', code: 'timeout', message: MESSAGES.timeout }])
    }
    const info = opened.adapter.info
    const support: GraphicsSupport = {
      backend: opened.backend,
      tier: opened.tier,
      capabilities: capabilitiesOf(opened.device, opened.backend),
      reasons: opened.reasons,
      adapter: {
        vendor: info?.vendor ?? '',
        architecture: info?.architecture ?? '',
        description: info?.description ?? '',
      },
    }
    opened.device.destroy()
    return support
  } catch (err) {
    const error = err instanceof ShardError ? err : undefined
    return none([
      {
        backend: 'webgpu',
        code: error?.code.replace(/^gpu\//, '') ?? 'device-failed',
        message: error?.message ?? String(err),
      },
    ])
  } finally {
    clearTimeout(timer)
  }
}

function none(reasons: GraphicsReason[]): GraphicsSupport {
  return { backend: 'none', tier: 'none', capabilities: undefined, reasons }
}
