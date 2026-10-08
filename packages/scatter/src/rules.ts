import { type AssetRef, hash32, hashSeed, type JsonValue, ShardError } from '@aethervtt/shard-core'
import type { PropCollider, ScatterSetValue } from './set'

/** Rule kinds as numbers. */
export const PROP = 0
export const FOLIAGE = 1

/** Most items a prop chunk may hold: placement picks a chunk size to hold 64–1 024. */
export const MAX_PROPS_PER_CHUNK = 1024
/** Most items a foliage chunk may hold (one GPU placement dispatch). */
export const MAX_FOLIAGE_PER_CHUNK = 16384
/** Least jitter (as a fraction of a cell) a rule keeps, so a lattice never looks like a grid. */
const MIN_JITTER = 0.4

export interface CompiledItem {
  prefab: AssetRef | null
  /** Generator name, or '' for a prefab item. */
  generator: string
  params: Record<string, JsonValue>
  variants: number
  material: AssetRef | null
  /** Footprint radius before scale, 0: from the mesh bounds. */
  radius: number
}

/** A rule as numbers, ready to place: its lattice, masks, and items. */
export interface CompiledRule {
  /** Index in the surface's compiled list (priority order). */
  index: number
  name: string
  /** Stable across runs: the set's path, the biome it belongs to, and the rule's name. */
  id: string
  kind: number
  /** The biome it applies in (−1: everywhere). */
  biome: number
  seed: number
  density: number
  spacing: number
  /** Lattice cell size (m): at most one candidate per cell. */
  cell: number
  slopeLo: number
  slopeHi: number
  heightLo: number
  heightHi: number
  noise: AssetRef | null
  noiseAbove: number
  align: number
  scaleMin: number
  scaleMax: number
  sink: number
  collider: PropCollider
  range: number
  wind: number
  shadowRange: number
  /** Indices of earlier rules whose footprints this one avoids. */
  avoid: number[]
  items: CompiledItem[]
  /** Running sum of item weights, normalized to end at 1. */
  weights: Float64Array
}

/** A set with where its rules apply: everywhere, or a biome (by index in the BiomeSet). */
export interface SetSource {
  /** The set's asset path (rule ids, saves). */
  path: string
  set: ScatterSetValue
  biome: number
}

/**
 * Turns sets into one priority-ordered rule list for a surface: a surface's own set first, then
 * each biome's in biome order. Throws `scatter/unknown-rule` (an `avoid` naming no earlier rule),
 * `scatter/density-too-high` (a density the spacing can't fit), and `scatter/no-items`.
 */
