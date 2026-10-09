import { timeout } from '@aethervtt/shard-core/test-env'
import { findPath, NavAgent, NavAgentState, NavMesh, navPlugin } from '@aethervtt/shard-nav'
import { loadNoiseKernel, NoiseGraph } from '@aethervtt/shard-noise'
import { CharacterController, CharacterIntent, CharacterState } from '@aethervtt/shard-physics'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { FloatingOrigin, placeInGrid, Transform, worldPosition64 } from '@aethervtt/shard-transform'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { TerrainAnchor } from '../components'
import { tilesOf } from './colliders'
import { pageHeight } from './queries'
import { mainNoise } from './stack'
import { heightfieldApp, untilStreaming, VALLEY_HILLS, valleySource } from './testing'

let hills: NoiseGraph
const workers = createNodeWorkers(3)

beforeAll(async () => {
  await loadNoiseKernel()
  hills = await NoiseGraph.create(VALLEY_HILLS)
})
afterAll(() => workers.dispose())

describe('navigation on a heightfield (0071)', () => {
  it(
    'paths a NavAgent 300 m across collider tiles, and walks it',
    async () => {
      const p = await heightfieldApp(undefined, {
        ...valleySource(),
        noise: { hills },
        workers,
        physics: true,
        extra: [navPlugin],
      })
      await untilStreaming(p)
      const w = p.world
      const rt = p.runtime()
      const size = rt.layout!.leafSize
      const ground = (x: number, z: number) =>
        pageHeight(
          rt,
          rt.pages!.leafNow(mainNoise(), rt.stack!, Math.floor(x / size), Math.floor(z / size)),
          x,
          z,
        )
      const start = [640, 0, 760]
      const goal = [880, 0, 940]
      start[1] = ground(start[0]!, start[2]!) + 1.2
      goal[1] = ground(goal[0]!, goal[2]!)
      // The origin stays at the start, so world positions (bounds, destination) hold still.
      const origin = w.spawn(Transform, FloatingOrigin)
      placeInGrid(w, origin, p.terrain, start)
      // Ground along the whole way: an anchor between the two, reaching past both.
      const mid = [(start[0]! + goal[0]!) / 2, start[1]!, (start[2]! + goal[2]!) / 2]
      const anchor = w.spawn([TerrainAnchor, { radius: 190 }], Transform)
      placeInGrid(w, anchor, p.terrain, mid)
      const agent = w.spawn(
        [CharacterController, { radius: 0.35, height: 1.8 }],
        [CharacterIntent, {}],
        [CharacterState, {}],
        [NavAgent, { speed: 4, stoppingDistance: 1, drive: 'character' }],
        [NavAgentState, {}],
        Transform,
      )
      placeInGrid(w, agent, p.terrain, start)
      for (let f = 0; f < 10; f++) p.app.update(1 / 60)
      // A navmesh over the region, in world space (the origin's frame).
      const lo = new Float64Array(3)
      const hi = new Float64Array(3)
      rt.frame.pointToOrigin(mid[0]! - 220, -200, mid[2]! - 220, lo)
      rt.frame.pointToOrigin(mid[0]! + 220, 400, mid[2]! + 220, hi)
      w.spawn([
        NavMesh,
        {
          agentRadius: 0.4,
          agentHeight: 1.8,
          maxSlope: 40,
          maxClimb: 0.5,
          cellSize: 0.3,
          cellHeight: 0.15,
          tileSize: 64,
          boundsMin: [lo[0]!, lo[1]!, lo[2]!],
          boundsMax: [hi[0]!, hi[1]!, hi[2]!],
        },
      ])
      for (let f = 0; f < 120; f++) p.app.update(1 / 60)
      expect(tilesOf(rt).tiles.size).toBeGreaterThan(40)
      const goalWorld = new Float64Array(3)
      rt.frame.pointToOrigin(goal[0]!, goal[1]!, goal[2]!, goalWorld)
      const startWorld = new Float64Array(3)
      rt.frame.pointToOrigin(start[0]!, start[1]!, start[2]!, startWorld)
      const path = findPath(w, startWorld, goalWorld)
      expect(path.status).toBe('complete')
      expect(path.length).toBeGreaterThan(295)
      // Across at least four collider tiles.
      const crossed = new Set<string>()
      const t = new Float64Array(3)
      for (let i = 1; i < path.count; i++) {
        const a = path.corners.subarray((i - 1) * 3, i * 3)
        const b = path.corners.subarray(i * 3, i * 3 + 3)
        const len = Math.hypot(b[0]! - a[0]!, b[2]! - a[2]!)
        for (let s = 0; s <= len; s += 1) {
          rt.frame.pointToPlanet(
            a[0]! + ((b[0]! - a[0]!) * s) / len,
            a[1]! + ((b[1]! - a[1]!) * s) / len,
            a[2]! + ((b[2]! - a[2]!) * s) / len,
            t,
          )
          crossed.add(`${Math.floor(t[0]! / size)},${Math.floor(t[2]! / size)}`)
        }
      }
      expect(crossed.size).toBeGreaterThanOrEqual(4)
      // And the agent walks it.
      w.set(agent, NavAgent, {
        ...w.get(agent, NavAgent),
        destination: [goalWorld[0]!, goalWorld[1]!, goalWorld[2]!],
      })
      let frames = 0
      while (frames < 60 * 120 && w.get(agent, NavAgentState).status !== 'arrived') {
        p.app.update(1 / 60)
        frames++
      }
      expect(w.get(agent, NavAgentState).status).toBe('arrived')
      const at = worldPosition64(w, agent, new Float64Array(3), p.terrain)
      expect(Math.hypot(at[0]! - goal[0]!, at[2]! - goal[2]!)).toBeLessThan(2.5)
      await p.app.dispose()
    },
    timeout(300_000),
  )
})
