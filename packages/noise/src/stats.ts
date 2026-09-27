import type { PreviewImage } from '@aethervtt/shard-assets'
import { ShardError } from '@aethervtt/shard-core'
import type { NoiseGraph } from './noise-graph'
import { sampleGrid2d, sampleOffset, sampleSpherePatch } from './sample'

export interface NoiseDomain {
  /** `plane`: a square on z = 0, centered on the origin. `sphere`: a sphere's surface. */
  readonly kind?: 'plane' | 'sphere'
  /** Plane side length. Default: twice the graph's extent, or 4. */
  readonly size?: number
  /** Sphere radius. Default: the graph's extent, or 1. */
  readonly radius?: number
  /** Samples per side (per cube face for spheres). Default 256 (plane) or 105 (six faces). */
  readonly resolution?: number
}

export interface NoiseStats {
  readonly samples: number
  readonly min: number
  readonly max: number
  readonly mean: number
  readonly stdDev: number
  /** `bins` equal-width buckets from `from` to `to`, as fractions of the domain. */
  readonly histogram: { readonly from: number; readonly to: number; readonly bins: number[] }
  /** For each requested threshold, the fraction of the domain below it. */
  readonly below: { readonly threshold: number; readonly fraction: number }[]
}

const HISTOGRAM_BINS = 16

/**
 * Samples a graph over a domain and summarizes it: min, max, mean, standard deviation, a histogram,
 * and the fraction below each threshold. Sphere samples are weighted by the area they cover, so
 * "30% below sea level" means 30% of the surface. Deterministic: the same numbers on every host.
 */
export function noiseStats(
  graph: NoiseGraph,
  seed: number,
  domain: NoiseDomain = {},
  options: { node?: string; thresholds?: readonly number[] } = {},
): NoiseStats {
  const { values, weights } = sampleDomain(graph, seed, domain, options.node)
  let min = Infinity
  let max = -Infinity
  let total = 0
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    const w = weights ? weights[i]! : 1
    if (v < min) min = v
    if (v > max) max = v
    total += w
    sum += v * w
  }
  const mean = sum / total
  let variance = 0
  for (let i = 0; i < values.length; i++) {
    const d = values[i]! - mean
    variance += d * d * (weights ? weights[i]! : 1)
  }
  const bins = new Array<number>(HISTOGRAM_BINS).fill(0)
  const span = max - min || 1
  const thresholds = options.thresholds ?? []
  const below = thresholds.map(() => 0)
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    const w = weights ? weights[i]! : 1
    bins[Math.min(HISTOGRAM_BINS - 1, Math.floor(((v - min) / span) * HISTOGRAM_BINS))]! += w
    for (let t = 0; t < thresholds.length; t++) if (v < thresholds[t]!) below[t]! += w
  }
  const r = (x: number) => Math.round(x * 1e6) / 1e6
  return {
    samples: values.length,
    min: r(min),
    max: r(max),
    mean: r(mean),
    stdDev: r(Math.sqrt(variance / total)),
    histogram: { from: r(min), to: r(max), bins: bins.map((b) => r(b / total)) },
    below: thresholds.map((threshold, t) => ({ threshold, fraction: r(below[t]! / total) })),
  }
}

