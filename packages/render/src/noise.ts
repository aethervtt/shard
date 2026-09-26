import { AssetServerResource, assetServer } from '@shard/assets'
import { type AssetRef, ShardError, type World } from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import {
  type Grid2d,
  type GridParams,
  type NoiseGraph,
  NoiseGraphs,
  noiseOrigins,
  normalizeGrid,
  patchOrigin,
  patchPoints,
  registerNoiseGraph,
  type SpherePatch,
} from '@shard/noise'
import { LogResource, Time } from '@shard/runtime'
import type { ShaderLibrary } from '@shard/shader'
import type { NodeDescriptor } from './graph'
import type { MaterialType } from './materials'
import { Shaders } from './plugin'

interface SlotState {
  ref: AssetRef | undefined
  graph: NoiseGraph | undefined
  version: number
}

interface TypeNoise {
  slots: SlotState[]
  /** The wrappers for the slots' current graphs; rebuilt only when one changes. */
  source: string
  key: string
}

const states = new WeakMap<MaterialType, TypeNoise>()
const loading = new WeakMap<World, Set<string>>()

/**
 * The WGSL a material type's noise slots add to its module: `noise_<slot>(p, seed)` for each,
 * calling its graph's function. Registers each graph's module (a changed graph relinks the
 * material). Undefined while a graph is still loading; this starts the load.
 */
export function materialNoise(
  world: World,
  library: ShaderLibrary,
  type: MaterialType,
): { source: string; key: string } | undefined {
  let state = states.get(type)
  if (!state || state.slots.length !== type.noise.length) {
    state = {
      slots: type.noise.map(() => ({ ref: undefined, graph: undefined, version: -1 })),
      source: '',
      key: '',
    }
    states.set(type, state)
  }
  const store = world.tryResource(NoiseGraphs)
  let changed = false
  for (let i = 0; i < type.noise.length; i++) {
    const slot = type.noise[i]!
    const s = state.slots[i]!
    s.ref ??= world.tryResource(AssetServerResource)
      ? assetServer(world).resolve(slot.path)
      : undefined
    if (!s.ref) {
      reportMissing(world, type, slot.path)
      return undefined
    }
    const graph = store?.get(s.ref)
    if (!graph) {
      startLoad(world, slot.path)
      return undefined
    }
    if (graph !== s.graph || graph.version !== s.version) {
      s.graph = graph
      s.version = graph.version
      changed = true
    }
    registerNoiseGraph(library, graph, slot.path)
  }
  if (changed || state.key === '') {
    let source = ''
    let key = ''
    for (let i = 0; i < type.noise.length; i++) {
      const graph = state.slots[i]!.graph!
      const pos = graph.program.dimensions === 4 ? 'vec4f' : 'vec3f'
      const name = type.noise[i]!.name
      source += `/** ${type.noise[i]!.path} */\nfn noise_${name}(p: ${pos}, seed: u32) -> f32 {\n  return ${graph.module}::${graph.fn}(p, seed);\n}\n`
      key += `${graph.hash}:${graph.module};`
    }
    state.source = source
    state.key = key
  }
  return state
}

const reported = new WeakMap<World, Set<string>>()

function reportMissing(world: World, type: MaterialType, path: string): void {
  let seen = reported.get(world)
  if (!seen) {
    seen = new Set()
    reported.set(world, seen)
  }
  const key = `${type.name}:${path}`
  if (seen.has(key)) return
  seen.add(key)
  world.tryResource(LogResource)?.error(
    new ShardError(
      'render/noise-graph-missing',
      `Material ${type.name} uses "${path}", which isn't an asset`,
      {
        path,
        hint: 'noise paths name *.noise.json assets, e.g. { detail: "assets/noise/rock.noise.json" }.',
      },
    ),
  )
}

function startLoad(world: World, path: string): void {
  let set = loading.get(world)
  if (!set) {
    set = new Set()
    loading.set(world, set)
  }
  if (set.has(path)) return
  set.add(path)
  const pending = set
  assetServer(world)
    .load(path)
    .catch((err) => world.tryResource(LogResource)?.error(err))
    .finally(() => pending.delete(path))
}

// --- compute -----------------------------------------------------------------------------------

export type NoiseComputeDomain = 'grid2d' | 'sphere-patch'

