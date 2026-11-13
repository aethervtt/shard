import { defineSystem, First, findComponent, Last } from '@aethervtt/shard-core'
import { Generated } from '@aethervtt/shard-procgen'
import { definePlugin, type Plugin, StepMode } from '@aethervtt/shard-runtime'
import { hookInstances, InstancePart } from '@aethervtt/shard-scene'
import { TransformPlugin } from '@aethervtt/shard-transform'
import * as componentsModule from './components'
import { CellBound, PartitionInstance, StreamingBudget, StreamingSource } from './components'
import { partitionMethods } from './methods'
import { hookPartition, PartitionState, partitionSettled, stream, upkeep } from './runtime'
import { definePartitionSaveSection } from './save'

export const streamCells = defineSystem({
  name: 'partition/stream',
  description:
    'Loads, swaps and unloads partition cells around StreamingSources: generation on the pool, commits within StreamingBudget (0112).',
  setup: (world) => {
    const camera = findComponent('render/Camera3d')
    return {
      sources: world.query({ with: [StreamingSource] }),
      cameras: camera ? world.query({ with: [camera] }) : undefined,
      instances: world.query({ with: [PartitionInstance] }),
    }
  },
  run: (s, world) => stream(world, s.sources, s.cameras, s.instances),
})

export const keepDeltas = defineSystem({
  name: 'partition/deltas',
  description:
    "Keeps loaded cells' deltas current and moves CellBound entities to the cell they stand in (server and single player).",
  setup: (world) => ({
    generated: world.query({ with: [InstancePart, Generated] }),
    bound: world.query({ with: [CellBound] }),
  }),
  run: (s, world) => upkeep(world, s.generated, s.bound),
})

/** Streamed generated worlds (0112). Add `partitionNetPlugin` too for multiplayer. */
export function partitionPlugin(): Plugin {
  return definePlugin({
    name: 'partition',
    provides: [componentsModule],
    build(app) {
      const world = app.world
      // Cells and sources are placed by world transform: a host that has no other reason to add
      // transform propagation (a headless project with no plugins) still needs it.
      if (!app.hasPlugin('core/transform')) app.addPlugin(TransformPlugin)
      world.initResource(PartitionState)
      world.initResource(StreamingBudget)
      hookInstances(world)
      hookPartition(world)
      definePartitionSaveSection()
      // Deterministic hosts wait for generation that's due before each step.
      world.initResource(StepMode).settles.push(() => partitionSettled(world))
      app.addSystems(First, streamCells)
      app.addSystems(Last, keepDeltas)
      app.addMethod(...partitionMethods)
    },
  })
}
