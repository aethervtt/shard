import type { Entity, World } from '@aethervtt/shard-core'
import { allocationChecks, gcWindow } from '@aethervtt/shard-core/test-env'
import {
  CharacterController,
  CharacterSuspended,
  Collider,
  physics3dPlugin,
  RigidBody,
} from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  NavAgent,
  NavAgentState,
  NavBudget,
  NavFlowField,
  NavMesh,
  NavSource,
  NavTier,
} from './components'
import { describeNav } from './methods'
import type { NavMeshRuntime } from './navmesh'
import { Nav } from './state'
import { navMoverTier } from './steer-state'
import { frames, navApp, slab } from './test-level'
import { navTiersPlugin } from './tiers-plugin'

// Movement tiers (0115): Detour's crowd near players, nav's own steer and coarse movers further
// out, with joins to the crowd capped per step.

const DT = 1 / 60
type Tier = 'crowd' | 'steer' | 'coarse'

/** A 60 × 60 m floor with a row of pillars to walk round. */
async function field(...plugins: Parameters<typeof navApp>) {
  const app = await navApp(navTiersPlugin, ...plugins)
  const world = app.world
  const floor = slab(world, 0, 0, 30, 30, 0)
  const pillars: Entity[] = []
  for (let i = 0; i < 6; i++) {
    pillars.push(
      world.spawn(
        [NavSource, {}],
        [Collider, { shape: 'cuboid', halfExtents: [1, 1, 1] }],
        [Transform, { translation: [-4 + (i % 2) * 6, 1, -20 + i * 8] }],
      ),
    )
  }
  world.spawn([NavMesh, { tileSize: 64 }])
  frames(app, 2)
  const rt = [...world.resource(Nav).meshes.values()][0]!
  return { app, world, rt, floor, pillars }
}

function walker(world: World, from: number[], to: number[], tier?: Tier, speed = 3): Entity {
  const e = world.spawn(
    [NavAgent, { destination: to as [number, number, number], speed, drive: 'transform' }],
    [Transform, { translation: from as [number, number, number] }],
  )
  if (tier) world.add(e, NavTier, { tier })
  return e
}

const flat = (world: World, e: Entity) => {
  const p = world.get(e, Transform).translation
  return [p[0], p[1], p[2]] as const
}

/** How far (x, z) is from the nearest polygon of the navmesh (∞: none within 1 m). */
function offMesh(rt: NavMeshRuntime, p: readonly number[]): number {
  const r = rt.query.findNearestPoly(
    { x: p[0]!, y: p[1]!, z: p[2]! },
    { halfExtents: { x: 1, y: 2, z: 1 } },
  )
  if (!r.success || r.nearestRef === 0) return Number.POSITIVE_INFINITY
  return Math.hypot(r.nearestPoint.x - p[0]!, r.nearestPoint.z - p[2]!)
}

