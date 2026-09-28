import { defineComponent, type ShardError, t } from '@aethervtt/shard-core'
import { budget } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { wgslLayout } from './layout'
import { ShaderLibrary } from './library'

function engineLibrary(): ShaderLibrary {
  const lib = new ShaderLibrary()
  lib.register('shard::view', 'struct View { view_proj: mat4x4f, position: vec3f }')
  lib.register(
    'shard::pbr::brdf',
    'fn ggx(ndotl: f32, roughness: f32) -> f32 { let a = roughness * roughness; return ndotl / (a + 1.0); }',
  )
  lib.register(
    'shard::pbr::lighting',
    `import shard::pbr::brdf::ggx;
fn apply_lighting(n: vec3f, l: vec3f, roughness: f32) -> vec3f { return vec3f(ggx(max(dot(n, l), 0.0), roughness)); }`,
  )
  lib.register(
    'shard::pbr::material',
    `struct PbrInput { base_color: vec3f, roughness: f32 }
@hook fn pbr_input(uv: vec2f) -> PbrInput { return PbrInput(vec3f(uv, 0.5), 0.5); }
@hook fn fragment_output(color: vec4f) -> vec4f { return color; }`,
  )
  lib.register(
    'shard::pbr::main',
    `import shard::view::View;
import shard::pbr::lighting::apply_lighting;
import shard::pbr::material::{ pbr_input, fragment_output };
@group(0) @binding(0) var<uniform> view: View;
@if(NORMAL_MAP)
fn surface_normal() -> vec3f { return vec3f(0.0, 0.0, 1.0); }
@if(!NORMAL_MAP)
fn surface_normal() -> vec3f { return vec3f(0.0, 1.0, 0.0); }
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = pbr_input(uv);
  let lit = p.base_color * apply_lighting(surface_normal(), vec3f(0.0, 1.0, 0.0), p.roughness);
  return fragment_output(vec4f(lit + view.position * 0.0, 1.0));
}`,
  )
  return lib
}

