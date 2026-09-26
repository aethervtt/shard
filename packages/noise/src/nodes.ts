/**
 * The node table. Every node type is one entry here; the validator, the JSON Schema, the agent
 * docs, the compiler, and the WGSL generator all read it. Adding a node is an entry plus its
 * instruction in the Rust kernel (`crates/shard-noise`) and in `wgsl.ts`.
 */

export type ParamDef =
  | {
      readonly type: 'number'
      readonly default?: number
      readonly min?: number
      readonly max?: number
      readonly positive?: boolean
      readonly description: string
    }
  | {
      readonly type: 'integer'
      readonly default?: number
      readonly min?: number
      readonly max?: number
      readonly description: string
    }
  | { readonly type: 'boolean'; readonly default?: boolean; readonly description: string }
  | {
      readonly type: 'enum'
      readonly values: readonly (string | number)[]
      readonly default?: string | number
      readonly description: string
    }
  /** A node name, an inline node, or a number. */
  | { readonly type: 'input'; readonly description: string }
  /** `[a, b]` */
  | {
      readonly type: 'pair'
      readonly default?: readonly [number, number]
      readonly description: string
    }
  /** A number (all axes) or `[x, y, z]` / `[x, y, z, w]`. */
  | { readonly type: 'vec'; readonly default?: number; readonly description: string }
  /** `[[x, y], …]`, x increasing. */
  | { readonly type: 'points'; readonly description: string }

export type NodeCategory = 'source' | 'fractal' | 'combine' | 'shape' | 'domain' | 'constant'

export interface NodeDef {
  readonly name: string
  readonly category: NodeCategory
  readonly description: string
  /** The output range, for docs. */
  readonly range: string
  /**
   * `params`: an object of parameters. `list`: an array of two or more inputs. `unary`: one input,
   * written bare or as `{ "input": … }`. `value`: a number.
   */
  readonly form: 'params' | 'list' | 'unary' | 'value'
  readonly params: Readonly<Record<string, ParamDef>>
  /** A typical use, shown in the schema and the docs. */
  readonly example: unknown
}

export const SOURCE_KINDS = ['value', 'perlin', 'simplex', 'cellular'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]

export const CELL_DISTANCES = ['euclidean', 'manhattan', 'chebyshev'] as const
export const CELL_RETURNS = ['f1', 'f2', 'f2-f1', 'cell'] as const

/** Largest octave count a fractal may have (`noise/too-many-octaves`). */
export const MAX_OCTAVES = 16

const seed: ParamDef = {
  type: 'integer',
  default: 0,
  min: 0,
  max: 0xffffffff,
  description:
    'Layer seed, mixed with the seed the graph is sampled with. Changing it changes only this layer.',
}
const frequency: ParamDef = {
  type: 'number',
  default: 1,
  positive: true,
  description: 'Features per unit of distance. 1 means one lattice cell per unit.',
}
const dims = (values: readonly number[]): ParamDef => ({
  type: 'enum',
  values,
  default: 3,
  description: `Dimensions sampled: ${values.join(', ')}. 2 reads x and y only; 4 needs a 4D graph.`,
})
const cellular = {
  distance: {
    type: 'enum',
    values: CELL_DISTANCES,
    default: 'euclidean',
    description: 'Distance metric to feature points.',
  },
  return: {
    type: 'enum',
    values: CELL_RETURNS,
    default: 'f1',
    description:
      'f1: distance to the nearest point. f2: to the second nearest. f2-f1: cell edges (0 on a border). cell: a random value per cell in [-1, 1].',
  },
  jitter: {
    type: 'number',
    default: 1,
    min: 0,
    max: 1,
    description: 'How far feature points move from cell centers: 0 is a regular grid.',
  },
} as const satisfies Record<string, ParamDef>

const input = (description: string): ParamDef => ({ type: 'input', description })

const fractal = (name: string, description: string, range: string, example: unknown): NodeDef => ({
  name,
  category: 'fractal',
  description,
  range,
  form: 'params',
  params: {
    source: {
      type: 'enum',
      values: SOURCE_KINDS,
      default: 'simplex',
      description: 'The source summed per octave.',
    },
    octaves: {
      type: 'integer',
      default: 4,
      min: 1,
      max: MAX_OCTAVES,
      description: `Layers summed, 1 to ${MAX_OCTAVES}. Each adds detail at lacunarity × the previous frequency.`,
    },
    frequency: { ...frequency, description: 'Frequency of the first octave.' },
    lacunarity: {
      type: 'number',
      default: 2,
      positive: true,
      description: 'Frequency multiplier per octave (usually 2).',
    },
    gain: {
      type: 'number',
      default: 0.5,
      positive: true,
      description: 'Amplitude multiplier per octave (0.5 halves each; higher is rougher).',
    },
    seed,
    dims: dims([2, 3, 4]),
    ...cellular,
  },
  example,
})