export interface NoiseComputeRequest {
  readonly seed: number
  /** The grid (grid2d) or cube-sphere patch (sphere-patch) to fill. */
  readonly area: GridParams | SpherePatch
  /** Receives one f32 per sample, row by row (the same order as `sampleGrid2d` and `sampleSpherePatch`). */
  readonly out: GPUBuffer
}

const WORKGROUP = 64

/**
 * Fills a storage buffer with a graph's values over a grid or a cube-sphere patch, on the GPU,
 * with origin-offset sampling: the CPU computes the origin records in f64 (and, for sphere patches,
 * the same local points `sampleSpherePatch` uses), so the values match the CPU kernel within its
 * tolerance at any planet size. 0043 dispatches one per terrain chunk.
 */
export class NoiseCompute {
  readonly gpu: GpuContext
  readonly domain: NoiseComputeDomain
  graph: NoiseGraph
  private readonly params: GpuBuffer
  private readonly origins: GpuBuffer
  private readonly points: GpuBuffer
  private readonly scratch = new ArrayBuffer(48)
  private readonly f32 = new Float32Array(this.scratch)
  private readonly u32 = new Uint32Array(this.scratch)
  private local = new Float32Array(0)
  private records = new Int32Array(0)
  private readonly origin64 = new Float64Array(4)
  private bindGroups = new WeakMap<GPUBuffer, { key: string; group: GPUBindGroup }>()

  constructor(gpu: GpuContext, graph: NoiseGraph, domain: NoiseComputeDomain) {
    this.gpu = gpu
    this.graph = graph
    this.domain = domain
    const usage = GPUBufferUsage.STORAGE
    this.params = new GpuBuffer(gpu, {
      label: 'noise/params',
      usage: GPUBufferUsage.UNIFORM,
      size: 48,
    })
    this.origins = new GpuBuffer(gpu, { label: 'noise/origins', usage, size: 256 })
    this.points = new GpuBuffer(gpu, { label: 'noise/points', usage, size: 16 })
  }

  /** The root module path of this domain's compute shader for the graph. */
  get modulePath(): string {
    return `${this.graph.module}::compute_${this.domain === 'grid2d' ? 'grid' : 'patch'}`
  }

  /** The compute shader: one invocation per sample, calling `noise_<name>_at`. */
  shaderSource(): string {
    const g = this.graph
    const n = g.name
    const point =
      this.domain === 'grid2d'
        ? 'let local = vec3f(params.corner + vec2f(f32(i % params.width), f32(i / params.width)) * params.step, 0.0);'
        : 'let local = vec3f(points[i * 3u], points[i * 3u + 1u], points[i * 3u + 2u]);'
    return `import ${g.module}::{ noise_${n}_at, NoiseOrigins_${n} };

struct NoiseComputeParams {
  seed: u32,
  count: u32,
  width: u32,
  _pad: u32,
  /** Grid: the first sample, relative to the grid center, and the spacing. */
  corner: vec2f,
  step: vec2f,
}

@group(0) @binding(0) var<uniform> params: NoiseComputeParams;
@group(0) @binding(1) var<storage, read> origins: NoiseOrigins_${n};
@group(0) @binding(2) var<storage, read_write> out: array<f32>;
${this.domain === 'sphere-patch' ? '@group(0) @binding(3) var<storage, read> points: array<f32>;\n' : ''}
@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.count) { return; }
  ${point}
  var o = origins;
  out[i] = noise_${n}_at(&o, local, params.seed);
}
`
  }

  private pipeline(library: ShaderLibrary): GPUComputePipeline | undefined {
    registerNoiseGraph(library, this.graph)
    const path = this.modulePath
    const source = this.shaderSource()
    library.register(path, source, `noise compute ${this.graph.module}`)
    const module = library.module(this.gpu, { root: path, label: `noise ${this.graph.name}` })
    if (!module) return undefined
    return this.gpu.pipelines.compute({
      label: `noise/${this.graph.name}/${this.domain}`,
      layout: 'auto',
      compute: { module, entryPoint: 'main' },
    })
  }

