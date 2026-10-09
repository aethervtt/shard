import { ShardError } from '@aethervtt/shard-core'
import { computeOrigins, evalProgram, type NoiseGraph, noiseKernel } from '@aethervtt/shard-noise'
import {
  BLEND_ADD,
  BLEND_MAX,
  BLEND_MIN,
  BLEND_REPLACE,
  buildSpline,
  evalHeightPoints,
  LAYER_IMAGE,
  LAYER_NOISE,
  LAYER_SPLINE,
  MODE_CARVE,
  MODE_FLATTEN,
  MODE_RAISE,
  type NoiseAccess,
  type Stack,
  type StackHeightLayer,
  type StackMap,
  type StackPaint,
  type StackRect,
  type StackSpline,
} from './kernel'
import type { SourceRect, SourceSpline, TerrainSource } from './source'

/** What compiling a source needs: its assets, loaded. */
export interface StackAssets {
  noise(path: string): NoiseGraph
  heightmap(path: string): StackMap
}

/** This thread's noise kernel, as the bake kernel reads it (it must be loaded). */
export function mainNoise(): NoiseAccess {
  return {
    state: noiseKernel().state,
    computeOrigins: computeOrigins as NoiseAccess['computeOrigins'],
    evalProgram: evalProgram as NoiseAccess['evalProgram'],
  }
}

const BLENDS = { add: BLEND_ADD, max: BLEND_MAX, min: BLEND_MIN, replace: BLEND_REPLACE } as const
const MODES = { flatten: MODE_FLATTEN, raise: MODE_RAISE, carve: MODE_CARVE } as const

export function rectOf(r: SourceRect): StackRect {
  const a = (r.rotation * Math.PI) / 180
  return {
    cx: r.at[0],
    cz: r.at[1],
    hw: r.size[0] / 2,
    hd: r.size[1] / 2,
    cos: Math.cos(a),
    sin: Math.sin(a),
  }
}

/**
 * A spline's centerline: uniform Catmull-Rom through its points (ends repeated), in pieces of at
 * most `step` metres, heights interpolated the same way. `heights` holds each point's y (its
 * "ground" resolved).
 */
export function tessellate(
  spline: SourceSpline,
  heights: ArrayLike<number>,
  step: number,
): number[] {
  const p = spline.points
  const n = p.length
  const out: number[] = []
  const at = (i: number) => {
    const k = Math.min(n - 1, Math.max(0, i))
    return [p[k]![0], heights[k]!, p[k]![2]] as const
  }
  for (let s = 0; s + 1 < n; s++) {
    const p0 = at(s - 1)
    const p1 = at(s)
    const p2 = at(s + 1)
    const p3 = at(s + 2)
    const len = Math.hypot(p2[0] - p1[0], p2[2] - p1[2])
    const pieces = Math.max(1, Math.ceil(len / step))
    for (let k = s === 0 ? 0 : 1; k <= pieces; k++) {
      const t = k / pieces
      const t2 = t * t
      const t3 = t2 * t
      for (let c = 0; c < 3; c++) {
        out.push(
          0.5 *
            (2 * p1[c]! +
              (-p0[c]! + p2[c]!) * t +
              (2 * p0[c]! - 5 * p1[c]! + 4 * p2[c]! - p3[c]!) * t2 +
              (-p0[c]! + 3 * p1[c]! - 3 * p2[c]! + p3[c]!) * t3),
        )
      }
    }
  }
  return out
}

/**
 * Metres between a spline's tessellated points: a metre (or the spacing, if coarser). A road bend
 * of 100 m radius then strays from its chords by about a millimetre.
 */
export function splineStep(spacing: number): number {
  return Math.max(1, spacing)
}

/**
 * Compiles a validated source and its loaded assets into what the bake kernel reads (spec 0071):
 * noise programs, heightmaps, rectangles, and splines tessellated with their "ground" points
 * resolved against the layers below the layer using them. Structured-cloneable, so it goes to pool
 * workers as is. Needs the noise kernel loaded (splines on "ground" sample the stack).
 */
export function compileStack(
  source: TerrainSource,
  assets: StackAssets,
  noise: NoiseAccess = mainNoise(),
): Stack {
  const height: StackHeightLayer[] = []
  const stack = {
    spacing: source.spacing,
    seed: source.seed,
    lo: source.heightRange[0],
    hi: source.heightRange[1],
    layerCount: Math.max(1, source.layers.length),
    height,
    paint: [] as StackPaint[],
  }
  const step = splineStep(source.spacing)
  const splineFor = (name: string, reach: (s: SourceSpline) => number, ground: number) => {
    const s = source.splines[name]
    if (!s) {
      throw new ShardError('terrain/unknown-spline', `No spline named "${name}"`, {
        hint: 'Define it under "splines".',
      })
    }
    const ys = new Float64Array(s.points.length)
    const xz: number[] = []
    const groundAt: number[] = []
    s.points.forEach((p, i) => {
      if (p[1] === 'ground') {
        xz.push(p[0], p[2])
        groundAt.push(i)
      } else ys[i] = p[1]
    })
    if (groundAt.length > 0 && ground >= 0) {
      const out = new Float64Array(groundAt.length)
      evalHeightPoints(noise, stack, xz, groundAt.length, ground, out)
      groundAt.forEach((i, k) => {
        ys[i] = out[k]!
      })
    }
    return buildSpline(tessellate(s, ys, step), s.width, s.falloff, reach(s))
  }
  source.height.forEach((l, index) => {
    if (l.kind === 'noise') {
      height.push({
        kind: LAYER_NOISE,
        program: assets.noise(l.noise.path).program as never,
        scale: l.scale,
        offset: l.offset,
        blend: BLENDS[l.blend],
        rect: l.region ? rectOf(l.region) : null,
        falloff: l.falloff,
      })
    } else if (l.kind === 'image') {
      height.push({
        kind: LAYER_IMAGE,
        map: assets.heightmap(l.image.path),
        rect: rectOf(l),
        lo: l.range[0],
        hi: l.range[1],
        blend: BLENDS[l.blend],
        falloff: l.falloff,
      })
    } else {
      const spline: StackSpline = splineFor(l.spline, (s) => s.width / 2 + l.falloff, index)
      height.push({
        kind: LAYER_SPLINE,
        spline,
        mode: MODES[l.mode],
        offset: l.offset,
        falloff: l.falloff,
      })
    }
  })
  const names = new Map(source.layers.map((l, i) => [l.name, i]))
  for (const p of source.paint) {
    stack.paint.push({
      layer: names.get(p.layer) ?? 0,
      height: p.height,
      slope: p.slope,
      noise: p.noise
        ? { program: assets.noise(p.noise.ref.path).program as never, above: p.noise.above }
        : null,
      mask: p.mask ? { map: assets.heightmap(p.mask.ref.path), rect: rectOf(p.mask) } : null,
      // Paint reads where the spline is, not its heights.
      spline: p.spline ? splineFor(p.spline, (s) => s.width / 2 + p.blend, -1) : null,
      blend: p.blend,
    })
  }
  return stack
}
