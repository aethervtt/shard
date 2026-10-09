import { timeout } from '@aethervtt/shard-core/test-env'
import { findPath, Nav, NavAgent, NavAgentState, navPlugin } from '@aethervtt/shard-nav'
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
import { beforeAll, describe, expect, it } from 'vitest'
import { Planet, PlanetNav } from './components'
import { keyString, nodeAt } from './cube'
import { planetHeightAt, TerrainWorld } from './heights'
import { planetNavMesh } from './nav'
import { terrainPlugin } from './plugin'

const R = 6.371e6
let graph: NoiseGraph

beforeAll(async () => {
  await loadNoiseKernel()
  graph = await NoiseGraph.create({
    output: 'h',
    nodes: {
      rolling: { fbm: { source: 'simplex', octaves: 5, frequency: 1.5e-3, seed: 3 } },
      h: { multiply: ['rolling', 1] },
    },
  })
})

describe('navigation on a planet (spec 0043)', () => {
  it('walks a NavAgent 120 m across several chunks and navmesh tiles', {
    timeout: timeout(240_000),
  }, async () => {
    const app = new App().addPlugin(TransformPlugin, physics3dPlugin(), navPlugin, terrainPlugin())
    await app.init()
    const w = app.world
    w.resource(PhysicsConfig).gravity = [0, 0, 0]
    const height = w.initResource(NoiseGraphs).add(graph, 'rolling')
    const planet = w.spawn(
      [Grid, { cellSize: 2000 }],
      [Planet, { radius: R, height, heightScale: 60, ocean: false }],
      [GravitySource, { strength: 9.81, radius: R }],
      [PlanetNav, { radius: 150 }],
      Transform,
    )
    app.update(1 / 60)
    const rt = w.resource(TerrainWorld).planets.get(planet)!
    // Start and goal: 120 m apart along the surface.
    const n = [0.2, 0.9, 0.39].map((v, _, a) => v / Math.hypot(a[0]!, a[1]!, a[2]!))
    const east = [n[2]!, 0, -n[0]!]
    const el = Math.hypot(east[0]!, east[1]!, east[2]!)
    const surface = (d: number[], above: number) => {
      const l = Math.hypot(d[0]!, d[1]!, d[2]!)
      const u = d.map((v) => v / l)
      return u.map((v) => v * (R + planetHeightAt(w, planet, u) + above))
    }
    const start = surface(n, 1.2)
    const goalDir = n.map((v, k) => v * R + (east[k]! / el) * 120)
    const goal = surface(goalDir, 0)
    // The origin stays at the start, so world positions (destination) hold still.
    const origin = w.spawn(Transform, FloatingOrigin)
    placeInGrid(w, origin, planet, start)
    const agent = w.spawn(
      [CharacterController, { up: 'gravity', radius: 0.35, height: 1.8 }],
      [CharacterIntent, {}],
      [CharacterState, {}],
      [NavAgent, { speed: 3, stoppingDistance: 1, drive: 'character' }],
      [NavAgentState, {}],
      Transform,
    )
    placeInGrid(w, agent, planet, start)
    for (let f = 0; f < 120; f++) app.update(1 / 60)
    const navmesh = planetNavMesh(rt)
    expect(navmesh).toBeDefined()
    const runtime = w.resource(Nav).meshes.get(navmesh!)
    expect(runtime?.frame).not.toBeNull()
    expect(runtime!.tiles.size).toBeGreaterThan(3)
    // Goal in world space (the origin's frame).
    const goalWorld = new Float64Array(3)
    rt.frame.pointToOrigin(goal[0]!, goal[1]!, goal[2]!, goalWorld)
    const startWorld = new Float64Array(3)
    rt.frame.pointToOrigin(start[0]!, start[1]!, start[2]!, startWorld)
    // The path: long enough, and across several collider chunks and navmesh tiles.
    const path = findPath(w, startWorld, goalWorld)
    expect(path.status).toBe('complete')
    expect(path.length).toBeGreaterThan(115)
    const chunks = new Set<string>()
    const tiles = new Set<string>()
    const planetPoint = new Float64Array(3)
    const local = new Float64Array(3)
    const node = new Float64Array(3)
    for (let i = 1; i < path.count; i++) {
      const a = path.corners.subarray((i - 1) * 3, i * 3)
      const b = path.corners.subarray(i * 3, i * 3 + 3)
      const len = Math.hypot(b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!)
      for (let t = 0; t <= len; t += 1) {
        const x = a[0]! + ((b[0]! - a[0]!) * t) / len
        const y = a[1]! + ((b[1]! - a[1]!) * t) / len
        const z = a[2]! + ((b[2]! - a[2]!) * t) / len
        rt.frame.pointToPlanet(x, y, z, planetPoint)
        const l = Math.hypot(planetPoint[0]!, planetPoint[1]!, planetPoint[2]!)
        nodeAt(
          planetPoint[0]! / l,
          planetPoint[1]! / l,
          planetPoint[2]! / l,
          rt.colliderDepth,
          node,
        )
        chunks.add(keyString(node[0]!, rt.colliderDepth, node[1]!, node[2]!))
        runtime!.pointIn(x, y, z, local)
        tiles.add(
          `${Math.floor(local[0]! / runtime!.tileWorld)},${Math.floor(local[2]! / runtime!.tileWorld)}`,
        )
      }
    }
    expect(chunks.size).toBeGreaterThanOrEqual(3)
    expect(tiles.size).toBeGreaterThanOrEqual(3)
    // And the agent walks it.
    w.set(agent, NavAgent, {
      ...w.get(agent, NavAgent),
      destination: [goalWorld[0]!, goalWorld[1]!, goalWorld[2]!],
    })
    let frames = 0
    while (frames < 60 * 70 && w.get(agent, NavAgentState).status !== 'arrived') {
      app.update(1 / 60)
      frames++
    }
    expect(w.get(agent, NavAgentState).status).toBe('arrived')
    const at = worldPosition64(w, agent, new Float64Array(3), planet)
    const miss = Math.hypot(at[0]! - goal[0]!, at[1]! - goal[1]!, at[2]! - goal[2]!)
    expect(miss).toBeLessThan(2.5)
  })
})
