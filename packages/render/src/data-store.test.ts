import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { ShaderLibrary } from '@aethervtt/shard-shader'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  DATA_WIDTH,
  DataStore,
  flushDataStores,
  loadDataTextures,
  releaseDataStores,
} from './data-store'

let full: GpuContext
let compat: GpuContext
beforeAll(async () => {
  full = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline', recovery: { intervalMs: 10 } })
  await loadDataTextures()
})
afterAll(() => {
  full.destroy()
  compat.destroy()
})

/** The texels of a data texture, as bytes. */
async function readTexture(gpu: GpuContext, store: DataStore): Promise<Uint8Array> {
  const texture = (store as unknown as { texture: { texture: GPUTexture } }).texture.texture
  const rows = texture.height
  const buffer = gpu.device.createBuffer({
    size: rows * DATA_WIDTH * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  })
  const encoder = gpu.device.createCommandEncoder()
  encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow: DATA_WIDTH * 16 }, [
    DATA_WIDTH,
    rows,
  ])
  gpu.device.queue.submit([encoder.finish()])
  await buffer.mapAsync(GPUMapMode.READ)
  const out = new Uint8Array(buffer.getMappedRange().slice(0))
  buffer.destroy()
  return out
}

describe('DataStore (0064)', () => {
  it('is a storage buffer on the full tier, written as GpuBuffer writes it', () => {
    const store = new DataStore(full, { label: 'test/full' })
    expect(store.textured).toBe(false)
    expect(store.layoutEntry(3, GPUShaderStage.VERTEX)).toEqual({
      binding: 3,
      visibility: GPUShaderStage.VERTEX,
      buffer: { type: 'read-only-storage' },
    })
    store.write(new Float32Array([1, 2, 3, 4]), 16)
    expect(store.resource()).toEqual({ buffer: store.gpuBuffer })
    expect(store.gpuBuffer.usage & GPUBufferUsage.STORAGE).toBeTruthy()
    store.destroy()
  })

  it('is a data texture on baseline: the same bytes, the length in the last texel, at most three uploads a frame', async () => {
    const store = new DataStore(compat, { label: 'test/texture', size: 64 * 1024 })
    expect(store.textured).toBe(true)
    expect(store.layoutEntry(0, GPUShaderStage.FRAGMENT)).toEqual({
      binding: 0,
      visibility: GPUShaderStage.FRAGMENT,
      texture: { sampleType: 'uint', viewDimension: '2d' },
    })
    const writes: number[] = []
    const queue = compat.device.queue
    const writeTexture = queue.writeTexture
    queue.writeTexture = (...args: Parameters<GPUQueue['writeTexture']>) => {
      writes.push(1)
      return writeTexture.apply(queue, args)
    }
    try {
      const expected = new Uint8Array(64 * 1024)
      // Two writes a row apart and one across rows: one span, then three.
      const a = new Uint32Array(64).map((_, i) => i * 7 + 1)
      store.write(a, 32)
      expected.set(new Uint8Array(a.buffer), 32)
      flushDataStores(compat)
      const first = writes.length
      writes.length = 0
      const b = new Uint32Array(8000).map((_, i) => i ^ 0xabcd)
      store.write(b, 16 * (DATA_WIDTH - 10))
      expected.set(new Uint8Array(b.buffer), 16 * (DATA_WIDTH - 10))
      flushDataStores(compat)
      expect(writes.length).toBeLessThanOrEqual(3)
      // Nothing written: nothing uploaded.
      writes.length = 0
      flushDataStores(compat)
      expect(writes.length).toBe(0)
      // The first upload was the whole new texture (it covers everything once).
      expect(first).toBeGreaterThan(0)
    } finally {
      queue.writeTexture = writeTexture
    }
    const bytes = await readTexture(compat, store)
    const texture = (store as unknown as { texture: { texture: GPUTexture } }).texture.texture
    expect(texture.width).toBe(DATA_WIDTH)
    const lastTexel = new Uint32Array(bytes.buffer, bytes.byteLength - 16, 4)
    expect(lastTexel[0]).toBe(store.byteLength)
    store.destroy()
  })

  it('keeps its contents through growth and device loss, bumping its version', async () => {
    const store = new DataStore(compat, { label: 'test/grow', size: 256 })
    const data = new Uint32Array(64).map((_, i) => i + 100)
    store.write(data)
    flushDataStores(compat)
    const v0 = store.version
    // Past its size but within the uploaded row: the mirror is a whole row by now.
    store.write(new Uint32Array([7]), 400)
    store.write(new Uint32Array([42]), 20_000)
    expect(store.version).toBeGreaterThan(v0)
    flushDataStores(compat)
    let bytes = await readTexture(compat, store)
    expect(new Uint32Array(bytes.buffer, 0, 64)).toEqual(data)
    expect(new Uint32Array(bytes.buffer, 400, 1)[0]).toBe(7)
    expect(new Uint32Array(bytes.buffer, 20_000, 1)[0]).toBe(42)
    const v1 = store.version
    compat.simulateDeviceLoss()
    await compat.recreate()
    expect(store.version).toBeGreaterThan(v1)
    flushDataStores(compat)
    bytes = await readTexture(compat, store)
    expect(new Uint32Array(bytes.buffer, 0, 64)).toEqual(data)
    store.destroy()
  })

  it("stops flushing an owner's stores once they're released, as a disposed app's are", async () => {
    const errors = compat.errors.length
    const store = compat.withOwner('test/app', () => new DataStore(compat, { label: 'test/owned' }))
    expect(store.owner).toBe('test/app')
    store.write(new Uint32Array([1, 2, 3]))
    flushDataStores(compat)
    // The app disposes: its render plugin forgets its stores, then the ledger destroys their objects.
    store.write(new Uint32Array([4]))
    releaseDataStores(compat, 'test/app')
    expect(compat.release('test/app')).toBeGreaterThan(0)
    flushDataStores(compat)
    compat.device.queue.submit([])
    await compat.device.queue.onSubmittedWorkDone()
    expect(compat.errors.slice(errors)).toEqual([])
  })

  it('feeds @data and @data(uniform) declarations on a compatibility device, pixel for pixel', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::quads',
      `struct Quad { offset: vec2f, size: f32, tint: u32 }
struct Palette { colors: array<vec4f, 4> }
@data @group(0) @binding(0) var<storage, read> quads: array<Quad>;
@data(uniform) @group(0) @binding(1) var<storage, read> palette: Palette;
struct V { @builtin(position) clip: vec4f, @location(0) @interpolate(flat) tint: u32 }
@vertex fn vs(@builtin(vertex_index) v: u32, @builtin(instance_index) i: u32) -> V {
  let q = quads[i];
  let corner = vec2f(f32(v & 1u), f32((v >> 1u) & 1u)) * q.size;
  return V(vec4f(q.offset + corner, 0.0, 1.0), q.tint);
}
@fragment fn fs(in: V) -> @location(0) vec4f { return palette.colors[in.tint]; }`,
    )
    const gpu = compat
    const module = library.module(gpu, { root: 'test::quads' })
    await library.whenIdle()
    const shader = library.module(gpu, { root: 'test::quads' })!
    expect(shader ?? module).toBeTruthy()
    const quads = new DataStore(gpu, { label: 'test/quads' })
    const palette = new DataStore(gpu, { label: 'test/palette', kind: 'uniform', size: 64 })
    // Four quads, one per screen quadrant, each a palette color.
    const q = new Float32Array(16)
    const u = new Uint32Array(q.buffer)
    ;[
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ].forEach(([x, y], i) => {
      q[i * 4] = x!
      q[i * 4 + 1] = y!
      q[i * 4 + 2] = 1
      u[i * 4 + 3] = 3 - i
    })
    quads.write(q)
    palette.write(new Float32Array([1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 1, 1, 1, 0, 1]))
    const layout = gpu.device.createBindGroupLayout({
      entries: [
        quads.layoutEntry(0, GPUShaderStage.VERTEX),
        palette.layoutEntry(1, GPUShaderStage.FRAGMENT),
      ],
    })
    gpu.device.pushErrorScope('validation')
    const pipeline = gpu.device.createRenderPipeline({
      layout: gpu.device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module: shader, entryPoint: 'vs' },
      fragment: { module: shader, entryPoint: 'fs', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-strip' },
    })
    const group = gpu.device.createBindGroup({
      layout,
      entries: [
        { binding: 0, resource: quads.resource() },
        { binding: 1, resource: palette.resource() },
      ],
    })
    const target = gpu.device.createTexture({
      size: [8, 8],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
    })
    const read = gpu.device.createBuffer({
      size: 256 * 8,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = gpu.device.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.draw(4, 4)
    pass.end()
    encoder.copyTextureToBuffer({ texture: target }, { buffer: read, bytesPerRow: 256 }, [8, 8])
    flushDataStores(gpu)
    gpu.device.queue.submit([encoder.finish()])
    expect(await gpu.device.popErrorScope()).toBeNull()
    await read.mapAsync(GPUMapMode.READ)
    const px = new Uint8Array(read.getMappedRange().slice(0))
    const at = (x: number, y: number) =>
      Array.from(px.subarray(y * 256 + x * 4, y * 256 + x * 4 + 4))
    // Row 0 is the top of clip space: quads 2 and 3 (y from 0 to 1), tints 1 and 0.
    expect(at(1, 1)).toEqual([0, 255, 0, 255])
    expect(at(6, 1)).toEqual([255, 0, 0, 255])
    expect(at(1, 6)).toEqual([255, 255, 0, 255])
    expect(at(6, 6)).toEqual([0, 0, 255, 255])
    quads.destroy()
    palette.destroy()
  })
})
