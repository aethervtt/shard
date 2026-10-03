import { defineSchema, type InferFields, t } from '@aethervtt/shard-core'

// Surface variation (0068): a material modulated in surface space by shaped noise, so a repeated
// texture or a flat colour breaks up without new textures. `surfaceVariation` is the CPU mirror of
// `surface::variation` (surface-shaders.ts): the same hash, noise and arithmetic, step for step.

export const VARIATION_PATTERNS = [
  'mottle',
  'streaks',
  'grain',
  'cells',
  'stagger',
  'brushed',
] as const
export type VariationPattern = (typeof VARIATION_PATTERNS)[number]

/** The variation's fields: one schema for validation, the inspector, and the GPU struct. */
export const VARIATION_FIELDS = {
  strength: t.f32({
    default: 1,
    min: 0,
    max: 1,
    description: '0 is off, 1 full. Scales the pigment shift, tone, weathering and roughness.',
  }),
  seed: t.u32({ description: 'Picks the pattern; the same seed is the same surface.' }),
  pattern: t.enum(VARIATION_PATTERNS, {
    description:
      'mottle (value noise), streaks (squashed across u: plaster runs), grain (stretched along u: wood), cells (a tone per cell: tiles), stagger (cells with alternate rows offset by half, toned per 2×2: bricks), brushed (mottle with a slanted brush mark per cell: stone).',
  }),
  scale: t.vec2({
    default: [1.5, 1.5],
    min: 0.001,
    unit: 'm',
    description: "Patch size along the surface's u and v. Unequal stretches the pattern.",
  }),
  warp: t.f32({
    min: 0,
    max: 2,
    description: 'Domain warp by a second noise, in patches: stone-like breakup of the pattern.',
  }),
  detail: t.f32({
    min: 0,
    max: 1,
    description: 'Blend toward a 3.1× finer octave.',
  }),
  bands: t.f32({
    min: 0,
    max: 1,
    description: '0 soft noise … 1 posterized paint bands.',
  }),
  toneRange: t.f32({
    default: 0.15,
    min: 0,
    max: 1,
    description: '± brightness at the patch extremes.',
  }),
  coolTint: t.vec3({
    default: [0.92, 0.96, 1.07],
    min: 0,
    max: 2,
    description: 'The pigment a low patch moves toward (a multiplier, linear).',
  }),
  warmTint: t.vec3({
    default: [1.08, 1.04, 0.93],
    min: 0,
    max: 2,
    description: 'The pigment a high patch moves toward (a multiplier, linear).',
  }),
  roughnessRange: t.f32({
    default: 0.15,
    min: 0,
    max: 1,
    description: '± roughness from the detail octave.',
  }),
  weathering: t.f32({
    min: 0,
    max: 1,
    description: 'Darkens and roughens where the weather mask is on.',
  }),
  weatherThreshold: t.vec2({
    default: [0.66, 0.9],
    min: 0,
    max: 1,
    description: "The weather mask's smoothstep edges, over the detail octave.",
  }),
}

export type Variation = InferFields<typeof VARIATION_FIELDS>

/** A partial variation: what presets and materials write (the rest takes the defaults). */
export type VariationInit = Partial<Variation>

/** The GPU struct `surface::variation::VariationUniform`, generated from VARIATION_FIELDS. */
export const VariationUniform = defineSchema('surface/VariationUniform', VARIATION_FIELDS, {
  description: 'A surface variation (0068), as SurfaceMaterial and custom material types hold it.',
})

/** Where the WGSL struct lives: a material's generated module imports it from here. */
export const VARIATION_STRUCT = 'surface::variation::VariationUniform'

const PX = 1.5 / 70

const preset = (v: VariationInit): Variation => ({ ...VariationUniform.defaults(), ...v })

/**
 * Tuned variations, seeded from Aether's eight recipes (its patch sizes converted from pixels at
 * 1.5 m per 70 px, its global intensity of 0.5 as `strength`). Plain data: spread one and
 * override, or add your own. Nothing in the shader knows their names.
 */
