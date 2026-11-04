import { ShardError } from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'
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
  const points = new Float64Array(p.length * 3)
  for (let i = 0; i < p.length; i++) {
    points[i * 3] = p[i]![0]
    points[i * 3 + 1] = heights[i]!
    points[i * 3 + 2] = p[i]![2]
  }
  return sampleCatmullRom(points, false, step)
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
