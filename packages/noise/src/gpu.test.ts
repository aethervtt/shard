import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { ShaderLibrary } from '@aethervtt/shard-shader'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  loadNoiseKernel,
  NoiseGraph,
  noiseOrigins,
  registerNoiseGraph,
  sampleNoise,
  sampleOffset,
} from '.'
import { PLANET } from './planet'

let gpu: GpuContext

beforeAll(async () => {
  await loadNoiseKernel()
  gpu = await createNodeGpuContext()
})

afterAll(() => gpu?.destroy())

const COUNT = 65_536
/** Points within ±4 units: a chunk's worth of lattice cells at these frequencies. */
const SPAN = 8

function lcg(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Evaluates `graph` on the GPU at `points` (vec4 each): plainly, or around `origin` with `_at`. */
async function gpuSample(
  graph: NoiseGraph,
  seed: number,
  points: Float32Array,
  origin?: ArrayLike<number>,
): Promise<Float32Array> {
  const library = new ShaderLibrary()
  registerNoiseGraph(library, graph)
  const n = graph.name
  const pos = graph.program.dimensions === 4 ? 'p' : 'p.xyz'
  library.register(
    'noise::parity::main',
    `import ${graph.module}::{ noise_${n}, noise_${n}_at, NoiseOrigins_${n} };
@group(0) @binding(0) var<storage, read> points: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> out: array<f32>;
@group(0) @binding(2) var<storage, read> origins: NoiseOrigins_${n};
@group(0) @binding(3) var<uniform> params: vec4u;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.y) { return; }
  let p = points[i];
  if (params.z == 0u) {
    out[i] = noise_${n}(${pos}, params.x);
  } else {
    var o = origins;
    out[i] = noise_${n}_at(&o, ${pos}, params.x);
  }
}`,
  )
  const linked = await library.link({ root: 'noise::parity::main' })
  const device = gpu.device
  device.pushErrorScope('validation')
  const module = device.createShaderModule({ code: linked.code })
  const info = await module.getCompilationInfo()
  const errors = info.messages.filter((m) => m.type === 'error')
  if (errors.length)
    throw new Error(`${errors.map((e) => `${e.lineNum}: ${e.message}`).join('\n')}\n${linked.code}`)
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  })
  const count = points.length / 4
  const buf = (data: ArrayBufferView, usage: number) => {
    const b = device.createBuffer({
      size: Math.max(16, data.byteLength),
      usage: usage | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(b, 0, data as BufferSource)
    return b
  }
  const records = origin
    ? noiseOrigins(graph, origin)
    : new Int32Array(Math.max(8, graph.program.zeroOrigins.length))
  const pointBuf = buf(points, GPUBufferUsage.STORAGE)
  const outBuf = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  })
  const originBuf = buf(records.length ? records : new Int32Array(8), GPUBufferUsage.STORAGE)
  const paramBuf = buf(
    new Uint32Array([seed >>> 0, count, origin ? 1 : 0, 0]),
    GPUBufferUsage.UNIFORM,
  )
  const read = device.createBuffer({
    size: count * 4,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  const bind = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: pointBuf } },
      { binding: 1, resource: { buffer: outBuf } },
      { binding: 2, resource: { buffer: originBuf } },
      { binding: 3, resource: { buffer: paramBuf } },
    ],
  })
  const enc = device.createCommandEncoder()
  const pass = enc.beginComputePass()
  pass.setPipeline(pipeline)
  pass.setBindGroup(0, bind)
  pass.dispatchWorkgroups(Math.ceil(count / 64))
  pass.end()
  enc.copyBufferToBuffer(outBuf, 0, read, 0, count * 4)
  device.queue.submit([enc.finish()])
  const scope = await device.popErrorScope()
  if (scope) throw new Error(scope.message)
  await read.mapAsync(GPUMapMode.READ)
  const result = new Float32Array(read.getMappedRange().slice(0))
  read.unmap()
  for (const b of [pointBuf, outBuf, originBuf, paramBuf, read]) b.destroy()
  return result
}

