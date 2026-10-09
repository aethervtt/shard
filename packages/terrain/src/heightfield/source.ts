import { isPlainObject, pointer, ShardError } from '@aethervtt/shard-core'
import { BLOCK, PAGE } from './kernel'

/** Most material layers a terrain may have (the control page stores a layer in a byte; 0043's arrays hold 32). */
export const MAX_MATERIAL_LAYERS = 32
/** Sides from 256 m to 64 km; sample spacing from 0.25 to 4 m. */
export const MIN_SIZE = 256
export const MAX_SIZE = 65536
export const MIN_SPACING = 0.25
export const MAX_SPACING = 4
/** Roots a terrain may have, at most (the importer picks the root depth to stay under it). */
export const MAX_ROOTS = 64
/** Deepest root depth: a block's samples hold every level's lattice up to 2^10. */
export const MAX_DEPTH = 10

export type BlendOp = 'add' | 'max' | 'min' | 'replace'
export type SplineMode = 'flatten' | 'raise' | 'carve'

/** An asset reference in a terrain file: by path, and its guid once imported. */
export interface SourceRef {
  path: string
  guid?: string
}

/** A rotated rectangle on the terrain: center, size (width along X before rotation, depth along Z), degrees about +Y. */
export interface SourceRect {
  at: [number, number]
  size: [number, number]
  rotation: number
}

export interface SourceSpline {
  /** [x, y, z] in terrain metres; y may be "ground" (the stack's height below the layer using it). */
  points: [number, number | 'ground', number][]
  /** Full width of the flat part (m). */
  width: number
  /** Metres past the width over which a layer using it fades out. */
  falloff: number
}

export type SourceHeightLayer =
  | ({
      kind: 'noise'
      noise: SourceRef
      /** Metres per unit of the graph's output. */
      scale: number
      offset: number
      blend: BlendOp
      falloff: number
    } & { region: SourceRect | null })
  | ({
      kind: 'image'
      image: SourceRef
      /** Metres the image's 0 and 1 map to. */
      range: [number, number]
      blend: BlendOp
      falloff: number
    } & SourceRect)
  | {
      kind: 'spline'
      spline: string
      mode: SplineMode
      /** Metres added to the spline's height (a carve's depth below it, say). */
      offset: number
      /** The spline's falloff unless set here. */
      falloff: number
    }

export interface SourceMaterialLayer {
  name: string
  /** Layers of the texture arrays (0043's `*.texarray.json`): albedo, and normal and ORM (default: the albedo's). */
  albedo: number
  normal: number
  orm: number
  /** Metres one texture repeat covers. */
  scale: number
  /** Projected from three axes where the slope passes 45° (cliffs). */
  triplanar: boolean
  /** Linear RGB multiplying the albedo; the whole color without texture arrays. */
  tint: [number, number, number]
}

/** Tints for layers that don't set one, by index: grass, rock, gravel, sand, snow, soil, … */
export const LAYER_TINTS: [number, number, number][] = [
  [0.16, 0.3, 0.08],
  [0.32, 0.3, 0.28],
  [0.45, 0.4, 0.33],
  [0.7, 0.62, 0.42],
  [0.9, 0.92, 0.95],
  [0.25, 0.17, 0.1],
  [0.12, 0.2, 0.12],
  [0.5, 0.25, 0.15],
]

export interface SourcePaint {
  /** Material layer name. */
  layer: string
  height: [number, number] | null
  slope: [number, number] | null
  noise: { ref: SourceRef; above: number } | null
  mask: ({ ref: SourceRef } & SourceRect) | null
  spline: string | null
  /** Edge softness: metres for height, masks and splines; degrees for slope. */
  blend: number
}

/** A terrain source (`*.terrain.json`) after validation, with every default filled in. */
export interface TerrainSource {
  size: [number, number]
  spacing: number
  paintSpacing: number
  heightRange: [number, number]
  seed: number
  splines: Record<string, SourceSpline>
  height: SourceHeightLayer[]
  layers: SourceMaterialLayer[]
  textures: { albedo: SourceRef | null; normal: SourceRef | null; orm: SourceRef | null }
  paint: SourcePaint[]
}

/** The terrain's grid (spec 0071): roots, depths, blocks, and paint cells. */
export interface TerrainLayout {
  sizeX: number
  sizeZ: number
  spacing: number
  paintSpacing: number
  /** Leaf samples per paint sample. */
  paintStep: number
  /** Paint cells per page side (control pages hold cells + 1 texels a side). */
  cells: number
  /** Leaves are at this depth; roots at 0. */
  depth: number
  rootsX: number
  rootsZ: number
  /** Metres a root covers. */
  rootSize: number
  /** Metres a leaf covers. */
  leafSize: number
  leavesX: number
  leavesZ: number
  /** Leaves per block side (BLOCK), and the levels each block bakes itself above its leaves. */
  block: number
  blocksX: number
  blocksZ: number
  blockLevels: number
}

