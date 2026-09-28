import type { Entity } from '@aethervtt/shard-core'
import {
  CharacterController,
  CharacterState,
  Collider,
  physics3dPlugin,
  RigidBody,
} from '@aethervtt/shard-physics'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  NavAgent,
  type NavAgentEventData,
  NavAgentState,
  NavArrived,
  NavGrid,
  NavGridDatas,
  NavMesh,
  NavSource,
  NavUnreachable,
  OffMeshLink,
} from './components'
import { NavGridData } from './grid'
import { frames, navApp, ramp, slab } from './test-level'

const DT = 1 / 60

describe('navmesh agents', () => {
  it('50 agents cross a room to swapped places without overlapping, and all arrive', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 14, 14, 0)
    w.spawn([NavMesh, { tileSize: 48, agentRadius: 0.4 }])
    frames(a, 2)
    const r = 0.4
    const agents: Entity[] = []
    // Two columns of 25, 2.5 radii apart, facing each other across the room: every lane
    // crosses head-on in the middle.
    for (let i = 0; i < 25; i++) {
      const z = -12 + i
      for (const side of [-1, 1]) {
        agents.push(
          w.spawn(
            [NavAgent, { destination: [-side * 9, 0, z], radius: r, speed: 3, drive: 'transform' }],
            [Transform, { translation: [side * 9, 0, z] }],
          ),
        )
      }
    }
    const arrived = new Set<Entity>()
    const reader = w.reader(NavArrived)
    let worst = Infinity
    for (let f = 0; f < 60 * 30 && arrived.size < agents.length; f++) {
      a.update(DT)
      for (const e of reader.read()) arrived.add((e as NavAgentEventData).entity)
      for (let i = 0; i < agents.length; i++) {
        const p = w.get(agents[i]!, Transform).translation
        for (let j = i + 1; j < agents.length; j++) {
          const q = w.get(agents[j]!, Transform).translation
          const d = Math.hypot(p[0] - q[0], p[2] - q[2])
          if (d < worst) worst = d
        }
      }
    }
    expect(arrived.size).toBe(agents.length)
    for (const e of agents) expect(w.get(e, NavAgentState).status).toBe('arrived')
    // Overlap is 2r − distance; at most 10% of r.
    expect(2 * r - worst).toBeLessThanOrEqual(0.1 * r)
  })

  it('walks a character up a ramp by CharacterIntent, grounded all the way', async () => {
    const a = await navApp(physics3dPlugin())
    const w = a.world
    // Solid ground for physics and the bake: fixed bodies tagged as nav sources.
    const floor = slab(w, 0, 0, 10, 10, 0)
    const top = slab(w, 0, -14, 4, 4, 3)
    const slope = ramp(w, 0, -2, 20, 3)
    for (const e of [floor, top, slope]) w.add(e, RigidBody, { kind: 'fixed' })
    w.spawn([NavMesh, { tileSize: 48 }])
    const agent = w.spawn(
      [CharacterController, {}],
      [NavAgent, { destination: [0, 3, -14], drive: 'character', speed: 3 }],
      [Transform, { translation: [0, 0.95, 6] }],
    )
    frames(a, 10)
    expect(w.get(agent, CharacterState).grounded).toBe(true)
    let airborne = 0
    let maxY = 0
    let status = ''
    for (let f = 0; f < 60 * 15 && status !== 'arrived'; f++) {
      a.update(DT)
      if (!w.get(agent, CharacterState).grounded) airborne++
      maxY = Math.max(maxY, w.get(agent, Transform).translation[1])
      status = w.get(agent, NavAgentState).status
    }
    expect(status).toBe('arrived')
    expect(airborne).toBe(0)
    // The capsule's center rides 0.9 above the upper floor.
    expect(maxY).toBeGreaterThan(3.5)
    const p = w.get(agent, Transform).translation
    expect(Math.hypot(p[0], p[2] + 14)).toBeLessThan(0.5)
  })

  it('jumps a character across an off-mesh link without sinking into the ground', async () => {
    const a = await navApp(physics3dPlugin())
    const w = a.world
    // Ground (top 0) up to x = 10, then a ledge (top 1.2) too tall to step onto.
    const ground = slab(w, 0, 0, 10, 6, 0)
    const ledge = w.spawn(
      [NavSource, {}],
      [Collider, { shape: 'cuboid', halfExtents: [4, 0.6, 6] }],
      [Transform, { translation: [14, 0.6, 0] }],
    )
    for (const e of [ground, ledge]) w.add(e, RigidBody, { kind: 'fixed' })
    const far = w.spawn([Transform, { translation: [11.4, 1.2, 0] }])
    w.spawn([OffMeshLink, { to: far, radius: 0.6 }], [Transform, { translation: [8.8, 0, 0] }])
    w.spawn([NavMesh, { tileSize: 48 }])
    const agent = w.spawn(
      [CharacterController, {}],
      [NavAgent, { destination: [15, 1.2, 0], drive: 'character', speed: 3 }],
      [Transform, { translation: [4, 0.95, 0] }],
    )
    frames(a, 10)
    // Lowest the capsule's bottom got below the top of whatever is under or beside it.
    const half = 0.9
    let worst = Infinity
    let status = ''
    for (let f = 0; f < 60 * 10 && status !== 'arrived'; f++) {
      a.update(DT)
      const [x, y] = w.get(agent, Transform).translation
      const top = x + 0.35 > 10 ? 1.2 : 0
      worst = Math.min(worst, y - half - top)
      status = w.get(agent, NavAgentState).status
    }
    expect(status).toBe('arrived')
    expect(worst).toBeGreaterThan(-0.05)
    expect(w.get(agent, Transform).translation[1]).toBeGreaterThan(1.2 + half - 0.05)
  })

  it('follows a moving target, and says so when it cannot reach it', async () => {
    const a = await navApp()
    const w = a.world
    slab(w, 0, 0, 10, 10, 0)
    slab(w, 30, 0, 3, 3, 0) // an island
    w.spawn([NavMesh, { tileSize: 48 }])
    frames(a, 2)
    const target = w.spawn([Transform, { translation: [5, 0, 5] }])
    const agent = w.spawn(
      [NavAgent, { target, drive: 'transform', speed: 4, stoppingDistance: 0.5 }],
      [Transform, { translation: [-5, 0, -5] }],
    )
    const unreachable = w.reader(NavUnreachable)
    let unreachableEvents = 0
    frames(a, 60 * 5)
    expect(w.get(agent, NavAgentState).status).toBe('arrived')
    // The target walks away: the agent follows.
    w.set(target, Transform, { translation: [-6, 0, 6] })
    frames(a, 2)
    expect(w.get(agent, NavAgentState).status).toBe('moving')
    frames(a, 60 * 5)
    expect(w.get(agent, NavAgentState).status).toBe('arrived')
    let p = w.get(agent, Transform).translation
    expect(Math.hypot(p[0] + 6, p[2] - 6)).toBeLessThan(0.6)
    // Onto the island: no path, the agent heads for the shore and reports it.
    unreachable.read()
    w.set(target, Transform, { translation: [30, 0, 0] })
    for (let f = 0; f < 60 * 5; f++) {
      a.update(DT)
      unreachableEvents += unreachable.read().length
    }
    expect(unreachableEvents).toBe(1)
    expect(w.get(agent, NavAgentState).status).toBe('unreachable')
    p = w.get(agent, Transform).translation
    expect(p[0]).toBeGreaterThan(8.5)
  })
})

