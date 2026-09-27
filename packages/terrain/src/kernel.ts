import {
  generateWgsl,
  type NoiseGraph,
  type NoiseProgram,
  registerNoiseLibrary,
} from '@shard/noise'
import type { ShaderLibrary } from '@shard/shader'

/** A graph (or one node of it) as the kernel imports it: a WGSL module and its program. */
export interface KernelGraph {
  module: string
  name: string
  wgsl: string
  program: NoiseProgram
  hash: string
}

const nodeGraphs = new WeakMap<NoiseGraph, Map<string, KernelGraph>>()

/** The graph's own output, or one node of it (the climate graph's temperature and moisture). */
export function kernelGraph(graph: NoiseGraph, node?: string): KernelGraph {
  if (!node) {
    return {
      module: graph.module,
      name: graph.name,
      wgsl: graph.wgsl,
      program: graph.program,
      hash: graph.hash,
    }
  }
  let byNode = nodeGraphs.get(graph)
  if (!byNode) {
    byNode = new Map()
    nodeGraphs.set(graph, byNode)
  }
  const cached = byNode.get(node)
  if (cached && cached.hash === `${graph.hash}:${node}`) return cached
  const name = `${graph.name}_${node}`
  const program = graph.programFor(node)
  const out: KernelGraph = {
    module: `${graph.module}_${node}`,
    name,
    wgsl: generateWgsl(program, { name }),
    program,
    hash: `${graph.hash}:${node}`,
  }
  byNode.set(node, out)
  return out
}

/** Floats per point in the uploaded point buffer: local xyz, q xyz, dir xyz, group (u32 bits). */
export const POINT_FLOATS = 10

/** Bytes of the kernel's uniform. */
export const PARAMS_BYTES = 64

/** Flags in GenParams.flags. */
export const GEN_HEIGHT = 1
export const GEN_CLIMATE = 2
export const GEN_ROOT = 4
export const GEN_OCEAN = 8

const PARAMS = `
struct GenParams {
  count: u32,
  side: u32,
  n: u32,
  surface: u32,
  ring: u32,
  seed: u32,
  flags: u32,
  /** The chunk's slot: its normal tile, packed into uv1.x (see packGrid). */
  tile: u32,
  /** Ellipsoid axis ratios (xyz), metres per height unit (w). */
  shape: vec4f,
  /** x: surface offset (m, the ocean's sea level), y: morph error, z: skirt depth. */
  misc: vec4f,
}

@group(0) @binding(0) var<uniform> params: GenParams;
@group(0) @binding(1) var<storage, read> pts: array<f32>;
`

/** The sampling pass: each point's height and climate from its lattice origin. */
export function sampleKernel(
  height: KernelGraph | undefined,
  temperature: KernelGraph | undefined,
  moisture: KernelGraph | undefined,
): string {
  const imports: string[] = []
  const bindings: string[] = []
  const body: string[] = []
  const add = (g: KernelGraph | undefined, binding: number, target: string) => {
    if (!g) return
    imports.push(`import ${g.module}::{ noise_${g.name}_at, NoiseOrigins_${g.name} };`)
    bindings.push(
      `@group(0) @binding(${binding}) var<storage, read> origins_${target}: array<NoiseOrigins_${g.name}>;`,
    )
    body.push(
      `  { var o = origins_${target}[g]; ${target} = noise_${g.name}_at(&o, local, params.seed); }`,
    )
  }
  add(height, 3, 'h')
  add(temperature, 4, 't')
  add(moisture, 5, 'm')
  return `${imports.join('\n')}
${PARAMS}
@group(0) @binding(2) var<storage, read_write> values: array<f32>;
${bindings.join('\n')}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  if (k >= params.count) { return; }
  let p = k * ${POINT_FLOATS}u;
  let local = vec3f(pts[p], pts[p + 1u], pts[p + 2u]);
  let g = bitcast<u32>(pts[p + 9u]);
  var h = 0.0;
  var t = 0.0;
  var m = 0.0;
${body.join('\n')}
  values[k * 3u] = h;
  values[k * 3u + 1u] = t;
  values[k * 3u + 2u] = m;
}
`
}

