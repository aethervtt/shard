import { ShardError } from '@aethervtt/shard-core'
import { FakeGl } from '@aethervtt/shard-gpu-webgl2/testing'
import { describe, expect, it } from 'vitest'
import { createGpuContext } from './context'
import { toShardError } from './errors'
import { nodeGpu } from './node'
import { probeGraphics } from './probe'

// Picking the backend (0064): WebGPU when it gives a device, else WebGL2 through the shim, loaded
// only then. WebGL2 here runs on a fake context; the browser tests run it for real.

/** GL's RGBA16F, whose sample counts decide the HDR target's MSAA. */
const RGBA16F = 0x881a

const noAdapter = { requestAdapter: async () => null } as unknown as GPU

describe('backends (0064)', () => {
  it("'auto' takes WebGPU when it gives a device, exactly as before", async () => {
    const gpu = await createGpuContext({ gpu: nodeGpu() })
    expect(gpu.backend).toBe('webgpu')
    expect(gpu.tier).toBe('full')
    expect(gpu.reasons).toEqual([])
    gpu.destroy()
  })

  it("'auto' falls back to WebGL2 with the reason, as the baseline tier", async () => {
    const fake = new FakeGl({ samples: { [RGBA16F]: [4, 2] } })
    const gpu = await createGpuContext({ gpu: noAdapter, webgl2: { context: fake.context } })
    expect(gpu.backend).toBe('webgl2')
    expect(gpu.tier).toBe('baseline')
    expect(gpu.reasons.map((r) => [r.backend, r.code])).toEqual([['webgpu', 'no-adapter']])
    expect(gpu.capabilities).toMatchObject({
      core: false,
      compute: false,
      arbitraryTextureViews: false,
      storageBuffersPerStage: { vertex: 0, fragment: 0, compute: 0 },
      hdrSampleCount: 4,
    })
    expect(gpu.format).toBe('rgba8unorm')
    gpu.destroy()
  })

  it("names a browser without WebGPU, and reads 4× HDR off the context's sample counts", async () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    Object.defineProperty(globalThis, 'navigator', { value: {}, configurable: true })
    try {
      // RGBA16F renders at most 2×: the HDR target drops to 1×.
      const fake = new FakeGl({ samples: { [RGBA16F]: [2] } })
      const gpu = await createGpuContext({ webgl2: { context: fake.context } })
      expect(gpu.reasons.map((r) => r.code)).toEqual(['no-webgpu'])
      expect(gpu.capabilities.hdrSampleCount).toBe(1)
      gpu.destroy()
    } finally {
      if (saved) Object.defineProperty(globalThis, 'navigator', saved)
    }
  })

  it("'webgpu' never falls back; 'webgl2' never asks WebGPU", async () => {
    await expect(createGpuContext({ gpu: noAdapter, backend: 'webgpu' })).rejects.toThrow(
      expect.objectContaining({ code: 'gpu/no-adapter' }),
    )
    let asked = false
    const watched = {
      requestAdapter: async () => {
        asked = true
        return null
      },
    } as unknown as GPU
    const gpu = await createGpuContext({
      gpu: watched,
      backend: 'webgl2',
      webgl2: { context: new FakeGl().context },
    })
    expect(asked).toBe(false)
    expect(gpu.backend).toBe('webgl2')
    expect(gpu.reasons).toEqual([])
    gpu.destroy()
  })

  it('says why neither runs, backend by backend', async () => {
    // Node has no canvas: WebGL2 can't open either.
    await expect(createGpuContext({ gpu: noAdapter })).rejects.toThrow(
      expect.objectContaining({ code: 'gpu/unsupported' }),
    )
    const result = await probeGraphics({ gpu: noAdapter })
    expect(result).toMatchObject({ backend: 'none', tier: 'none' })
    expect(result.reasons.map((r) => [r.backend, r.code])).toEqual([
      ['webgpu', 'no-adapter'],
      ['webgl2', 'no-webgl2'],
    ])
    const noFloat = await probeGraphics({
      gpu: noAdapter,
      webgl2: { context: new FakeGl({ without: ['EXT_color_buffer_float'] }).context },
    })
    expect(noFloat.reasons.at(-1)).toMatchObject({
      backend: 'webgl2',
      code: 'no-float-render-targets',
    })
    const webgl2 = await probeGraphics({
      backend: 'webgl2',
      webgl2: { context: new FakeGl().context },
    })
    expect(webgl2).toMatchObject({ backend: 'webgl2', tier: 'baseline' })
    expect(webgl2.adapter?.description).toBe('WebGL2: Fake WebGL2')
  })

  it("adds surfaces through the shim's canvas contexts, and recovers a lost device on WebGL2", async () => {
    const fake = new FakeGl()
    const gpu = await createGpuContext({
      backend: 'webgl2',
      webgl2: { context: fake.context },
      recovery: { intervalMs: 1 },
    })
    const canvas = fake.canvas as unknown as HTMLCanvasElement
    const surface = gpu.addSurface(canvas)
    expect(surface.texture().format).toBe('rgba8unorm')
    const first = gpu.device
    gpu.simulateDeviceLoss()
    await gpu.recreate()
    expect(gpu.status).toBe('ok')
    expect(gpu.device).not.toBe(first)
    expect(gpu.backend).toBe('webgl2')
    // The surface is configured for the new device.
    expect(surface.texture()).toBeDefined()
    surface.remove()
    gpu.destroy()
  })

  it("keeps the shim's error codes, and its out-of-memory errors as such", () => {
    const shim = new ShardError('gpu-webgl2/unsupported', "WebGL2 can't run compute", { hint: 'h' })
    expect(toShardError(shim, 'noise')).toMatchObject({
      code: 'gpu-webgl2/unsupported',
      message: `WebGL2 can't run compute (in "noise")`,
      hint: 'h',
      path: 'noise',
    })
    const oom = Object.assign(new Error('too big'), { name: 'GPUOutOfMemoryError' })
    expect(toShardError(oom, 'atlas').code).toBe('gpu/out-of-memory')
  })
})