describe('grid agents', () => {
  it('chase a target through a maze and arrive', async () => {
    const a = await navApp()
    const w = a.world
    // ##########
    // #........#
    // #.######.#
    // #.#....#.#
    // #.#.##.#.#
    // #...#..#.#
    // ######.#.#
    // #......#.#
    // #.########
    // ##########   (row 0 is the bottom)
    const rows = [
      '##########',
      '#........#',
      '#.######.#',
      '#.#....#.#',
      '#.#.##.#.#',
      '#...#..#.#',
      '######.#.#',
      '#......#.#',
      '#.########',
      '##########',
    ].reverse()
    const data = new NavGridData(10, 10)
    for (let y = 0; y < 10; y++)
      for (let x = 0; x < 10; x++) data.set(x, y, rows[y]![x] === '#' ? 0 : 1)
    const ref = w.resource(NavGridDatas).add(data, 'maze')
    w.spawn([NavGrid, { source: 'data', data: ref }], [Transform, {}])
    const target = w.spawn([Transform, { translation: [1.5, 1.5, 0] }])
    const agent = w.spawn(
      [NavAgent, { target, drive: 'transform', speed: 4, radius: 0.3, stoppingDistance: 0.3 }],
      [Transform, { translation: [8.5, 2.5, 0] }],
    )
    let status = ''
    for (let f = 0; f < 60 * 20 && status !== 'arrived'; f++) {
      a.update(DT)
      status = w.get(agent, NavAgentState).status
      // Never inside a wall.
      const p = w.get(agent, Transform).translation
      expect(data.get(Math.floor(p[0]), Math.floor(p[1]))).toBeGreaterThan(0)
    }
    expect(status).toBe('arrived')
  })
})