/**
 * The vertex pass, one invocation per surface vertex: position (the point's offset from the chunk
 * center plus its direction times its height), central-difference normal from the bordered grid,
 * climate, morph delta to the parent level, and the skirt copy of ring vertices. Heights, water
 * depth, and morph error go into the stats for the readback. Same layout and math as `buildChunk`.
 * uv1 is (grid point i + j·n + n²·tile, morph error): the vertex stage derives lock codes from the
 * grid point, the surface stage finds its normal tile (`packGrid`).
 */
export const VERTEX_KERNEL = `${PARAMS}
@group(0) @binding(2) var<storage, read> values: array<f32>;
@group(0) @binding(3) var<storage, read_write> positions: array<f32>;
@group(0) @binding(4) var<storage, read_write> normals: array<f32>;
@group(0) @binding(5) var<storage, read_write> uvs: array<f32>;
@group(0) @binding(6) var<storage, read_write> uvs1: array<f32>;
@group(0) @binding(7) var<storage, read_write> tangents: array<f32>;
/** Min height, max height (mm), largest morph delta (mm). */
@group(0) @binding(8) var<storage, read_write> stats: array<atomic<i32>, 4>;

/** Vertex index of grid point (i, j): the border ring first (counter-clockwise), then rows. */
fn vertex_index(i: u32, j: u32, n: u32) -> u32 {
  let s = n - 1u;
  if (j == 0u) { return i; }
  if (i == s) { return s + j; }
  if (j == s) { return 2u * s + (s - i); }
  if (i == 0u) { return 3u * s + (s - j); }
  return 4u * s + (j - 1u) * (n - 2u) + (i - 1u);
}

fn terrain_height(k: u32) -> f32 {
  return values[k * 3u] * params.shape.w;
}

fn surface_height(k: u32) -> f32 {
  if ((params.flags & ${GEN_OCEAN}u) != 0u) { return params.misc.x; }
  return terrain_height(k) + params.misc.x;
}

fn point_position(k: u32) -> vec3f {
  let p = k * ${POINT_FLOATS}u;
  let q = vec3f(pts[p + 3u], pts[p + 4u], pts[p + 5u]);
  let d = vec3f(pts[p + 6u], pts[p + 7u], pts[p + 8u]);
  return q + params.shape.xyz * d * surface_height(k);
}

fn write_vertex(v: u32, p: vec3f, n: vec3f, climate: vec2f, lock: vec2f, t: vec4f) {
  positions[v * 3u] = p.x;
  positions[v * 3u + 1u] = p.y;
  positions[v * 3u + 2u] = p.z;
  normals[v * 3u] = n.x;
  normals[v * 3u + 1u] = n.y;
  normals[v * 3u + 2u] = n.z;
  uvs[v * 2u] = climate.x;
  uvs[v * 2u + 1u] = climate.y;
  uvs1[v * 2u] = lock.x;
  uvs1[v * 2u + 1u] = lock.y;
  tangents[v * 4u] = t.x;
  tangents[v * 4u + 1u] = t.y;
  tangents[v * 4u + 2u] = t.z;
  tangents[v * 4u + 3u] = t.w;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let v = id.x;
  if (v >= params.surface) { return; }
  let n = params.n;
  let b = params.side;
  let i = v % n;
  let j = v / n;
  let k = (i + 1u) + (j + 1u) * b;
  let p = point_position(k);
  let normal = normalize(cross(point_position(k + 1u) - point_position(k - 1u), point_position(k + b) - point_position(k - b)));
  var delta = vec3f(0.0);
  let oi = (i & 1u) == 1u;
  let oj = (j & 1u) == 1u;
  if ((oi || oj) && (params.flags & ${GEN_ROOT}u) == 0u) {
    let ka = select(k, k - 1u, oi) - select(0u, b, oj);
    let kb = select(k, k + 1u, oi) + select(0u, b, oj);
    delta = (point_position(ka) + point_position(kb)) * 0.5 - p;
    atomicMax(&stats[2], i32(ceil(length(delta) * 1000.0)));
  }
  let h = terrain_height(k);
  let surface = surface_height(k);
  var w = h;
  if ((params.flags & ${GEN_OCEAN}u) != 0u) { w = params.misc.x - h; }
  let climate = vec2f(values[k * 3u + 1u], values[k * 3u + 2u]);
  let vi = vertex_index(i, j, n);
  let lock = vec2f(f32(i + j * n + n * n * params.tile), params.misc.y);
  let tangent = vec4f(delta, w);
  write_vertex(vi, p, normal, climate, lock, tangent);
  if (vi < params.ring) {
    let q = k * ${POINT_FLOATS}u;
    let down = normalize(params.shape.xyz * vec3f(pts[q + 6u], pts[q + 7u], pts[q + 8u]));
    write_vertex(params.surface + vi, p - down * params.misc.z, normal, climate, lock, tangent);
  }
  atomicMin(&stats[0], i32(floor(surface * 1000.0)));
  atomicMax(&stats[1], i32(ceil(surface * 1000.0)));
}
`

