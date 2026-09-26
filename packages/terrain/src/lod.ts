import { hash32 } from '@shard/core'
import type { NoiseGraph } from '@shard/noise'
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