export function compileRules(sources: readonly SetSource[], surfaceSeed: number): CompiledRule[] {
  const out: CompiledRule[] = []
  for (const source of sources) {
    const byName = new Map<string, number>()
    for (const [r, rule] of source.set.rules.entries()) {
      const path = `${source.path}#/rules/${r}`
      if (byName.has(rule.name)) {
        throw new ShardError('scatter/duplicate-rule', `Two rules are named "${rule.name}"`, {
          path,
          hint: 'Rule names are unique within a set: saves and `avoid` refer to them.',
        })
      }
      const avoid: number[] = []
      for (const name of rule.avoid) {
        const target = byName.get(name)
        if (target === undefined) {
          throw new ShardError(
            'scatter/unknown-rule',
            `Rule "${rule.name}" avoids "${name}", which isn't an earlier rule of its set`,
            {
              path: `${path}/avoid`,
              hint: `Earlier rules: ${[...byName.keys()].join(', ') || 'none'}. Rule order is priority, so the avoided rule goes first.`,
            },
          )
        }
        avoid.push(target)
      }
      const items = rule.items.filter((i) => i.weight > 0)
      if (items.length === 0) {
        throw new ShardError('scatter/no-items', `Rule "${rule.name}" has nothing to place`, {
          path: `${path}/items`,
          hint: 'Add an item: { "generator": "shard/Rock" } or { "prefab": { "path": "…" } }.',
        })
      }
      for (const [i, item] of items.entries()) {
        if (!item.prefab && !item.generator) {
          throw new ShardError(
            'scatter/item-not-mesh',
            `Item ${i} of rule "${rule.name}" has neither a prefab nor a generator`,
            { path: `${path}/items/${i}`, hint: 'Set "generator" (a mesh generator) or "prefab".' },
          )
        }
        if (rule.kind === 'foliage' && !item.generator) {
          throw new ShardError(
            'scatter/item-not-mesh',
            `Foliage rule "${rule.name}" places a prefab; foliage draws meshes only`,
            {
              path: `${path}/items/${i}`,
              hint: 'Use a mesh generator item ("shard/GrassClump"), or make the rule kind "prop".',
            },
          )
        }
      }
      const kind = rule.kind === 'foliage' ? FOLIAGE : PROP
      const cell = cellSize(rule.density, rule.spacing)
      if (rule.density > 0 && rule.density * cell * cell > 1 + 1e-9) {
        const most = (1 - MIN_JITTER) ** 2 / (rule.spacing * rule.spacing)
        throw new ShardError(
          'scatter/density-too-high',
          `Rule "${rule.name}" asks for ${rule.density}/m² with ${rule.spacing} m spacing; at most ${most.toPrecision(3)}/m² fit`,
          {
            path: `${path}/density`,
            hint: 'Lower the density or the spacing: items keep `spacing` apart on a jittered lattice.',
          },
        )
      }
      let sum = 0
      for (const item of items) sum += item.weight
      const weights = new Float64Array(items.length)
      let acc = 0
      for (const [i, item] of items.entries()) {
        acc += item.weight / sum
        weights[i] = i === items.length - 1 ? 1 : acc
      }
      const id = `${source.path}${source.biome >= 0 ? `@${source.biome}` : ''}:${rule.name}`
      out.push({
        index: out.length,
        name: rule.name,
        id,
        kind,
        biome: source.biome,
        seed: hashSeed(surfaceSeed ^ source.set.seed, id),
        density: rule.density,
        spacing: rule.spacing,
        cell,
        slopeLo: rule.masks.slope[0]!,
        slopeHi: rule.masks.slope[1]!,
        heightLo: rule.masks.height[0]!,
        heightHi: rule.masks.height[1]!,
        noise: rule.masks.noise.graph,
        noiseAbove: rule.masks.noise.above,
        align: rule.align,
        scaleMin: Math.min(rule.scale[0]!, rule.scale[1]!),
        scaleMax: Math.max(rule.scale[0]!, rule.scale[1]!),
        sink: rule.sink,
        collider: rule.collider,
        range: rule.range,
        wind: rule.wind,
        shadowRange: rule.shadowRange,
        avoid: avoid.map((a) => out.length - byName.size + a),
        items: items.map((i) => ({
          prefab: i.prefab,
          generator: i.generator,
          params: (i.params && typeof i.params === 'object' && !Array.isArray(i.params)
            ? i.params
            : {}) as Record<string, JsonValue>,
          variants: Math.max(1, i.variants),
          material: i.material,
          radius: i.radius,
        })),
        weights,
      })
      byName.set(rule.name, r)
    }
  }
  return out
}

/**
 * The lattice cell for a density and spacing: about two cells per expected item (so acceptance is
 * a coin flip, which hides the lattice), but never so small that jitter can't keep `spacing`.
 */
export function cellSize(density: number, spacing: number): number {
  const byDensity = density > 0 ? 1 / Math.sqrt(2 * density) : Number.POSITIVE_INFINITY
  const bySpacing = spacing > 0 ? spacing / (1 - MIN_JITTER) : 0
  return Math.max(byDensity, bySpacing)
}

/**
 * Jitter as a fraction of a cell, for cells `cell` metres across: as much as `spacing` allows.
 * Items sit in the middle `jitter` of their cell, so two in neighboring cells are at least
 * `cell × (1 − jitter)` = `spacing` apart.
 */
export function jitterFor(cell: number, spacing: number): number {
  if (!(spacing > 0)) return 1
  return Math.max(0, Math.min(1, 1 - spacing / cell))
}

// --- per-cell randomness -------------------------------------------------------------------------

/** Streams of a cell's hash (the w lane of hash32), so each decision is independent. */
export const STREAM_ACCEPT = 0
export const STREAM_X = 1
export const STREAM_Y = 2
export const STREAM_ITEM = 3
export const STREAM_VARIANT = 4
export const STREAM_YAW = 5
export const STREAM_SCALE = 6
export const STREAM_SHADE = 7

const INV32 = 1 / 4294967296

/**
 * A cell's random number in [0, 1) for a stream: a hash of the rule's seed, the cell's global
 * lattice coordinates, and its domain (a cube face, or 0 on a mesh). The foliage compute shader
 * computes the same numbers.
 */
export function cellRandom(seed: number, gi: number, gj: number, domain: number, stream: number) {
  return hash32(seed, gi, gj, domain, stream) * INV32
}

/** The item a cell picks by weight. */
export function pickItem(rule: CompiledRule, u: number): number {
  const w = rule.weights
  for (let i = 0; i < w.length - 1; i++) if (u < w[i]!) return i
  return w.length - 1
}

/** Whether `x` is within [lo, hi], or the range is open (lo ≥ hi). */
export function inRange(x: number, lo: number, hi: number): boolean {
  return !(lo < hi) || (x >= lo && x <= hi)
}
