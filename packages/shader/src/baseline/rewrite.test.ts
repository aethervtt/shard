import type { ShardError } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ShaderLibrary } from '../library'
import { collectData } from './data'
import { DATA_TEXTURE_WIDTH } from './rewrite'

let gpu: GpuContext
let compat: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
  compat = await createNodeGpuContext({ tier: 'baseline' })
})
afterAll(() => {
  gpu.destroy()
  compat.destroy()
})

/** A struct of every kind of field a loader reads, at awkward offsets. */
const RECORD = `
struct Inner { a: vec2f, b: u32 }
struct Record {
  m: mat4x4f,
  v3: vec3f,
  s: f32,
  i: i32,
  u: u32,
  v2: vec2f,
  arr: array<vec2f, 3>,
  inner: Inner,
  m3: mat3x3f,
}`

/** Words of a Record as the kernel flattens them: every field, bitcast to u32, in order. */
const FLATTEN = `
fn flatten(r: Record, out_base: u32) {
  var o = out_base;
  for (var c = 0u; c < 4u; c++) { for (var k = 0u; k < 4u; k++) { out_words[o] = bitcast<u32>(r.m[c][k]); o++; } }
  for (var k = 0u; k < 3u; k++) { out_words[o] = bitcast<u32>(r.v3[k]); o++; }
  out_words[o] = bitcast<u32>(r.s); o++;
  out_words[o] = bitcast<u32>(r.i); o++;
  out_words[o] = r.u; o++;
  out_words[o] = bitcast<u32>(r.v2.x); o++;
  out_words[o] = bitcast<u32>(r.v2.y); o++;
  for (var k = 0u; k < 3u; k++) { out_words[o] = bitcast<u32>(r.arr[k].x); o++; out_words[o] = bitcast<u32>(r.arr[k].y); o++; }
  out_words[o] = bitcast<u32>(r.inner.a.x); o++;
  out_words[o] = bitcast<u32>(r.inner.a.y); o++;
  out_words[o] = r.inner.b; o++;
  for (var c = 0u; c < 3u; c++) { for (var k = 0u; k < 3u; k++) { out_words[o] = bitcast<u32>(r.m3[c][k]); o++; } }
}`
const WORDS = 16 + 3 + 1 + 1 + 1 + 2 + 6 + 3 + 9

