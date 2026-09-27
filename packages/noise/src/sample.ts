import { ShardError } from '@aethervtt/shard-core'
import type { Workers } from '@aethervtt/shard-platform'
import type { NoiseProgram } from './compile'
import {
  computeOrigins,
  evalProgram,
  type Grid2d,
  gridOrigin,
  gridPoints,
  patchOrigin,
  patchPoints,
  type SpherePatch,
} from './kernel'
import { loadNoiseKernel, noiseKernel } from './loader'
import type { NoiseGraph } from './noise-graph'

export type { Grid2d, SpherePatch } from './kernel'

/** A grid as the helpers take it: `size` and `resolution` may be one number for both axes. */
export interface GridParams {
  readonly origin: readonly [number, number]
  readonly size: number | readonly [number, number]
  readonly resolution: number | readonly [number, number]
  readonly z?: number
}

const WORKER = new URL('./worker.js', import.meta.url).href

// Scratch reused across calls, so sync sampling allocates nothing once warmed up.
let originScratch = new Int32Array(0)
let localScratch = new Float32Array(0)
const origin64 = new Float64Array(4)

function origins(program: NoiseProgram): Int32Array {
  const n = program.zeroOrigins.length
  if (originScratch.length < n) originScratch = new Int32Array(n)
  return n === originScratch.length ? originScratch : originScratch.subarray(0, n)
}

function local(n: number): Float32Array {
  if (localScratch.length < n) localScratch = new Float32Array(n)
  return localScratch
}

/** Re-throws the kernel's plain errors (worker-safe) as ShardErrors. */
function shard(err: unknown): never {
  if (err instanceof ShardError) throw err
  const e = err as { code?: string; message?: string; hint?: string }
  throw new ShardError(e.code ?? 'noise/sample-failed', e.message ?? String(err), {
    ...(e.hint ? { hint: e.hint } : {}),
  })
}

function stride(graph: NoiseGraph): number {
  return graph.program.dimensions === 4 ? 4 : 3
}

function check(count: number, out: Float32Array): void {
  if (out.length < count) {
    throw new ShardError(
      'noise/out-too-small',
      `out holds ${out.length} values; the call writes ${count}`,
      {
        hint: 'Size out to one value per point (resolution² for patches, nx × ny for grids).',
      },
    )
  }
}

/**
 * Samples a graph at absolute positions (`xyz…`, or `xyzw…` for a 4D graph) into `out`. Precise
 * near the origin only (past ~10⁵ units fine octaves lose their fraction bits): use `sampleOffset`
 * for large domains. Sync, on the calling thread; meant for small batches (a raycast's worth).
 */
export function sampleNoise(
  graph: NoiseGraph,
  seed: number,
  points: Float32Array,
  out: Float32Array,
  node?: string,
): void {
  const program = graph.programFor(node)
  const s = stride(graph)
  const count = Math.floor(points.length / s)
  check(count, out)
  evalProgram(noiseKernel().state, program, seed, program.zeroOrigins, points, s, count, out)
}

/**
 * Samples at `origin + local`: `origin` is an f64 point (a chunk's center) and `local` small f32
 * offsets from it. Every source splits its lattice position of the origin into an integer cell and
 * a fraction in f64, so precision depends only on the size of `local`, not on where the origin is.
 * Throws `noise/frequency-too-high` if a lattice cell leaves the i32 range.
 */
export function sampleOffset(
  graph: NoiseGraph,
  seed: number,
  origin: ArrayLike<number>,
  localPoints: Float32Array,
  out: Float32Array,
  node?: string,
): void {
  const program = graph.programFor(node)
  const s = stride(graph)
  const count = Math.floor(localPoints.length / s)
  check(count, out)
  const records = origins(program)
  try {
    computeOrigins(program.terms, origin, records)
  } catch (err) {
    shard(err)
  }
  evalProgram(noiseKernel().state, program, seed, records, localPoints, s, count, out)
}

/** The origin records `noise_<name>_at` reads in WGSL, for sampling around `origin`. */
export function noiseOrigins(
  graph: NoiseGraph,
  origin: ArrayLike<number>,
  out?: Int32Array,
): Int32Array {
  const program = graph.program
  const records = out ?? new Int32Array(program.zeroOrigins.length)
  try {
    return computeOrigins(program.terms, origin, records)
  } catch (err) {
    shard(err)
  }
}