const shape = (def: Omit<NodeDef, 'category' | 'form'> & { form?: NodeDef['form'] }): NodeDef => ({
  category: 'shape',
  form: 'params',
  ...def,
})

export const NODE_DEFS: readonly NodeDef[] = [
  {
    name: 'value',
    category: 'source',
    description: 'Value noise: random values on a lattice, smoothly interpolated. Blocky, cheap.',
    range: '[-1, 1], mean 0',
    form: 'params',
    params: { seed, frequency, dims: dims([2, 3]) },
    example: { value: { frequency: 4, seed: 1 } },
  },
  {
    name: 'perlin',
    category: 'source',
    description: 'Perlin gradient noise: smooth, with a slight grid alignment.',
    range: '[-1, 1], mean 0',
    form: 'params',
    params: { seed, frequency, dims: dims([2, 3]) },
    example: { perlin: { frequency: 2, seed: 1 } },
  },
  {
    name: 'simplex',
    category: 'source',
    description:
      'Simplex noise: smooth and isotropic, the usual choice. 3D uses the OpenSimplex2 lattice; 2D and 4D the classic simplex lattice.',
    range: '[-1, 1], mean 0',
    form: 'params',
    params: { seed, frequency, dims: dims([2, 3, 4]) },
    example: { simplex: { frequency: 1, seed: 1 } },
  },
  {
    name: 'cellular',
    category: 'source',
    description:
      'Cellular (Worley) noise: distances to jittered feature points, one per cell. Cracks, cells, pebbles.',
    range:
      'euclidean f1 [0, 1.25] (mean ≈ 0.43 in 2D, 0.52 in 3D); f2 [0, 1.5] (mean ≈ 0.70); f2-f1 [0, 1.25] (mean ≈ 0.2 in 3D); manhattan distances reach 2 and chebyshev 1; cell [-1, 1], mean 0',
    form: 'params',
    params: { seed, frequency, dims: dims([2, 3]), ...cellular },
    example: { cellular: { frequency: 3, return: 'f2-f1' } },
  },
  fractal(
    'fbm',
    'Fractal Brownian motion: octaves of a source summed with falling amplitude. Continents, hills, clouds.',
    '[-1, 1] (normalized by the sum of amplitudes), mean 0',
    { fbm: { source: 'simplex', octaves: 5, frequency: 0.8, gain: 0.5, seed: 1 } },
  ),
  fractal(
    'ridged',
    'Ridged multifractal: (1 − |n|)² per octave, so zero crossings become sharp ridges. Mountains.',
    '[-1, 1], ridges near 1',
    { ridged: { source: 'simplex', octaves: 6, frequency: 3.2, seed: 2 } },
  ),
  fractal(
    'billow',
    'Billow: 2|n| − 1 per octave, so valleys become creases. Puffy clouds, rolling hills.',
    '[-1, 1]',
    { billow: { source: 'simplex', octaves: 4, frequency: 2, seed: 3 } },
  ),
  {
    name: 'add',
    category: 'combine',
    description: 'Sum of two or more inputs.',
    range: 'sum of the input ranges',
    form: 'list',
    params: {},
    example: { add: ['continents', { multiply: ['mountains', 'mask'] }] },
  },
  {
    name: 'multiply',
    category: 'combine',
    description:
      'Product of two or more inputs. Multiply by a 0–1 mask to fade a layer in and out.',
    range: 'product of the input ranges',
    form: 'list',
    params: {},
    example: { multiply: ['mountains', 'mask'] },
  },
  {
    name: 'min',
    category: 'combine',
    description: 'Smallest of two or more inputs.',
    range: 'within the input ranges',
    form: 'list',
    params: {},
    example: { min: ['a', 'b'] },
  },
  {
    name: 'max',
    category: 'combine',
    description: 'Largest of two or more inputs.',
    range: 'within the input ranges',
    form: 'list',
    params: {},
    example: { max: ['a', 0] },
  },
  {
    name: 'lerp',
    category: 'combine',
    description: 'a + t × (b − a): blends a toward b by t (0 gives a, 1 gives b).',
    range: 'between a and b for t in [0, 1]',
    form: 'params',
    params: { a: input('Value at t = 0.'), b: input('Value at t = 1.'), t: input('Blend factor.') },
    example: { lerp: { a: 'plains', b: 'mountains', t: 'mask' } },
  },
  {
    name: 'select',
    category: 'combine',
    description:
      'a where control is below threshold, b above it, blended smoothly over ±falloff (0 is a hard edge).',
    range: 'between a and b',
    form: 'params',
    params: {
      a: input('Value below the threshold.'),
      b: input('Value above the threshold.'),
      control: input('What decides between a and b.'),
      threshold: { type: 'number', default: 0, description: 'Where control switches from a to b.' },
      falloff: {
        type: 'number',
        default: 0,
        min: 0,
        description: 'Half-width of the smooth blend around the threshold.',
      },
    },
    example: {
      select: { a: 'ocean', b: 'land', control: 'continents', threshold: 0.1, falloff: 0.05 },
    },
  },
  shape({
    name: 'remap',
    description: 'Linearly maps [from₀, from₁] to [to₀, to₁], optionally clamped. Builds masks.',
    range: 'to (when clamped)',
    params: {
      input: input('The value to map.'),
      from: { type: 'pair', default: [-1, 1], description: 'Input range.' },
      to: { type: 'pair', default: [0, 1], description: 'Output range.' },
      clamp: {
        type: 'boolean',
        default: false,
        description: 'Clamp the result to the output range.',
      },
    },
    example: { remap: { input: 'continents', from: [0.1, 0.4], to: [0, 1], clamp: true } },
  }),
  shape({
    name: 'clamp',
    description: 'Limits the input to [min, max].',
    range: '[min, max]',
    params: {
      input: input('The value to clamp.'),
      min: { type: 'number', default: -1, description: 'Lower bound.' },
      max: { type: 'number', default: 1, description: 'Upper bound.' },
    },
    example: { clamp: { input: 'height', min: 0, max: 1 } },
  }),
  shape({
    name: 'curve',
    description:
      'Piecewise-linear curve through control points, flat beyond the first and last. Reshapes a height profile.',
    range: 'the points’ y range',
    params: {
      input: input('The value to reshape.'),
      points: {
        type: 'points',
        description: 'Control points [[x, y], …], x increasing, at least two.',
      },
    },
    example: {
      curve: {
        input: 'height',
        points: [
          [-1, -1],
          [0, -0.2],
          [0.5, 0.3],
          [1, 1],
        ],
      },
    },
  }),
  shape({
    name: 'terrace',
    description: 'Quantizes the input into steps with sloped risers. Mesas, rice terraces, strata.',
    range: 'range',
    params: {
      input: input('The value to terrace.'),
      steps: {
        type: 'integer',
        default: 4,
        min: 1,
        max: 256,
        description: 'Steps across the range.',
      },
      range: { type: 'pair', default: [-1, 1], description: 'The input range the steps span.' },
      sharpness: {
        type: 'number',
        default: 0.5,
        min: 0,
        max: 1,
        description: '0 leaves the input linear; 1 makes vertical risers.',
      },
    },
    example: { terrace: { input: 'hills', steps: 6, sharpness: 0.7 } },
  }),
  shape({
    name: 'abs',
    description: 'Absolute value.',
    range: '[0, max |input|]',
    form: 'unary',
    params: { input: input('The value.') },
    example: { abs: 'ridges' },
  }),
  shape({
    name: 'power',
    description: 'sign(x) × |x|^exponent. Exponents above 1 flatten low values and sharpen peaks.',
    range: 'same sign as the input',
    params: {
      input: input('The base.'),
      exponent: { type: 'number', default: 2, description: 'The exponent.' },
    },
    example: { power: { input: 'mask', exponent: 3 } },
  }),
  {
    name: 'constant',
    category: 'constant',
    description: 'A fixed value. A bare number anywhere an input goes means the same.',
    range: 'the value',
    form: 'value',
    params: {},
    example: { constant: 0.5 },
  },
  {
    name: 'warp',
    category: 'domain',
    description:
      'Domain warp: samples input at a position displaced by `by` (read three times with independent seeds, one per axis) × amount. Makes layers swirl and flow.',
    range: 'the input’s',
    form: 'params',
    params: {
      input: input('What is sampled at the displaced position.'),
      by: input('The displacement source (usually a low-frequency fbm).'),
      amount: {
        type: 'number',
        default: 0.1,
        description: 'Displacement in domain units at |by| = 1.',
      },
    },
    example: { warp: { input: 'mountains', by: 'continents', amount: 0.15 } },
  },
  {
    name: 'scale',
    category: 'domain',
    description:
      'The input sees the position multiplied by `by`: 2 doubles every frequency below it. A vector scales axes separately.',
    range: 'the input’s',
    form: 'params',
    params: {
      input: input('What sees the scaled position.'),
      by: { type: 'vec', default: 1, description: 'Scale: a number, or [x, y, z] (and w in 4D).' },
    },
    example: { scale: { input: 'hills', by: [1, 0.25, 1] } },
  },
  {
    name: 'translate',
    category: 'domain',
    description:
      'The input sees the position moved by `by`. Offsets two otherwise identical layers.',
    range: 'the input’s',
    form: 'params',
    params: {
      input: input('What sees the moved position.'),
      by: { type: 'vec', default: 0, description: 'Offset: a number, or [x, y, z] (and w in 4D).' },
    },
    example: { translate: { input: 'hills', by: [100, 0, 0] } },
  },
]

const byName = new Map(NODE_DEFS.map((d) => [d.name, d]))

export function nodeDef(name: string): NodeDef | undefined {
  return byName.get(name)
}
