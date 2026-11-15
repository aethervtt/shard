import { timeout } from '@aethervtt/shard-core/test-env'
import { MeshBuilder } from '@aethervtt/shard-mesh'
import { NoiseGraph } from '@aethervtt/shard-noise'
import { describe, expect, it } from 'vitest'
import { loadTerrainRegion, terrainHeightAt } from './queries'
import { groundSource, groundStack, heightfieldApp, NEAR_GRAIN, untilStreaming } from './testing'

const ROAD = [
  [400, 100, 400],
  [700, 108, 520],
  [900, 104, 800],
]

describe('a road swept along a terrain spline (0122 on 0071)', () => {
  it(
    'puts the profile’s ground line on the ground the same spline flattened',
    async () => {
      await groundStack()
      const grain = await NoiseGraph.create(NEAR_GRAIN)
      const base = groundSource()
      const p = await heightfieldApp(undefined, {
        source: {
          ...base,
          splines: { road: { points: ROAD, width: 8, falloff: 12 } },
          height: [...base.height, { spline: 'road', mode: 'flatten' }],
        },
        noise: { grain },
      })
      await untilStreaming(p)
      await loadTerrainRegion(p.world, p.terrain, [380, 380, 920, 820])
      const m = MeshBuilder.create().sweep([-3, 0, 3, 0], ROAD.flat(), { step: 1 }).finish()
      let worst = 0
      for (let v = 0; v < m.positions.length / 3; v++) {
        const x = m.positions[v * 3]!
        const z = m.positions[v * 3 + 2]!
        const ground = terrainHeightAt(p.world, p.terrain, x, z)
        expect(ground.exact).toBe(true)
        worst = Math.max(worst, Math.abs(m.positions[v * 3 + 1]! - ground.height))
      }
      expect(worst).toBeLessThan(0.02)
      await p.app.dispose()
    },
    timeout(120_000),
  )
})