export function normalizeGrid(g: GridParams): Grid2d {
  const size = typeof g.size === 'number' ? ([g.size, g.size] as const) : g.size
  const res =
    typeof g.resolution === 'number' ? ([g.resolution, g.resolution] as const) : g.resolution
  return { origin: g.origin, size, resolution: res, ...(g.z !== undefined ? { z: g.z } : {}) }
}

/**
 * Samples a `resolution` grid spanning `origin` to `origin + size` on the z plane (x along a row,
 * rows along y) into `out`, row by row. Offsets from the grid's center, so it's precise anywhere.
 */
export function sampleGrid2d(
  graph: NoiseGraph,
  seed: number,
  grid: GridParams,
  out: Float32Array,
  node?: string,
): void {
  const g = normalizeGrid(grid)
  const [nx, ny] = g.resolution
  check(nx * ny, out)
  gridOrigin(g, origin64)
  const pts = gridPoints(g, origin64, 0, ny, local(nx * ny * 3))
  sampleArea(graph, seed, pts, nx * ny, out, node)
}

/**
 * Samples a cube-sphere patch: `resolution`² vertices over face coordinates [x0, x0 + extent] ×
 * [y0, y0 + extent] (tangent-adjusted, as 0043's terrain), at direction × radius. Offsets from the
 * patch center, so a chunk on a gas giant samples as precisely as one at the origin.
 */
export function sampleSpherePatch(
  graph: NoiseGraph,
  seed: number,
  patch: SpherePatch,
  out: Float32Array,
  node?: string,
): void {
  const n = patch.resolution
  check(n * n, out)
  patchOrigin(patch, origin64)
  const pts = patchPoints(patch, origin64, 0, n, local(n * n * 3))
  sampleArea(graph, seed, pts, n * n, out, node)
}

function sampleArea(
  graph: NoiseGraph,
  seed: number,
  pts: Float32Array,
  count: number,
  out: Float32Array,
  node?: string,
) {
  const program = graph.programFor(node)
  if (program.dimensions === 4) {
    throw new ShardError(
      'noise/domain-mismatch',
      'Grids and sphere patches are 3D; this graph is 4D',
      {
        hint: 'Sample a 4D graph with sampleNoise or sampleOffset and xyzw points.',
      },
    )
  }
  const records = origins(program)
  try {
    computeOrigins(program.terms, origin64, records)
  } catch (err) {
    shard(err)
  }
  evalProgram(noiseKernel().state, program, seed, records, pts, 3, count, out)
}

/**
 * The gradient of the graph at each point, by central differences of `h` (default: a thousandth
 * of the finest lattice cell), written to `dx`, `dy`, `dz`; `out` gets the values. For CPU normals
 * and slope masks. Positions are absolute, as in `sampleNoise`.
 */
export function sampleNoiseGradient(
  graph: NoiseGraph,
  seed: number,
  points: Float32Array,
  out: Float32Array,
  dx: Float32Array,
  dy: Float32Array,
  dz: Float32Array,
  h?: number,
): void {
  const s = stride(graph)
  const count = Math.floor(points.length / s)
  check(count, out)
  let finest = 0
  for (const a of graph.program.terms.a) finest = Math.max(finest, Math.abs(a))
  const step = h ?? (finest > 0 ? 1e-3 / finest : 1e-3)
  const pts = local(count * s * 7)
  const values = new Float32Array(count * 7)
  for (let i = 0; i < count; i++) {
    for (let v = 0; v < 7; v++) {
      const o = (v * count + i) * s
      for (let c = 0; c < s; c++) pts[o + c] = points[i * s + c]!
    }
    for (let axis = 0; axis < 3; axis++) {
      pts[((1 + axis * 2) * count + i) * s + axis]! += step
      pts[((2 + axis * 2) * count + i) * s + axis]! -= step
    }
  }
  const program = graph.program
  evalProgram(noiseKernel().state, program, seed, program.zeroOrigins, pts, s, count * 7, values)
  const inv = 1 / (2 * step)
  for (let i = 0; i < count; i++) {
    out[i] = values[i]!
    dx[i] = (values[count + i]! - values[2 * count + i]!) * inv
    dy[i] = (values[3 * count + i]! - values[4 * count + i]!) * inv
    dz[i] = (values[5 * count + i]! - values[6 * count + i]!) * inv
  }
}

