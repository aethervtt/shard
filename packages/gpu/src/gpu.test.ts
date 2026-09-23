import type { ShardError } from '@shard/core'
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
