import { t } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import { App, LogResource } from '@aethervtt/shard-runtime'
import { ShaderLibrary, wgslLayout } from '@aethervtt/shard-shader'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets, validateMaterial } from './assets'
import { Camera3d, Exposure } from './camera'
import { Mesh3d, MeshMaterial } from './instances'
import { DirectionalLight } from './lights'
import { defineMaterial } from './materials'
import { Gpu, renderPlugin, Shaders } from './plugin'
import { registerEngineShaders } from './shaders'
import { forwardPlugin } from './standard'
import {
  SURFACE_PRESETS,
  SURFACE_VARIATION_WGSL,
  SurfaceMaterial,
  SurfaceSettings,
  surfacePlugin,
  surfaceVariation,
  VARIATION_PATTERNS,
  type Variation,
  VariationField,
  VariationUniform,
} from './surface'
import { OffscreenTarget } from './target'
import { renderView, settle } from './testing'
import { Tonemapping } from './view'

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

/** Every preset, and each pattern on its own (with warp on the odd ones). */
function cases(): [string, Variation][] {
  const out: [string, Variation][] = Object.entries(SURFACE_PRESETS).map(([name, v], i) => [
    name,
    { ...v, seed: 1234 + i * 977 },
  ])
  VARIATION_PATTERNS.forEach((pattern, i) => {
    out.push([
      pattern,
      {
        ...VariationUniform.defaults(),
        pattern,
        seed: 0xfffff000 + i * 4099,
        scale: [0.7 + i * 0.4, 1.9 - i * 0.2],
        warp: i % 2 ? 0.8 : 0,
        detail: 0.3,
        bands: i / 5,
        toneRange: 0.3,
        weathering: 0.4,
      },
    ])
  })
  return out
}

