import { timeout } from '@aethervtt/shard-core/test-env'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { afterAll, describe, expect, it } from 'vitest'
import { heightfieldWalk } from './testing'

/** What heightfieldWalk() prints; the playground's #heightfield page checks Chrome against it. */
export const HEIGHTFIELD_WALK = '4e53476b'

const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

describe('walking on a heightfield (0071, headless)', () => {
  it(
    'keeps 20 characters on the collider tiles for 100 m each, never through the ground',
    async () => {
      const r = await heightfieldWalk(20, 30, workers)
      for (const m of r.walked) expect(m).toBeGreaterThan(100)
      // The capsule's lowest point rests on the triangles; its center over them by its half height.
      expect(r.lowest).toBeGreaterThan(-0.25)
      expect(r.tiles).toBeGreaterThan(20)
    },
    timeout(300_000),
  )

  it(
    'matches the pinned checksum the playground shows',
    async () => {
      const r = await heightfieldWalk()
      for (const m of r.walked) expect(m).toBeGreaterThan(12)
      expect(r.checksum).toBe(HEIGHTFIELD_WALK)
    },
    timeout(120_000),
  )
})