const shape = (path: string, message: string, hint?: string) =>
  new ShardError('terrain/bad-source', message, { path, ...(hint ? { hint } : {}) })

function num(v: unknown, path: string, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw shape(path, `${what} must be a number`)
  return v
}

function opt(v: unknown, fallback: number, path: string, what: string): number {
  return v === undefined ? fallback : num(v, path, what)
}

function pair(v: unknown, path: string, what: string): [number, number] {
  if (!Array.isArray(v) || v.length !== 2)
    throw shape(path, `${what} must be [a, b]`, 'Two numbers, e.g. [0, 140].')
  return [num(v[0], pointer(path, 0), what), num(v[1], pointer(path, 1), what)]
}

function ref(v: unknown, path: string, what: string): SourceRef {
  if (typeof v === 'string' && v !== '') return { path: v }
  if (isPlainObject(v) && typeof v.path === 'string' && v.path !== '') {
    return typeof v.guid === 'string' ? { path: v.path, guid: v.guid } : { path: v.path }
  }
  throw shape(path, `${what} must be { "path": "…" }`, 'e.g. { "path": "noise/hills.noise.json" }')
}

function blendOf(v: unknown, fallback: BlendOp, path: string): BlendOp {
  if (v === undefined) return fallback
  if (v === 'add' || v === 'max' || v === 'min' || v === 'replace') return v
  throw shape(path, `blend must be "add", "max", "min" or "replace"`)
}

function rectOf(o: Record<string, unknown>, path: string): SourceRect {
  const size = pair(o.size, pointer(path, 'size'), 'size')
  if (!(size[0] > 0 && size[1] > 0)) throw shape(pointer(path, 'size'), 'size must be positive')
  return {
    at: pair(o.at, pointer(path, 'at'), 'at'),
    size,
    rotation: opt(o.rotation, 0, pointer(path, 'rotation'), 'rotation'),
  }
}

function known(o: Record<string, unknown>, keys: readonly string[], path: string): void {
  for (const k of Object.keys(o)) {
    if (k === '$schema' || keys.includes(k)) continue
    throw shape(pointer(path, k), `Unknown field "${k}"`, `Fields here: ${keys.join(', ')}.`)
  }
}

/**
 * Validates a terrain file's JSON and fills in defaults. Throws a ShardError whose path is a JSON
 * pointer into the file: `terrain/bad-size`, `terrain/bad-spacing`, `terrain/unknown-spline`,
 * `terrain/unknown-layer`, `terrain/too-many-layers`, or `terrain/bad-source` for anything else.
 */
