import type { ShardError } from '@aethervtt/shard-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GpuBuffer } from './buffer'
import type { GpuContext } from './context'
import { createNodeGpuContext } from './node'

let gpu: GpuContext

beforeAll(async () => {
  gpu = await createNodeGpuContext({ features: ['timestamp-query'] })
})
afterAll(() => gpu.destroy())

const shader = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4f(f32(i % 2u), f32(i / 2u), 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }
`

function pipelineDescriptor(label = 'test-pipeline'): GPURenderPipelineDescriptor {
  const module =
    moduleCache ?? gpu.device.createShaderModule({ label: 'test-shader', code: shader })
  moduleCache = module
  return {
    label,
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
  }
}
let moduleCache: GPUShaderModule | undefined

describe('GpuBuffer', () => {
  it('grows by doubling and bumps its version', () => {
    const buf = new GpuBuffer(gpu, {
      label: 'test-buffer',
      usage: GPUBufferUsage.STORAGE,
      size: 64,
    })
    const first = buf.buffer
    expect(buf.ensureCapacity(32)).toBe(false)
    expect(buf.ensureCapacity(200)).toBe(true)
    expect(buf.byteLength).toBe(256)
    expect(buf.version).toBe(1)
    expect(buf.buffer).not.toBe(first)
    buf.write(new Float32Array(100)) // 400 bytes: grows again
    expect(buf.byteLength).toBe(512)
    buf.destroy()
  })
})

describe('PipelineCache', () => {
  it('skips while compiling, then returns the same pipeline for equal descriptors', async () => {
    gpu.pipelines.skipped = 0
    expect(gpu.pipelines.render(pipelineDescriptor())).toBeUndefined()
    expect(gpu.pipelines.pending).toBe(1)
    await gpu.pipelines.whenIdle()
    const a = gpu.pipelines.render(pipelineDescriptor())
    const b = gpu.pipelines.render(pipelineDescriptor('another label, same pipeline'))
    expect(a).toBeDefined()
    expect(b).toBe(a)
    expect(gpu.pipelines.skipped).toBe(1)
  })

  it('counts the wall time pipelines were compiling (0062)', async () => {
    const before = gpu.pipelines.busyMs()
    // From before the first compile starts: creating the second's module takes a few ms on a
    // software GPU, and the first is compiling all the while.
    const start = performance.now()
    gpu.pipelines.render(pipelineDescriptor('busy-a'))
    gpu.pipelines.compute({
      label: 'busy-b',
      layout: 'auto',
      compute: {
        module: gpu.device.createShaderModule({ code: '@compute @workgroup_size(1) fn main() {}' }),
        entryPoint: 'main',
      },
    })
    await gpu.pipelines.whenIdle()
    const elapsed = performance.now() - start
    const busy = gpu.pipelines.busyMs() - before
    expect(busy).toBeGreaterThan(0)
    // Two overlapping compiles count once: no more than the wall time they took.
    expect(busy).toBeLessThanOrEqual(elapsed + 1)
    expect(gpu.pipelines.busyMs()).toBe(gpu.pipelines.busyMs())
  })

  it('reports invalid pipelines as gpu/validation with the label', async () => {
    const errors: ShardError[] = []
    const off = gpu.onError((e) => errors.push(e))
    const module = gpu.device.createShaderModule({ label: 'broken-shader', code: shader })
    gpu.pipelines.render({
      label: 'broken-pipeline',
      layout: 'auto',
      vertex: { module, entryPoint: 'does_not_exist' },
    })
    await gpu.pipelines.whenIdle()
    off()
    expect(errors[0]).toMatchObject({ code: 'gpu/validation', path: 'broken-pipeline' })
    expect(errors[0]?.message).toContain('broken-pipeline')
  })
})

describe('memory (0062)', () => {
  it('splits live bytes by what the objects are for', () => {
    const owner = 'test/memory'
    gpu.withOwner(owner, () => {
      gpu.device.createBuffer({ size: 256, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST })
      gpu.device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM })
      gpu.device.createBuffer({
        size: 128,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      gpu.device.createBuffer({ size: 512, usage: GPUBufferUsage.STORAGE })
      gpu.device.createTexture({
        size: [4, 4],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      gpu.device.createTexture({
        size: [8, 8],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
    })
    const memory = gpu.memory(owner)
    expect(memory.byCategory).toEqual({
      geometry: 256,
      uniforms: 64,
      staging: 128,
      storage: 512,
      targets: 64,
      textures: 256,
    })
    expect(memory.bytes).toBe(gpu.stats(owner).bytes)
    gpu.release(owner)
    expect(gpu.memory(owner)).toEqual({ bytes: 0, byCategory: {} })
  })

  it('records how long the device request took', () => {
    expect(gpu.deviceMs).toBeGreaterThan(0)
  })
})

describe('LayoutCache', () => {
  it('returns the same object for equal descriptors', () => {
    const a = gpu.layouts.sampler({ magFilter: 'linear' })
    expect(gpu.layouts.sampler({ magFilter: 'linear' })).toBe(a)
    expect(gpu.layouts.sampler({ magFilter: 'nearest' })).not.toBe(a)
    const entries: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
    ]
    expect(gpu.layouts.bindGroupLayout({ entries })).toBe(gpu.layouts.bindGroupLayout({ entries }))
  })
})

describe('validate()', () => {
  it('reports validation errors from a scope with the label', async () => {
    const errors: ShardError[] = []
    const off = gpu.onError((e) => errors.push(e))
    gpu.validate('bad-buffer', () =>
      gpu.device.createBuffer({
        label: 'bad-buffer',
        size: 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.MAP_WRITE,
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    off()
    expect(errors[0]).toMatchObject({ code: 'gpu/validation', path: 'bad-buffer' })
  })
})

describe('device loss', () => {
  it('notifies listeners and recovers with a new device', async () => {
    const own = await createNodeGpuContext()
    const buffer = new GpuBuffer(own, { label: 'survivor', usage: GPUBufferUsage.STORAGE })
    const lost: string[] = []
    own.onDeviceLost((info) => lost.push(info.reason))
    own.simulateDeviceLoss()
    expect(lost).toEqual(['unknown'])
    await own.recreate()
    expect(own.generation).toBe(1)
    const before = buffer.version
    expect(buffer.buffer).toBeDefined() // rebuilt on the new device
    expect(buffer.version).toBe(before + 1)
    buffer.write(new Float32Array([1, 2, 3]))
    own.destroy()
  })
})