export const SURFACE_PRESETS: Record<string, Variation> = {
  solid: preset({
    strength: 0.5,
    pattern: 'mottle',
    scale: [72 * PX, 72 * PX],
    detail: 0.2,
    bands: 1,
    toneRange: 0.24,
    roughnessRange: 0.2,
    weathering: 0.07,
    weatherThreshold: [0.64, 0.9],
  }),
  plaster: preset({
    strength: 0.5,
    pattern: 'streaks',
    scale: [128 * PX, 128 * PX],
    detail: 0.18,
    bands: 1,
    toneRange: 0.16,
    coolTint: [0.9, 0.95, 1.07],
    warmTint: [1.1, 1.05, 0.93],
    roughnessRange: 0.16,
    weathering: 0.11,
    weatherThreshold: [0.66, 0.88],
  }),
  stone: preset({
    strength: 0.5,
    pattern: 'brushed',
    scale: [112 * PX, 112 * PX],
    warp: 0.42,
    detail: 0.18,
    bands: 1,
    toneRange: 0.2,
    coolTint: [0.88, 0.95, 1.08],
    warmTint: [1.12, 1.05, 0.92],
    roughnessRange: 0.22,
    weathering: 0.12,
    weatherThreshold: [0.34, 0.76],
  }),
  brick: preset({
    strength: 0.5,
    pattern: 'stagger',
    scale: [144 * 0.56 * PX, 144 * 0.3 * PX],
    toneRange: 0.18,
    coolTint: [0.9, 0.98, 1.08],
    warmTint: [1.12, 1.02, 0.88],
    roughnessRange: 0.19,
    weathering: 0.1,
    weatherThreshold: [0.7, 0.92],
  }),
  timber: preset({
    strength: 0.5,
    pattern: 'grain',
    scale: [96 * PX, 96 * PX],
    detail: 0.16,
    bands: 1,
    toneRange: 0.2,
    coolTint: [0.88, 0.96, 1.1],
    warmTint: [1.14, 1.04, 0.86],
    roughnessRange: 0.2,
    weathering: 0.11,
  }),
  ground: preset({
    strength: 0.5,
    pattern: 'mottle',
    scale: [96 * PX, 96 * PX],
    detail: 0.24,
    bands: 1,
    toneRange: 0.16,
    coolTint: [0.88, 1.04, 0.9],
    warmTint: [1.12, 1.02, 0.82],
    roughnessRange: 0.18,
    weathering: 0.09,
    weatherThreshold: [0.28, 0.76],
  }),
  metal: preset({
    strength: 0.5,
    pattern: 'mottle',
    scale: [112 * PX, 112 * PX],
    detail: 0.12,
    bands: 1,
    toneRange: 0.1,
    coolTint: [0.9, 0.97, 1.1],
    warmTint: [1.08, 1.03, 0.94],
    roughnessRange: 0.12,
    weathering: 0.06,
    weatherThreshold: [0.74, 0.94],
  }),
  tile: preset({
    strength: 0.5,
    pattern: 'cells',
    scale: [0.6, 0.6],
    detail: 0.18,
    toneRange: 0.12,
    coolTint: [0.94, 0.98, 1.06],
    warmTint: [1.06, 1.02, 0.94],
    roughnessRange: 0.14,
    weathering: 0.06,
    weatherThreshold: [0.72, 0.94],
  }),
}

// --- the CPU mirror ------------------------------------------------------------------------------

/** PCG-style integer hash (u32 → u32), as `surface_hash`. */
function hash(x: number): number {
  let h = (Math.imul(x, 747796405) + 2891336453) >>> 0
  h = Math.imul(((h >>> ((h >>> 28) + 4)) ^ h) >>> 0, 277803737) >>> 0
  return ((h >>> 22) ^ h) >>> 0
}

/** A cell's value in [0, 1): 24 bits of its hash, exact in f32. */
function cell(x: number, z: number, seed: number): number {
  const h = hash(((x | 0) >>> 0) ^ hash(((z | 0) >>> 0) ^ hash(seed >>> 0)))
  return (h >>> 8) / 16777216
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x
}

