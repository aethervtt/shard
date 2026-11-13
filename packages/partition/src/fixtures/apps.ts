import type { Entity, World } from '@aethervtt/shard-core'
import { physics3dPlugin } from '@aethervtt/shard-physics'
import { App, type Plugin } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import {
  type CommitMode,
  PartitionInstance,
  PartitionState,
  partitionPlugin,
  partitionSettled,
  StreamingBudget,
  StreamingSource,
} from '../index'
import { ENGINE_COMPONENTS } from './engine-components'

void ENGINE_COMPONENTS

export interface TownAppOptions {
  physics?: boolean
  commit?: CommitMode
  commitDelay?: number
  extra?: Plugin[]
  fixedHz?: number
}

export function townPlugins(options: TownAppOptions = {}): Plugin[] {
  const out: Plugin[] = [TransformPlugin, ScenePlugin, partitionPlugin()]
  if (options.physics) out.push(physics3dPlugin())
  return out
}

/** An app that streams (single player, unless a net plugin says otherwise). */
export async function townApp(options: TownAppOptions = {}): Promise<App> {
  const app = new App({ fixedHz: options.fixedHz ?? 60, now: () => 0 })
  for (const p of townPlugins(options)) app.addPlugin(p)
  for (const p of options.extra ?? []) app.addPlugin(p)
  await app.init()
  configureCommits(app.world, options)
  return app
}

export function configureCommits(world: World, options: TownAppOptions): void {
  const budget = world.resource(StreamingBudget)
  budget.commit = options.commit ?? 'deterministic'
  budget.commitDelay = options.commitDelay ?? 2
}

export function spawnTown(world: World, partition: string, seed = 7, secretSeed = 99): Entity {
  return world.spawn([PartitionInstance, { partition, seed, secretSeed }])
}

export function spawnSource(world: World, x: number, z: number, peer = 0): Entity {
  return world.spawn([Transform, { translation: [x, 1, z] }], [StreamingSource, { peer }])
}

/** Steps `frames` frames, waiting for due cells before each (deterministic commits). */
export async function steps(app: App, frames: number, dt = 1 / 60): Promise<void> {
  for (let i = 0; i < frames; i++) {
    await partitionSettled(app.world)
    app.update(dt)
  }
}

/** Cells by key with their level name, for asserts. */
export function loadedCells(world: World): Record<string, string> {
  const out: Record<string, string> = {}
  const s = world.tryResource(PartitionState)
  for (const rt of s?.instances.values() ?? []) {
    for (const cell of rt.cells.values()) {
      if (cell.level >= 0) out[cell.key] = cell.grid.levels[cell.level]!.name
    }
  }
  return out
}

export function cellOf(world: World, key: string) {
  const rt = world.resource(PartitionState).instances.values().next().value!
  return rt.cells.get(key)
}

export function moveTo(world: World, e: Entity, x: number, z: number): void {
  world.add(e, Transform, { translation: [x, 1, z] })
}