describe('linking', () => {
  it('resolves nested imports across packages', async () => {
    const lib = engineLibrary()
    lib.register(
      'project::water',
      `import shard::pbr::lighting::apply_lighting;
@fragment fn fs() -> @location(0) vec4f { return vec4f(apply_lighting(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 1.0, 0.0), 0.2), 1.0); }`,
    )
    const { code } = await lib.link({ root: 'project::water' })
    expect(code).toContain('fn apply_lighting')
    expect(code).toContain('fn ggx')
  })

  it('produces distinct cached variants from defines', async () => {
    const lib = engineLibrary()
    const a = lib.link({ root: 'shard::pbr::main', defines: { NORMAL_MAP: true } })
    const b = lib.link({ root: 'shard::pbr::main', defines: { NORMAL_MAP: false } })
    expect(lib.link({ root: 'shard::pbr::main', defines: { NORMAL_MAP: true } })).toBe(a)
    const [va, vb] = await Promise.all([a, b])
    expect(va.code).toContain('vec3f(0.0, 0.0, 1.0)')
    expect(vb.code).toContain('vec3f(0.0, 1.0, 0.0)')
    expect(va.code).not.toBe(vb.code)
  })

  it('reports unknown imports, even unused ones', async () => {
    const lib = engineLibrary()
    lib.register(
      'project::typo',
      'import shard::pbr::lightning::apply_lighting;\nfn f() {}',
      'shaders/typo.wesl',
    )
    await expect(lib.link({ root: 'project::typo' })).rejects.toMatchObject({
      code: 'shader/link-unknown-module',
      path: 'shaders/typo.wesl',
    })
  })

  it('allows module import cycles (WESL semantics) when nothing recurses', async () => {
    const lib = new ShaderLibrary()
    lib.register(
      'project::a',
      'import project::b::two;\nfn one() -> f32 { return 1.0; }\n@fragment fn fs() -> @location(0) vec4f { return vec4f(two()); }',
    )
    lib.register('project::b', 'import project::a::one;\nfn two() -> f32 { return one() + 1.0; }')
    expect((await lib.link({ root: 'project::a' })).code).toContain('fn two')
  })

  it('links a PBR-sized shader in under 5 ms', async () => {
    const lib = engineLibrary()
    const helpers = Array.from(
      { length: 80 },
      (_, i) =>
        `fn helper_${i}(x: vec3f) -> vec3f { var y = x; for (var k = 0; k < 4; k++) { y = normalize(y * ${i + 1}.0 + vec3f(1.0)); } return y; }`,
    ).join('\n')
    const source = `import shard::pbr::lighting::apply_lighting;
${helpers}
@fragment fn fs() -> @location(0) vec4f { return vec4f(apply_lighting(helper_0(vec3f(1.0)), vec3f(0.0, 1.0, 0.0), 0.5), 1.0); }`
    let best = Infinity
    for (let i = 0; i < 15; i++) {
      lib.register('project::big', `// v${i}\n${source}`) // a new version busts the link cache
      const start = performance.now()
      await lib.link({ root: 'project::big' })
      if (i >= 5) best = Math.min(best, performance.now() - start) // first runs warm up the JIT
    }
    expect(best).toBeLessThan(budget(5))
  })

  it('reloads modules from watched files', async () => {
    const files = new Map([['shaders/water/foam.wesl', 'fn foam() -> f32 { return 1.0; }']])
    let emit: ((e: { kind: 'create' | 'modify' | 'remove'; path: string }) => void) | undefined
    const platform = {
      name: 'fake',
      fs: {
        writable: true,
        readText: async (path: string) => files.get(path)!,
        watch: async (_dir: string, onChange: typeof emit) => {
          emit = onChange
          return () => {}
        },
      },
    } as never
    const lib = new ShaderLibrary()
    const changed: string[] = []
    lib.onChange((paths) => changed.push(...paths))
    await lib.watch(platform, 'shaders', 'project')
    emit!({ kind: 'create', path: 'shaders/water/foam.wesl' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lib.has('project::water::foam')).toBe(true)
    files.set('shaders/water/foam.wesl', 'fn foam() -> f32 { return 2.0; }')
    emit!({ kind: 'modify', path: 'shaders/water/foam.wesl' })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(changed).toEqual(['project::water::foam', 'project::water::foam'])
    emit!({ kind: 'modify', path: 'shaders/readme.txt' })
    expect(changed.length).toBe(2)
  })
})

describe('baking', () => {
  it('serves baked variants without linking, and links the ones the bake misses', async () => {
    const first = engineLibrary()
    const normal = await first.link({ root: 'shard::pbr::main', defines: { NORMAL_MAP: true } })
    const bake = JSON.parse(JSON.stringify(first.bake()))
    expect(bake.shaders).toHaveLength(1)

    const next = engineLibrary()
    next.preload(bake)
    expect(
      (await next.link({ root: 'shard::pbr::main', defines: { NORMAL_MAP: true } })).code,
    ).toBe(normal.code)
    expect(next.linked).toBe(0)
    await next.link({ root: 'shard::pbr::main' })
    expect(next.linked).toBe(1)
    // What the second library used, baked or linked, is what it bakes.
    expect(next.bake().shaders).toHaveLength(2)
  })

  it('links again when a module the variant uses changed', async () => {
    const first = engineLibrary()
    await first.link({ root: 'shard::pbr::main' })
    const next = engineLibrary()
    next.preload(first.bake())
    next.register(
      'shard::pbr::brdf',
      'fn ggx(ndotl: f32, roughness: f32) -> f32 { return ndotl * roughness; }',
    )
    const linked = await next.link({ root: 'shard::pbr::main' })
    expect(next.linked).toBe(1)
    expect(linked.code).toContain('ndotl * roughness')
    // A module the variant doesn't import can change without making the bake stale.
    const other = engineLibrary()
    other.preload(first.bake())
    other.register('project::unrelated', 'fn f() {}')
    await other.link({ root: 'shard::pbr::main' })
    expect(other.linked).toBe(0)
  })

  it('rejects a bake from another format version', () => {
    expect(() => engineLibrary().preload({ version: 2 as 1, shaders: [] })).toThrow(
      expect.objectContaining({ code: 'shader/bake-version' }),
    )
  })
})

describe('hooks', () => {
  const toon = `import shard::pbr::material::{ PbrInput, pbr_input as base_pbr_input };
override fn shard::pbr::material::pbr_input(uv: vec2f) -> PbrInput {
  var p = base_pbr_input(uv);
  p.roughness = 1.0;
  return p;
}`

  it('uses the default when nothing overrides', async () => {
    const { code } = await engineLibrary().link({ root: 'shard::pbr::main' })
    expect(code).toContain('PbrInput(vec3f(uv, 0.5), 0.5)')
    expect(code).not.toContain('__override')
  })

  it('replaces a hook and keeps the default callable by alias', async () => {
    const lib = engineLibrary()
    lib.register('project::toon', toon)
    const { code } = await lib.link({ root: 'shard::pbr::main', overrides: ['project::toon'] })
    // The hook forwards to the override...
    expect(code).toMatch(
      /fn pbr_input\(uv: vec2f\) -> PbrInput \{\s*return pbr_input__override_0\(uv\);/,
    )
    expect(code).toContain('p.roughness = 1.0')
    // ...and the override's alias still reaches the original default body.
    expect(code).toMatch(
      /fn base_pbr_input\(uv: vec2f\) -> PbrInput \{\s*return PbrInput\(vec3f\(uv, 0\.5\), 0\.5\);/,
    )
  })

  it('lets the last override win', async () => {
    const lib = engineLibrary()
    lib.register('project::toon', toon)
    lib.register('project::shiny', toon.replace('p.roughness = 1.0', 'p.roughness = 0.05'))
    const { code } = await lib.link({
      root: 'shard::pbr::main',
      overrides: ['project::toon', 'project::shiny'],
    })
    expect(code).toContain('p.roughness = 0.05')
    expect(code).not.toContain('pbr_input__override_0(uv)')
  })

  it('rejects a signature mismatch', async () => {
    const lib = engineLibrary()
    lib.register(
      'project::bad',
      toon.replace('(uv: vec2f) -> PbrInput {', '(uv: vec3f) -> PbrInput {'),
    )
    await expect(
      lib.link({ root: 'shard::pbr::main', overrides: ['project::bad'] }),
    ).rejects.toMatchObject({
      code: 'shader/hook-signature-mismatch',
    })
  })

  it('describes modules, hooks, and defines', () => {
    const d = engineLibrary().describe('shard::pbr::main')
    expect(d.modules).toContain('shard::pbr::brdf')
    expect(d.hooks['shard::pbr::material']).toEqual(['pbr_input', 'fragment_output'])
    expect(d.defines).toEqual(['NORMAL_MAP'])
  })
})

describe('on the GPU', () => {
  let gpu: GpuContext
  beforeAll(async () => {
    gpu = await createNodeGpuContext()
  })
  afterAll(() => gpu.destroy())

  it('linked output with hooks and variants compiles cleanly', async () => {
    const lib = engineLibrary()
    lib.register(
      'project::toon',
      `import shard::pbr::material::{ PbrInput, pbr_input as base };
override fn shard::pbr::material::pbr_input(uv: vec2f) -> PbrInput { var p = base(uv); p.roughness = 1.0; return p; }`,
    )
    for (const request of [
      { root: 'shard::pbr::main', defines: { NORMAL_MAP: true } },
      { root: 'shard::pbr::main', overrides: ['project::toon'] },
    ]) {
      const { code } = await lib.link(request)
      const info = await gpu.device.createShaderModule({ code }).getCompilationInfo()
      expect(info.messages.filter((m) => m.type === 'error').map((m) => m.message)).toEqual([])
    }
  })

  it('maps compile errors to the original file, line, and column', async () => {
    const lib = engineLibrary()
    const errors: ShardError[] = []
    const off = gpu.onError((e) => errors.push(e))
    lib.register(
      'project::broken',
      `import shard::pbr::lighting::apply_lighting;

@fragment fn fs() -> @location(0) vec4f {
  let x: f32 = vec3f(1.0);
  return vec4f(apply_lighting(vec3f(0.0), vec3f(0.0), 0.5), x);
}`,
      'shaders/broken.wesl',
    )
    expect(lib.module(gpu, { root: 'project::broken' })).toBeUndefined()
    await lib.whenIdle()
    off()
    expect(errors[0]?.code).toBe('shader/compile')
    expect(errors[0]?.path).toMatch(/^shaders\/broken\.wesl:4:\d+$/)
  })

  it('hot reload swaps in fixed code and keeps the old module on a broken edit', async () => {
    const lib = engineLibrary()
    const request = { root: 'project::live' }
    const errors: ShardError[] = []
    const off = gpu.onError((e) => errors.push(e))
    lib.register(
      'project::live',
      '@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }',
      'shaders/live.wesl',
    )
    lib.module(gpu, request)
    await lib.whenIdle()
    const first = lib.module(gpu, request)
    expect(first).toBeDefined()

    lib.register(
      'project::live',
      '@fragment fn fs() -> @location(0) vec4f { return vec4f(oops); }',
      'shaders/live.wesl',
    )
    expect(lib.module(gpu, request)).toBe(first) // still the old one while compiling
    await lib.whenIdle()
    expect(lib.module(gpu, request)).toBe(first) // broken edit: old module kept
    expect(errors.at(-1)?.path).toMatch(/^shaders\/live\.wesl:1:/)

    lib.register(
      'project::live',
      '@fragment fn fs() -> @location(0) vec4f { return vec4f(0.5); }',
      'shaders/live.wesl',
    )
    lib.module(gpu, request)
    await lib.whenIdle()
    const fixed = lib.module(gpu, request)
    expect(fixed).toBeDefined()
    expect(fixed).not.toBe(first)
    off()
  })

  it('wgslLayout matches WGSL alignment, verified on the GPU', async () => {
    const Probe = defineComponent('test/Probe', {
      a: t.f32,
      b: t.vec3,
      c: t.u32,
      d: t.vec2,
      e: t.color,
      f: t.bool,
      g: t.mat3,
      h: t.enum(['x', 'y', 'z']),
      i: t.affine3x4,
      j: t.i32,
      k: t.mat4,
    })
    const layout = wgslLayout(Probe)
    const value = {
      a: 1.5,
      b: [2, 3, 4] as [number, number, number],
      c: 5,
      d: [6, 7] as [number, number],
      e: [8, 9, 10, 11] as [number, number, number, number],
      f: true,
      g: [12, 13, 14, 15, 16, 17, 18, 19, 20] as never,
      h: 'z' as const,
      i: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32] as never,
      j: -33,
      k: Array.from({ length: 16 }, (_, n) => 34 + n) as never,
    }
    const bytes = new ArrayBuffer(layout.size)
    layout.write(new DataView(bytes), 0, value)

    // A compute shader reads each member through the generated struct and writes it out flat.
    const outCount = 1 + 3 + 1 + 2 + 4 + 1 + 9 + 1 + 12 + 1 + 16
    const code = `${layout.wgsl}
@group(0) @binding(0) var<storage, read> p: Probe;
@group(0) @binding(1) var<storage, read_write> o: array<f32, ${outCount}>;
@compute @workgroup_size(1) fn main() {
  var n = 0u;
  o[n] = p.a; n++;
  for (var k = 0u; k < 3u; k++) { o[n] = p.b[k]; n++; }
  o[n] = f32(p.c); n++;
  for (var k = 0u; k < 2u; k++) { o[n] = p.d[k]; n++; }
  for (var k = 0u; k < 4u; k++) { o[n] = p.e[k]; n++; }
  o[n] = f32(p.f); n++;
  for (var c = 0u; c < 3u; c++) { for (var r = 0u; r < 3u; r++) { o[n] = p.g[c][r]; n++; } }
  o[n] = f32(p.h); n++;
  for (var r = 0u; r < 3u; r++) { for (var c = 0u; c < 4u; c++) { o[n] = p.i[r][c]; n++; } }
  o[n] = f32(p.j); n++;
  for (var c = 0u; c < 4u; c++) { for (var r = 0u; r < 4u; r++) { o[n] = p.k[c][r]; n++; } }
}`
    const device = gpu.device
    const module = device.createShaderModule({ code })
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
    const input = device.createBuffer({
      size: layout.size,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(input, 0, bytes)
    const output = device.createBuffer({
      size: outCount * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const read = device.createBuffer({
      size: outCount * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
    const encoder = device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(
      0,
      device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } },
        ],
      }),
    )
    pass.dispatchWorkgroups(1)
    pass.end()
    encoder.copyBufferToBuffer(output, 0, read, 0, outCount * 4)
    device.queue.submit([encoder.finish()])
    await read.mapAsync(GPUMapMode.READ)
    const got = [...new Float32Array(read.getMappedRange())]
    read.unmap()
    const expected = [
      1.5,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      1,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
      20,
      2,
      ...Array.from({ length: 12 }, (_, n) => 21 + n),
      -33,
      ...Array.from({ length: 16 }, (_, n) => 34 + n),
    ]
    expect(got).toEqual(expected)
  })

  it('skips object fields (bound, not packed) and rejects f64', () => {
    const Mixed = defineComponent('test/MixedGpu', { name: t.string, value: t.f32 })
    expect(wgslLayout(Mixed).fields.map((f) => f.name)).toEqual(['value'])
    const Bad = defineComponent('test/BadGpu', { big: t.f64 })
    expect(() => wgslLayout(Bad)).toThrow(
      expect.objectContaining({ code: 'shader/unsupported-field' }),
    )
  })
})