function sampleDomain(
  graph: NoiseGraph,
  seed: number,
  domain: NoiseDomain,
  node?: string,
): { values: Float32Array; weights?: Float64Array } {
  if (graph.program.dimensions === 4) {
    throw new ShardError('noise/domain-mismatch', 'Stats sample 3D domains; this graph is 4D', {
      hint: 'Use noise.sample with xyzw points for 4D graphs.',
    })
  }
  const extent = graph.graph.extent
  if ((domain.kind ?? 'plane') === 'plane') {
    const size = domain.size ?? (extent ? extent * 2 : 4)
    const n = domain.resolution ?? 256
    const values = new Float32Array(n * n)
    sampleGrid2d(graph, seed, { origin: [-size / 2, -size / 2], size, resolution: n }, values, node)
    return { values }
  }
  const radius = domain.radius ?? extent ?? 1
  const n = domain.resolution ?? 105
  const values = new Float32Array(6 * n * n)
  const weights = new Float64Array(6 * n * n)
  const face = new Float32Array(n * n)
  // Cell centers, weighted by the solid angle each covers under the tangent-adjusted mapping.
  const step = 2 / n
  for (let f = 0; f < 6; f++) {
    const x0 = -1 + step / 2
    const extentUv = step * (n - 1)
    sampleSpherePatch(
      graph,
      seed,
      { face: f, x0, y0: x0, extent: extentUv, resolution: n, radius },
      face,
      node,
    )
    values.set(face, f * n * n)
    for (let j = 0; j < n; j++) {
      const tv = Math.tan((Math.PI / 4) * (x0 + j * step))
      for (let i = 0; i < n; i++) {
        const tu = Math.tan((Math.PI / 4) * (x0 + i * step))
        weights[f * n * n + j * n + i] =
          (1 + tu * tu) * (1 + tv * tv) * (1 + tu * tu + tv * tv) ** -1.5
      }
    }
  }
  return { values, weights }
}

export interface NoisePreviewOptions {
  /** `plane` (default): the domain's square. `sphere`: an orthographic view of the sphere from +z. */
  readonly domain?: 'plane' | 'sphere'
  readonly seed?: number
  /** Image side in pixels; overrides width and height. */
  readonly size?: number
  /** Preview an intermediate node instead of the output. */
  readonly node?: string
  /** Plane side length or sphere radius; defaults as in `noiseStats`. */
  readonly span?: number
}

/**
 * A grayscale picture of a graph (black at its minimum, white at its maximum). Returns the image and
 * the value range it maps.
 */
export function previewNoise(
  graph: NoiseGraph,
  width: number,
  height: number,
  options: NoisePreviewOptions = {},
): PreviewImage & { min: number; max: number } {
  if (options.size) {
    width = options.size
    height = options.size
  }
  const seed = options.seed ?? 0
  const extent = graph.graph.extent
  const values = new Float32Array(width * height)
  const inside = new Uint8Array(width * height).fill(1)
  if ((options.domain ?? 'plane') === 'plane') {
    const size = options.span ?? (extent ? extent * 2 : 4)
    const aspect = height / width
    sampleGrid2d(
      graph,
      seed,
      {
        origin: [-size / 2, (-size * aspect) / 2],
        size: [size, size * aspect],
        resolution: [width, height],
      },
      values,
      options.node,
    )
    // Rows run up the image in y; flip so +y is at the top.
    const row = new Float32Array(width)
    for (let j = 0; j < height >> 1; j++) {
      const a = j * width
      const b = (height - 1 - j) * width
      row.set(values.subarray(a, a + width))
      values.copyWithin(a, b, b + width)
      values.set(row, b)
    }
  } else {
    const radius = options.span ?? extent ?? 1
    const origin = [0, 0, radius]
    const local = new Float32Array(width * height * 3)
    const d = new Float64Array(3)
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const x = ((i + 0.5) / width) * 2 - 1
        const y = 1 - ((j + 0.5) / height) * 2
        const r2 = x * x + y * y
        const k = j * width + i
        if (r2 > 1) {
          inside[k] = 0
          continue
        }
        d[0] = x
        d[1] = y
        d[2] = Math.sqrt(1 - r2)
        local[k * 3] = d[0] * radius
        local[k * 3 + 1] = d[1] * radius
        local[k * 3 + 2] = d[2] * radius - radius
      }
    }
    sampleOffset(graph, seed, origin, local, values, options.node)
  }
  let min = Infinity
  let max = -Infinity
  for (let k = 0; k < values.length; k++) {
    if (!inside[k]) continue
    min = Math.min(min, values[k]!)
    max = Math.max(max, values[k]!)
  }
  const scale = max > min ? 255 / (max - min) : 0
  const data = new Uint8Array(width * height * 4)
  for (let k = 0; k < values.length; k++) {
    if (!inside[k]) continue
    const g = Math.round((values[k]! - min) * scale)
    data[k * 4] = g
    data[k * 4 + 1] = g
    data[k * 4 + 2] = g
    data[k * 4 + 3] = 255
  }
  return { width, height, data, min, max }
}