describe('movement tiers', () => {
  it('keeps agents moving and on the navmesh as they switch crowd, steer and coarse', async () => {
    const { app, world, rt } = await field()
    const agents: Entity[] = []
    for (let i = 0; i < 12; i++) {
      const z = -22 + i * 4
      agents.push(walker(world, [-26, 0, z], [26, 0, z + (i % 3) - 1], 'crowd'))
    }
    // Tiers by frame: each switch is a join to or a leave from the crowd, or steer ↔ coarse.
    const schedule: [number, Tier][] = [
      [90, 'steer'],
      [180, 'coarse'],
      [270, 'crowd'],
      [360, 'coarse'],
      [450, 'steer'],
      [540, 'crowd'],
      [630, 'steer'],
    ]
    const last = new Map(agents.map((e) => [e, flat(world, e)]))
    let worstAfterSwitch = Number.POSITIVE_INFINITY
    let worstOff = 0
    let sinceSwitch = 1000
    const seen = new Set<string>()
    for (let f = 0; f < 720; f++) {
      const next = schedule.find(([at]) => at === f)
      if (next) {
        for (const e of agents) world.set(e, NavTier, { tier: next[1] })
        sinceSwitch = 0
      }
      app.update(DT)
      sinceSwitch++
      for (const e of agents) {
        const p = flat(world, e)
        const q = last.get(e)!
        last.set(e, p)
        worstOff = Math.max(worstOff, offMesh(rt, p))
        seen.add(navMoverTier(world, e))
        const state = world.get(e, NavAgentState)
        // Speed across a switch, while the agent is on its way (not arriving or just started).
        if (f < 60 || state.status !== 'moving' || state.remaining < 3 || sinceSwitch > 30) continue
        const speed = Math.hypot(p[0] - q[0], p[2] - q[2]) / DT
        worstAfterSwitch = Math.min(worstAfterSwitch, speed)
      }
    }
    console.info(
      `tier switches: slowest step within 30 of a switch ${worstAfterSwitch.toFixed(2)} m/s (of 3), farthest off the navmesh ${worstOff.toFixed(3)} m`,
    )
    expect([...seen].sort()).toEqual(['coarse', 'crowd', 'steer'])
    expect(worstAfterSwitch).toBeGreaterThanOrEqual(0.5 * 3)
    expect(worstOff).toBeLessThanOrEqual(0.1)
    // They keep their paths across the switches and get there.
    for (let f = 0; f < 600; f++) app.update(DT)
    for (const e of agents) expect(world.get(e, NavAgentState).status).toBe('arrived')
  })

  it('caps crowd joins per step and the crowd per navmesh, and steers those waiting', async () => {
    const { app, world } = await field()
    const nav = world.resource(Nav)
    const agents: Entity[] = []
    for (let i = 0; i < 30; i++)
      agents.push(
        walker(world, [-20 + (i % 10) * 2, 0, -24 + Math.floor(i / 10) * 3], [20, 0, 20], 'steer'),
      )
    frames(app, 10)
    const inCrowd = () => agents.filter((e) => nav.agents.get(e)!.crowdIndex >= 0).length
    expect(inCrowd()).toBe(0)
    for (const e of agents) world.set(e, NavTier, { tier: 'crowd' })
    const counts: number[] = []
    for (let f = 0; f < 6; f++) {
      app.update(DT)
      counts.push(inCrowd())
    }
    // 8 a step (NavBudget.joins), and the rest keep steering until admitted.
    expect(counts).toEqual([8, 16, 24, 30, 30, 30])

    // With room for 20, 10 stay with nav/steer, still moving.
    world.insertResource(NavBudget, { ...world.initResource(NavBudget), crowd: 20 })
    for (const e of agents) world.set(e, NavTier, { tier: 'steer' })
    frames(app, 2)
    expect(inCrowd()).toBe(0)
    for (const e of agents) world.set(e, NavTier, { tier: 'crowd' })
    frames(app, 6)
    expect(inCrowd()).toBe(20)
    const waiting = agents.filter((e) => nav.agents.get(e)!.crowdIndex < 0)
    expect(waiting.map((e) => navMoverTier(world, e))).toEqual(new Array(10).fill('steer'))
    const before = waiting.map((e) => flat(world, e))
    frames(app, 30)
    waiting.forEach((e, i) => {
      const p = flat(world, e)
      expect(Math.hypot(p[0] - before[i]![0], p[2] - before[i]![2])).toBeGreaterThan(1)
    })

    // New agents spawned into the crowd join at the same rate.
    world.insertResource(NavBudget, { ...world.initResource(NavBudget), crowd: 128 })
    const fresh: Entity[] = []
    for (let i = 0; i < 20; i++)
      fresh.push(walker(world, [-20 + i * 2, 0, 10], [20, 0, -20], 'crowd'))
    const added: number[] = []
    for (let f = 0; f < 4; f++) {
      app.update(DT)
      added.push(fresh.filter((e) => (nav.agents.get(e)?.crowdIndex ?? -1) >= 0).length)
    }
    expect(added[0]).toBeLessThanOrEqual(8)
    expect(added.at(-1)).toBe(20)
    const d = describeNav(world)
    expect(d.agents.find((a) => a.entity === fresh[0])?.tier).toBe('crowd')
  })

  it('pushes steer agents apart, and leaves coarse ones to overlap', async () => {
    for (const tier of ['steer', 'coarse'] as const) {
      const { app, world } = await field()
      const agents: Entity[] = []
      for (let i = 0; i < 16; i++) {
        const x = -20 + (i % 4) * 0.05
        const z = 10 + Math.floor(i / 4) * 0.05
        agents.push(walker(world, [x, 0, z], [20, 0, 10], tier, 2))
      }
      frames(app, 120)
      let closest = Number.POSITIVE_INFINITY
      for (let i = 0; i < agents.length; i++) {
        const p = flat(world, agents[i]!)
        for (let j = i + 1; j < agents.length; j++) {
          const q = flat(world, agents[j]!)
          closest = Math.min(closest, Math.hypot(p[0] - q[0], p[2] - q[2]))
        }
      }
      if (tier === 'steer') expect(closest).toBeGreaterThan(0.4)
      else expect(closest).toBeLessThan(0.2)
    }
  })

  it('suspends a character controller below the crowd and resumes it in the crowd', async () => {
    const { app, world, floor, pillars } = await field(physics3dPlugin())
    for (const e of [floor, ...pillars]) world.add(e, RigidBody, { kind: 'fixed' })
    frames(app, 2)
    const e = world.spawn(
      [CharacterController, {}],
      [NavAgent, { destination: [20, 0, 0], drive: 'character', speed: 3 }],
      [Transform, { translation: [-20, 0.95, 0] }],
    )
    frames(app, 30)
    world.add(e, NavTier, { tier: 'steer' })
    frames(app, 2)
    expect(world.has(e, CharacterSuspended)).toBe(true)
    const y0 = world.get(e, Transform).translation[1]
    const x0 = world.get(e, Transform).translation[0]
    frames(app, 60)
    const p = world.get(e, Transform).translation
    expect(p[0] - x0).toBeGreaterThan(2)
    // The capsule's centre stays as high above the surface as it was.
    expect(Math.abs(p[1] - y0)).toBeLessThan(0.1)
    world.set(e, NavTier, { tier: 'crowd' })
    frames(app, 2)
    expect(world.has(e, CharacterSuspended)).toBe(false)
    for (let f = 0; f < 900 && world.get(e, NavAgentState).status !== 'arrived'; f++) app.update(DT)
    expect(world.get(e, NavAgentState).status).toBe('arrived')
  })

  it('steers and coarsens agents on paths and a flow field without allocating', async () => {
    const { app, world } = await field()
    const flow = world.spawn([NavFlowField, { goal: [0, 0, 26] }])
    for (let i = 0; i < 200; i++) {
      const at: [number, number, number] = [-26 + (i % 20) * 2.6, 0, -26 + Math.floor(i / 20) * 2]
      const tier = i % 3 ? 'coarse' : 'steer'
      if (i % 2) walker(world, at, [at[0], 0, at[2] + 40], tier, 0.5)
      else
        world.spawn(
          [NavAgent, { flow, speed: 0.5, drive: 'transform' }],
          [NavTier, { tier }],
          [Transform, { translation: at }],
        )
    }
    frames(app, 120)
    ;(globalThis as { gc?: () => void }).gc?.()
    await new Promise((r) => setTimeout(r, 200))
    const gcs = gcWindow()
    const t0 = performance.now()
    frames(app, 240)
    const ms = (performance.now() - t0) / 240
    const collections = await gcs.end()
    console.info(`200 steer and coarse agents (half on a flow field): ${ms.toFixed(3)} ms a step`)
    if (allocationChecks) expect(collections).toBe(0)
  })
})
