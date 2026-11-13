import { assetServer } from '@aethervtt/shard-assets'
import { defineSchema, ShardError, t, World } from '@aethervtt/shard-core'
import {
  configureProcgenHost,
  outputHash,
  procgen,
  procgenHost,
  requestOf,
} from '@aethervtt/shard-procgen'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { StreamingBudget } from './components'
import { cellKey, type Partition, partitionNames, requirePartition } from './partition'
import { PartitionState, storedDelta } from './runtime'

function gridOf(partition: Partition, grid: string | number) {
  const g =
    typeof grid === 'number' ? partition.grids[grid] : partition.grids.find((x) => x.name === grid)
  if (!g) {
    throw new ShardError('partition/unknown-grid', `${partition.name} has no grid "${grid}"`, {
      hint: `Its grids: ${partition.grids.map((x) => x.name).join(', ')}.`,
    })
  }
  return g
}

/**
 * The hash of a cell's generated fragment at one level, for `seed`: the same bits on every machine
 * and engine, or the cell diverged (0113). Generates the level if it isn't cached.
 */
export async function cellHashOf(
  world: World,
  partition: string,
  seed: number,
  grid: string | number,
  x: number,
  z: number,
  level: string | number,
): Promise<string> {
  const p = requirePartition(partition)
  const g = gridOf(p, grid)
  const name = typeof level === 'number' ? g.levels[level]?.name : level
  if (!name || !g.levels.some((l) => l.name === name)) {
    throw new ShardError('partition/bad-levels', `Grid ${g.name} has no level "${level}"`)
  }
  const entry = procgen(world).entryFor(
    requestOf(g.generator, { ...g.params, x, z, level: name }, seed),
  )
  await assetServer(world).load(entry.guid)
  return outputHash(world, { type: entry.type, guid: entry.guid, path: entry.path } as never)
}

/** `cellHashOf` for the world's streaming partition (its first PartitionInstance's seed). */
export function cellHash(
  world: World,
  grid: string | number,
  x: number,
  z: number,
  level: string | number,
): Promise<string> {
  const rt = world.tryResource(PartitionState)?.instances.values().next().value
  if (!rt) {
    throw new ShardError('partition/no-instance', 'No PartitionInstance is streaming', {
      hint: 'Spawn partition/PartitionInstance, or call cellHashOf with a partition and seed.',
    })
  }
  return cellHashOf(world, rt.partition.name, rt.seed, grid, x, z, level)
}

const NoParams = defineSchema('partition/NoParams', {})
const CellParams = defineSchema('partition/CellParams', {
  grid: t.string({ description: 'Grid name (default: the first).' }),
  x: t.i32(),
  z: t.i32(),
})

const GenParams = defineSchema('partition/GenParams', {
  partition: t.string({ description: 'Partition name (default: the only one defined).' }),
  grid: t.string({ description: 'Grid name (default: the first).' }),
  x: t.i32(),
  z: t.i32(),
  level: t.string({ description: 'Level name (default: the first).' }),
  seed: t.u32(),
  compare: t.bool({ description: 'Also generate inline (no worker pool) and report both hashes.' }),
})

/** Generates one cell level in a fresh world: its hash, entity count and time. */
async function generateCell(
  partition: string,
  seed: number,
  grid: string | number,
  x: number,
  z: number,
  level: string,
): Promise<{ hash: string; entities: number; ms: number }> {
  const world = new World()
  const start = performance.now()
  const hash = await cellHashOf(world, partition, seed, grid, x, z, level)
  const ms = performance.now() - start
  let entities = 0
  const p = requirePartition(partition)
  const g = gridOf(p, grid)
  const entry = procgen(world).entryFor(requestOf(g.generator, { ...g.params, x, z, level }, seed))
  const json = procgen(world)
    .recordOf(entry.guid)
    ?.assets.find((a) => a.label === '')?.json as { root?: unknown } | undefined
  const count = (node: unknown): number => {
    const n = node as { children?: unknown[] }
    let c = 1
    for (const child of n?.children ?? []) c += count(child)
    return c
  }
  if (json?.root) entities = count(json.root) - 1
  return { hash, entities, ms }
}

