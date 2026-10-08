import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timeout } from '@aethervtt/shard-core/test-env'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { planetHeightAt, TerrainAnchor } from '@aethervtt/shard-terrain'
import { placeInGrid, Transform } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { placementChecksum, scatterPlanet, settleScatter, TEST_RADIUS } from './testing'

/** What placementChecksum() gives for the test planet's three spots; the playground's #scatter page checks Chrome against it. */
const PLACEMENT_CHECKSUM = '9acc927a'

const roots: string[] = []
beforeAll(async () => {
  await loadNoiseKernel()
})
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Props around three anchors on the test planet (one per biome), headless; the checksum. */
async function run(workers: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'shard-scatter-sum-'))
  roots.push(root)
  const platform = createNodePlatform({ root, logTo: () => {} })
  const p = await scatterPlanet(undefined, platform, { workers })
  for (const angle of [3, 18, 35]) {
    const a = angle * 0.157
    const d0 = [Math.cos(a) * 0.3, 0.9, Math.sin(a) * 0.3]
    const l = Math.hypot(d0[0]!, d0[1]!, d0[2]!)
    const d = d0.map((x) => x / l)
    const h = planetHeightAt(p.world, p.planet, d)
    const anchor = p.world.spawn([TerrainAnchor, { radius: 60 }], Transform)
    placeInGrid(
      p.world,
      anchor,
      p.planet,
      d.map((x) => x * (TEST_RADIUS + h + 1)),
    )
  }
  await settleScatter(p)
  const result = placementChecksum(p.world)
  await p.app.dispose()
  platform.workers?.dispose()
  return result
}

describe('placement checksum', () => {
  it('places the same props on every run, with or without the worker pool, and on every host', {
    timeout: timeout(120_000),
  }, async () => {
    const a = await run(false)
    const b = await run(false)
    const c = await run(true)
    expect(a.props).toBeGreaterThan(500)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    expect(a.checksum).toBe(PLACEMENT_CHECKSUM)
  })
})
