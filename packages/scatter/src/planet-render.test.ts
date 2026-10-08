import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { createNodeGpuContext } from '@aethervtt/shard-gpu/node'
import { loadNoiseKernel } from '@aethervtt/shard-noise'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { compareGolden, pngBytes } from '@aethervtt/shard-render/testing'
import { planetHeightAt } from '@aethervtt/shard-terrain'
import { capture, placeCamera, settleTerrain, sunOver } from '@aethervtt/shard-terrain/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Prop, propIdentity } from './components'
import { Wind } from './foliage'
import { Scatter } from './runtime'
import { placementChecksum, scatterPlanet, settleScatter, TEST_RADIUS } from './testing'

const here = dirname(fileURLToPath(import.meta.url))
const shots = process.env.SHARD_SHOTS
const roots: string[] = []
let gpu: GpuContext

beforeAll(async () => {
  await loadNoiseKernel()
  gpu = await createNodeGpuContext()
})
afterAll(() => {
  gpu?.destroy()
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

/** Spots on the test planet by biome (around the 0.9-up ring the explorer sampled), and how high. */
const VIEWS = [
  { name: 'grassland', angle: 3 * 0.157, up: 1.7, pitch: -0.15 },
  { name: 'forest', angle: 18 * 0.157, up: 1.7, pitch: -0.1 },
  { name: 'rock', angle: 35 * 0.157, up: 2.5, pitch: -0.2 },
  { name: 'edge', angle: 37 * 0.157, up: 6, pitch: -0.25 },
  { name: 'overview', angle: 23 * 0.157, up: 60, pitch: -0.45 },
]

function direction(angle: number): number[] {
  const d = [Math.cos(angle) * 0.3, 0.9, Math.sin(angle) * 0.3]
  const l = Math.hypot(d[0]!, d[1]!, d[2]!)
  return d.map((x) => x / l)
}

describe('scatter on a planet, rendered', () => {
  it('shows rocks, trees and grass in their biomes from five fixed viewpoints', {
    timeout: timeout(300_000),
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-scatter-planet-'))
    roots.push(root)
    const p = await scatterPlanet(gpu, createNodePlatform({ root, logTo: () => {} }))
    const w = p.world
    // Calm: sway follows the clock, and how many frames settling takes varies.
    w.resource(Wind).strength = 0
    const rules = new Set<string>()
    for (const view of VIEWS) {
      const d = direction(view.angle)
      const h = planetHeightAt(w, p.planet, d)
      const r = TEST_RADIUS + h + view.up
      const eye = d.map((x) => x * r)
      // Look along a tangent, pitched down.
      const side = Math.abs(d[1]!) < 0.9 ? [0, 1, 0] : [1, 0, 0]
      const t = [
        side[1]! * d[2]! - side[2]! * d[1]!,
        side[2]! * d[0]! - side[0]! * d[2]!,
        side[0]! * d[1]! - side[1]! * d[0]!,
      ]
      const tl = Math.hypot(t[0]!, t[1]!, t[2]!)
      const target = eye.map((x, k) => x + (t[k]! / tl) * 20 + d[k]! * view.pitch * 20)
      placeCamera(p, eye, target)
      sunOver(p, d, 40)
      await settleTerrain(p)
      await settleScatter(p)
      await settleTerrain(p)
      const image = await capture(p)
      if (shots) {
        mkdirSync(shots, { recursive: true })
        writeFileSync(
          join(shots, `scatter-planet-${view.name}.png`),
          pngBytes(image.data as Uint8Array, image.width, image.height),
        )
      }
      const golden = compareGolden(here, `planet-${view.name}`, image)
      expect(golden.mean, view.name).toBeLessThan(2)
      for (const table of w.query({ with: [Prop] }).tables)
        for (let row = 0; row < table.count; row++)
          rules.add(propIdentity(w, table.entities[row]!)!.rule)
    }
    // Props from all three biomes' sets were placed along the way.
    expect([...rules].some((r) => r.includes('grassland'))).toBe(true)
    expect([...rules].some((r) => r.includes('forest'))).toBe(true)
    expect([...rules].some((r) => r.includes('rocks'))).toBe(true)
    expect(placementChecksum(w).props).toBeGreaterThan(100)
    expect(w.resource(Scatter).surfaces.get(p.planet)!.problem).toBeNull()
  })
})