describe('surface variation on the GPU', () => {
  it('matches surfaceVariation within 1/255 at 1,000 points, for every preset and pattern', async () => {
    const library = new ShaderLibrary()
    registerEngineShaders(library)
    library.register('surface::variation', SURFACE_VARIATION_WGSL)
    library.register(
      'test::variation_probe',
      `import surface::variation::{ surface_variation, VariationUniform };
@group(0) @binding(0) var<uniform> v: VariationUniform;
@group(0) @binding(1) var<storage, read> points: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= arrayLength(&points)) { return; }
  let s = surface_variation(points[i], v);
  out[i] = vec4f(s.tint, s.roughness);
}`,
    )
    const { code } = await library.link({ root: 'test::variation_probe' })
    const device = gpu.device
    const pipeline = await device.createComputePipelineAsync({
      layout: 'auto',
      compute: { module: device.createShaderModule({ code }), entryPoint: 'main' },
    })
    const n = 1000
    // Points over 100 m, from a fixed sequence, as f32 (what the GPU reads).
    const points = new Float32Array(n * 2)
    let r = 7
    for (let i = 0; i < n * 2; i++) {
      r = (Math.imul(r, 1103515245) + 12345) >>> 0
      points[i] = (r / 4294967296) * 100 - 50
    }
    const layout = wgslLayout(VariationUniform)
    const uniform = device.createBuffer({
      size: layout.size,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const input = device.createBuffer({
      size: points.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(input, 0, points)
    const output = device.createBuffer({
      size: n * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const group = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniform } },
        { binding: 1, resource: { buffer: input } },
        { binding: 2, resource: { buffer: output } },
      ],
    })
    const bytes = new DataView(new ArrayBuffer(layout.size))
    const sample = { tint: [0, 0, 0] as [number, number, number], roughness: 0 }
    for (const [name, v] of cases()) {
      layout.write(bytes, 0, v)
      device.queue.writeBuffer(uniform, 0, bytes.buffer)
      const read = device.createBuffer({
        size: n * 16,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
      })
      const encoder = device.createCommandEncoder()
      const pass = encoder.beginComputePass()
      pass.setPipeline(pipeline)
      pass.setBindGroup(0, group)
      pass.dispatchWorkgroups(Math.ceil(n / 64))
      pass.end()
      encoder.copyBufferToBuffer(output, 0, read, 0, n * 16)
      device.queue.submit([encoder.finish()])
      await read.mapAsync(GPUMapMode.READ)
      const got = new Float32Array(read.getMappedRange().slice(0))
      read.unmap()
      read.destroy()
      let worst = 0
      let varied = 0
      for (let i = 0; i < n; i++) {
        surfaceVariation(v, [points[i * 2]!, points[i * 2 + 1]!], sample)
        for (let c = 0; c < 3; c++) {
          worst = Math.max(worst, Math.abs(sample.tint[c]! - got[i * 4 + c]!))
          if (Math.abs(sample.tint[c]! - 1) > 0.01) varied++
        }
        worst = Math.max(worst, Math.abs(sample.roughness - got[i * 4 + 3]!))
      }
      expect(worst, name).toBeLessThan(1 / 255)
      // It does something: most points move off white.
      expect(varied, name).toBeGreaterThan(n)
    }
    uniform.destroy()
    input.destroy()
    output.destroy()
  })
})

// A user-authored type with the same variation field, calling the WGSL library (0068).
const Mossy = defineMaterial('test/Mossy', {
  fields: { variation: VariationField, moss: t.f32({ min: 0, max: 1 }) },
  shader: 'project::mossy',
})

const MOSSY_WESL = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import surface::variation::{ surface_point, surface_variation };
import material::mossy::Mossy;

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  let v = surface_variation(surface_point(in, 1u), Mossy.variation);
  p.base_color = mix(p.base_color * v.tint, vec3f(0.1, 0.4, 0.1), Mossy.moss);
  p.roughness = clamp(p.roughness + v.roughness, 0.045, 1.0);
  return p;
}
`

async function scene(plugins = true) {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
  )
  if (plugins) app.addPlugin(surfacePlugin)
  await app.init()
  const world = app.world
  world.resource(Shaders).register('project::mossy', MOSSY_WESL, 'shaders/mossy.wesl')
  const target = new OffscreenTarget(gpu, { label: 'surface', width: 64, height: 64 })
  const ref = world.resource(RenderTargets).add(target, 'surface')
  const mesh = world.resource(Meshes).add(plane({ size: 12 }))
  const entity = world.spawn([Mesh3d, { mesh }], [MeshMaterial, { material: null }], Transform)
  const cam = world.spawn(
    [Camera3d, { target: ref, fovY: 60 }],
    [Exposure, { ev100: 12 }],
    [Tonemapping, { dither: false }],
    [Transform, { translation: [0, 9, 0.01], rotation: lookAt([0, 9, 0.01], [0, 0, 0]) }],
  )
  world.spawn(
    [DirectionalLight, { illuminance: 20_000, shadows: false }],
    [Transform, { rotation: lookAt([-2, 6, 3], [0, 0, 0]) }],
  )
  const show = async (material: MaterialAsset) => {
    const m = world.resource(Materials).add(material)
    world.set(entity, MeshMaterial, { material: m })
    await settle(app)
    return renderView(app, `camera:${cam}`)
  }
  return { app, world, target, show }
}

function maxDiff(a: { data: Uint8Array }, b: { data: Uint8Array }): number {
  let max = 0
  for (let i = 0; i < a.data.length; i++) max = Math.max(max, Math.abs(a.data[i]! - b.data[i]!))
  return max
}

const PLAIN = { baseColor: [0.7, 0.62, 0.55, 1], roughness: 0.7 }

describe('SurfaceMaterial', () => {
  it('draws twenty variations across every preset with one pipeline', async () => {
    const { app, world, target } = await scene()
    // Every pipeline the forward pass draws SurfaceMaterial batches with.
    const pipelines = new Set<GPURenderPipeline>()
    const cache = gpu.pipelines
    const render = cache.render.bind(cache)
    cache.render = (d) => {
      const pipeline = render(d)
      if (pipeline && d.label?.startsWith('forward/render/SurfaceMaterial/'))
        pipelines.add(pipeline)
      return pipeline
    }
    const presets = Object.values(SURFACE_PRESETS)
    const mesh = world.resource(Meshes).add(plane({ size: 0.5 }))
    for (let i = 0; i < 20; i++) {
      const material = world.resource(Materials).add(
        new MaterialAsset(
          {
            baseColor: [0.5 + i * 0.02, 0.5, 0.5, 1],
            variation: { ...presets[i % presets.length]!, seed: i },
            projection: i % 2 ? 'uv' : 'world',
          },
          SurfaceMaterial,
        ),
      )
      world.spawn(
        [Mesh3d, { mesh }],
        [MeshMaterial, { material }],
        [Transform, { translation: [(i % 5) - 2, 0.1, Math.floor(i / 5) - 2] }],
      )
    }
    await settle(app)
    delete (cache as { render?: unknown }).render
    expect(pipelines.size).toBe(1)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
    target.destroy()
  })

  it('varies the surface, and a custom type importing surface::variation renders the same', async () => {
    const { app, world, target, show } = await scene()
    const variation = { ...SURFACE_PRESETS.stone!, seed: 99, strength: 1 }
    const standard = await show(new MaterialAsset(PLAIN))
    const surface = await show(
      new MaterialAsset({ ...PLAIN, variation, projection: 'world' }, SurfaceMaterial),
    )
    const custom = await show(new MaterialAsset({ ...PLAIN, variation }, Mossy))
    expect(world.resource(Gpu).errors).toEqual([])
    expect(maxDiff(standard, surface)).toBeGreaterThan(10)
    expect(maxDiff(surface, custom)).toBeLessThanOrEqual(1)
    await app.dispose()
    target.destroy()
  })

  it('renders byte-identical to StandardMaterial with variation off, and relinks when it turns on', async () => {
    const { app, world, target, show } = await scene()
    world.patchResource(SurfaceSettings, { variation: false })
    const standard = await show(new MaterialAsset(PLAIN))
    const varied = new MaterialAsset(
      { ...PLAIN, variation: { ...SURFACE_PRESETS.plaster!, strength: 1 }, projection: 'world' },
      SurfaceMaterial,
    )
    const off = await show(varied)
    expect(maxDiff(standard, off)).toBe(0)
    world.patchResource(SurfaceSettings, { variation: true })
    const on = await show(varied)
    expect(maxDiff(standard, on)).toBeGreaterThan(10)
    expect(world.resource(Gpu).errors).toEqual([])
    await app.dispose()
    target.destroy()
  })

  it('fails validation for an out-of-range variation field', () => {
    const errors = validateMaterial({
      type: 'render/SurfaceMaterial',
      variation: { ...SURFACE_PRESETS.brick, strength: 2 },
    })
    expect(errors.map((e) => [e.code, e.path])).toEqual([
      ['schema/out-of-range', '/variation/strength'],
    ])
    expect(
      validateMaterial({ type: 'render/SurfaceMaterial', variation: { pattern: 'cells' } }),
    ).toEqual([])
    // Presets are the schema's examples.
    const schema = SurfaceMaterial.schema.jsonSchema() as {
      properties: { variation: { examples: unknown[] } }
    }
    expect(schema.properties.variation.examples).toHaveLength(Object.keys(SURFACE_PRESETS).length)
  })

  it('logs render/feature-missing without surfacePlugin, and draws as the standard material', async () => {
    const { app, world, target, show } = await scene(false)
    const standard = await show(new MaterialAsset(PLAIN))
    const surface = await show(
      new MaterialAsset({ ...PLAIN, variation: SURFACE_PRESETS.stone }, SurfaceMaterial),
    )
    const missing = world
      .resource(LogResource)
      .errors()
      .filter((e) => e.code === 'render/feature-missing')
    expect(missing).toHaveLength(1)
    expect(missing[0]!.hint).toContain('surfacePlugin')
    expect(maxDiff(standard, surface)).toBe(0)
    await app.dispose()
    target.destroy()
  })
})
