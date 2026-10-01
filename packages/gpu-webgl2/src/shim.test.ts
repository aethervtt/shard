import { allocationChecks, gcWindow } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'
import { BufferUsage, TextureUsage } from './constants'
import { FakeGl, type FakeGlOptions, type FakeTexture } from './fake-gl'
import { GL } from './gl'
import { createWebgl2Gpu, type Webgl2GpuOptions } from './gpu'
import { canvasContext } from './present'
import { floatToHalf } from './readback'
import type { Webgl2Buffer, Webgl2Texture } from './resources'

// The WebGL2 shim (0064 stage 2) against a fake context: what each WebGPU call becomes in GL, and
// bytes through uploads, copies and readbacks. Real naga translates the shaders.

async function open(options: FakeGlOptions & Pick<Webgl2GpuOptions, 'profile'> = {}) {
  const fake = new FakeGl(options)
  const gpu = createWebgl2Gpu({
    context: fake.context,
    profile: options.profile,
    checkErrors: true,
  })
  const adapter = await gpu.requestAdapter()
  if (!adapter) throw new Error('no adapter')
  const shim = await adapter.requestDevice()
  const device = shim as unknown as GPUDevice
  return { fake, gpu, adapter, shim, device }
}

const SHADER = /* wgsl */ `
struct View { view_proj: mat4x4f, tint: vec4f }
@group(0) @binding(0) var<uniform> view: View;
@group(1) @binding(0) var albedo: texture_2d<f32>;
@group(1) @binding(1) var albedo_sampler: sampler;
@group(1) @binding(2) var data: texture_2d<u32>;

struct Out {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat, either) id: u32,
}

@vertex fn vs(@builtin(instance_index) i: u32, @location(0) position: vec3f, @location(1) slot: u32) -> Out {
  var out: Out;
  out.clip = view.view_proj * vec4f(position, 1.0);
  out.uv = position.xy;
  out.id = textureLoad(data, vec2i(i32(i + slot), 0), 0).x;
  return out;
}

@fragment fn fs(in: Out) -> @location(0) vec4f {
  return textureSample(albedo, albedo_sampler, in.uv) * view.tint + f32(in.id);
}
`

