import { defineDataType } from '@shard/assets'
import { ShardError, t } from '@shard/core'

/** Most biomes a BiomeSet may list. */
export const MAX_BIOMES = 32
/** Most texture layers per biome. */
export const MAX_LAYERS = 4
/** Biomes a fragment blends (the heaviest ones). */
export const BLENDED_BIOMES = 4

const range = (what: string, unit: string) =>
  t.vec2({
    description: `[min, max] ${what}${unit}. Equal ends (the default): anywhere.`,
  })

export const Biome = defineDataType(
  'terrain/Biome',
  {
    layers: t.list(
      t.struct({
        layer: t.u16({
          description:
            'Layer of the BiomeSet’s albedo, normal, and ORM texture arrays (the same index in each).',
        }),
        scale: t.f32({
          default: 4,
          min: 0.01,
          unit: 'm',
          description: 'World size of one texture repeat.',
        }),
      }),
      {
        description:
          'Up to 4 texture layers, from flat ground (first) to the steepest slopes (last), blended by slope.',
      },
    ),
    temperature: range('temperature', ' (−1 cold to 1 hot, after latitude and altitude)'),
    moisture: range('moisture', ' (−1 dry to 1 wet)'),
    height: range('height', ' in metres above the planet radius'),
    slope: range('slope', ' in degrees (0 flat, 90 a cliff)'),
    blend: t.f32({
      default: 0.1,
      min: 0,
      max: 1,
      description: 'Softness of every range’s edges, as a fraction of the range’s width.',
    }),
    tint: t.color({
      default: [1, 1, 1, 1],
      description: 'Multiplies the albedo (the whole color when the set has no textures).',
    }),
  },
  {
    extension: 'biome',
    description:
      'Where a surface type grows (temperature, moisture, height, slope windows) and how it looks (texture layers, tint).',
  },
)

export const BiomeSet = defineDataType(
  'terrain/BiomeSet',
  {
    biomes: t.list(t.handle('terrain/Biome'), {
      description: `The planet’s biomes (*.biome.json), at most ${MAX_BIOMES}. The first is used where none fits.`,
    }),
    albedo: t.handle('Texture', {
      description: 'Albedo texture array (*.texarray.json), a layer per surface texture.',
    }),
    normal: t.handle('Texture', { description: 'Normal map texture array, same layers.' }),
    orm: t.handle('Texture', {
      description: 'Occlusion / roughness / metallic texture array, same layers.',
    }),
    latitudeBias: t.f32({
      default: 0.6,
      description: 'Temperature drop from the equator to the poles.',
    }),
    snowLine: t.f32({
      min: 0,
      unit: 'm',
      description: 'Height at which temperature has dropped by 1 (0: altitude doesn’t cool).',
    }),
  },
  {
    extension: 'biomes',
    description: 'A planet’s biomes and the texture arrays their layers index into.',
  },
)

export type BiomeValue = ReturnType<typeof Biome.defaults>
export type BiomeSetValue = ReturnType<typeof BiomeSet.defaults>

/** A biome set resolved for sampling: the loaded biomes in order, flattened into numbers. */
export interface BiomeTable {
  count: number
  /** Per biome, 12 floats: t lo, t hi, m lo, m hi, h lo, h hi, s lo, s hi, blend, layers, 0, 0. */
  ranges: Float32Array
  /** Per biome, rgba tint. */
  tints: Float32Array
  /** Per biome, 4 layer indices and 4 scales. */
  layers: Float32Array
  latitudeBias: number
  snowLine: number
}

