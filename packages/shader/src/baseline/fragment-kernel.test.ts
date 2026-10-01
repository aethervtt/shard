import type { ShardError } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShaderLibrary } from '../library'
import { fragmentKernel } from './fragment-kernel'

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  full.destroy()
  compat.destroy()
})

// A kernel with every shape the transform handles: an early return, textureDimensions, a store
// followed by `return;`, a store at the end, and the layer from id.z.
const KERNEL = `
struct Params { scale: f32, bias: f32, _a: f32, _b: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var out: texture_storage_2d_array<rgba16float, write>;

@compute @workgroup_size(8, 8, 1)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let size = textureDimensions(out);
  if (gid.x >= size.x || gid.y >= size.y) { return; }
  let v = vec2f(gid.xy) / vec2f(size.xy);
  if (gid.x == 3u) {
    textureStore(out, gid.xy, gid.z, vec4f(1.0, 0.0, f32(gid.z), 1.0));
    return;
  }
  textureStore(out, gid.xy, gid.z, vec4f(v * params.scale + params.bias, f32(gid.z) * 0.25, 1.0));
}`

/** A linked module, compiled, with its errors thrown. */
async function moduleOf(
  gpu: GpuContext,
  library: ShaderLibrary,
  root: string,
): Promise<GPUShaderModule> {
  const linked = await library.link({ root })
  const module = gpu.device.createShaderModule({ code: linked.code })
  const errors = (await module.getCompilationInfo()).messages.filter((m) => m.type === 'error')
  if (errors.length > 0)
    throw new Error(`${errors.map((e) => e.message).join('\n')}\n${linked.code}`)
  return module
}

const W = 12
const H = 10
const LAYERS = 3

async function read(gpu: GpuContext, texture: GPUTexture): Promise<Uint16Array> {
  const bytesPerRow = 256
  const buffer = gpu.device.createBuffer({
    size: bytesPerRow * H * LAYERS,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow, rowsPerImage: H }, [W, H, LAYERS])
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const all = new Uint16Array(buffer.getMappedRange().slice(0))
  buffer.destroy()
  // Tight texels, row by row.
  const out = new Uint16Array(W * H * LAYERS * 4)
  for (let l = 0; l < LAYERS; l++) {
    for (let y = 0; y < H; y++) {
      const src = ((l * H + y) * bytesPerRow) / 2
      out.set(all.subarray(src, src + W * 4), (l * H + y) * W * 4)
    }
  }
  return out
}

function paramsBuffer(gpu: GpuContext): GPUBuffer {
  const buffer = gpu.device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  gpu.device.queue.writeBuffer(buffer, 0, new Float32Array([2, 0.125, 0, 0]))
  return buffer
}

describe('image kernels as fragment passes (0064)', () => {
  it('render what the compute kernel stores, texel for texel, on a compatibility device', async () => {
    // The full tier: the kernel as written.
    const library = new ShaderLibrary()
    library.register('test::kernel', KERNEL)
    const cs = await moduleOf(full, library, 'test::kernel')
    const computeTarget = full.device.createTexture({
      size: [W, H, LAYERS],
      format: 'rgba16float',
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.COPY_SRC,
    })
    const compute = full.device.createComputePipeline({
      layout: 'auto',
      compute: { module: cs, entryPoint: 'main' },
    })
    const encoder = full.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(compute)
    pass.setBindGroup(
      0,
      full.device.createBindGroup({
        layout: compute.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuffer(full) } },
          { binding: 1, resource: computeTarget.createView({ dimension: '2d-array' }) },
        ],
      }),
    )
    pass.dispatchWorkgroups(Math.ceil(W / 8), Math.ceil(H / 8), LAYERS)
    pass.end()
    full.device.queue.submit([encoder.finish()])
    const expected = await read(full, computeTarget)

    // Baseline: the fragment form, one pass per layer.
    const kernel = fragmentKernel(KERNEL, 'main', 'test::kernel')
    expect(kernel).toMatchObject({ format: 'rgba16float', group: 0, binding: 1 })
    const fragment = new ShaderLibrary()
    fragment.register('test::kernel', kernel.source)
    fragment.register(
      'test::fullscreen',
      `@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = vec2f(f32((i << 1u) & 2u), f32(i & 2u));
  return vec4f(xy * 2.0 - 1.0, 0.0, 1.0);
}`,
    )
    const fs = await moduleOf(compat, fragment, 'test::kernel')
    const vs = await moduleOf(compat, fragment, 'test::fullscreen')
    const target = compat.device.createTexture({
      size: [W, H, LAYERS],
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const layout = compat.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
      ],
    })
    const render = compat.device.createRenderPipeline({
      layout: compat.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: vs, entryPoint: 'vs' },
      fragment: { module: fs, entryPoint: 'main', targets: [{ format: 'rgba16float' }] },
    })
    const params = paramsBuffer(compat)
    const draw = compat.device.createCommandEncoder()
    for (let layer = 0; layer < LAYERS; layer++) {
      const t = compat.device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      compat.device.queue.writeBuffer(t, 0, new Uint32Array([W, H, LAYERS, layer]))
      const rp = draw.beginRenderPass({
        colorAttachments: [
          {
            view: target.createView({ dimension: '2d', baseArrayLayer: layer, arrayLayerCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [0, 0, 0, 0],
          },
        ],
      })
      rp.setPipeline(render)
      rp.setBindGroup(
        0,
        compat.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: { buffer: params } },
            { binding: 1, resource: { buffer: t } },
          ],
        }),
      )
      rp.draw(3)
      rp.end()
    }
    compat.device.queue.submit([draw.finish()])
    expect(await read(compat, target)).toEqual(expected)
    expect(compat.errors).toEqual([])
  })

  it('refuses kernels that aren’t image kernels', () => {
    const two = `@group(0) @binding(0) var a: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var b: texture_storage_2d<rgba16float, write>;
@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) {
  textureStore(a, id.xy, vec4f(1.0));
  textureStore(b, id.xy, vec4f(1.0));
}`
    expect(() => fragmentKernel(two)).toThrow(/exactly one storage texture/)
    const passed = `@group(0) @binding(0) var a: texture_storage_2d<rgba16float, write>;
fn put(t: texture_storage_2d<rgba16float, write>, p: vec2u) { textureStore(t, p, vec4f(1.0)); }
@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id: vec3u) { put(a, id.xy); }`
    try {
      fragmentKernel(passed, 'main', 'test::passed')
      expect.unreachable()
    } catch (err) {
      expect((err as ShardError).code).toBe('shader/fragment-kernel')
      expect((err as ShardError).message).toContain('test::passed')
    }
  })
})
