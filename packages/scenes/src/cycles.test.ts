import type { AssetRef } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { cylinder } from '@aethervtt/shard-mesh'
import { createMirror } from '@aethervtt/shard-mirror'
import {
  forwardPlugin,
  Mesh3d,
  Meshes,
  OffscreenTarget,
  RenderHealth,
  RenderTargets,
  renderOwner,
  renderPlugin,
} from '@aethervtt/shard-render'
import { settle } from '@aethervtt/shard-render/testing'
import { App } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parityPlugins, poseParityCamera, showParityView, spawnParity } from './parity'

// Mount, load, switch, reconnect, leave (0061), fifty times on one shared device: nothing grows.

let gpu: GpuContext
beforeAll(async () => {
  gpu = await createNodeGpuContext()
})
afterAll(() => gpu.destroy())

interface Token {
  id: string
  rev: number
  x: number
}

/** One visit to the table: every step a host takes, back to nothing. */
async function visit(): Promise<string> {
  const app = new App().addPlugin(
    TransformPlugin,
    renderPlugin({ gpu, windowView: false }),
    forwardPlugin({ msaa: 1 }),
    ...parityPlugins(),
  )
  await app.init()
  const world = app.world
  const target = new OffscreenTarget(gpu, { label: 'cycle', width: 32, height: 24 })
  const ref = world.resource(RenderTargets).add(target, 'cycle') as AssetRef<'RenderTarget'>
  const empty = world.entityCount
  // Mount the table for an owner.
  const first = world.owners.create('scene:first')
  const table = spawnParity(world, { target: ref, owner: first })
  showParityView(world, table, 'tabletop')
  poseParityCamera(world, table, 'tabletop', 55)
  await settle(app, 12)
  expect(world.resource(RenderHealth).state).toBe('ok')
  // Switch scenes: release the old owner, load the new one.
  world.owners.release(first)
  app.update(1 / 60) // structure removes what it built for the released walls
  expect(world.entityCount).toBe(empty)
  const second = world.owners.create('scene:second')
  const next = spawnParity(world, { target: ref, owner: second })
  showParityView(world, next, 'map')
  // Reconnect: the host's documents sync again; unchanged revisions cost nothing.
  const disc = world.resource(Meshes).add(cylinder({ radius: 0.3, height: 0.05 }))
  const tokens = createMirror<Token>(world, {
    key: (d) => d.id,
    rev: (d) => d.rev,
    spawn: (d, w) =>
      w.owners.spawn(second, [Mesh3d, { mesh: disc }], [Transform, { translation: [d.x, 0, 0] }]),
    apply: (e, d, w) => w.set(e, Transform, { translation: [d.x, 0, 0] }),
  })
  const docs = [0, 1, 2].map((i) => ({ id: `t${i}`, rev: 1, x: i }))
  tokens.sync(docs)
  await settle(app, 4)
  expect(tokens.sync(docs)).toEqual({ spawned: 0, applied: 0, removed: 0 })
  tokens.sync(docs.map((d) => (d.id === 't1' ? { ...d, rev: 2, x: 5 } : d)))
  expect(tokens.last).toEqual({ spawned: 0, applied: 1, removed: 0 })
  await settle(app, 4)
  // Leave.
  const owner = renderOwner(world)
  world.owners.release(second)
  app.update(1 / 60)
  expect(world.entityCount).toBe(empty)
  await app.dispose()
  target.destroy()
  return owner
}

describe('mount and leave cycles (0061)', () => {
  it(
    '50 cycles of mount, load the parity fixture, switch scene, reconnect and dispose leave everything at its baseline',
    async () => {
      const errors = gpu.errors.length
      // One visit first: per-device objects the apps share (gpu.shared) are made once.
      await visit()
      const baseline = gpu.stats()
      const listeners = gpu.listenerCount
      const owners = gpu.owners()
      for (let i = 0; i < 50; i++) {
        const owner = await visit()
        expect(gpu.stats(owner)).toEqual({ buffers: 0, textures: 0, bytes: 0 })
      }
      expect(gpu.stats()).toEqual(baseline)
      expect(gpu.listenerCount).toEqual(listeners)
      expect(gpu.owners()).toEqual(owners)
      expect(gpu.surfaces).toEqual([])
      expect(gpu.errors.slice(errors)).toEqual([])
    },
    timeout(300_000),
  )
})