/** The textured, instanced pipeline of SHADER, its layouts, and a bind group set to draw with. */
async function scene(
  device: GPUDevice,
  options: { topology?: GPUPrimitiveTopology; dynamic?: boolean } = {},
) {
  const viewLayout = device.createBindGroupLayout({
    label: 'view',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform', hasDynamicOffset: options.dynamic === true },
      },
    ],
  })
  const materialLayout = device.createBindGroupLayout({
    label: 'material',
    entries: [
      { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 2, visibility: GPUShaderStage.VERTEX, texture: { sampleType: 'uint' } },
    ],
  })
  const module = device.createShaderModule({ label: 'scene', code: SHADER })
  const pipeline = await device.createRenderPipelineAsync({
    label: 'scene',
    layout: device.createPipelineLayout({ bindGroupLayouts: [viewLayout, materialLayout] }),
    vertex: {
      module,
      buffers: [
        { arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] },
        {
          arrayStride: 4,
          stepMode: 'instance',
          attributes: [{ shaderLocation: 1, offset: 0, format: 'uint32' }],
        },
      ],
    },
    fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: options.topology ?? 'triangle-list', cullMode: 'back' },
  })
  const uniforms = device.createBuffer({
    label: 'view',
    size: 1024,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  })
  const albedo = device.createTexture({
    label: 'albedo',
    size: [8, 8],
    mipLevelCount: 4,
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const data = device.createTexture({
    label: 'data',
    size: [4, 1],
    format: 'r32uint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
  })
  const viewGroup = device.createBindGroup({
    layout: viewLayout,
    entries: [{ binding: 0, resource: { buffer: uniforms, size: 80 } }],
  })
  const materialGroup = device.createBindGroup({
    layout: materialLayout,
    entries: [
      { binding: 0, resource: albedo.createView({ baseMipLevel: 1, mipLevelCount: 2 }) },
      { binding: 1, resource: sampler },
      { binding: 2, resource: data.createView() },
    ],
  })
  const positions = device.createBuffer({
    label: 'positions',
    size: 1200,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  const slots = device.createBuffer({
    label: 'slots',
    size: 64,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  })
  const target = device.createTexture({
    label: 'target',
    size: [4, 4],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  })
  return {
    pipeline,
    uniforms,
    albedo,
    data,
    sampler,
    viewGroup,
    materialGroup,
    positions,
    slots,
    target,
  }
}

type Scene = Awaited<ReturnType<typeof scene>>

function pass(device: GPUDevice, s: Scene, draw: (p: GPURenderPassEncoder) => void) {
  const encoder = device.createCommandEncoder()
  const p = encoder.beginRenderPass({
    colorAttachments: [
      { view: s.target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] },
    ],
  })
  p.setPipeline(s.pipeline)
  p.setBindGroup(0, s.viewGroup, [0])
  p.setBindGroup(1, s.materialGroup)
  p.setVertexBuffer(0, s.positions)
  p.setVertexBuffer(1, s.slots)
  draw(p)
  p.end()
  device.queue.submit([encoder.finish()])
}

const glOf = (texture: GPUTexture) =>
  (texture as unknown as Webgl2Texture).gl as unknown as FakeTexture

describe('the WebGL2 adapter (0064)', () => {
  it('reads features and limits off GL, offers a baseline device, and needs float targets', async () => {
    const { adapter, fake, device } = await open({ samples: { [GL.R11F_G11F_B10F]: [4, 2] } })
    expect(adapter.featureLevel).toBe('compatibility')
    expect(adapter.limits.maxStorageBuffersInVertexStage).toBe(0)
    expect(adapter.limits.maxStorageBuffersInFragmentStage).toBe(0)
    expect(adapter.limits.maxComputeInvocationsPerWorkgroup).toBe(0)
    expect(adapter.limits.maxTextureDimension2D).toBe(8192)
    expect(adapter.limits.minUniformBufferOffsetAlignment).toBe(256)
    expect([...adapter.features].sort()).toEqual([
      'depth32float-stencil8',
      'float32-blendable',
      'float32-filterable',
      'rg11b10ufloat-renderable',
    ])
    expect(adapter.features.has('timestamp-query')).toBe(false)
    // The device has what it asked for, and depth in [0, 1] through EXT_clip_control.
    expect([...device.features]).toEqual([])
    expect(fake.extensionCalls).toContain('clipControlEXT')
    expect(adapter.info.description).toBe('WebGL2: Fake WebGL2')

    const without = createWebgl2Gpu({
      context: new FakeGl({ without: ['EXT_color_buffer_float'] }).context,
    })
    expect(await without.requestAdapter()).toBeNull()
  })

  it("holds the 'minimum' profile to WebGL2's floor", async () => {
    const { adapter, fake } = await open({ profile: 'minimum' })
    expect(adapter.limits.maxTextureDimension2D).toBe(2048)
    expect(adapter.limits.maxColorAttachments).toBe(4)
    expect(adapter.limits.maxSampledTexturesPerShaderStage).toBe(16)
    expect(adapter.features.has('float32-filterable')).toBe(false)
    expect(fake.extensionCalls).not.toContain('clipControlEXT')
  })

  it('refuses features it lacks, and makes one device', async () => {
    const fake = new FakeGl()
    const gpu = createWebgl2Gpu({ context: fake.context })
    const adapter = await gpu.requestAdapter()
    await expect(adapter!.requestDevice({ requiredFeatures: ['timestamp-query'] })).rejects.toThrow(
      TypeError,
    )
    await adapter!.requestDevice()
    await expect(adapter!.requestDevice()).rejects.toThrow(/already made its device/)
    expect(gpu.getPreferredCanvasFormat()).toBe('rgba8unorm')
    expect(globalThis.GPUBufferUsage.STORAGE).toBe(0x80)
  })
})

describe('the WebGL2 device: copies and readbacks', () => {
  const formats: {
    format: GPUTextureFormat
    bytes: number
    texel: (i: number, out: DataView, at: number) => void
  }[] = [
    {
      format: 'rgba8unorm',
      bytes: 4,
      texel: (i, o, at) => o.setUint32(at, (i * 0x01020304) >>> 0, true),
    },
    { format: 'r8unorm', bytes: 1, texel: (i, o, at) => o.setUint8(at, (i * 37) & 0xff) },
    {
      format: 'rg8unorm',
      bytes: 2,
      texel: (i, o, at) => o.setUint16(at, (i * 4099) & 0xffff, true),
    },
    { format: 'r32uint', bytes: 4, texel: (i, o, at) => o.setUint32(at, i * 100_003, true) },
    {
      format: 'rgba32uint',
      bytes: 16,
      texel: (i, o, at) => {
        for (let c = 0; c < 4; c++) o.setUint32(at + c * 4, i * 7 + c, true)
      },
    },
    { format: 'r32float', bytes: 4, texel: (i, o, at) => o.setFloat32(at, i * 0.375 - 2, true) },
    {
      format: 'rg16float',
      bytes: 4,
      texel: (i, o, at) => {
        for (let c = 0; c < 2; c++) o.setUint16(at + c * 2, floatToHalf(i * 0.25 + c), true)
      },
    },
    {
      format: 'rgba16float',
      bytes: 8,
      texel: (i, o, at) => {
        for (let c = 0; c < 4; c++) o.setUint16(at + c * 2, floatToHalf(c - i * 0.125), true)
      },
    },
    {
      format: 'rg11b10ufloat',
      bytes: 4,
      // Exactly representable: mantissas 0..63 / 0..31 at exponent 15 (1.x).
      texel: (i, o, at) =>
        o.setUint32(
          at,
          (15 << 6) |
            (i & 63) |
            (((15 << 6) | ((i * 3) & 63)) << 11) |
            (((15 << 5) | (i & 31)) << 22),
          true,
        ),
    },
  ]

  it.each(formats)(
    'writes $format with any row pitch and reads it back as WebGPU lays it out',
    async ({ format, bytes, texel }) => {
      const { device } = await open()
      const width = 5
      const height = 3
      const layers = 2
      const texture = device.createTexture({
        label: format,
        size: [width, height, layers],
        format,
        usage:
          GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC,
        textureBindingViewDimension: '2d-array',
      } as GPUTextureDescriptor)
      // Rows padded past their texels, starting 8 bytes in: what a sub-allocated upload looks like.
      const pitch = width * bytes + 8
      const offset = 8
      const source = new Uint8Array(offset + pitch * height * layers)
      const view = new DataView(source.buffer)
      for (let l = 0; l < layers; l++) {
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++)
            texel((l * height + y) * width + x, view, offset + (l * height + y) * pitch + x * bytes)
        }
      }
      device.queue.writeTexture(
        { texture },
        source,
        { offset, bytesPerRow: pitch, rowsPerImage: height },
        [width, height, layers],
      )

      const out = device.createBuffer({
        size: 256 * height * layers,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToBuffer(
        { texture },
        { buffer: out, bytesPerRow: 256, rowsPerImage: height },
        [width, height, layers],
      )
      device.queue.submit([encoder.finish()])
      await out.mapAsync(GPUMapMode.READ)
      const read = new Uint8Array(out.getMappedRange())
      for (let l = 0; l < layers; l++) {
        for (let y = 0; y < height; y++) {
          const got = read.subarray((l * height + y) * 256, (l * height + y) * 256 + width * bytes)
          const want = source.subarray(
            offset + (l * height + y) * pitch,
            offset + (l * height + y) * pitch + width * bytes,
          )
          expect([...got], `${format} layer ${l} row ${y}`).toEqual([...want])
        }
      }
      out.unmap()
    },
  )

  it('copies a buffer into a texture region and a texture into another', async () => {
    const { device } = await open()
    const src = device.createBuffer({
      size: 512,
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    })
    const bytes = new Uint8Array(512)
    for (let i = 0; i < bytes.length; i++) bytes[i] = i & 0xff
    device.queue.writeBuffer(src, 0, bytes)
    const a = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: TextureUsage.COPY_DST | TextureUsage.COPY_SRC | TextureUsage.RENDER_ATTACHMENT,
    })
    const b = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: TextureUsage.COPY_DST | TextureUsage.COPY_SRC | TextureUsage.RENDER_ATTACHMENT,
    })
    const out = device.createBuffer({
      size: 256 * 2,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    })
    const encoder = device.createCommandEncoder()
    // Two rows of two texels, 256 bytes apart in the buffer, into (1, 1) of a.
    encoder.copyBufferToTexture(
      { buffer: src, offset: 16, bytesPerRow: 256 },
      { texture: a, origin: [1, 1] },
      [2, 2],
    )
    encoder.copyTextureToTexture(
      { texture: a, origin: [1, 1] },
      { texture: b, origin: [0, 2] },
      [2, 2],
    )
    encoder.copyTextureToBuffer(
      { texture: b, origin: [0, 2] },
      { buffer: out, bytesPerRow: 256 },
      [2, 2],
    )
    device.queue.submit([encoder.finish()])
    await out.mapAsync(GPUMapMode.READ)
    const read = new Uint8Array(out.getMappedRange())
    expect([...read.subarray(0, 8)]).toEqual([...bytes.subarray(16, 24)])
    expect([...read.subarray(256, 264)]).toEqual([...bytes.subarray(272, 280)])
  })

  it('copies between buffers, keeps index buffers checkable, and clears', async () => {
    const { device, shim } = await open()
    const a = device.createBuffer({ size: 16, usage: BufferUsage.COPY_SRC | BufferUsage.COPY_DST })
    const index = device.createBuffer({ size: 16, usage: BufferUsage.INDEX | BufferUsage.COPY_DST })
    const out = device.createBuffer({
      size: 16,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(a, 0, new Uint16Array([1, 2, 65535, 4, 5, 6, 7, 8]))
    // dataOffset and size count elements of a typed array.
    device.queue.writeBuffer(a, 12, new Uint16Array([0, 0, 9, 10, 11]), 2, 2)
    const encoder = device.createCommandEncoder()
    encoder.copyBufferToBuffer(a, 0, index, 0, 16)
    encoder.copyBufferToBuffer(index, 0, out, 0, 16)
    encoder.clearBuffer(out, 8, 4)
    device.queue.submit([encoder.finish()])
    expect([...new Uint16Array((index as unknown as Webgl2Buffer).shadow!.buffer)]).toEqual([
      1, 2, 65535, 4, 5, 6, 9, 10,
    ])
    await out.mapAsync(GPUMapMode.READ)
    expect([...new Uint16Array(out.getMappedRange())]).toEqual([1, 2, 65535, 4, 0, 0, 9, 10])
    out.unmap()
    expect(out.mapState).toBe('unmapped')
    await device.queue.onSubmittedWorkDone()
    expect(shim.isLost).toBe(false)
  })

  it('maps only readable buffers, and never for writing', async () => {
    const { device } = await open()
    const vertex = device.createBuffer({ size: 16, usage: BufferUsage.VERTEX })
    await expect(vertex.mapAsync(GPUMapMode.READ)).rejects.toThrow(
      expect.objectContaining({ name: 'OperationError' }),
    )
    const read = device.createBuffer({
      size: 16,
      usage: BufferUsage.MAP_READ | BufferUsage.COPY_DST,
    })
    await expect(read.mapAsync(GPUMapMode.WRITE)).rejects.toThrow(
      expect.objectContaining({ code: 'gpu-webgl2/unsupported' }),
    )
  })
})