export function parseTerrainSource(json: unknown): TerrainSource {
  if (!isPlainObject(json)) throw shape('', 'A terrain file is a JSON object')
  known(
    json,
    [
      'size',
      'spacing',
      'paintSpacing',
      'heightRange',
      'seed',
      'splines',
      'height',
      'layers',
      'textures',
      'paint',
    ],
    '',
  )
  const size = pair(json.size, '/size', 'size')
  const spacing = num(json.spacing, '/spacing', 'spacing')
  if (!(spacing >= MIN_SPACING && spacing <= MAX_SPACING)) {
    throw new ShardError(
      'terrain/bad-spacing',
      `spacing ${spacing} m is outside ${MIN_SPACING}–${MAX_SPACING} m`,
      {
        path: '/spacing',
        hint: 'Sample spacing is the leaf vertex spacing: 1 m for most open worlds, 0.5 m for detailed ground.',
      },
    )
  }
  const paintSpacing = opt(json.paintSpacing, spacing * 2, '/paintSpacing', 'paintSpacing')
  const step = paintSpacing / spacing
  if (!(step === 1 || step === 2 || step === 4)) {
    throw new ShardError(
      'terrain/bad-spacing',
      `paintSpacing ${paintSpacing} m isn't 1, 2 or 4 times spacing (${spacing} m)`,
      {
        path: '/paintSpacing',
        hint: 'The default, twice spacing, quarters control memory and keeps 8 m roads crisp.',
      },
    )
  }
  const heightRange = pair(json.heightRange, '/heightRange', 'heightRange')
  if (!(heightRange[1] > heightRange[0]))
    throw shape('/heightRange', 'heightRange must be [lowest, highest] with lowest < highest')
  const seed = opt(json.seed, 0, '/seed', 'seed') >>> 0
  // Splines.
  const splines: Record<string, SourceSpline> = {}
  if (json.splines !== undefined) {
    if (!isPlainObject(json.splines))
      throw shape(
        '/splines',
        'splines is an object of named splines',
        'e.g. { "north-road": { … } }',
      )
    for (const [name, value] of Object.entries(json.splines)) {
      const path = pointer('/splines', name)
      if (!isPlainObject(value)) throw shape(path, 'A spline is an object')
      known(value, ['points', 'width', 'falloff'], path)
      if (!Array.isArray(value.points) || value.points.length < 2)
        throw shape(pointer(path, 'points'), 'A spline needs at least two points')
      const points = value.points.map((p, i) => {
        const pp = pointer(pointer(path, 'points'), i)
        if (!Array.isArray(p) || p.length !== 3)
          throw shape(pp, 'A point is [x, y, z]', 'y may be "ground": the height below at x, z.')
        const y = p[1] === 'ground' ? 'ground' : num(p[1], pointer(pp, 1), 'y')
        return [num(p[0], pointer(pp, 0), 'x'), y, num(p[2], pointer(pp, 2), 'z')] as [
          number,
          number | 'ground',
          number,
        ]
      })
      const width = num(value.width, pointer(path, 'width'), 'width')
      if (!(width > 0)) throw shape(pointer(path, 'width'), 'width must be positive')
      const falloff = opt(value.falloff, 0, pointer(path, 'falloff'), 'falloff')
      if (falloff < 0) throw shape(pointer(path, 'falloff'), 'falloff must be ≥ 0')
      splines[name] = { points, width, falloff }
    }
  }
  const splineName = (v: unknown, path: string): string => {
    if (typeof v !== 'string' || v === '') throw shape(path, 'A spline is named by a string')
    if (!splines[v]) {
      throw new ShardError('terrain/unknown-spline', `No spline named "${v}"`, {
        path: path,
        hint: `Define it under "splines". Known: ${Object.keys(splines).join(', ') || '(none)'}.`,
      })
    }
    return v
  }
  // Height layers.
  if (!Array.isArray(json.height))
    throw shape(
      '/height',
      'height is a list of layers',
      'e.g. [{ "noise": { "path": "…" }, "scale": 200 }]',
    )
  const height = json.height.map((value, i): SourceHeightLayer => {
    const path = pointer('/height', i)
    if (!isPlainObject(value)) throw shape(path, 'A height layer is an object')
    const kinds = ['noise', 'image', 'spline'].filter((k) => value[k] !== undefined)
    if (kinds.length !== 1) {
      throw shape(
        path,
        'A height layer has exactly one of "noise", "image" or "spline"',
        'Noise: { "noise": { "path": … }, "scale": 200 }. Image: { "image": { "path": … }, "at", "size", "range" }. Spline: { "spline": "road", "mode": "flatten" }.',
      )
    }
    const falloff = opt(value.falloff, 0, pointer(path, 'falloff'), 'falloff')
    if (falloff < 0) throw shape(pointer(path, 'falloff'), 'falloff must be ≥ 0')
    if (value.noise !== undefined) {
      known(value, ['noise', 'scale', 'offset', 'blend', 'falloff', 'at', 'size', 'rotation'], path)
      const region = value.at !== undefined || value.size !== undefined ? rectOf(value, path) : null
      return {
        kind: 'noise',
        noise: ref(value.noise, pointer(path, 'noise'), 'noise'),
        scale: opt(value.scale, 1, pointer(path, 'scale'), 'scale'),
        offset: opt(value.offset, 0, pointer(path, 'offset'), 'offset'),
        blend: blendOf(value.blend, 'add', pointer(path, 'blend')),
        falloff,
        region,
      }
    }
    if (value.image !== undefined) {
      known(value, ['image', 'at', 'size', 'rotation', 'range', 'blend', 'falloff'], path)
      return {
        kind: 'image',
        image: ref(value.image, pointer(path, 'image'), 'image'),
        range: pair(value.range, pointer(path, 'range'), 'range'),
        blend: blendOf(value.blend, 'replace', pointer(path, 'blend')),
        falloff,
        ...rectOf(value, path),
      }
    }
    known(value, ['spline', 'mode', 'offset', 'falloff'], path)
    const name = splineName(value.spline, pointer(path, 'spline'))
    const mode = value.mode ?? 'flatten'
    if (mode !== 'flatten' && mode !== 'raise' && mode !== 'carve')
      throw shape(pointer(path, 'mode'), 'mode must be "flatten", "raise" or "carve"')
    return {
      kind: 'spline',
      spline: name,
      mode,
      offset: opt(value.offset, 0, pointer(path, 'offset'), 'offset'),
      falloff: value.falloff === undefined ? splines[name]!.falloff : falloff,
    }
  })
  // Material layers.
  const layerList = json.layers ?? []
  if (!Array.isArray(layerList)) throw shape('/layers', 'layers is a list of material layers')
  if (layerList.length > MAX_MATERIAL_LAYERS) {
    throw new ShardError(
      'terrain/too-many-layers',
      `${layerList.length} material layers; a terrain has at most ${MAX_MATERIAL_LAYERS}`,
      {
        path: '/layers',
        hint: 'Merge layers that look alike, or share texture array layers between them.',
      },
    )
  }
  const layers = layerList.map((value, i): SourceMaterialLayer => {
    const path = pointer('/layers', i)
    if (!isPlainObject(value)) throw shape(path, 'A material layer is an object')
    known(value, ['name', 'albedo', 'normal', 'orm', 'scale', 'triplanar', 'tint'], path)
    if (typeof value.name !== 'string' || value.name === '')
      throw shape(pointer(path, 'name'), 'A material layer needs a name')
    const albedo = opt(value.albedo, i, pointer(path, 'albedo'), 'albedo')
    const scale = opt(value.scale, 4, pointer(path, 'scale'), 'scale')
    if (!(scale > 0)) throw shape(pointer(path, 'scale'), 'scale must be positive')
    let tint = LAYER_TINTS[i % LAYER_TINTS.length]!
    if (value.tint !== undefined) {
      const tp = pointer(path, 'tint')
      if (!Array.isArray(value.tint) || value.tint.length !== 3)
        throw shape(tp, 'tint is [r, g, b], linear, 0–1')
      tint = [
        num(value.tint[0], tp, 'tint'),
        num(value.tint[1], tp, 'tint'),
        num(value.tint[2], tp, 'tint'),
      ]
    }
    return {
      name: value.name,
      albedo,
      normal: opt(value.normal, albedo, pointer(path, 'normal'), 'normal'),
      orm: opt(value.orm, albedo, pointer(path, 'orm'), 'orm'),
      scale,
      triplanar: value.triplanar === true,
      tint,
    }
  })
  const names = new Map(layers.map((l, i) => [l.name, i]))
  if (names.size !== layers.length) throw shape('/layers', 'Material layer names must be unique')
  // Textures.
  const textures: TerrainSource['textures'] = { albedo: null, normal: null, orm: null }
  if (json.textures !== undefined) {
    if (!isPlainObject(json.textures)) throw shape('/textures', 'textures is an object')
    known(json.textures, ['albedo', 'normal', 'orm'], '/textures')
    for (const k of ['albedo', 'normal', 'orm'] as const) {
      const v = json.textures[k]
      if (v !== undefined) textures[k] = ref(v, pointer('/textures', k), k)
    }
  }
  // Paint.
  const paintList = json.paint ?? []
  if (!Array.isArray(paintList)) throw shape('/paint', 'paint is a list of paint layers')
  const paint = paintList.map((value, i): SourcePaint => {
    const path = pointer('/paint', i)
    if (!isPlainObject(value)) throw shape(path, 'A paint layer is an object')
    known(value, ['layer', 'height', 'slope', 'noise', 'mask', 'spline', 'blend'], path)
    if (typeof value.layer !== 'string' || !names.has(value.layer)) {
      throw new ShardError(
        'terrain/unknown-layer',
        `No material layer named ${JSON.stringify(value.layer)}`,
        {
          path: pointer(path, 'layer'),
          hint: `Paint names one of "layers": ${[...names.keys()].join(', ') || '(none defined)'}.`,
        },
      )
    }
    let noise: SourcePaint['noise'] = null
    if (value.noise !== undefined) {
      const np = pointer(path, 'noise')
      if (!isPlainObject(value.noise)) throw shape(np, 'noise is { "path": …, "above": 0.2 }')
      noise = {
        ref: ref(value.noise, np, 'noise'),
        above: opt(value.noise.above, 0, pointer(np, 'above'), 'above'),
      }
    }
    let mask: SourcePaint['mask'] = null
    if (value.mask !== undefined) {
      const mp = pointer(path, 'mask')
      if (!isPlainObject(value.mask))
        throw shape(mp, 'mask is { "path": …, "at": [x, z], "size": [w, d] }')
      mask = { ref: ref(value.mask, mp, 'mask'), ...rectOf(value.mask, mp) }
    }
    const blend = opt(value.blend, 0, pointer(path, 'blend'), 'blend')
    if (blend < 0) throw shape(pointer(path, 'blend'), 'blend must be ≥ 0')
    return {
      layer: value.layer,
      height:
        value.height === undefined ? null : pair(value.height, pointer(path, 'height'), 'height'),
      slope: value.slope === undefined ? null : pair(value.slope, pointer(path, 'slope'), 'slope'),
      noise,
      mask,
      spline: value.spline === undefined ? null : splineName(value.spline, pointer(path, 'spline')),
      blend,
    }
  })
  const source: TerrainSource = {
    size,
    spacing,
    paintSpacing,
    heightRange,
    seed,
    splines,
    height,
    layers,
    textures,
    paint,
  }
  terrainLayout(source)
  return source
}

