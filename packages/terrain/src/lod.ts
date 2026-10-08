import { hash32 } from '@aethervtt/shard-core'
import type { NoiseGraph } from '@aethervtt/shard-noise'
import { buildChunk } from './chunk'

/** Sample chunks per depth when measuring errors: four per face. */
const SAMPLES_PER_DEPTH = 24
/** Headroom over the largest sampled error, for relief the samples missed. */
const SAFETY = 1.25

export interface ErrorSpec {
  radius: number
  shape: ArrayLike<number>
  heightScale: number
  seed: number
  resolution: number
  maxDepth: number
  height: NoiseGraph | undefined
  heightOffset?: number
}

/**
 * Each depth's geometric error (m): the largest distance between a vertex and where its parent
 * level puts it, over sample chunks spread across the six faces, with some headroom. Depth 0 has no
 * parent and gets depth 1's doubled. Errors never grow with depth, so split distances shrink with
 * it. Deterministic for a (graph, seed, radius), and cheap enough to redo when the graph changes.
 *
 * Selection splits a depth-d node when `K × errors[d + 1] / distance` passes the planet's
 * `errorPixels`; every chunk of depth d morphs over the band set by `errors[d]`. One error per depth
 * (not per node) keeps neighbors at one depth in the same band, so their shared edges morph alike.
 */
export function measureErrors(spec: ErrorSpec): Float32Array {
  const out = new Float32Array(spec.maxDepth + 2)
  for (let d = 1; d <= spec.maxDepth; d++) {
    const n = 2 ** d
    let worst = 0
    for (let s = 0; s < SAMPLES_PER_DEPTH; s++) {
      const face = s % 6
      const h = hash32(spec.seed ^ 0x7e11a1, d, s)
      const x = h % n
      const y = hash32(h, d, s, 1) % n
      const chunk = buildChunk({
        face,
        depth: d,
        x,
        y,
        radius: spec.radius,
        shape: spec.shape,
        heightScale: spec.heightScale,
        seed: spec.seed,
        resolution: spec.resolution,
        height: spec.height,
        climate: undefined,
        morphError: 0,
        skirtDepth: 0,
        // Statistics only: coarse origins keep it quick (every vertex its own batch otherwise).
        snap: 8192,
        ...(spec.heightOffset !== undefined ? { heightOffset: spec.heightOffset } : {}),
      })
      if (chunk.error > worst) worst = chunk.error
    }
    out[d] = worst * SAFETY
  }
  out[0] = out[1]! * 2
  // Past the deepest level nothing refines: zero error stops splits there.
  out[spec.maxDepth + 1] = 0
  for (let d = spec.maxDepth - 1; d >= 0; d--) out[d] = Math.max(out[d]!, out[d + 1]!)
  return out
}

// --- shared by every quadtree surface (planets, ocean, heightfields) ---------------------------

/**
 * Caps each depth's error at the spacing that projects to `vertexPixels` wherever it projects to
 * `errorPixels` (spec 0043): a node then splits only while its children's vertices stay that far
 * apart on screen. Rough terrain otherwise keeps splitting into sub-pixel triangles. Selection and
 * morphing read the same capped table, so morph bands still end where splits happen. Errors never
 * grow with depth, like the measured ones. `vertexPixels` 0 leaves the errors as they are.
 */
export function capErrors(
  raw: Float32Array,
  spacing: (depth: number) => number,
  errorPixels: number,
  vertexPixels: number,
  out: Float32Array = new Float32Array(raw.length),
): Float32Array {
  const k = vertexPixels > 0 ? errorPixels / vertexPixels : Number.POSITIVE_INFINITY
  for (let d = 0; d < raw.length; d++) out[d] = Math.min(raw[d]!, k * spacing(d))
  // Never growing with depth, like the measured errors: split distances shrink with depth.
  for (let d = raw.length - 2; d >= 0; d--) out[d] = Math.max(out[d]!, out[d + 1]!)
  return out
}

/** Largest LOD bias the triangle budget may set (errorPixels × 16). */
export const MAX_LOD_BIAS = 16

/**
 * Steers a LOD bias (a multiplier on errorPixels for selection and morphing) toward a triangle
 * budget: up 1% a frame while `drawn` is over `budget`, back down 0.5% a frame once under 85% of
 * it, never below 1 (the surface's own settings) or above MAX_LOD_BIAS. Slow on purpose: the bias
 * moves split distances, so morphs shift with it (2× in about a second). `budget` 0: no limit.
 */
export function adaptLodBias(bias: number, drawn: number, budget: number): number {
  if (budget > 0 && drawn > budget) return Math.min(MAX_LOD_BIAS, bias * 1.01)
  if (budget <= 0 || drawn < budget * 0.85) return Math.max(1, bias / 1.005)
  return bias
}

/**
 * Where a vertex is in its morph toward the parent level (0 its own, 1 the parent's), by its
 * distance from the camera: across [0.5, 0.95] of `split`, the distance at which the parent would
 * split (`errors[depth] × pixelsPerRadian / (errorPixels × lodBias)`). Merging takes a 10% margin
 * past that, so a chunk is fully morphed before it goes. The vertex shaders inline the same
 * formula (`MORPH_WGSL`); CPU replays of the vertex stage call this.
 */
export function morphFactor(distance: number, split: number): number {
  if (!(split > 0)) return 0
  return Math.min(1, Math.max(0, (distance - 0.5 * split) / (0.45 * split)))
}

/** `morphFactor` in WGSL, for a `d` (distance) and `split` in scope. */
export const MORPH_WGSL = 'clamp((d - 0.5 * split) / (0.45 * split), 0.0, 1.0)'
