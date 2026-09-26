import { type Entity, hash32, type World } from '@shard/core'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@shard/noise'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  GravitySource,
  PhysicsConfig,
  physics3dPlugin,
} from '@shard/physics'
import { App } from '@shard/runtime'
import {
  FloatingOrigin,
  Grid,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@shard/transform'
import { beforeAll, describe, expect, it } from 'vitest'
import { collidersOf } from './colliders'
import { Planet } from './components'
import { planetHeightAt, Terrain } from './heights'
import { terrainPlugin } from './plugin'
import { walkChecksum } from './testing'

/** What walkChecksum() prints; the playground's #terrain page checks Chrome against it. */
const WALK_CHECKSUM = '0da23929'

const DT = 1 / 60
const R = 6.371e6

let graph: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  graph = await NoiseGraph.create({
    output: 'h',
    nodes: {
      continents: { fbm: { source: 'simplex', octaves: 5, frequency: 2e-6, seed: 1 } },
      hills: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-3, seed: 2 } },
      h: { add: ['continents', { multiply: ['hills', 0.05] }] },
    },
  })
})

async function planetApp() {
  const app = new App().addPlugin(TransformPlugin, physics3dPlugin, terrainPlugin())
  await app.init()
  const w = app.world
  w.resource(PhysicsConfig).gravity = [0, 0, 0]
  const height = w.initResource(NoiseGraphs).add(graph, 'hills')
  const planet = w.spawn(
    [Grid, { cellSize: 2000 }],
    [Planet, { radius: R, height, heightScale: 400, seed: 11, ocean: false }],
    [GravitySource, { strength: 9.81, radius: R }],
    Transform,
  )
  app.update(DT)
  return { app, w, planet }
}

function surfacePoint(w: World, planet: Entity, dir: number[], above: number): number[] {
  const len = Math.hypot(dir[0]!, dir[1]!, dir[2]!)
  const d = dir.map((v) => v / len)
  const h = planetHeightAt(w, planet, d)
  return d.map((v) => v * (R + h + above))
}

/** Height of a planet-frame point above the canonical surface under it. */
function altitude(w: World, planet: Entity, p: Float64Array): number {
  const len = Math.hypot(p[0]!, p[1]!, p[2]!)
  return len - R - planetHeightAt(w, planet, p)
}

describe('walking on a planet (headless)', () => {
  it('keeps a character on the ground for 100 m at 20 random points on an Earth-sized planet', async () => {
    const { app, w, planet } = await planetApp()
    const positions: number[] = []
    for (let k = 0; k < 20; k++) {
      // Random point on the sphere, deterministic.
      const u = (hash32(99, k) / 2 ** 32) * 2 - 1
      const a = (hash32(98, k) / 2 ** 32) * Math.PI * 2
      const s = Math.sqrt(1 - u * u)
      const dir = [s * Math.cos(a), u, s * Math.sin(a)]
      const start = surfacePoint(w, planet, dir, 1.2)
      const c = w.spawn(
        [CharacterController, { up: 'gravity', radius: 0.35, height: 1.8 }],
        [CharacterIntent, {}],
        [CharacterState, {}],
        Transform,
        FloatingOrigin,
      )
      placeInGrid(w, c, planet, start)
      for (let f = 0; f < 60; f++) app.update(DT)
      expect(w.get(c, CharacterState).grounded).toBe(true)
      const p0 = worldPosition64(w, c, new Float64Array(3), planet)
      w.set(c, CharacterIntent, { move: [0, 0, -5] })
      let lowest = Infinity
      let airborne = 0
      const p = new Float64Array(3)
      for (let f = 0; f < 21 * 60; f++) {
        app.update(DT)
        worldPosition64(w, c, p, planet)
        // The capsule's center is 0.9 m over its feet; feet below the surface is falling through.
        lowest = Math.min(lowest, altitude(w, planet, p) - 0.9)
        if (!w.get(c, CharacterState).grounded) airborne++
      }
      const walked = Math.hypot(p[0]! - p0[0]!, p[1]! - p0[1]!, p[2]! - p0[2]!)
      expect(walked).toBeGreaterThan(100)
      // Feet stay within the collider triangles' flattening of the terrain (under a metre spacing).
      expect(lowest).toBeGreaterThan(-0.25)
      expect(airborne).toBeLessThan(60)
      positions.push(p[0]!, p[1]!, p[2]!)
      w.despawn(c)
    }
    const set = collidersOf(w.resource(Terrain).planets.get(planet)!)
    expect(set.chunks.size).toBeGreaterThan(0)
    expect(positions.length).toBe(60)
  }, 240_000)
})

describe('walk checksum (Node and Chrome)', () => {
  it('matches the pinned checksum the playground #terrain page shows', async () => {
    const r = await walkChecksum()
    for (const m of r.walked) expect(m).toBeGreaterThan(12)
    expect(r.colliders).toBeGreaterThan(0)
    expect(r.checksum).toBe(WALK_CHECKSUM)
  }, 120_000)
})