/** Runs \`module\`'s \`main\` over n records: the storage read and the data texture read, compared. */
async function run(
  library: ShaderLibrary,
  root: string,
  defines: Record<string, boolean>,
  bytes: Uint8Array,
  n: number,
  words: number,
): Promise<Uint32Array> {
  const linked = await library.link({ root, defines })
  const device = gpu.device
  device.pushErrorScope('validation')
  const module = device.createShaderModule({ code: linked.code })
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')
  if (errors.length > 0)
    throw new Error(`${errors.map((e) => e.message).join('\n')}\n${linked.code}`)
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const out = device.createBuffer({
    size: n * words * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const read = device.createBuffer({
    size: n * words * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  let resource: GPUBindingResource
  if (defines.BASELINE) {
    // What a data store uploads: the same bytes, 16 to a texel, 1,024 texels a row, and the byte
    // length in the last texel.
    const texels = Math.ceil(bytes.byteLength / 16) + 1
    const rows = Math.ceil(texels / DATA_TEXTURE_WIDTH)
    const data = new Uint32Array(DATA_TEXTURE_WIDTH * rows * 4)
    new Uint8Array(data.buffer).set(bytes)
    data[data.length - 4] = bytes.byteLength
    const texture = device.createTexture({
      size: [DATA_TEXTURE_WIDTH, rows],
      format: 'rgba32uint',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture }, data, { bytesPerRow: DATA_TEXTURE_WIDTH * 16 }, [
      DATA_TEXTURE_WIDTH,
      rows,
    ])
    resource = texture.createView()
  } else {
    const buffer = device.createBuffer({
      size: bytes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(buffer, 0, bytes)
    resource = { buffer }
  }
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource },
      { binding: 1, resource: { buffer: out } },
    ],
  })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, group)
  pass.dispatchWorkgroups(n)
  pass.end()
  encoder.copyBufferToBuffer(out, 0, read, 0, n * words * 4)
  device.queue.submit([encoder.finish()])
  const error = await device.popErrorScope()
  if (error) throw new Error(error.message)
  await read.mapAsync(GPUMapMode.READ)
  const result = new Uint32Array(read.getMappedRange().slice(0))
  read.unmap()
  return result
}

/** Random words that are also finite floats, so bitcasts round-trip whatever the field's type. */
function randomBytes(count: number, seed: number): Uint8Array {
  const words = new Uint32Array(count / 4)
  let s = seed
  for (let i = 0; i < words.length; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    // Keep the exponent off all-ones (NaN/inf) and off zero (denormals may flush).
    words[i] = (s & 0x807fffff) | ((((s >>> 23) % 200) + 20) << 23)
  }
  return new Uint8Array(words.buffer)
}

describe('@data marks (0064)', () => {
  it('are stripped before linking, so the full tier links exactly the unmarked code', async () => {
    const plain = `@group(0) @binding(0) var<storage, read> things: array<vec4f>;
@group(0) @binding(1) var<storage, read> one: vec4f;
@fragment fn fs() -> @location(0) vec4f { return things[0] + one; }`
    const marked = plain
      .replace('@group(0) @binding(0)', '@data @group(0) @binding(0)')
      .replace('@group(0) @binding(1)', '@data(uniform) @group(0) @binding(1)')
    const collected = collectData(marked, 'test::m')
    expect(collected.code).toBe(plain)
    expect(collected.data).toEqual([
      { module: 'test::m', name: 'things', group: 0, binding: 0, kind: 'texture' },
      { module: 'test::m', name: 'one', group: 0, binding: 1, kind: 'uniform' },
    ])
    const a = new ShaderLibrary()
    a.register('test::m', plain)
    const b = new ShaderLibrary()
    b.register('test::m', marked)
    expect((await b.link({ root: 'test::m' })).code).toBe((await a.link({ root: 'test::m' })).code)
    expect(() => collectData('@data fn f() {}', 'test::bad')).toThrow(/storage declaration/)
  })
})

describe('the baseline rewrite (0064)', () => {
  it('reads every field of a record from a data texture exactly as from storage', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::records',
      `${RECORD}
@data @group(0) @binding(0) var<storage, read> records: array<Record>;
@group(0) @binding(1) var<storage, read_write> out_words: array<u32>;
${FLATTEN}
@compute @workgroup_size(1) fn main(@builtin(workgroup_id) id: vec3u) {
  flatten(records[id.x], id.x * ${WORDS}u);
}`,
    )
    const n = 37
    // Record: mat4 64, vec3 12 (+ s 4 = 80), i 84, u 88, v2 at 96, arr at 104 (3 × 8), inner at 128
    // (16), m3 at 144 (48): 192 bytes.
    const bytes = randomBytes(n * 192, 7)
    const full = await run(library, 'test::records', {}, bytes, n, WORDS)
    const baseline = await run(library, 'test::records', { BASELINE: true }, bytes, n, WORDS)
    expect(Buffer.compare(Buffer.from(baseline.buffer), Buffer.from(full.buffer))).toBe(0)
    const linked = await library.link({ root: 'test::records', defines: { BASELINE: true } })
    expect(linked.code).toContain('var records: texture_2d<u32>;')
    expect(linked.bindings).toEqual([{ group: 0, binding: 0, name: 'records', as: 'data-texture' }])
  })

  it('reads arrays of 4- and 8-byte elements, and answers arrayLength', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::small',
      `@data @group(0) @binding(0) var<storage, read> words: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_words: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(workgroup_id) id: vec3u) {
  out_words[id.x * 2u] = words[id.x];
  out_words[id.x * 2u + 1u] = arrayLength(&words);
}`,
    )
    library.register(
      'test::pairs',
      `@data @group(0) @binding(0) var<storage, read> pairs: array<vec2f>;
@group(0) @binding(1) var<storage, read_write> out_words: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(workgroup_id) id: vec3u) {
  out_words[id.x * 3u] = bitcast<u32>(pairs[id.x].x);
  out_words[id.x * 3u + 1u] = bitcast<u32>(pairs[id.x].y);
  out_words[id.x * 3u + 2u] = arrayLength(&pairs);
}`,
    )
    const n = 50
    const words = randomBytes(n * 4, 3)
    expect(await run(library, 'test::small', { BASELINE: true }, words, n, 2)).toEqual(
      await run(library, 'test::small', {}, words, n, 2),
    )
    const pairs = randomBytes(n * 8, 5)
    expect(await run(library, 'test::pairs', { BASELINE: true }, pairs, n, 3)).toEqual(
      await run(library, 'test::pairs', {}, pairs, n, 3),
    )
  })

  it('makes @data(uniform) a uniform block when the layouts agree, and refuses when they don’t', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::uniform',
      `struct Lights { count: u32, colors: array<vec4f, 4> }
@data(uniform) @group(0) @binding(0) var<storage, read> lights: Lights;
@fragment fn fs() -> @location(0) vec4f { return lights.colors[lights.count]; }`,
    )
    const linked = await library.link({ root: 'test::uniform', defines: { BASELINE: true } })
    expect(linked.code).toContain('var<uniform> lights: Lights;')
    expect(linked.bindings).toEqual([{ group: 0, binding: 0, name: 'lights', as: 'uniform' }])
    library.register(
      'test::packed',
      `struct Weights { w: array<f32, 4> }
@data(uniform) @group(0) @binding(0) var<storage, read> weights: Weights;
@fragment fn fs() -> @location(0) vec4f { return vec4f(weights.w[0]); }`,
    )
    await expect(
      library.link({ root: 'test::packed', defines: { BASELINE: true } }),
    ).rejects.toMatchObject({ code: 'shader/baseline-uniform-layout' })
    // A runtime-sized array needs a length, and gets it.
    library.register(
      'test::lights',
      `struct Light { color: vec4f, position: vec4f }
@data(uniform, 128) @group(0) @binding(0) var<storage, read> lights: array<Light>;
@fragment fn fs() -> @location(0) vec4f { return lights[arrayLength(&lights) - 1u].color; }`,
    )
    const lights = await library.link({ root: 'test::lights', defines: { BASELINE: true } })
    expect(lights.code).toContain('var<uniform> lights: array<Light, 128>;')
    expect(lights.code).toContain('lights[128u - 1u]')
    library.register(
      'test::unsized',
      `@data(uniform) @group(0) @binding(0) var<storage, read> things: array<vec4f>;
@fragment fn fs() -> @location(0) vec4f { return things[0]; }`,
    )
    await expect(
      library.link({ root: 'test::unsized', defines: { BASELINE: true } }),
    ).rejects.toMatchObject({ code: 'shader/baseline-data' })
  })

  it('fails storage a render stage reads that isn’t @data, and a shadowed @data name, at module and line', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::helpers',
      `@group(1) @binding(0) var<storage, read> raw: array<vec4f>;
fn tint() -> vec4f { return raw[0]; }`,
    )
    library.register(
      'test::hook',
      `import test::helpers::tint;
@fragment fn fs() -> @location(0) vec4f { return tint(); }`,
    )
    const error = (await library
      .link({ root: 'test::hook', defines: { BASELINE: true } })
      .catch((e: unknown) => e)) as ShardError
    expect(error.code).toBe('shader/baseline-storage')
    expect(error.message).toContain('"raw"')
    expect(error.path).toBe('test::helpers:1:1')
    // The full tier links it as it is.
    await expect(library.link({ root: 'test::hook' })).resolves.toBeTruthy()

    library.register(
      'test::shadow',
      `@data @group(0) @binding(0) var<storage, read> items: array<u32>;
@fragment fn fs() -> @location(0) vec4f {
  let items = 3u;
  return vec4f(f32(items));
}`,
    )
    await expect(
      library.link({ root: 'test::shadow', defines: { BASELINE: true } }),
    ).rejects.toMatchObject({ code: 'shader/baseline-shadowed', path: 'test::shadow:3:7' })
  })

  it('reads depth as a float texture unless it’s compared, asks for either-vertex flat inputs, and polyfills reverseBits', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::depth',
      `@group(0) @binding(0) var scene_depth: texture_depth_2d;
@group(0) @binding(1) var shadow_map: texture_depth_2d;
@group(0) @binding(2) var shadow_sampler: sampler_comparison;
struct V { @builtin(position) p: vec4f, @location(0) @interpolate(flat) id: u32 }
@vertex fn vs(@builtin(vertex_index) i: u32) -> V { return V(vec4f(0.0), reverseBits(i)); }
@fragment fn fs(in: V) -> @location(0) vec4f {
  let d = textureLoad(scene_depth, vec2i(0), 0);
  let s = textureSampleCompareLevel(shadow_map, shadow_sampler, vec2f(0.5), d);
  return vec4f(d, s, f32(in.id), 1.0);
}`,
    )
    const linked = await library.link({ root: 'test::depth', defines: { BASELINE: true } })
    expect(linked.code).toContain('var scene_depth: texture_2d<f32>;')
    expect(linked.code).toContain('textureLoad(scene_depth, vec2i(0), 0).x')
    expect(linked.code).toContain('var shadow_map: texture_depth_2d;')
    expect(linked.code).toContain('@interpolate(flat, either)')
    expect(linked.code).toContain('shard_reverse_bits(i)')
    expect(linked.bindings).toEqual([
      { group: 0, binding: 0, name: 'scene_depth', as: 'unfilterable-float' },
    ])
    // Valid on a compatibility-mode device.
    compat.device.pushErrorScope('validation')
    const module = compat.device.createShaderModule({ code: linked.code })
    const info = await module.getCompilationInfo()
    expect(info.messages.filter((m) => m.type === 'error')).toEqual([])
    expect(await compat.device.popErrorScope()).toBeNull()
  })

  it('computes reverseBits exactly as the builtin', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::reverse',
      `@data @group(0) @binding(0) var<storage, read> words: array<u32>;
@group(0) @binding(1) var<storage, read_write> out_words: array<u32>;
@compute @workgroup_size(1) fn main(@builtin(workgroup_id) id: vec3u) {
  out_words[id.x] = reverseBits(words[id.x]);
}`,
    )
    const bytes = randomBytes(64 * 4, 11)
    const baseline = await run(library, 'test::reverse', { BASELINE: true }, bytes, 64, 1)
    expect(
      await library.link({ root: 'test::reverse', defines: { BASELINE: true } }),
    ).toMatchObject({
      code: expect.stringContaining('shard_reverse_bits'),
    })
    expect(baseline).toEqual(await run(library, 'test::reverse', {}, bytes, 64, 1))
  })

  it('links every variant with BASELINE on a baseline device, and the full tier asks for what it always has', async () => {
    const library = new ShaderLibrary()
    library.register(
      'test::tier',
      `@data @group(0) @binding(0) var<storage, read> things: array<vec4f>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f { return things[i]; }`,
    )
    for (const [device, texture] of [
      [gpu, false],
      [compat, true],
    ] as const) {
      library.module(device, { root: 'test::tier' })
      await library.whenIdle()
      const baked = library.bake().shaders.map((s) => s.key)
      expect(
        baked.some((k) => k.includes('BASELINE')),
        device.tier,
      ).toBe(texture)
    }
  })
})