/**
 * The normal-tile pass (spec 0044 follow-up to 0043): over a chunk's grid at twice the vertex
 * density (sampled like any chunk grid, bordered), one planet-space normal per texel into the
 * chunk's tile of the planet's tile array. The same central differences as the vertex pass, so a
 * tile texel on a vertex has that vertex's normal (to 8 bits).
 */
export const NORMAL_KERNEL = `${PARAMS}
@group(0) @binding(2) var<storage, read> values: array<f32>;
@group(0) @binding(3) var tile_out: texture_storage_2d<rgba8unorm, write>;

fn point_position(k: u32) -> vec3f {
  let p = k * ${POINT_FLOATS}u;
  let q = vec3f(pts[p + 3u], pts[p + 4u], pts[p + 5u]);
  let d = vec3f(pts[p + 6u], pts[p + 7u], pts[p + 8u]);
  return q + params.shape.xyz * d * (values[k * 3u] * params.shape.w);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let t = params.n;
  if (id.x >= t * t) { return; }
  let b = params.side;
  let i = id.x % t;
  let j = id.x / t;
  let k = (i + 1u) + (j + 1u) * b;
  let normal = normalize(cross(point_position(k + 1u) - point_position(k - 1u), point_position(k + b) - point_position(k - b)));
  // The tile's corner in its layer: surface (texel x) and ring (texel y) carry it.
  textureStore(tile_out, vec2u(params.surface + i, params.ring + j), vec4f(normal * 0.5 + 0.5, 1.0));
}
`

/** uv1.x of grid point (i, j) in a chunk of resolution n drawn from normal tile `tile`. */
export function packGrid(i: number, j: number, n: number, tile: number): number {
  return i + j * n + n * n * tile
}

/** Registers a kernel's graph modules and its two roots; returns the root module paths. */
export function registerKernel(
  library: ShaderLibrary,
  key: string,
  height: KernelGraph | undefined,
  temperature: KernelGraph | undefined,
  moisture: KernelGraph | undefined,
): { sample: string; vertices: string; normals: string } {
  registerNoiseLibrary(library)
  for (const g of [height, temperature, moisture])
    if (g) library.register(g.module, g.wgsl, g.module)
  const sample = `terrain::gen::k${key}::sample`
  const vertices = 'terrain::gen::vertices'
  const normals = 'terrain::gen::normals'
  library.register(sample, sampleKernel(height, temperature, moisture), 'terrain chunk sampling')
  if (!library.has(vertices)) library.register(vertices, VERTEX_KERNEL, 'terrain chunk vertices')
  if (!library.has(normals)) library.register(normals, NORMAL_KERNEL, 'terrain normal tiles')
  return { sample, vertices, normals }
}