export const partitionMethods: AppMethod[] = [
  {
    name: 'partition.gen',
    description:
      'Generates one cell at one level from a seed, in a fresh world: its hash (the bits every machine must produce), entity count and time. With compare, also inline, off the worker pool.',
    params: GenParams,
    handler: async (_ctx, params) => {
      const p = params as {
        partition: string
        grid: string
        x: number
        z: number
        level: string
        seed: number
        compare: boolean
      }
      const names = partitionNames()
      const partition = p.partition || (names.length === 1 ? names[0]! : '')
      if (!partition) {
        throw new ShardError('partition/unknown-partition', 'Name the partition', {
          hint: `Defined: ${names.join(', ') || 'none'}. Pass --partition.`,
        })
      }
      const part = requirePartition(partition)
      const grid = gridOf(part, p.grid === '' ? 0 : p.grid)
      const level = p.level || grid.levels[0]!.name
      const first = await generateCell(partition, p.seed, grid.index, p.x, p.z, level)
      const out: Record<string, unknown> = {
        partition,
        grid: grid.name,
        x: p.x,
        z: p.z,
        level,
        seed: p.seed,
        ...first,
        pooled: procgenHost().workers !== undefined,
      }
      if (p.compare) {
        const host = procgenHost()
        configureProcgenHost({ workers: undefined, workerModule: undefined })
        try {
          const inline = await generateCell(partition, p.seed, grid.index, p.x, p.z, level)
          out.inline = inline.hash
        } finally {
          configureProcgenHost(host)
        }
        out.pool = first.hash
      }
      return out
    },
  },
  {
    name: 'partition.describe',
    description:
      'Streaming as data: role, budget, and per partition its cells by level and state, generating cells, deltas (count and bytes), dormant entities, and last frame main-thread ms.',
    params: NoParams,
    handler: ({ world }) => {
      const s = world.tryResource(PartitionState)
      if (!s) return { role: 'none', instances: [] }
      return {
        role: s.hooks.role,
        peers: s.hooks.describe?.(world) ?? [],
        budget: { ...world.resource(StreamingBudget) },
        instances: [...s.instances.values()].map((rt) => {
          const levels: Record<string, number> = {}
          let generating = 0
          for (const cell of rt.cells.values()) {
            if (cell.level >= 0) {
              const name = cell.grid.levels[cell.level]!.name
              levels[name] = (levels[name] ?? 0) + 1
            } else generating++
          }
          let deltas = 0
          let bytes = 0
          let dormant = 0
          for (const d of s.deltas.get(rt.partition.name)?.values() ?? []) {
            if (d.empty) continue
            deltas++
            bytes += JSON.stringify(d.toJson()).length
            dormant += d.dormant.length
          }
          return {
            partition: rt.partition.name,
            seed: rt.seed,
            grids: rt.partition.grids.map((g) => ({
              name: g.name,
              cellSize: g.cellSize,
              levels: g.levels,
              simulate: g.simulate,
              replicate: g.replicateRange,
            })),
            cells: { loaded: levels, generating },
            deltas,
            deltaBytes: bytes,
            dormant,
            ms: rt.ms,
          }
        }),
      }
    },
  },
  {
    name: 'partition.cell',
    description:
      "One cell: its state and level, the hash of each level's fragment, its delta, and entity counts.",
    params: CellParams,
    handler: async ({ world }, params) => {
      const p = params as { grid: string; x: number; z: number }
      const rt = world.tryResource(PartitionState)?.instances.values().next().value
      if (!rt) throw new ShardError('partition/no-instance', 'No PartitionInstance is streaming')
      const grid = gridOf(rt.partition, p.grid === '' ? 0 : p.grid)
      const key = cellKey(grid.index, p.x, p.z)
      const cell = rt.cells.get(key)
      const hashes: Record<string, string> = {}
      for (const level of grid.levels) {
        hashes[level.name] = await cellHashOf(
          world,
          rt.partition.name,
          rt.seed,
          grid.index,
          p.x,
          p.z,
          level.name,
        )
      }
      const delta = storedDelta(world, rt.partition.name, key)
      return {
        grid: grid.name,
        x: p.x,
        z: p.z,
        state: !cell ? 'unloaded' : cell.level >= 0 ? 'loaded' : 'generating',
        level: cell && cell.level >= 0 ? grid.levels[cell.level]!.name : null,
        entities: cell?.entities.size ?? 0,
        added: cell?.added.size ?? 0,
        hashes,
        delta: delta ? delta.toJson() : null,
      }
    },
  },
]