  /**
   * Writes this request's parameters and records a dispatch into `pass`. Returns false while the
   * shader compiles (nothing is recorded).
   */
  encode(
    library: ShaderLibrary,
    pass: GPUComputePassEncoder,
    request: NoiseComputeRequest,
  ): boolean {
    const pipeline = this.pipeline(library)
    if (!pipeline) return false
    const origin = this.origin64
    let count: number
    let width: number
    const f = this.f32
    const u = this.u32
    if (this.domain === 'grid2d') {
      const g: Grid2d = normalizeGrid(request.area as GridParams)
      const [nx, ny] = g.resolution
      count = nx * ny
      width = nx
      origin[0] = g.origin[0] + g.size[0] / 2
      origin[1] = g.origin[1] + g.size[1] / 2
      origin[2] = g.z ?? 0
      f[4] = -g.size[0] / 2
      f[5] = -g.size[1] / 2
      f[6] = nx > 1 ? g.size[0] / (nx - 1) : 0
      f[7] = ny > 1 ? g.size[1] / (ny - 1) : 0
    } else {
      const p = request.area as SpherePatch
      count = p.resolution * p.resolution
      width = p.resolution
      patchOrigin(p, origin)
      if (this.local.length < count * 3) this.local = new Float32Array(count * 3)
      patchPoints(p, origin, 0, p.resolution, this.local)
      this.points.ensureCapacity(count * 12)
      this.points.write(this.local.subarray(0, count * 3))
    }
    const records = this.graph.program.zeroOrigins.length
    if (this.records.length !== records) this.records = new Int32Array(Math.max(8, records))
    noiseOrigins(this.graph, origin, this.records.subarray(0, records))
    this.origins.ensureCapacity(this.records.byteLength)
    this.origins.write(this.records)
    u[0] = request.seed >>> 0
    u[1] = count
    u[2] = width
    this.params.write(f)
    const group = this.bindGroup(pipeline, request.out)
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, group)
    pass.dispatchWorkgroups(Math.ceil(count / WORKGROUP))
    return true
  }

  private bindGroup(pipeline: GPUComputePipeline, out: GPUBuffer): GPUBindGroup {
    const key = `${this.params.version}:${this.origins.version}:${this.points.version}:${this.graph.hash}`
    const cached = this.bindGroups.get(out)
    if (cached && cached.key === key) return cached.group
    const group = this.gpu.device.createBindGroup({
      label: `noise/${this.graph.name}`,
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.params.buffer } },
        { binding: 1, resource: { buffer: this.origins.buffer } },
        { binding: 2, resource: { buffer: out } },
        // Grids compute their points in the shader; `auto` layouts drop the unused binding.
        ...(this.domain === 'sphere-patch'
          ? [{ binding: 3, resource: { buffer: this.points.buffer } }]
          : []),
      ],
    })
    this.bindGroups.set(out, { key, group })
    return group
  }

  destroy(): void {
    this.params.destroy()
    this.origins.destroy()
    this.points.destroy()
  }
}

export interface NoiseComputeNodeOptions {
  readonly graph: NoiseGraph
  readonly domain: NoiseComputeDomain
  /** What to fill this frame, or undefined for nothing. Called once per frame. */
  next(): NoiseComputeRequest | undefined
  /** Called after the frame's commands are submitted with the request that ran. */
  done?(request: NoiseComputeRequest): void
}

/**
 * A render graph node (setup phase, once per frame) that fills a storage buffer from a noise graph
 * on the GPU whenever `next` returns a request. Add it with `world.resource(Graph).addNode(name, …)`.
 */
export function noiseComputeNode(options: NoiseComputeNodeOptions): NodeDescriptor {
  let compute: NoiseCompute | undefined
  let frame = -1
  return {
    kind: 'raw',
    phase: 0,
    sideEffects: true,
    run(ctx) {
      const library = ctx.world.resource(Shaders)
      const time = ctx.world.resource(Time).frame
      if (time === frame) return
      frame = time
      const request = options.next()
      if (!request) return
      if (!compute || compute.gpu !== ctx.gpu)
        compute = new NoiseCompute(ctx.gpu, options.graph, options.domain)
      compute.graph = options.graph
      const pass = ctx.encoder.beginComputePass({ label: `noise/${options.graph.name}` })
      const ok = compute.encode(library, pass, request)
      pass.end()
      if (ok && options.done) ctx.afterSubmit(() => options.done!(request))
    },
  }
}
