import { describe, expect, it } from 'vitest'
import { nodeGpu } from './node'
import { probeWebGpu } from './probe'

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