/** The table for a set whose biomes are loaded (undefined entries fall back to defaults). */
export function biomeTable(
  set: BiomeSetValue | undefined,
  biomes: readonly (BiomeValue | undefined)[],
): BiomeTable {
  if (biomes.length > MAX_BIOMES) {
    throw new ShardError(
      'terrain/too-many-biomes',
      `A BiomeSet lists ${biomes.length} biomes; the most is ${MAX_BIOMES}`,
      { hint: 'Merge similar biomes, or split the planet’s surface into fewer, broader ones.' },
    )
  }
  const count = Math.max(1, biomes.length)
  const ranges = new Float32Array(count * 12)
  const tints = new Float32Array(count * 4)
  const layers = new Float32Array(count * 8)
  for (let b = 0; b < count; b++) {
    const v = biomes[b]
    const o = b * 12
    if (v) {
      ranges.set([...v.temperature, ...v.moisture, ...v.height, ...v.slope], o)
      ranges[o + 8] = v.blend
      ranges[o + 9] = Math.min(MAX_LAYERS, v.layers.length)
      tints.set(v.tint, b * 4)
      for (let l = 0; l < MAX_LAYERS; l++) {
        const layer = v.layers[l]
        layers[b * 8 + l] = layer ? layer.layer : 0
        layers[b * 8 + 4 + l] = layer ? layer.scale : 4
      }
    } else {
      ranges[o + 8] = 0.1
      tints.set([0.5, 0.5, 0.5, 1], b * 4)
      for (let l = 0; l < MAX_LAYERS; l++) layers[b * 8 + 4 + l] = 4
    }
  }
  return {
    count,
    ranges,
    tints,
    layers,
    latitudeBias: set?.latitudeBias ?? 0.6,
    snowLine: set?.snowLine ?? 0,
  }
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/** 1 inside [lo, hi] with soft edges `blend × (hi − lo)` wide; 1 everywhere when lo ≥ hi. */
export function biomeWindow(x: number, lo: number, hi: number, blend: number): number {
  if (!(lo < hi)) return 1
  const soft = Math.max(1e-6, blend * (hi - lo))
  return smoothstep(lo - soft, lo + soft, x) * (1 - smoothstep(hi - soft, hi + soft, x))
}

/** What biome selection reads at a point. */
export interface BiomeInputs {
  temperature: number
  moisture: number
  /** Metres above radius. */
  height: number
  /** Degrees from flat. */
  slope: number
  /** Sine of the latitude (−1 south pole, 1 north pole). */
  latitude: number
}

/** Temperature after latitude and altitude cool it: what the temperature windows test. */
export function effectiveTemperature(table: BiomeTable, p: BiomeInputs): number {
  return (
    p.temperature -
    table.latitudeBias * Math.abs(p.latitude) -
    (table.snowLine > 0 ? Math.max(0, p.height) / table.snowLine : 0)
  )
}

/**
 * Every biome's weight at a point (summing to 1): the product of its four windows, normalized.
 * Where no window fits, the first biome gets everything. The terrain shader computes the same
 * thing per fragment and blends the four heaviest.
 */
export function biomeWeights(table: BiomeTable, p: BiomeInputs, out: Float32Array): Float32Array {
  const t = effectiveTemperature(table, p)
  let sum = 0
  for (let b = 0; b < table.count; b++) {
    const r = table.ranges
    const o = b * 12
    const blend = r[o + 8]!
    const w =
      biomeWindow(t, r[o]!, r[o + 1]!, blend) *
      biomeWindow(p.moisture, r[o + 2]!, r[o + 3]!, blend) *
      biomeWindow(p.height, r[o + 4]!, r[o + 5]!, blend) *
      biomeWindow(p.slope, r[o + 6]!, r[o + 7]!, blend)
    out[b] = w
    sum += w
  }
  if (sum < 1e-6) {
    out.fill(0, 0, table.count)
    out[0] = 1
    return out
  }
  for (let b = 0; b < table.count; b++) out[b] = out[b]! / sum
  return out
}

/** The index of the heaviest weight. */
export function dominantBiome(weights: ArrayLike<number>, count: number): number {
  let best = 0
  for (let b = 1; b < count; b++) if (weights[b]! > weights[best]!) best = b
  return best
}