/**
 * Worst |cpu − gpu| / (1e-5 × (1 + |cpu|) × gain) over the points; ≤ 1 passes. `gain` is how much
 * the graph amplifies differences in its inputs (a remap's slope): GPUs fuse multiply-adds, so
 * sources differ by about an ulp of their lattice position, and a slope-k operator passes that on
 * k-fold.
 */
function worst(
  cpu: Float32Array,
  gpuValues: Float32Array,
  gain = 1,
): { ratio: number; at: number } {
  let ratio = 0
  let at = -1
  for (let i = 0; i < cpu.length; i++) {
    const r = Math.abs(cpu[i]! - gpuValues[i]!) / (1e-5 * (1 + Math.abs(cpu[i]!)) * gain)
    if (!(r <= ratio)) {
      ratio = r
      at = i
    }
  }
  return { ratio, at }
}

const src = { simplex: { frequency: 0.7, seed: 3 } }
const other = { perlin: { frequency: 1.3, seed: 4 } }

/** One graph per node type (operators get simplex and Perlin inputs). */
const CASES: Record<string, { node: unknown; dimensions?: 2 | 3 | 4; gain?: number }> = {
  value2: { node: { value: { dims: 2, frequency: 2 } } },
  value3: { node: { value: { frequency: 2 } } },
  perlin2: { node: { perlin: { dims: 2, frequency: 2 } } },
  perlin3: { node: { perlin: { frequency: 2 } } },
  simplex2: { node: { simplex: { dims: 2, frequency: 2 } } },
  simplex3: { node: { simplex: { frequency: 2 } } },
  simplex4: { node: { simplex: { dims: 4, frequency: 2 } }, dimensions: 4 },
  cellular2: { node: { cellular: { dims: 2, frequency: 2, return: 'f2' } } },
  cellular3: { node: { cellular: { frequency: 2 } } },
  cellular_edges: { node: { cellular: { frequency: 2, return: 'f2-f1', distance: 'manhattan' } } },
  cellular_cheb: { node: { cellular: { frequency: 2, distance: 'chebyshev', jitter: 0.7 } } },
  fbm: { node: { fbm: { octaves: 6, frequency: 0.5 } } },
  ridged: { node: { ridged: { octaves: 5, source: 'perlin' } } },
  billow: { node: { billow: { octaves: 4, source: 'value' } } },
  add: { node: { add: [src, other, 0.5] } },
  multiply: { node: { multiply: [src, other] } },
  min: { node: { min: [src, other] } },
  max: { node: { max: [src, other] } },
  lerp: {
    node: { lerp: { a: src, b: other, t: { remap: { input: src, from: [-1, 1], to: [0, 1] } } } },
  },
  select: { node: { select: { a: src, b: other, control: src, threshold: 0.1, falloff: 0.2 } } },
  remap: {
    node: { remap: { input: src, from: [0.1, 0.4], to: [0, 1], clamp: true } },
    gain: 1 / 0.3,
  },
  clamp: { node: { clamp: { input: src, min: -0.3, max: 0.6 } } },
  curve: {
    node: {
      curve: {
        input: src,
        points: [
          [-1, -1],
          [-0.2, 0.1],
          [0.3, 0.2],
          [1, 1],
        ],
      },
    },
  },
  terrace: { node: { terrace: { input: src, steps: 5, sharpness: 0.6 } }, gain: 1 / (1 - 0.6) },
  abs: { node: { abs: src } },
  power: { node: { power: { input: src, exponent: 2.7 } } },
  constant: { node: { constant: 0.375 } },
  warp: { node: { warp: { input: src, by: other, amount: 0.3 } } },
  scale: {
    node: { scale: { input: { warp: { input: src, by: other, amount: 0.2 } }, by: [2, 0.5, 1] } },
  },
  translate: { node: { translate: { input: src, by: [10.5, -3, 2] } } },
}