describe('the WebGL2 device: drawing', () => {
  it("binds uniform blocks and textures by naga's reflection, one point and unit shared by both stages", async () => {
    const { device, fake } = await open()
    const s = await scene(device, { dynamic: true })
    pass(device, s, (p) => {
      p.setBindGroup(0, s.viewGroup, [256])
      p.draw(3, 1)
    })
    const draw = fake.draws.at(-1)!
    // View is read by both stages: one binding point, at the dynamic offset.
    expect([...draw.blocks.values()]).toEqual([
      { buffer: (s.uniforms as unknown as Webgl2Buffer).gl, offset: 256, size: 80 },
    ])
    const units = [...draw.units.values()]
    expect(units).toHaveLength(2)
    const albedo = units.find((u) => u.texture === glOf(s.albedo))!
    // The view's mips are the texture's base and max level; its sampler sits on the unit.
    expect(albedo).toMatchObject({ base: 1, max: 2, sampler: expect.anything() })
    // texelFetch reads need no sampler.
    expect(units.find((u) => u.texture === glOf(s.data))!.sampler).toBeNull()
    // WebGPU's counter-clockwise front faces are clockwise once y is flipped.
    expect(draw.frontFace).toBe(GL.CW)
    expect(draw.cullFace).toBe(GL.BACK)
    expect(draw.enabled.has(GL.CULL_FACE)).toBe(true)
  })

  it('binds a uniform struct as the 16-byte block std140 makes of it', async () => {
    // WGSL lets an 8-byte struct bind as 8 bytes; GLSL rounds its block up to 16, and WebGL fails
    // a draw with less bound.
    const { device, fake } = await open({ blockSizes: { Small: 16 } })
    const module = device.createShaderModule({
      code: `struct Small { seed: f32, relief: f32 }
@group(0) @binding(0) var<uniform> small: Small;
@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return vec4f(f32(v) * small.seed, 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(small.relief); }`,
    })
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: {} },
      ],
    })
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module },
      fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    })
    const small = device.createBuffer({
      size: 8,
      usage: BufferUsage.UNIFORM | BufferUsage.COPY_DST,
    })
    expect((small as unknown as Webgl2Buffer).allocated).toBe(16)
    const group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: { buffer: small } }],
    })
    const target = device.createTexture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    const encoder = device.createCommandEncoder()
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    })
    p.setPipeline(pipeline)
    p.setBindGroup(0, group)
    p.draw(3)
    p.end()
    device.queue.submit([encoder.finish()])
    expect([...fake.draws.at(-1)!.blocks.values()]).toEqual([
      { buffer: (small as unknown as Webgl2Buffer).gl, offset: 0, size: 16 },
    ])
  })

  it('moves attribute pointers by base vertex and first instance, and hands the shader its instance index', async () => {
    const { device, fake } = await open()
    const s = await scene(device)
    const indices = device.createBuffer({
      size: 12,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 1, 2, 0, 0, 0]))
    pass(device, s, (p) => {
      p.setVertexBuffer(0, s.positions, 24)
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexed(3, 2, 0, 10, 5)
    })
    const draw = fake.draws.at(-1)!
    expect(draw.call).toBe('drawElements')
    expect(draw.instances).toBe(2)
    const [position, slot] = [0, 1].map((l) => draw.attribs.find((a) => a.location === l)!)
    expect(position).toMatchObject({
      offset: 24 + 10 * 12,
      stride: 12,
      divisor: 0,
      integer: false,
      size: 3,
    })
    expect(slot).toMatchObject({
      offset: 5 * 4,
      stride: 4,
      divisor: 1,
      integer: true,
      type: GL.UNSIGNED_INT,
    })
    expect(draw.uniforms.get('naga_vs_first_instance')).toBe(5)
  })

  it('draws a uint16 list with 65535 from a uint32 copy; strips keep restarting', async () => {
    const { device, fake } = await open()
    const s = await scene(device)
    const indices = device.createBuffer({
      size: 8,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 65535, 2, 3]))
    pass(device, s, (p) => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexed(3, 1, 1)
    })
    const list = fake.draws.at(-1)!
    expect(list.type).toBe(GL.UNSIGNED_INT)
    expect(list.offset).toBe(4)
    expect([...new Uint32Array(list.element!.data.buffer)]).toEqual([0, 65535, 2, 3])
    // Without 65535 the buffer draws as it is.
    device.queue.writeBuffer(indices, 2, new Uint16Array([1]))
    pass(device, s, (p) => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexed(3, 1, 1)
    })
    const plain = fake.draws.at(-1)!
    expect(plain.type).toBe(GL.UNSIGNED_SHORT)
    expect(plain.offset).toBe(2)
    expect(plain.element).toBe((indices as unknown as Webgl2Buffer).gl)

    const strip = await scene(device, { topology: 'triangle-strip' })
    device.queue.writeBuffer(indices, 0, new Uint16Array([0, 65535, 2, 3]))
    pass(device, strip, (p) => {
      p.setIndexBuffer(indices, 'uint16')
      p.drawIndexed(4)
    })
    expect(fake.draws.at(-1)!.type).toBe(GL.UNSIGNED_SHORT)
  })

  it("refuses a base vertex for a shader that reads vertex_index (WebGL2 can't offset it)", async () => {
    const { device, fake } = await open()
    const module = device.createShaderModule({
      code: `@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return vec4f(f32(v), 0.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }`,
    })
    const pipeline = await device.createRenderPipelineAsync({
      label: 'reads vertex_index',
      layout: device.createPipelineLayout({ bindGroupLayouts: [] }),
      vertex: { module },
      fragment: { module, targets: [{ format: 'rgba8unorm' }] },
    })
    const target = device.createTexture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    const indices = device.createBuffer({
      size: 8,
      usage: BufferUsage.INDEX | BufferUsage.COPY_DST,
    })
    const errors: string[] = []
    device.addEventListener('uncapturederror', (e) =>
      errors.push((e as GPUUncapturedErrorEvent).error.message),
    )
    const encoder = device.createCommandEncoder()
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }],
    })
    p.setPipeline(pipeline)
    p.setIndexBuffer(indices, 'uint16')
    p.drawIndexed(3, 1, 0, 4)
    p.draw(3)
    p.end()
    const before = fake.draws.length
    device.queue.submit([encoder.finish()])
    await Promise.resolve()
    expect(fake.draws.length - before).toBe(1)
    expect(errors).toEqual([
      expect.stringContaining('"reads vertex_index" reads vertex_index with a base vertex of 4'),
    ])
  })

  it('makes a framebuffer once per set of attachments, and repeats a frame without redundant calls', async () => {
    const { device, fake } = await open()
    const s = await scene(device)
    const frame = () =>
      pass(device, s, (p) => {
        p.draw(3, 2)
      })
    frame()
    const mark = fake.calls.length
    frame()
    const again = fake.callsSince(mark)
    for (const call of [
      'createFramebuffer',
      'texParameteri',
      'bindBufferRange',
      'useProgram',
      'bindTexture',
      'bindSampler',
      'vertexAttribPointer',
      'vertexAttribIPointer',
      'enableVertexAttribArray',
      'uniformBlockBinding',
      'uniform1ui',
    ]) {
      expect(again, call).not.toContain(call)
    }
    expect(again.filter((c) => c === 'drawArraysInstanced')).toHaveLength(1)
    // Dropping the texture drops its framebuffer.
    const deleted = fake.calls.length
    s.target.destroy()
    expect(fake.callsSince(deleted)).toContain('deleteFramebuffer')
  })

  it('clears with masks open and no scissor, resolves multisampling by blit, and invalidates discards', async () => {
    const { device, fake } = await open()
    const s = await scene(device)
    const msaa = device.createTexture({
      size: [4, 4],
      sampleCount: 4,
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    const resolve = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    })
    const depth = device.createTexture({
      size: [4, 4],
      sampleCount: 4,
      format: 'depth24plus',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    // A previous pass leaves a scissor and the pipeline's write mask behind.
    pass(device, s, (p) => {
      p.setScissorRect(0, 0, 1, 1)
      p.draw(3)
    })
    const mark = fake.calls.length
    const encoder = device.createCommandEncoder()
    const p = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: msaa.createView(),
          resolveTarget: resolve.createView(),
          loadOp: 'clear',
          storeOp: 'discard',
          clearValue: { r: 1, g: 0.5, b: 0, a: 1 },
        },
      ],
      depthStencilAttachment: {
        view: depth.createView(),
        depthLoadOp: 'clear',
        depthClearValue: 1,
        depthStoreOp: 'discard',
      },
    })
    p.end()
    device.queue.submit([encoder.finish()])
    expect((msaa as unknown as Webgl2Texture).renderbuffer).not.toBeNull()
    for (const [x, y] of [
      [0, 0],
      [3, 3],
      [2, 1],
    ] as const) {
      expect(fake.texel(glOf(resolve), x, y), `${x},${y}`).toEqual([1, 0.5, 0, 1])
    }
    const calls = fake.callsSince(mark)
    expect(calls).toContain('blitFramebuffer')
    expect(calls).toContain('invalidateFramebuffer')
    expect(calls.indexOf('blitFramebuffer')).toBeLessThan(calls.indexOf('invalidateFramebuffer'))
  })

  it('clears integer targets as integers', async () => {
    const { device, fake } = await open()
    const target = device.createTexture({
      size: [2, 2],
      format: 'r32uint',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    })
    const encoder = device.createCommandEncoder()
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: target.createView(),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [4_000_000_000, 0, 0, 0],
          },
        ],
      })
      .end()
    const mark = fake.calls.length
    device.queue.submit([encoder.finish()])
    expect(fake.callsSince(mark)).toContain('clearBufferuiv')
    expect(fake.texel(glOf(target), 1, 1)[0]).toBe(4_000_000_000)
  })

  it('renders into cube faces, array layers and 3D slices', async () => {
    const { device, fake } = await open()
    const cube = device.createTexture({
      size: [2, 2, 6],
      format: 'rgba16float',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
      textureBindingViewDimension: 'cube',
    } as GPUTextureDescriptor)
    const volume = device.createTexture({
      size: [2, 2, 4],
      dimension: '3d',
      format: 'rgba16float',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    })
    const encoder = device.createCommandEncoder()
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: cube.createView({ dimension: '2d', baseArrayLayer: 4, arrayLayerCount: 1 }),
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [4, 0, 0, 1],
          },
        ],
      })
      .end()
    encoder
      .beginRenderPass({
        colorAttachments: [
          {
            view: volume.createView(),
            depthSlice: 2,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue: [2, 0, 0, 1],
          },
        ],
      })
      .end()
    device.queue.submit([encoder.finish()])
    expect(glOf(cube).target).toBe(GL.TEXTURE_CUBE_MAP)
    expect(fake.texel(glOf(cube), 0, 0, 0, 4)[0]).toBe(4)
    expect(fake.texel(glOf(cube), 0, 0, 0, 3)[0]).toBe(0)
    expect(fake.texel(glOf(volume), 1, 1, 0, 2)[0]).toBe(2)
    expect(fake.texel(glOf(volume), 1, 1, 0, 1)[0]).toBe(0)
  })

  it('samples a read-only depth attachment from a copy made once per pass', async () => {
    const { device, fake } = await open()
    const module = device.createShaderModule({
      code: `@group(0) @binding(0) var depth_tex: texture_2d<f32>;
@vertex fn vs(@builtin(vertex_index) v: u32) -> @builtin(position) vec4f { return vec4f(f32(v), 0.0, 0.0, 1.0); }
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f { return vec4f(textureLoad(depth_tex, vec2i(p.xy), 0).x); }`,
    })
    const layout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          texture: { sampleType: 'unfilterable-float' },
        },
      ],
    })
    const pipeline = await device.createRenderPipelineAsync({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      vertex: { module },
      fragment: { module, targets: [{ format: 'rgba8unorm' }] },
      depthStencil: { format: 'depth32float', depthWriteEnabled: false, depthCompare: 'less' },
    })
    const depth = device.createTexture({
      size: [4, 4],
      format: 'depth32float',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.TEXTURE_BINDING,
    })
    const color = device.createTexture({
      size: [4, 4],
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    const group = device.createBindGroup({
      layout,
      entries: [{ binding: 0, resource: depth.createView() }],
    })
    const encoder = device.createCommandEncoder()
    const p = encoder.beginRenderPass({
      colorAttachments: [{ view: color.createView(), loadOp: 'clear', storeOp: 'store' }],
      depthStencilAttachment: { view: depth.createView(), depthReadOnly: true },
    })
    p.setPipeline(pipeline)
    p.setBindGroup(0, group)
    p.draw(3)
    p.draw(3)
    p.end()
    const mark = fake.calls.length
    device.queue.submit([encoder.finish()])
    const [first, second] = fake.draws.slice(-2)
    const sampled = [...first!.units.values()][0]!.texture!
    expect(sampled).not.toBe(glOf(depth))
    expect([...second!.units.values()][0]!.texture).toBe(sampled)
    expect(fake.callsSince(mark).filter((c) => c === 'blitFramebuffer')).toHaveLength(1)
  })

  it('waits for a parallel link before the pipeline is ready', async () => {
    const { device, fake } = await open({ linkPolls: 3 })
    const s = await scene(device)
    expect(fake.calls.filter((c) => c === 'getProgramParameter').length).toBeGreaterThanOrEqual(4)
    expect((s.pipeline as unknown as { program: unknown }).program).not.toBeNull()
  })
})

