import { ShardError } from '@aethervtt/shard-core'
import { sampleCatmullRom } from '@aethervtt/shard-mesh'
import { computeOrigins, evalProgram, type NoiseGraph, noiseKernel } from '@aethervtt/shard-noise'
import { findTerrainGenerator, generatorAccess, stackGenerator } from './generator'
import {
  BLEND_ADD,
  BLEND_MAX,
  BLEND_MIN,
  BLEND_REPLACE,
  buildSpline,
  evalHeightPoints,
  LAYER_GENERATED,
  LAYER_IMAGE,
  LAYER_NOISE,
  LAYER_SPLINE,
  MODE_CARVE,
  MODE_FLATTEN,
  MODE_RAISE,
  type NoiseAccess,
  type Stack,
  type StackEdits,
  type StackGenerator,
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

/**
 * This thread's noise kernel and terrain generators, as the bake kernel reads them (the kernel must
 * be loaded).
 */
export function mainNoise(): NoiseAccess {
  return {
    state: noiseKernel().state,
    computeOrigins: computeOrigins as NoiseAccess['computeOrigins'],
    evalProgram: evalProgram as NoiseAccess['evalProgram'],
    generator: generatorAccess,
  }
}

/**
 * The generator a source names, from this thread's registry. Throws `terrain/unknown-generator`
 * until the project's code defines it.
 */
function requireGenerator(name: string, path: string) {
  const gen = findTerrainGenerator(name)
  if (!gen) {
    throw new ShardError('terrain/unknown-generator', `No terrain generator named "${name}"`, {
      path,
      hint: 'Define it with defineTerrainGenerator in the project’s scripts; the terrain waits for it.',
    })
  }
  return gen
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
    generators: [] as StackGenerator[],
    holes: null as { gen: number } | null,
    // The runtime attaches its edit layers' tiles (heightfield/edits.ts).
    edits: {
      at: source.edits.height,
      paintAt: source.edits.paint,
      sculpt: null,
      paint: null,
    } as StackEdits,
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
  const generatorIndex = new Map<string, number>()
  const addGenerator = (name: string, params: unknown, path: string): number => {
    const spec = stackGenerator(requireGenerator(name, path), params, `${path}/params`)
    const key = `${name}\u0000${JSON.stringify(spec.params)}`
    let i = generatorIndex.get(key)
    if (i === undefined) {
      i = stack.generators.length
      stack.generators.push(spec)
      generatorIndex.set(key, i)
    }
    return i
  }
  source.height.forEach((l, index) => {
    if (l.kind === 'generator') {
      height.push({
        kind: LAYER_GENERATED,
        gen: addGenerator(l.generator, l.params, `/height/${index}`),
        blend: BLENDS[l.blend],
      })
    } else if (l.kind === 'noise') {
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
  if (source.holes) {
    const h = source.holes
    const def = requireGenerator(h.generator, '/holes/generator')
    if (!def.options.holes) {
      throw new ShardError('terrain/bad-generator', `${def.name} has no holes()`, {
        path: '/holes/generator',
        hint: 'Give the generator holes(state, area, out), or drop "holes" from the source.',
      })
    }
    const params =
      h.params ??
      source.height.find(
        (l): l is Extract<typeof l, { kind: 'generator' }> =>
          l.kind === 'generator' && l.generator === h.generator,
      )?.params
    stack.holes = { gen: addGenerator(h.generator, params, '/holes') }
  }
  const names = new Map(source.layers.map((l, i) => [l.name, i]))
  for (const [i, p] of source.paint.entries()) {
    if (p.generator) {
      const path = `/paint/${i}`
      const params =
        p.generator.params ??
        source.height.find(
          (l): l is Extract<typeof l, { kind: 'generator' }> =>
            l.kind === 'generator' && l.generator === p.generator!.name,
        )?.params
      const gen = addGenerator(p.generator.name, params, path)
      const def = findTerrainGenerator(p.generator.name)!
      const layers = def.layers.map((name) => {
        const l = names.get(name)
        if (l === undefined) {
          throw new ShardError(
            'terrain/unknown-layer',
            `${def.name} weights a layer named "${name}" the terrain doesn't have`,
            {
              path: `${path}/generator`,
              hint: `Add it to "layers", or drop it from the generator's layers. Terrain layers: ${[...names.keys()].join(', ') || '(none)'}.`,
            },
          )
        }
        return l
      })
      if (layers.length === 0) {
        throw new ShardError('terrain/bad-source', `${def.name} paints no layers`, {
          path: `${path}/generator`,
          hint: 'Give the generator `layers` and `weights`, or drop this paint entry.',
        })
      }
      stack.paint.push({
        layer: 0,
        height: null,
        slope: null,
        noise: null,
        mask: null,
        spline: null,
        generated: { gen, layers },
        blend: 0,
      })
      continue
    }
    stack.paint.push({
      generated: null,
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