describe('GPU codegen matches the CPU kernel', () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(`${name}: within 1e-5 × (1 + |cpu|) over 64k points`, async () => {
      const graph = NoiseGraph.fromJson(
        {
          output: 'n',
          nodes: { n: c.node },
          ...(c.dimensions ? { dimensions: c.dimensions } : {}),
        },
        { name, module: `noise::parity::${name}` },
      )
      const r = lcg(name.length * 7919)
      const pts4 = new Float32Array(COUNT * 4)
      for (let i = 0; i < pts4.length; i++) pts4[i] = (r() - 0.5) * SPAN
      const stride = c.dimensions === 4 ? 4 : 3
      const pts = new Float32Array(COUNT * stride)
      for (let i = 0; i < COUNT; i++)
        for (let k = 0; k < stride; k++) pts[i * stride + k] = pts4[i * 4 + k]!
      const cpu = new Float32Array(COUNT)
      sampleNoise(graph, 1234, pts, cpu)
      const g = await gpuSample(graph, 1234, pts4)
      const w = worst(cpu, g, c.gain)
      expect(w.ratio, `point ${w.at}: cpu ${cpu[w.at]} gpu ${g[w.at]}`).toBeLessThanOrEqual(1)
    })
  }

  it('the planet graph agrees, plainly and around a far origin', async () => {
    const graph = NoiseGraph.fromJson(PLANET, { name: 'planet', module: 'noise::parity::planet' })
    const r = lcg(99)
    const pts4 = new Float32Array(COUNT * 4)
    // The contract covers a chunk's worth of lattice cells (±4) of every octave. The finest here
    // (the mountains' sixth) has frequency 3.2 × 2⁵ = 102.4, so ±4 cells is ±0.039 units. Wider
    // spans leave it: the GPU's fused multiply-adds round an ulp of the lattice position differently,
    // and that ulp grows with the span (±51 cells differs by ~1e-3 on Metal and software Vulkan).
    const half = 4 / 102.4
    for (let i = 0; i < pts4.length; i++) pts4[i] = (r() * 2 - 1) * half
    const pts = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i++) pts.set(pts4.subarray(i * 4, i * 4 + 3), i * 3)
    const cpu = new Float32Array(COUNT)
    sampleNoise(graph, 5, pts, cpu)
    // The mask's remap has slope 1 / 0.3 and multiplies the mountains, and the warp moves the
    // mountains' lattice by amount × frequency per unit of difference in `by`.
    const gain = (1 / 0.3) * (1 + 0.15 * 3.2)
    let w = worst(cpu, await gpuSample(graph, 5, pts4), gain)
    expect(w.ratio).toBeLessThanOrEqual(1)
    const origin = [6.4e6, -2.5e5, 1.1e6]
    sampleOffset(graph, 5, origin, pts, cpu)
    w = worst(cpu, await gpuSample(graph, 5, pts4, origin), gain)
    expect(w.ratio).toBeLessThanOrEqual(1)
  })

  it('origin offsets: a 0.5 m octave at 7×10⁷ m matches on the GPU too', async () => {
    const graph = NoiseGraph.fromJson(
      { output: 'n', nodes: { n: { simplex: { frequency: 2, seed: 5 } } } },
      { name: 'far', module: 'noise::parity::far' },
    )
    const r = lcg(3)
    const pts4 = new Float32Array(COUNT * 4)
    for (let i = 0; i < pts4.length; i++) pts4[i] = (r() - 0.5) * 8
    const pts = new Float32Array(COUNT * 3)
    for (let i = 0; i < COUNT; i++) pts.set(pts4.subarray(i * 4, i * 4 + 3), i * 3)
    const origin = [7e7, 1.3e5, -2.1e6]
    const cpu = new Float32Array(COUNT)
    sampleOffset(graph, 77, origin, pts, cpu)
    const w = worst(cpu, await gpuSample(graph, 77, pts4, origin))
    expect(w.ratio).toBeLessThanOrEqual(1)
  })
})