describe('the WebGL2 device: canvases', () => {
  it('shows a drawn canvas texture flipped into the default framebuffer, opaque unless premultiplied', async () => {
    const { device, fake, shim } = await open()
    fake.canvas.width = 2
    fake.canvas.height = 2
    fake.backbuffer = new Float64Array(2 * 2 * 4)
    const context = canvasContext(fake.canvas as unknown as HTMLCanvasElement)
    context.configure({
      device,
      format: 'rgba8unorm',
      usage: TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC,
    })
    const source = device.createTexture({
      size: [2, 2],
      format: 'rgba8unorm',
      usage: TextureUsage.COPY_DST | TextureUsage.COPY_SRC | TextureUsage.RENDER_ATTACHMENT,
    })
    // Top row red, bottom row blue, alpha half.
    device.queue.writeTexture(
      { texture: source },
      new Uint8Array([255, 0, 0, 128, 255, 0, 0, 128, 0, 0, 255, 128, 0, 0, 255, 128]),
      { bytesPerRow: 8 },
      [2, 2],
    )
    const show = () => {
      const encoder = device.createCommandEncoder()
      encoder.copyTextureToTexture(
        { texture: source },
        { texture: context.getCurrentTexture() as unknown as GPUTexture },
        [2, 2],
      )
      device.queue.submit([encoder.finish()])
    }
    show()
    // GL's row 0 is the bottom of the canvas: the top row lands in the last one.
    const at = (x: number, y: number) => [
      ...fake.backbuffer.subarray((y * 2 + x) * 4, (y * 2 + x) * 4 + 4),
    ]
    expect(at(0, 1)).toEqual([1, 0, 0, 1])
    expect(at(1, 0)).toEqual([0, 0, 1, 1])
    context.configure({ device, format: 'rgba8unorm', alphaMode: 'premultiplied' })
    show()
    expect(at(0, 1)[3]).toBeCloseTo(128 / 255)
    // A submit that doesn't touch the canvas shows nothing.
    const mark = fake.calls.length
    device.queue.submit([device.createCommandEncoder().finish()])
    expect(fake.callsSince(mark)).not.toContain('blitFramebuffer')
    expect(() => context.configure({ device, format: 'bgra8unorm' })).toThrow(/present bgra8unorm/)
    expect(shim.isLost).toBe(false)
  })
})

