import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assetServer } from '@aethervtt/shard-assets'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { plane } from '@aethervtt/shard-mesh'
import {
  loadNoiseKernel,
  NoiseGraph,
  NoiseGraphs,
  sampleGrid2d,
  sampleSpherePatch,
} from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { App } from '@aethervtt/shard-runtime'
import { lookAt, Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MaterialAsset, Materials, Meshes, RenderTargets } from './assets'
import { Camera3d, Exposure } from './camera'
import { forwardPlugin } from './forward'
import { Mesh3d, MeshMaterial } from './instances'
import { defineMaterial } from './materials'
import { NoiseCompute, noiseComputeNode } from './noise'
import { captureView, Gpu, Graph, renderPlugin, Shaders } from './plugin'
import { OffscreenTarget } from './target'
import { pixel, renderView } from './testing'
import { Tonemapping } from './view'

let gpu: GpuContext
let root: string

beforeAll(async () => {
  gpu = await createNodeGpuContext()
  await loadNoiseKernel()
  root = mkdtempSync(join(tmpdir(), 'shard-noise-material-'))
  mkdirSync(join(root, 'assets/noise'), { recursive: true })
})

afterAll(() => {
  gpu?.destroy()
  rmSync(root, { recursive: true, force: true })
})

const graphFile = (value: number) =>
  JSON.stringify({
    output: 'glow',
    nodes: {
      base: { constant: value },
      ripple: { simplex: { frequency: 3 } },
      glow: { add: ['base', { multiply: ['ripple', 0.02] }] },
    },
  })

const NOISY_WESL = `
import shard::pbr::types::{ VertexOutput, PbrInput };
import shard::pbr::standard::standard_input;
import material::noisy::noise_detail;

override fn pbr_input(in: VertexOutput) -> PbrInput {
  var p = standard_input(in);
  p.emissive += vec3f(max(noise_detail(in.world_position, 7u), 0.0) * 4000.0);
  return p;
}
`

describe('materials call noise graphs', () => {
  it('draws once the graph loads, and re-renders within two frames of an edit', async () => {
    writeFileSync(join(root, 'assets/noise/glow.noise.json'), graphFile(0.1))
    const Noisy = defineMaterial('test/Noisy', {
      shader: 'project::noisy',
      noise: { detail: 'assets/noise/glow.noise.json' },
    })
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
    )
    await app.init()
    const world = app.world
    await assetServer(world)
      .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
      .scan()
    world.resource(Shaders).register('project::noisy', NOISY_WESL, 'shaders/noisy.wesl')
    const target = new OffscreenTarget(gpu, { label: 'noise-material', width: 32, height: 32 })
    const targetRef = world.resource(RenderTargets).add(target, 'noise-material')
    const material = world
      .resource(Materials)
      .add(new MaterialAsset({ baseColor: [0, 0, 0, 1], roughness: 1 }, Noisy))
    world.spawn(
      [Mesh3d, { mesh: world.resource(Meshes).add(plane({ size: 4 })) }],
      [MeshMaterial, { material }],
      [Transform, {}],
    )
    const cam = world.spawn(
      [Camera3d, { target: targetRef, fovY: 40 }],
      [Exposure, { ev100: 12 }],
      [Tonemapping, { dither: false }],
      [Transform, { translation: [0, 3, 0.01], rotation: lookAt([0, 3, 0.01], [0, 0, 0]) }],
    )
    const view = `camera:${cam}`
    const before = pixel(await renderView(app, view), 16, 16)[0]!
    expect(world.resource(Gpu).errors).toEqual([])
    expect(before).toBeGreaterThan(10)

    writeFileSync(join(root, 'assets/noise/glow.noise.json'), graphFile(0.9))
    await assetServer(world).scan()
    const graph = [...world.resource(NoiseGraphs).entries()][0]![1]
    expect(graph.version).toBe(1)

    // Frames as the game would run them: one per ~16 ms.
    let frames = 0
    let after = before
    while (frames < 120) {
      const shot = captureView(world, view)
      app.update(1 / 60)
      frames++
      after = pixel(await shot, 16, 16)[0]!
      if (after > before + 20) break
      await new Promise((r) => setTimeout(r, 16))
    }
    expect(after).toBeGreaterThan(before + 20)
    // Two frames is the spec budget, held under `pnpm bench` (serial). In parallel `pnpm test` runs
    // other packages compile shaders on the same GPU, so only the reload itself is checked.
    if (process.env.SHARD_BENCH) expect(frames).toBeLessThanOrEqual(2)
    expect(world.resource(Gpu).errors).toEqual([])
  })
})

