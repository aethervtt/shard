import { type JsonValue, ShardError, t } from '@aethervtt/shard-core'
import { findGenerator, type Generator } from '@aethervtt/shard-procgen'
import type { Overrides } from '@aethervtt/shard-scene'

export interface LevelConfig {
  /** `full`, `far`, …: the value the generator's `level` param takes. */
  name: string
  /** Metres from a source to the nearest point of the cell within which this level loads. */
  range: number
  /**
   * HLOD (0073): cells at this level are drawn by proxies (`hlodPlugin`), built from what they
   * draw. They still commit and take deltas. Never the first level.
   */
  proxy?: boolean
}

export interface ReplicateBand {
  /** Metres from the peer's nearest focus. */
  within: number
  /** Network ticks between unreliable state sends. */
  every: number
}

export interface GridConfig {
  name: string
  /** Edge of a cell in metres. */
  cellSize: number
  /** The cell generator: an `entities` generator, or its name. */
  generator: Generator | string
  /** Params every cell gets besides `x`, `z` and `level` (handles to shared world data). */
  params?: Record<string, JsonValue>
  /** Detail levels, nearest first. The server loads only the first. */
  levels: LevelConfig[]
  /** The server ring: cells within it load at the first level and are simulated. */
  simulate: number
  replicate?: { range?: number; bands?: ReplicateBand[] }
  /** What clients must not know: a `data` generator run with the secret seed, and its components. */
  secrets?: { generator: Generator | string; components: string[] }
}

export interface PartitionConfig {
  grids: GridConfig[]
}

/** A partition with its grids resolved and checked. */
export interface Partition {
  readonly name: string
  readonly grids: readonly ResolvedGrid[]
}

export interface ResolvedGrid {
  readonly name: string
  readonly index: number
  readonly cellSize: number
  readonly generator: Generator
  readonly params: Record<string, JsonValue>
  readonly levels: readonly LevelConfig[]
  readonly simulate: number
  readonly replicateRange: number
  readonly bands: readonly ReplicateBand[]
  readonly secrets: { generator: Generator; components: ReadonlySet<string> } | undefined
}

const partitions = new Map<string, PartitionConfig>()

/**
 * Defines a partition in code (0113). `PartitionInstance.partition` names it. Defining a name again
 * replaces it (hot reload). The `*.partition.json` file form lands with 0072, with the same fields.
 */
export function definePartition(name: string, config: PartitionConfig): string {
  checkConfig(name, config)
  partitions.set(name, config)
  return name
}

function generatorOf(ref: Generator | string, what: string): Generator {
  const gen = typeof ref === 'string' ? findGenerator(ref) : ref
  if (!gen) {
    throw new ShardError('procgen/unknown-generator', `No generator "${ref}" (${what})`, {
      hint: 'Define it with defineGenerator before the partition streams.',
    })
  }
  // Every machine regenerates cells, in every JS engine: transcendental Math must be guarded.
  if (!gen.deterministicMath) {
    throw new ShardError(
      'partition/nondeterministic-generator',
      `${gen.name} (${what}) needs deterministicMath: true`,
      {
        hint: 'Cells are generated on every client, in V8, SpiderMonkey and JavaScriptCore: use dsin, dcos, datan2, dexp, dlog and dpow from @aethervtt/shard-mesh, and set deterministicMath: true.',
      },
    )
  }
  return gen
}

function checkConfig(name: string, config: PartitionConfig): void {
  config.grids.forEach((g, i) => {
    const at = `${name}/grids/${i}`
    const bad = (message: string) =>
      new ShardError('partition/bad-levels', `${name} grid "${g.name}": ${message}`, {
        path: at,
        hint: 'Levels run near to far with increasing ranges, and simulate covers the first.',
      })
    if (g.levels.length === 0) throw bad('no levels')
    for (let k = 1; k < g.levels.length; k++) {
      if (g.levels[k]!.range <= g.levels[k - 1]!.range) throw bad('ranges must increase')
    }
    if (g.simulate < g.levels[0]!.range) throw bad('simulate is below the first level range')
    if (g.levels[0]!.proxy) throw bad('the first level is never drawn by proxies')
    if (!(g.cellSize > 0)) throw bad('cellSize must be positive')
  })
}

/** Every partition defined in this process, by name. */
export function partitionNames(): string[] {
  return [...partitions.keys()]
}

/** The partition `name` with generators resolved, or undefined if none is defined. */
export function resolvePartition(name: string): Partition | undefined {
  const config = partitions.get(name)
  if (!config) return undefined
  const grids = config.grids.map((g, index): ResolvedGrid => {
    const range = g.replicate?.range ?? g.simulate
    return {
      name: g.name,
      index,
      cellSize: g.cellSize,
      generator: generatorOf(g.generator, `grid ${g.name}`),
      params: g.params ?? {},
      levels: g.levels,
      simulate: g.simulate,
      replicateRange: range,
      bands: g.replicate?.bands ?? [{ within: range, every: 1 }],
      secrets: g.secrets && {
        generator: generatorOf(g.secrets.generator, `grid ${g.name} secrets`),
        components: new Set(g.secrets.components),
      },
    }
  })
  return { name, grids }
}

export function requirePartition(name: string): Partition {
  const p = resolvePartition(name)
  if (!p) {
    throw new ShardError('partition/unknown-partition', `No partition "${name}"`, {
      hint: 'Define it with definePartition before spawning its PartitionInstance.',
    })
  }
  return p
}

/**
 * The params a cell generator spreads into its own: the cell (`x`, `z`) and the level by name.
 * `defineGenerator('game/TownCell', { params: { ...cellParams(['full', 'far']), … } })`.
 */
export function cellParams<const L extends readonly string[]>(levels: L) {
  return {
    x: t.i32({ description: 'Cell column.' }),
    z: t.i32({ description: 'Cell row.' }),
    level: t.enum(levels, { description: 'Detail level, nearest first.' }),
  }
}

/** Rewrites a delta made by an older generator version (0113). Registered per generator name. */
export type DeltaMigration = (overrides: Overrides, from: number, to: number) => Overrides

const migrations = new Map<string, DeltaMigration>()

export function defineDeltaMigration(generator: string, migrate: DeltaMigration): void {
  migrations.set(generator, migrate)
}

export function deltaMigration(generator: string): DeltaMigration | undefined {
  return migrations.get(generator)
}

/** `town:3,-2`: a cell's key within a partition. */
export function cellKey(grid: number, x: number, z: number): string {
  return `${grid}:${x},${z}`
}

/** Distance from (px, pz) to the nearest point of cell (x, z). */
export function cellDistance(
  cellSize: number,
  x: number,
  z: number,
  px: number,
  pz: number,
): number {
  const x0 = x * cellSize
  const z0 = z * cellSize
  const dx = px < x0 ? x0 - px : px > x0 + cellSize ? px - x0 - cellSize : 0
  const dz = pz < z0 ? z0 - pz : pz > z0 + cellSize ? pz - z0 - cellSize : 0
  return Math.sqrt(dx * dx + dz * dz)
}
