import { describe, expect, it } from 'vitest'
import { createNodeGpuContext, nodeGpu } from './node'
import { probeGraphics, probeWebGpu } from './probe'

describe('probeWebGpu', () => {
  it('reports a working adapter as supported, with its features and limits', async () => {
    const result = await probeWebGpu({ gpu: nodeGpu() })
    expect(result.supported).toBe(true)
    expect(result.reason).toBeUndefined()
    expect(result.missing).toEqual([])
    expect(result.limits!.maxTextureDimension2D).toBeGreaterThanOrEqual(2048)
  })

  it('says so, without throwing, when WebGPU is absent', async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
      const result = await probeWebGpu()
      expect(result.supported).toBe(false)
      expect(result.reason).toBe('no-webgpu')
      expect(result.error?.code).toBe('gpu/no-webgpu')
      expect(result.error?.hint).toBeTruthy()
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved)
      else Reflect.deleteProperty(globalThis, 'navigator')
    }
  })

  it('reports no adapter, a missing feature, and a hung adapter request', async () => {
    const none = { requestAdapter: async () => null } as unknown as GPU
    expect((await probeWebGpu({ gpu: none })).reason).toBe('no-adapter')

    const missing = await probeWebGpu({
      gpu: nodeGpu(),
      requiredFeatures: ['not-a-feature' as GPUFeatureName],
    })
    expect(missing.reason).toBe('missing-feature')
    expect(missing.missing).toEqual(['not-a-feature'])
    expect(missing.error?.message).toContain('not-a-feature')

    const hung = { requestAdapter: () => new Promise(() => {}) } as unknown as GPU
    expect((await probeWebGpu({ gpu: hung, timeoutMs: 20 })).reason).toBe('timeout')
  })

  it('reports a device that fails to open', async () => {
    const adapter = {
      features: new Set<string>(),
      limits: { maxTextureDimension2D: 8192, maxBufferSize: 1, maxStorageBufferBindingSize: 1 },
      requestDevice: async () => {
        throw new Error('refused')
      },
    }
    const gpu = { requestAdapter: async () => adapter } as unknown as GPU
    const result = await probeWebGpu({ gpu })
    expect(result.reason).toBe('device-failed')
    expect(result.limits?.maxTextureDimension2D).toBe(8192)
  })
})

describe('probeGraphics and tiers (0064)', () => {
  it('classifies a core adapter as full, and the same adapter forced to baseline as baseline', async () => {
    const full = await probeGraphics({ gpu: nodeGpu() })
    expect(full).toMatchObject({ backend: 'webgpu', tier: 'full', reasons: [] })
    expect(full.capabilities).toMatchObject({
      core: true,
      compute: true,
      arbitraryTextureViews: true,
    })
    expect(full.capabilities!.storageBuffersPerStage.vertex).toBeGreaterThan(0)

    const baseline = await probeGraphics({ gpu: nodeGpu(), tier: 'baseline' })
    expect(baseline).toMatchObject({ backend: 'webgpu', tier: 'baseline' })
    // A compatibility-mode device: no storage in the vertex stage, no reinterpreting views.
    expect(baseline.capabilities).toMatchObject({ core: false, arbitraryTextureViews: false })
    expect(baseline.capabilities!.storageBuffersPerStage.vertex).toBe(0)
  })

  it('classifies a compatibility request answered with a core adapter as full', async () => {
    // No core adapter; the compatibility request gets a core one, as a browser without the mode does.
    const real = nodeGpu()
    const gpu = {
      requestAdapter: (options?: GPURequestAdapterOptions) =>
        options?.featureLevel === 'compatibility'
          ? real.requestAdapter({ powerPreference: options.powerPreference })
          : Promise.resolve(null),
      getPreferredCanvasFormat: () => real.getPreferredCanvasFormat(),
    } as unknown as GPU
    const result = await probeGraphics({ gpu })
    expect(result).toMatchObject({ backend: 'webgpu', tier: 'full' })
    expect(result.reasons.map((r) => r.code)).toEqual(['no-core-adapter'])
  })

  it('never throws: none, with the reason', async () => {
    const none = { requestAdapter: async () => null } as unknown as GPU
    const result = await probeGraphics({ gpu: none })
    expect(result).toMatchObject({ backend: 'none', tier: 'none', capabilities: undefined })
    expect(result.reasons.map((r) => r.code)).toEqual(['no-adapter'])
    const hung = { requestAdapter: () => new Promise(() => {}) } as unknown as GPU
    expect((await probeGraphics({ gpu: hung, timeoutMs: 20 })).reasons[0]!.code).toBe('timeout')
  })

  it('runs the baseline tier on a device that enforces compatibility rules (the canary)', async () => {
    const view = async (gpu: Awaited<ReturnType<typeof createNodeGpuContext>>) => {
      gpu.device.pushErrorScope('validation')
      const texture = gpu.device.createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING,
        viewFormats: ['rgba8unorm-srgb'],
      })
      texture.createView({ format: 'rgba8unorm-srgb' })
      const error = await gpu.device.popErrorScope()
      texture.destroy()
      return error
    }
    const core = await createNodeGpuContext()
    expect(core.tier).toBe('full')
    expect(await view(core)).toBeNull()
    core.destroy()
    // An sRGB view of a linear texture: fine on core, a validation error in compatibility mode.
    const compat = await createNodeGpuContext({ tier: 'baseline' })
    expect(compat.tier).toBe('baseline')
    expect(compat.capabilities.core).toBe(false)
    expect(await view(compat)).not.toBeNull()
    compat.destroy()
  })

  it('keeps the tier when it replaces a lost device', async () => {
    const gpu = await createNodeGpuContext({ tier: 'baseline', recovery: { intervalMs: 10 } })
    const before = gpu.device
    gpu.simulateDeviceLoss()
    await gpu.recreate()
    expect(gpu.device).not.toBe(before)
    expect(gpu.status).toBe('ok')
    expect(gpu.tier).toBe('baseline')
    expect(gpu.capabilities.core).toBe(false)
    gpu.destroy()
  })
})
