import {
  defineComponent,
  defineEvent,
  defineResource,
  defineTag,
  type Entity,
  t,
} from '@aethervtt/shard-core'

/**
 * Streams a partition's cells (0112): generated from `seed`, with their deltas applied. The server
 * and single-player games spawn it; a client gets it from the server when it joins.
 */
export const PartitionInstance = defineComponent(
  'partition/PartitionInstance',
  {
    partition: t.string({ description: 'The partition, by the name definePartition gave it.' }),
    seed: t.u32({ description: 'The world seed every machine generates cells from.' }),
    secretSeed: t.u32({
      description:
        'Server only: the seed of the secrets generator (loot). Never sent; clients have 0.',
    }),
    enabled: t.bool({ default: true }),
  },
  { description: 'Streams a partition of generated cells around StreamingSources (0112).' },
)

/** A point cells load around (0072): a player, a vehicle, a scripted event. */
export const StreamingSource = defineComponent(
  'partition/StreamingSource',
  {
    enabled: t.bool({ default: true }),
    rangeScale: t.f32({ default: 1, min: 0, description: 'Multiplies every ring around it.' }),
    priority: t.u8({ description: 'Its cells load first when several wait.' }),
    peer: t.u32({
      description:
        'The peer it belongs to (0 for the server). partitionNet copies net/Replicated.owner here, so a client streams around its own player.',
    }),
  },
  { description: 'Cells load around it (0072, 0112).' },
)

/**
 * A runtime entity that belongs to the cell it's in (0072, amended by 0112): it moves to the cell it
 * walks into, unloads with that cell, and comes back when it loads. `key` is assigned when it joins
 * a cell (0: not yet).
 */
export const CellBound = defineComponent(
  'partition/CellBound',
  {
    x: t.i32(),
    z: t.i32(),
    grid: t.u8(),
    key: t.u32({ description: 'Its name in the cell (+key); 0 until it joins one.' }),
  },
  { description: 'Belongs to the partition cell it stands in, and unloads with it.' },
)

export const CELL_STATES = ['loaded', 'swapping'] as const

/** On every cell root the partition spawns. */
export const StreamedCell = defineComponent(
  'partition/StreamedCell',
  {
    x: t.i32({ readonly: true }),
    z: t.i32({ readonly: true }),
    grid: t.u8({ readonly: true }),
    level: t.u8({ readonly: true, description: 'Index into the grid levels.' }),
  },
  {
    description: "A partition cell's root; its children are the generator's output.",
    serialize: false,
  },
)

/** An added static entity that shows at far levels too (a built wall). */
export const FarVisible = defineTag('partition/FarVisible', {
  description: "A cell's added entity that also shows at coarser levels than the first.",
})

/**
 * Marks a CellBound entity as dynamic: captured whole into its cell's delta when the cell
 * unloads, and never sent to clients in deltas. With networking, net/Replicated entities are
 * dynamic too.
 */
export const Dynamic = defineTag('partition/Dynamic', {
  description: 'A CellBound entity that is simulated: dormant while its cell is unloaded.',
})

export type CommitMode = 'auto' | 'ready' | 'deterministic'

export interface StreamingBudgetData {
  /** Entities committed (cells spawned, levels swapped) per frame; at least one cell always goes. */
  entitiesPerFrame: number
  /** Cells generating at once. */
  jobsInFlight: number
  /** Seconds a cell stays beyond 1.2 × its range before it coarsens or unloads. */
  unloadDelay: number
  /**
   * `ready`: as soon as a cell is ready. `deterministic`: exactly `commitDelay` frames after it's
   * wanted (the host awaits generation first). `auto`: deterministic when the host steps
   * deterministically (runtime's StepMode: `shard run`, netHarness), ready otherwise.
   */
  commit: CommitMode
  commitDelay: number
  /** Whether render/Camera3d entities are sources too (0072). Off by default on a client. */
  camerasAreSources: boolean
  /** Server: which levels a client's reported hash is checked at. */
  verifyLevels: 'first' | 'all'
}

export const StreamingBudget = defineResource<StreamingBudgetData>('partition/StreamingBudget', {
  description: 'Limits and modes for partition streaming (0112).',
  init: () => ({
    entitiesPerFrame: 2000,
    jobsInFlight: 8,
    unloadDelay: 2,
    commit: 'auto',
    commitDelay: 30,
    camerasAreSources: false,
    verifyLevels: 'first',
  }),
})

export interface CellEvent {
  partition: string
  grid: string
  x: number
  z: number
  root: Entity
}

export const CellLoaded = defineEvent<CellEvent>('partition/CellLoaded', {
  description: 'A cell committed (its entities, delta and dormant entities are in the world).',
})
export const CellUnloading = defineEvent<CellEvent>('partition/CellUnloading', {
  description: 'A cell is about to unload: its delta is captured right after.',
})
export const EntityDormant = defineEvent<{
  partition: string
  grid: string
  x: number
  z: number
  index: number
}>('partition/EntityDormant', {
  description: "A dynamic entity walked into an unloaded cell and went into that cell's delta.",
})
