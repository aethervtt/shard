// The 0113 fixture project: a generated town streamed by a server around two players, with
// zombies that wander between cells. `shard run --net clients=2` runs it headless.

import { defineSystem, FixedUpdate, Startup } from '@aethervtt/shard-core'
import { anyOf, onServer, ownerInterest, Replicated, replicate } from '@aethervtt/shard-net'
import { defineProject } from '@aethervtt/shard-project'
import { GlobalRng } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import {
  CellBound,
  PartitionInstance,
  partitionPlugin,
  StreamingSource,
} from '@aethervtt/shard-partition'
import { partitionNet, partitionNetPlugin, streamInterest } from '@aethervtt/shard-partition/net'
import { defineTown, ENGINE_COMPONENTS } from '@aethervtt/shard-partition/testing'

void ENGINE_COMPONENTS
const TOWN = defineTown({ name: 'streamed-town', props: 4 })

const STARTS: [number, number][] = [
  [32, 32],
  [1032, 32],
]

const project = defineProject({
  name: 'streamed-town',
  build(app) {
    app.addPlugin(partitionPlugin())
    app.addPlugin(partitionNetPlugin())
    app.addSystems(Startup, start.runIf(onServer))
    app.addSystems(FixedUpdate, wander.runIf(onServer))
  },
})

const start = defineSystem({
  name: 'streamed-town/start',
  run: (_, world) => {
    world.spawn([PartitionInstance, { partition: TOWN, seed: 7, secretSeed: 99 }])
    const rng = world.resource(GlobalRng).fork('streamed-town/zombies')
    for (const [x, z] of STARTS) {
      for (let i = 0; i < 6; i++) {
        world.spawn(
          [Transform, { translation: [x + rng.range(-60, 60), 0, z + rng.range(-60, 60)] }],
          [CellBound, {}],
          [Replicated, {}],
        )
      }
    }
  },
})

/** Zombies shuffle east, and players walk east: cells load, unload and change level. */
const wander = defineSystem({
  name: 'streamed-town/wander',
  setup: (world) => ({
    zombies: world.query({ with: [CellBound, Replicated, Transform] }),
    players: world.query({ with: [StreamingSource, Replicated, Transform] }),
  }),
  run: (s, world) => {
    for (const q of [s.zombies, s.players]) {
      const speed = q === s.players ? 0.5 : 0.05
      for (const table of q.tables) {
        for (let row = 0; row < table.count; row++) {
          const e = table.entities[row]!
          const t = world.get(e, Transform).translation
          world.add(e, Transform, { translation: [t[0] + speed, t[1], t[2]] })
        }
      }
    }
  },
})

project.net(
  partitionNet({
    interest: anyOf(ownerInterest(), streamInterest()),
    replicate: [replicate(Transform, { mode: 'interpolate', quantize: { translation: { step: 0.01 } } })],
    players: {
      spawn(world, { peer }) {
        const [x, z] = STARTS[(peer - 1) % STARTS.length]!
        world.spawn(
          [Replicated, { owner: peer }],
          [Transform, { translation: [x, 1, z] }],
          [StreamingSource, {}],
        )
      },
    },
  }),
)

export default project