describe('the WebGL2 device: errors and loss', () => {
  it("throws gpu-webgl2/unsupported, naming the call, for what WebGL2 can't do", async () => {
    const { device } = await open()
    const unsupported = (message: RegExp) =>
      expect.objectContaining({
        code: 'gpu-webgl2/unsupported',
        message: expect.stringMatching(message),
      })
    expect(() =>
      device.createCommandEncoder({ label: 'sim' }).beginComputePass({ label: 'particles' }),
    ).toThrow(unsupported(/run the compute pass "particles"/))
    await expect(
      device.createComputePipelineAsync({
        label: 'noise',
        layout: 'auto',
        compute: { module: device.createShaderModule({ code: '' }) },
      }),
    ).rejects.toThrow(unsupported(/compute pipeline "noise"/))
    expect(() =>
      device.createBindGroupLayout({
        label: 'instances',
        entries: [
          { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        ],
      }),
    ).toThrow(unsupported(/storage buffer to a vertex or fragment shader \("instances" #3\)/))
    const texture = device.createTexture({
      label: 'albedo',
      size: [2, 2],
      format: 'rgba8unorm',
      usage: TextureUsage.TEXTURE_BINDING,
    })
    expect(() => texture.createView({ format: 'rgba8unorm-srgb' })).toThrow(
      unsupported(/view "albedo" \(rgba8unorm\) as rgba8unorm-srgb/),
    )
    expect(() =>
      device.createTexture({
        label: 'twin',
        size: [2, 2],
        format: 'rgba8unorm',
        viewFormats: ['rgba8unorm-srgb'],
        usage: TextureUsage.TEXTURE_BINDING,
      }),
    ).toThrow(unsupported(/view "twin" in another format/))
    expect(() =>
      device.createTexture({
        label: 'image',
        size: [2, 2],
        format: 'rgba8unorm',
        usage: TextureUsage.STORAGE_BINDING,
      }),
    ).toThrow(unsupported(/storage texture/))
    // A single layer of a layered texture binds only as its own dimension.
    const layered = device.createTexture({
      label: 'shadows',
      size: [2, 2, 2],
      format: 'depth32float',
      usage: TextureUsage.TEXTURE_BINDING,
    })
    const layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
      ],
    })
    expect(() =>
      device.createBindGroup({
        layout,
        entries: [
          {
            binding: 0,
            resource: layered.createView({
              dimension: '2d',
              baseArrayLayer: 1,
              arrayLayerCount: 1,
            }),
          },
        ],
      }),
    ).toThrow(unsupported(/bind "shadows" as a 2d view of layers 1–1 \(it binds as 2d-array\)/))
    expect(() => device.createQuerySet({ type: 'timestamp', count: 2 })).toThrow(
      unsupported(/timestamp query set/),
    )
  })

  it('reports errors through scopes, then as uncaptured events, and checks GL after submits', async () => {
    const { device, fake } = await open({ samples: { [GL.RGBA16F]: [] } })
    device.pushErrorScope('validation')
    device.createTexture({
      label: 'hdr',
      size: [2, 2],
      sampleCount: 4,
      format: 'rgba16float',
      usage: TextureUsage.RENDER_ATTACHMENT,
    })
    const error = await device.popErrorScope()
    expect(error).toMatchObject({
      name: 'GPUValidationError',
      message: expect.stringContaining('"hdr" asks for 4 samples of rgba16float'),
    })
    await expect(device.popErrorScope()).rejects.toThrow()

    const uncaptured: GPUError[] = []
    device.addEventListener('uncapturederror', (e) =>
      uncaptured.push((e as GPUUncapturedErrorEvent).error),
    )
    fake.errors.push(GL.INVALID_OPERATION, GL.OUT_OF_MEMORY)
    device.queue.submit([])
    await Promise.resolve()
    expect(
      uncaptured.map((e) => [
        e.constructor.name === 'ShimError' ? (e as Error).name : '',
        e.message,
      ]),
    ).toEqual([
      ['GPUValidationError', 'WebGL error INVALID_OPERATION in a submit'],
      ['GPUOutOfMemoryError', 'WebGL error OUT_OF_MEMORY in a submit'],
    ])
  })

  it('is lost with the context, and destroyed by destroy()', async () => {
    const { device, fake, shim } = await open()
    fake.canvas.dispatch('webglcontextlost')
    expect(await device.lost).toMatchObject({ reason: 'unknown' })
    expect(shim.isLost).toBe(true)
    // Nothing runs on a lost device.
    const mark = fake.calls.length
    device.queue.writeBuffer(
      device.createBuffer({ size: 4, usage: BufferUsage.COPY_DST }),
      0,
      new Uint8Array(4),
    )
    expect(fake.callsSince(mark)).not.toContain('bufferSubData')

    const other = await open()
    other.device.destroy()
    expect(await other.device.lost).toMatchObject({ reason: 'destroyed' })
    // A context the shim was handed isn't its to lose.
    expect(other.fake.extensionCalls).not.toContain('loseContext')
    expect(other.fake.canvas.listeners.get('webglcontextlost')).toEqual([])
  })
})

describe('the WebGL2 device: recording', () => {
  it('records and replays a frame of draws without allocating once warm', async () => {
    // The fake itself, not its call-logging proxy: what's left allocating is the shim.
    const fake = new FakeGl()
    fake.recordDraws = false
    const gpu = createWebgl2Gpu({ context: fake as unknown as WebGL2RenderingContext })
    const device = (await (await gpu.requestAdapter())!.requestDevice()) as unknown as GPUDevice
    const s = await scene(device)
    const view = s.target.createView()
    const descriptor: GPURenderPassDescriptor = {
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 0, 0, 1] }],
    }
    const offsets = new Uint32Array([0])
    const buffers: GPUCommandBuffer[] = []
    const frame = () => {
      const encoder = device.createCommandEncoder()
      const p = encoder.beginRenderPass(descriptor)
      p.setPipeline(s.pipeline)
      p.setBindGroup(0, s.viewGroup, offsets, 0, 1)
      p.setBindGroup(1, s.materialGroup)
      p.setVertexBuffer(0, s.positions)
      p.setVertexBuffer(1, s.slots)
      for (let i = 0; i < 200; i++) p.draw(3, 1, 0, i & 7)
      p.end()
      buffers[0] = encoder.finish()
      device.queue.submit(buffers)
    }
    for (let i = 0; i < 100; i++) frame()
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((resolve) => setTimeout(resolve, 100))
    const gcs = gcWindow()
    for (let i = 0; i < 300; i++) frame()
    const collections = await gcs.end()
    process.stdout.write(`webgl2 replay, 300 frames × 200 draws: GC events ${collections}
`)
    if (allocationChecks) expect(collections).toBe(0)
  })
})