describe('noise compute', () => {
  const graph = () =>
    NoiseGraph.fromJson(
      {
        output: 'h',
        nodes: {
          c: { fbm: { octaves: 5, frequency: 1e-5, seed: 1 } },
          m: { ridged: { octaves: 4, frequency: 4e-4, seed: 2 } },
          h: {
            add: ['c', { multiply: ['m', { remap: { input: 'c', to: [0, 0.5], clamp: true } }] }],
          },
        },
      },
      { name: 'terrain', module: 'noise::test::terrain' },
    )

  async function run(
    compute: NoiseCompute,
    request: Parameters<NoiseCompute['encode']>[2],
    count: number,
  ) {
    const library = new (await import('@aethervtt/shard-shader')).ShaderLibrary()
    const device = gpu.device
    let ok = false
    for (let i = 0; i < 20 && !ok; i++) {
      const enc = device.createCommandEncoder()
      const pass = enc.beginComputePass()
      ok = compute.encode(library, pass, request)
      pass.end()
      device.queue.submit([enc.finish()])
      if (!ok) {
        await library.whenIdle()
        await gpu.pipelines.whenIdle()
      }
    }
    expect(ok).toBe(true)
    const read = device.createBuffer({
      size: count * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    const enc = device.createCommandEncoder()
    enc.copyBufferToBuffer(request.out, 0, read, 0, count * 4)
    device.queue.submit([enc.finish()])
    await read.mapAsync(GPUMapMode.READ)
    const values = new Float32Array(read.getMappedRange().slice(0))
    read.unmap()
    read.destroy()
    return values
  }

  const within = (cpu: Float32Array, g: Float32Array, gain: number) => {
    let worst = 0
    for (let i = 0; i < cpu.length; i++) {
      worst = Math.max(worst, Math.abs(cpu[i]! - g[i]!) / (1e-5 * (1 + Math.abs(cpu[i]!)) * gain))
    }
    return worst
  }

  it('fills a 257² sphere patch on an Earth-sized planet like sampleSpherePatch', async () => {
    const g = graph()
    const n = 257
    const patch = { face: 1, x0: 0.3, y0: -0.2, extent: 0.0005, resolution: n, radius: 6.371e6 }
    const out = gpu.device.createBuffer({
      size: n * n * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const compute = new NoiseCompute(gpu, g, 'sphere-patch')
    const values = await run(compute, { seed: 9, area: patch, out }, n * n)
    const cpu = new Float32Array(n * n)
    sampleSpherePatch(g, 9, patch, cpu)
    expect(within(cpu, values, 2)).toBeLessThanOrEqual(1)
    compute.destroy()
    out.destroy()
  })

  it('fills a grid like sampleGrid2d', async () => {
    const g = graph()
    const grid = { origin: [1.2e6, -4e5] as [number, number], size: 3000, resolution: 129 }
    const out = gpu.device.createBuffer({
      size: 129 * 129 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    const compute = new NoiseCompute(gpu, g, 'grid2d')
    const values = await run(compute, { seed: 3, area: grid, out }, 129 * 129)
    const cpu = new Float32Array(129 * 129)
    sampleGrid2d(g, 3, grid, cpu)
    expect(within(cpu, values, 2)).toBeLessThanOrEqual(1)
    compute.destroy()
    out.destroy()
  })

  it('runs as a render graph node when asked', async () => {
    const app = new App().addPlugin(
      TransformPlugin,
      renderPlugin({ gpu, windowView: false }),
      forwardPlugin({ msaa: 1 }),
    )
    await app.init()
    const g = graph()
    const out = gpu.device.createBuffer({
      size: 33 * 33 * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    let pending:
      | {
          seed: number
          area: { origin: [number, number]; size: number; resolution: number }
          out: GPUBuffer
        }
      | undefined = {
      seed: 1,
      area: { origin: [0, 0], size: 100, resolution: 33 },
      out,
    }
    let done = 0
    app.world.resource(Graph).addNode(
      'noise-test',
      noiseComputeNode({
        graph: g,
        domain: 'grid2d',
        next: () => pending,
        done: () => {
          done++
          pending = undefined
        },
      }),
    )
    const target = new OffscreenTarget(gpu, { label: 'noise-node', width: 8, height: 8 })
    const ref = app.world.resource(RenderTargets).add(target, 'noise-node')
    app.world.spawn([Camera3d, { target: ref }], [Transform, {}])
    for (let i = 0; i < 30 && done === 0; i++) {
      app.update(1 / 60)
      await app.world.resource(Shaders).whenIdle()
      await new Promise((r) => setTimeout(r, 5))
    }
    expect(done).toBe(1)
    expect(app.world.resource(Gpu).errors).toEqual([])
    out.destroy()
  })
})
