import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { describe, expect, it } from 'vitest'
import { loadTerrainRegion, terrainHeightAt } from './queries'
import { terrainRaycast } from './raycast'
import { EDIT_HILLS, editSource, heightfieldApp, untilStreaming } from './testing'

describe('terrainRaycast (0104)', () => {
  it('hits the ground within 1 cm of terrainHeightAt, from 20 camera rays', async () => {
    await loadNoiseKernel()
    const hills = await NoiseGraph.create(EDIT_HILLS)
    const p = await heightfieldApp(undefined, {
      ...editSource(),
      noise: { hills },
      block: 4,
      at: [1000, -5, -300],
    })
    await untilStreaming(p)
    await loadTerrainRegion(p.world, p.terrain, [0, 0, 512, 512])
    let rng = 7
    const random = () => {
      rng = (rng * 1103515245 + 12345) % 2 ** 31
      return rng / 2 ** 31
    }
    for (let k = 0; k < 20; k++) {
      // From 20–120 m up, toward a point below the ground: the ray meets it on the way.
      const eye = [1000 + 50 + random() * 400, 20 + random() * 100, -300 + 50 + random() * 400]
      const target = [1000 + 50 + random() * 400, -40, -300 + 50 + random() * 400]
      const dir = [target[0]! - eye[0]!, target[1]! - eye[1]!, target[2]! - eye[2]!]
      const hit = terrainRaycast(p.world, p.terrain, eye, dir)
      expect(hit).not.toBeNull()
      const ground = terrainHeightAt(p.world, p.terrain, hit!.x, hit!.z).height - 5
      expect(Math.abs(hit!.point[1] - ground)).toBeLessThan(0.01)
      expect(hit!.point[0]).toBeCloseTo(hit!.x + 1000, 6)
      expect(hit!.normal[1]).toBeGreaterThan(0.3)
    }
    // Straight up from below the terrain's box, or away from it: no hit.
    expect(terrainRaycast(p.world, p.terrain, [1100, 200, -200], [0, 1, 0])).toBeNull()
    expect(terrainRaycast(p.world, p.terrain, [0, 50, 0], [-1, 0, 0])).toBeNull()
  }, 60_000)
})
