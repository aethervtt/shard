import { afterEach, describe, expect, it } from 'vitest'
import { SHARED_OWNER } from './ledger'
import { createNodeGpuContext, headlessCanvas } from './node'

const devices: { destroy(): void }[] = []
afterEach(() => {
  for (const d of devices.splice(0)) d.destroy()
})

async function device() {
  const gpu = await createNodeGpuContext()
  devices.push(gpu)
  return gpu
}

describe('surfaces (0052)', () => {
  it('configures each canvas with its own alpha mode, and unconfigures it on remove', async () => {
    const gpu = await device()
    const table = headlessCanvas(8, 8)
    const dice = headlessCanvas(8, 8)
    const a = gpu.addSurface(table)
    const b = gpu.addSurface(dice, { alpha: 'premultiplied' })
    expect(gpu.surfaces).toEqual([a, b])
    expect(table.gpuContext.configuration?.alphaMode).toBe('opaque')
    expect(dice.gpuContext.configuration?.alphaMode).toBe('premultiplied')
    expect([b.label, b.width, b.height, b.format]).toEqual(['surface-2', 8, 8, gpu.format])
    expect(b.texture().width).toBe(8)
    expect(() => gpu.addSurface(dice)).toThrow(
      expect.objectContaining({ code: 'gpu/duplicate-surface' }),
    )
    b.remove()
    b.remove()
    expect(dice.gpuContext.configuration).toBeUndefined()
    expect(gpu.surfaces).toEqual([a])
  })

  it('restores a premultiplied surface as premultiplied after a device loss', async () => {
    const gpu = await device()
    const canvas = headlessCanvas(4, 4)
    gpu.addSurface(canvas, { alpha: 'premultiplied' })
    const before = gpu.device
    const lost = new Promise<void>((resolve) => gpu.onDeviceLost(() => resolve()))
    gpu.simulateDeviceLoss()
    await lost
    // Every app on the device asks; they get one new device.
    await Promise.all([gpu.recreate(), gpu.recreate()])
    expect(gpu.device).not.toBe(before)
    expect(gpu.generation).toBe(1)
    expect(canvas.gpuContext.configuration?.device).toBe(gpu.device)
    expect(canvas.gpuContext.configuration?.alphaMode).toBe('premultiplied')
  })

  it('resizes from a ResizeObserver and tells listeners', async () => {
    const gpu = await device()
    const observed: ((entries: unknown[]) => void)[] = []
    const g = globalThis as Record<string, unknown>
    const saved = g.ResizeObserver
    g.ResizeObserver = class {
      constructor(fn: (entries: unknown[]) => void) {
        observed.push(fn)
      }
      observe() {}
      disconnect() {
        observed.length = 0
      }
    }
    try {
      const canvas = Object.assign(headlessCanvas(1, 1), { clientWidth: 10, clientHeight: 5 })
      const surface = gpu.addSurface(canvas)
      expect([surface.width, surface.height]).toEqual([10, 5]) // measured once up front
      let resized = 0
      surface.onResize(() => resized++)
      observed[0]!([{ devicePixelContentBoxSize: [{ inlineSize: 40, blockSize: 20 }] }])
      expect([canvas.width, canvas.height, resized]).toEqual([40, 20, 1])
      observed[0]!([{ devicePixelContentBoxSize: [{ inlineSize: 40, blockSize: 20 }] }])
      expect(resized).toBe(1)
      surface.remove()
      expect(observed).toHaveLength(0)
    } finally {
      g.ResizeObserver = saved
    }
  })
})

describe('GPU accounting (0052)', () => {
  it('counts buffers and textures per owner, uncounts destroyed ones, and releases the rest', async () => {
    const gpu = await device()
    const base = gpu.stats()
    const kept = gpu.withOwner('test/a', () => {
      const buffer = gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM })
      gpu.device.createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        mipLevelCount: 3,
        usage: GPUTextureUsage.TEXTURE_BINDING,
      })
      return buffer
    })
    gpu.withOwner('test/b', () =>
      gpu.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM }),
    )
    // 4×4 + 2×2 + 1×1 texels of 4 bytes.
    expect(gpu.stats('test/a')).toEqual({ buffers: 1, textures: 1, bytes: 256 + (16 + 4 + 1) * 4 })
    expect(gpu.owners()).toEqual(['test/a', 'test/b'])
    kept.destroy()
    expect(gpu.stats('test/a')).toEqual({ buffers: 0, textures: 1, bytes: 84 })
    expect(gpu.release('test/a')).toBe(1)
    expect(gpu.stats('test/a')).toEqual({ buffers: 0, textures: 0, bytes: 0 })
    expect(gpu.stats('test/b').buffers).toBe(1)
    expect(gpu.stats().buffers).toBe(base.buffers + 1)
  })

  it('makes shared objects once per device, counted against the device', async () => {
    const gpu = await device()
    let made = 0
    const make = () =>
      gpu.withOwner('test/app', () =>
        gpu.shared('test/identity', (d) => {
          made++
          return d.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM })
        }),
      )
    const first = make()
    expect(make()).toBe(first)
    expect(made).toBe(1)
    expect(gpu.stats('test/app').buffers).toBe(0)
    expect(gpu.stats(SHARED_OWNER).buffers).toBeGreaterThanOrEqual(1)
  })
})
