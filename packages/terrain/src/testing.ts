import { hash32 } from '@aethervtt/shard-core'
import { loadNoiseKernel, NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import {
  CharacterController,
  CharacterIntent,
  CharacterState,
  GravitySource,
  PhysicsConfig,
  physics3dPlugin,
} from '@aethervtt/shard-physics'
import { App } from '@aethervtt/shard-runtime'
import {
  FloatingOrigin,
  Grid,
  placeInGrid,
  Transform,
  TransformPlugin,
  worldPosition64,
} from '@aethervtt/shard-transform'
import { collidersOf } from './colliders'
import { Planet } from './components'
import { planetHeightAt, Terrain } from './heights'
import { terrainPlugin } from './plugin'

/** The Earth-sized planet the walk checksum runs on. */
export const WALK_PLANET = {
  output: 'h',
  nodes: {
    continents: { fbm: { source: 'simplex', octaves: 5, frequency: 2e-6, seed: 1 } },
    hills: { fbm: { source: 'simplex', octaves: 6, frequency: 2e-3, seed: 2 } },
    h: { add: ['continents', { multiply: ['hills', 0.05] }] },
  },
}

export interface WalkResult {
  /** FNV-1a over the characters' final planet-frame positions (f64 bytes) and the collider count. */
  checksum: string
  /** Metres each character walked. */
  walked: number[]
  colliders: number
  ms: number
}

/**
 * Drops `characters` capsules at deterministic points on an Earth-radius planet and walks each
 * for `seconds` headless (no GPU). Node (packages/terrain tests) and Chrome (the playground's
 * #terrain page) must print the same checksum: the noise kernel, collider meshes, and physics are
 * all deterministic.
 */
export async function walkChecksum(characters = 4, seconds = 3): Promise<WalkResult> {
  const t0 = performance.now()
  await loadNoiseKernel()
  const graph = NoiseGraph.fromJson(WALK_PLANET)
  const app = new App().addPlugin(TransformPlugin, physics3dPlugin, terrainPlugin())
  await app.init()
  const w = app.world
  const R = 6.371e6
  w.resource(PhysicsConfig).gravity = [0, 0, 0]
  const height = w.initResource(NoiseGraphs).add(graph, 'walk')
  const planet = w.spawn(
    [Grid, { cellSize: 2000 }],
    [Planet, { radius: R, height, heightScale: 400, seed: 11, ocean: false }],
    [GravitySource, { strength: 9.81, radius: R }],
    Transform,
  )
  app.update(1 / 60)
  const walked: number[] = []
  const bytes = new Uint8Array(characters * 24 + 4)
  const f64 = new Float64Array(bytes.buffer, 0, characters * 3)
  const p0 = new Float64Array(3)
  const p = new Float64Array(3)
  for (let k = 0; k < characters; k++) {
    const u = (hash32(77, k) / 2 ** 32) * 2 - 1
    const a = (hash32(76, k) / 2 ** 32) * Math.PI * 2
    const s = Math.sqrt(1 - u * u)
    const dir = [s * Math.cos(a), u, s * Math.sin(a)]
    const h = planetHeightAt(w, planet, dir)
    const c = w.spawn(
      [CharacterController, { up: 'gravity', radius: 0.35, height: 1.8 }],
      [CharacterIntent, {}],
      [CharacterState, {}],
      Transform,
      FloatingOrigin,
    )
    placeInGrid(
      w,
      c,
      planet,
      dir.map((v) => v * (R + h + 1.2)),
    )
    for (let f = 0; f < 30; f++) app.update(1 / 60)
    worldPosition64(w, c, p0, planet)
    w.set(c, CharacterIntent, { move: [0, 0, -5] })
    for (let f = 0; f < seconds * 60; f++) app.update(1 / 60)
    worldPosition64(w, c, p, planet)
    walked.push(Math.hypot(p[0]! - p0[0]!, p[1]! - p0[1]!, p[2]! - p0[2]!))
    f64.set(p, k * 3)
    w.despawn(c)
  }
  const colliders = collidersOf(w.resource(Terrain).planets.get(planet)!).chunks.size
  new DataView(bytes.buffer).setUint32(characters * 24, colliders, true)
  let hash = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i]!, 0x01000193)
  return {
    checksum: (hash >>> 0).toString(16).padStart(8, '0'),
    walked,
    colliders,
    ms: performance.now() - t0,
  }
}