/** smoothstep that tolerates equal edges (a step), as `surface_step`. */
function step(a: number, b: number, x: number): number {
  const t = clamp((x - a) / Math.max(b - a, 1e-5), 0, 1)
  return t * t * (3 - 2 * t)
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const f = Math.fround

/** Value noise in [0, 1], smooth between integer lattice points. */
function noise(px: number, pz: number, seed: number): number {
  const ix = Math.floor(px)
  const iz = Math.floor(pz)
  const fx = px - ix
  const fz = pz - iz
  const ux = fx * fx * (3 - 2 * fx)
  const uz = fz * fz * (3 - 2 * fz)
  const a = cell(ix, iz, seed)
  const b = cell(ix + 1, iz, seed)
  const c = cell(ix, iz + 1, seed)
  const d = cell(ix + 1, iz + 1, seed)
  return mix(mix(a, b, ux), mix(c, d, ux), uz)
}

/** Aether's paint bands: three soft steps. */
function bands(v: number): number {
  return (step(0.18, 0.28, v) + step(0.43, 0.53, v) + step(0.68, 0.78, v)) / 3
}

/** A slanted brush mark in each cell of `p`. */
function brush(px: number, pz: number, seed: number): number {
  const cx = Math.floor(px)
  const cz = Math.floor(pz)
  const lx0 = px - cx - 0.5
  const lz0 = pz - cz - 0.5
  const slant = (cell(cx, cz, seed) - 0.5) * 1.35
  const lx = lx0 + lz0 * slant
  const lz = lz0 - lx0 * slant * 0.35
  const length = 1 - step(0.3, 0.49, Math.abs(lx))
  const width = 1 - step(0.11, 0.25, Math.abs(lz))
  return length * width * mix(0.45, 1, cell(cx + 17, cz - 9, seed))
}

const add = (seed: number, k: number) => (seed + k) >>> 0

export interface SurfaceSample {
  /** RGB multiplier for the base colour. */
  tint: [number, number, number]
  /** Added to roughness. */
  roughness: number
}

/**
 * The variation at surface point `p` (metres): a tint multiplier and a roughness offset. The CPU
 * mirror of WGSL `surface_variation`, for tests and for tools that preview a preset.
 */
export function surfaceVariation(
  v: Variation,
  p: ArrayLike<number>,
  out: SurfaceSample = { tint: [1, 1, 1], roughness: 0 },
): SurfaceSample {
  const seed = v.seed >>> 0
  let qx = f(p[0]! / Math.max(v.scale[0], 1e-3))
  let qz = f(p[1]! / Math.max(v.scale[1], 1e-3))
  if (v.warp > 0) {
    const wx = noise(qx * 0.7 - 6.2, qz * 0.7 + 8.1, add(seed, 7))
    const wz = noise(qx * 0.7 + 3.7, qz * 0.7 - 2.9, add(seed, 5))
    qx = f(qx + (wx - 0.5) * v.warp)
    qz = f(qz + (wz - 0.5) * v.warp)
  }
  const d = noise(qx * 3.1 + 9.7, qz * 3.1 - 4.3, add(seed, 11))
  let base: number
  switch (v.pattern) {
    case 'streaks':
      base = noise(qx * 1.25, qz * 0.42, add(seed, 19))
      break
    case 'grain':
      base = noise(qx * 0.36, qz * 4.2, add(seed, 23))
      break
    case 'cells':
      base = cell(Math.floor(qx), Math.floor(qz), add(seed, 3))
      break
    case 'stagger': {
      const row = Math.floor(qz)
      const col = Math.floor(qx + 0.5 * (row - 2 * Math.floor(row / 2)))
      const group = cell(Math.floor(col / 2), Math.floor(row / 2), add(seed, 13))
      base = mix(group, cell(col, row, add(seed, 17)), 0.28)
      break
    }
    case 'brushed': {
      const marks = Math.max(
        brush(qx * 1.45, qz * 1.45, add(seed, 37)),
        brush(qx * 1.45 + 0.47, qz * 1.45 + 0.63, add(seed, 41)),
      )
      base = clamp(noise(qx, qz, add(seed, 31)) + (marks - 0.24) * 0.26, 0, 1)
      break
    }
    default:
      base = noise(qx, qz, seed)
  }
  const value = clamp(mix(mix(base, bands(base), v.bands), d, v.detail), 0, 1)
  const s = v.strength
  const weather = step(v.weatherThreshold[0], v.weatherThreshold[1], d) * v.weathering
  const tone = (value - 0.5) * 2 * v.toneRange
  const k = clamp(1 + (tone - weather) * s, 0.62, 1.3)
  for (let i = 0; i < 3; i++)
    out.tint[i] = mix(1, mix(v.coolTint[i]!, v.warmTint[i]!, value), s) * k
  out.roughness = ((d - 0.5) * v.roughnessRange + weather * 0.45) * s
  return out
}