/**
 * The terrain's grid (spec 0071): leaves of PAGE segments at `spacing`, roots at the shallowest
 * depth giving at most MAX_ROOTS of them, and blocks of `block` × `block` leaves (a power of two;
 * BLOCK but in tests). Throws `terrain/bad-size` when a side is outside 256 m – 64 km or isn't a
 * whole number of roots.
 */
export function terrainLayout(
  source: Pick<TerrainSource, 'size' | 'spacing' | 'paintSpacing'>,
  block = BLOCK,
): TerrainLayout {
  const [sizeX, sizeZ] = source.size
  const spacing = source.spacing
  const leafSize = PAGE * spacing
  for (const [i, side] of [sizeX, sizeZ].entries()) {
    if (!(side >= MIN_SIZE && side <= MAX_SIZE)) {
      throw new ShardError(
        'terrain/bad-size',
        `A side of ${side} m is outside ${MIN_SIZE} m – ${MAX_SIZE / 1024} km`,
        {
          path: pointer('/size', i),
          hint: 'Terrains run from 256 m to 64 km a side. Bigger worlds are planets (0043).',
        },
      )
    }
  }
  const leavesX = sizeX / leafSize
  const leavesZ = sizeZ / leafSize
  const hint = `Sides are whole numbers of roots: ${leafSize} m × 2^k (each leaf is ${PAGE} samples of ${spacing} m), at most ${MAX_ROOTS} roots, e.g. ${leafSize * 32} m.`
  if (!Number.isInteger(leavesX) || !Number.isInteger(leavesZ)) {
    throw new ShardError(
      'terrain/bad-size',
      `size ${sizeX} × ${sizeZ} m isn't a whole number of ${leafSize} m leaves`,
      { path: '/size', hint: hint },
    )
  }
  let depth = 0
  while (depth <= MAX_DEPTH) {
    const n = 2 ** depth
    if (leavesX % n !== 0 || leavesZ % n !== 0) {
      depth = MAX_DEPTH + 1
      break
    }
    if ((leavesX / n) * (leavesZ / n) <= MAX_ROOTS) break
    depth++
  }
  if (depth > MAX_DEPTH) {
    throw new ShardError(
      'terrain/bad-size',
      `size ${sizeX} × ${sizeZ} m isn't a whole number of roots (at most ${MAX_ROOTS} of them)`,
      { path: '/size', hint: hint },
    )
  }
  const paintStep = source.paintSpacing / spacing
  return {
    sizeX,
    sizeZ,
    spacing,
    paintSpacing: source.paintSpacing,
    paintStep,
    cells: PAGE / paintStep,
    depth,
    rootsX: leavesX / 2 ** depth,
    rootsZ: leavesZ / 2 ** depth,
    rootSize: leafSize * 2 ** depth,
    leafSize,
    leavesX,
    leavesZ,
    block,
    blocksX: Math.ceil(leavesX / block),
    blocksZ: Math.ceil(leavesZ / block),
    blockLevels: Math.log2(block),
  }
}

/** Every asset a source refers to, by path: noise graphs, heightmaps (images and masks), texture arrays. */
export function sourceDependencies(source: TerrainSource): {
  noise: string[]
  heightmaps: string[]
  textures: string[]
} {
  const noise = new Set<string>()
  const heightmaps = new Set<string>()
  for (const l of source.height) {
    if (l.kind === 'noise') noise.add(l.noise.path)
    if (l.kind === 'image') heightmaps.add(l.image.path)
  }
  for (const p of source.paint) {
    if (p.noise) noise.add(p.noise.ref.path)
    if (p.mask) heightmaps.add(p.mask.ref.path)
  }
  const textures = [source.textures.albedo, source.textures.normal, source.textures.orm]
    .filter((t): t is SourceRef => t !== null)
    .map((t) => t.path)
  return { noise: [...noise], heightmaps: [...heightmaps], textures }
}