// --- on the pool -------------------------------------------------------------------------------

export interface AsyncOptions {
  readonly priority?: 'high' | 'normal'
  /** Sample `node` instead of the graph's output. */
  readonly node?: string
}

/**
 * `sampleNoise` (or `sampleOffset`, with `origin`) on the worker pool. `points` is copied and
 * moves to the worker; the values move back and are copied into `out`.
 */
export async function sampleNoiseAsync(
  workers: Workers,
  graph: NoiseGraph,
  seed: number,
  points: Float32Array,
  out: Float32Array,
  options: AsyncOptions & { origin?: ArrayLike<number> } = {},
): Promise<void> {
  const program = graph.programFor(options.node)
  const s = stride(graph)
  const count = Math.floor(points.length / s)
  check(count, out)
  const { module } = await loadNoiseKernel()
  const copy = points.slice(0, count * s)
  const job = {
    kind: 'points',
    points: copy,
    stride: s,
    ...(options.origin ? { origin: Float64Array.from(options.origin) } : {}),
  }
  const values = await workers
    .run<Float32Array>(WORKER, 'sample', [module, program, seed >>> 0, job], {
      transfer: [copy.buffer],
      priority: options.priority,
    })
    .catch(shard)
  out.set(values)
}

/**
 * Milliseconds the calling thread spent in pool sampling since the last reset: posting jobs and
 * copying results into `out`. The bench checks it stays small next to the work itself.
 */
export const poolTiming = { mainThreadMs: 0 }

/** Rows per job: a request splits across the pool, and each job's origin is the whole area's. */
function splits(workers: Workers, rows: number): number {
  const lanes = workers.size > 0 ? workers.size : 1
  return Math.max(1, Math.min(lanes, Math.ceil(rows / 16)))
}

async function areaAsync(
  workers: Workers,
  graph: NoiseGraph,
  seed: number,
  kind: 'patch' | 'grid',
  area: SpherePatch | Grid2d,
  width: number,
  rows: number,
  out: Float32Array,
  options: AsyncOptions,
): Promise<void> {
  const program = graph.programFor(options.node)
  const { module } = await loadNoiseKernel()
  const t0 = performance.now()
  const jobs = splits(workers, rows)
  const per = Math.ceil(rows / jobs)
  const pending: Promise<void>[] = []
  for (let row0 = 0; row0 < rows; row0 += per) {
    const row1 = Math.min(rows, row0 + per)
    pending.push(
      workers
        .run<Float32Array>(
          WORKER,
          'sample',
          [module, program, seed >>> 0, { kind, area, row0, row1 }],
          {
            priority: options.priority,
          },
        )
        .then((values) => {
          const t = performance.now()
          out.set(values, row0 * width)
          poolTiming.mainThreadMs += performance.now() - t
        }, shard),
    )
  }
  poolTiming.mainThreadMs += performance.now() - t0
  await Promise.all(pending)
}

/** `sampleSpherePatch` on the worker pool, split by rows across its workers. */
export function sampleSpherePatchAsync(
  workers: Workers,
  graph: NoiseGraph,
  seed: number,
  patch: SpherePatch,
  out: Float32Array,
  options: AsyncOptions = {},
): Promise<void> {
  check(patch.resolution * patch.resolution, out)
  const area = {
    face: patch.face,
    x0: patch.x0,
    y0: patch.y0,
    extent: patch.extent,
    resolution: patch.resolution,
    radius: patch.radius,
  }
  return areaAsync(
    workers,
    graph,
    seed,
    'patch',
    area,
    patch.resolution,
    patch.resolution,
    out,
    options,
  )
}

/** `sampleGrid2d` on the worker pool, split by rows across its workers. */
export function sampleGrid2dAsync(
  workers: Workers,
  graph: NoiseGraph,
  seed: number,
  grid: GridParams,
  out: Float32Array,
  options: AsyncOptions = {},
): Promise<void> {
  const g = normalizeGrid(grid)
  check(g.resolution[0] * g.resolution[1], out)
  return areaAsync(workers, graph, seed, 'grid', g, g.resolution[0], g.resolution[1], out, options)
}
