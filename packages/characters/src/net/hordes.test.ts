import { type Entity, Last, type World } from '@aethervtt/shard-core'
import { budget, timeout, timingMode } from '@aethervtt/shard-core/test-env'
import {
  anyOf,
  NetRole,
  netSession,
  ownerInterest,
  Replicated,
  replicate,
} from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import {
  CellBound,
  cellParams,
  Dynamic,
  definePartition,
  dormantEntities,
  moveDormant,
  PartitionInstance,
  partitionPlugin,
  partitionSettled,
  StreamingBudget,
  StreamingSource,
} from '@aethervtt/shard-partition'
import { partitionNet, partitionNetPlugin, streamInterest } from '@aethervtt/shard-partition/net'
import { defineGenerator } from '@aethervtt/shard-procgen'
import { App, definePlugin, type Plugin } from '@aethervtt/shard-runtime'
import { ScenePlugin } from '@aethervtt/shard-scene'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import { CharacterTier } from '../components'
import { characterLooks } from '../looks'
import { charactersPlugin } from '../plugin'
import type { CharacterRig } from '../rig'
import { CharacterStates } from '../spawn'
import { hordeClientStats, hordeProxyOf } from './client'
import { HordeCell, HordeMember, HordeMembers } from './components'
import { hordeInterest } from './interest'
import { hordeReplicate, hordesPlugin } from './plugin'
import { HordeServer, hordeServerStats, hordesSystem } from './server'

const FULL = timingMode === 'bench'

/** Open ground: one marker entity per cell, so streaming has something to load. */
const Field = defineGenerator('test/HordeField', {
  params: cellParams(['full', 'far']),
  output: 'entities',
  deterministicMath: true,
  run: (_ctx, p) => [
    {
      name: 'ground',
      components: { 'core/Transform': { translation: [p.x * 64 + 32, 0, p.z * 64 + 32] } },
    },
  ],
})

// 0113's numbers: 64 m cells, full to 96 m, far to 512 m, simulate and replicate to 160 m.
const TOWN = definePartition('horde-field', {
  grids: [
    {
      name: 'field',
      cellSize: 64,
      generator: Field,
      levels: [
        { name: 'full', range: 96 },
        { name: 'far', range: 512 },
      ],
      simulate: 160,
      replicate: {
        range: 160,
        bands: [
          { within: 48, every: 1 },
          { within: 96, every: 2 },
          { within: 160, every: 4 },
        ],
      },
    },
  ],
})
const SPEED = 1.5

/**
 * A one-joint rig standing in for a real one: proxies here are tested for what they do (counts,
 * positions, hand-offs), not for how far tiers draw them (tiers.test.ts, with a GPU).
 */
function stubRig(name: string): CharacterRig {
  const pre = new Float32Array(12)
  pre[0] = pre[5] = pre[10] = 1
  const inverseBind = new Float32Array(16)
  inverseBind[0] = inverseBind[5] = inverseBind[10] = inverseBind[15] = 1
  return {
    name,
    options: { name, model: { type: 'Scene', path: 'stub' } },
    skeleton: { paths: ['root'], parents: Int16Array.of(-1), pre, inverseBind },
    jointByName: new Map([['root', 0]]),
    nodes: [],
    builds: [
      {
        name: 'base',
        morphs: new Map(),
        rest: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1),
        bake: undefined,
      },
    ],
    movesJoints: new Set(),
    radii: new Float32Array(1),
    nearScreen: 0.15,
    midScreen: 0.02,
    midRates: [0.08, 0.04],
    farScreen: 0.002,
    farDistance: 600,
    farShadows: true,
    farClips: [],
    bakeFps: 30,
    merged: null,
    minTier: new Map(),
    scene: [],
    restSphere: Float32Array.of(0, 0.9, 0, 0.9),
    clipIndex: new Map(),
  } as unknown as CharacterRig
}

function lookAll(world: World): void {
  characterLooks(world, [
    { rig: stubRig('zombie-a'), parts: [] },
    { rig: stubRig('zombie-b'), parts: [] },
  ])
}

function deterministic(world: World): void {
  const b = world.resource(StreamingBudget)
  b.commit = 'deterministic'
  b.commitDelay = 2
}

function zombie(world: World, x: number, z: number, id = 0, look = id % 2, net = true): Entity {
  return world.spawn(
    [Transform, { translation: [x, 0, z] }],
    [CellBound, {}],
    net ? [Replicated, { owner: 0 }] : Dynamic,
    [HordeMember, { id, look }],
  )
}

/** Moves members in circles around (cx, cz): radius from their start, SPEED m/s. */
function walk(world: World, members: Entity[], cx: number, cz: number, dt: number): void {
  for (const e of members) {
    if (!world.isAlive(e)) continue
    const t = world.get(e, Transform).translation
    const dx = t[0] - cx
    const dz = t[2] - cz
    const r = Math.max(1, Math.sqrt(dx * dx + dz * dz))
    const a = Math.atan2(dz, dx) + (SPEED * dt) / r
    const yaw = a + Math.PI / 2
    world.add(e, Transform, {
      translation: [cx + r * Math.cos(a), 0, cz + r * Math.sin(a)],
      rotation: [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    })
  }
}

// --- the server alone ---------------------------------------------------------------------------

async function serverApp(sources: [number, number][]): Promise<App> {
  const app = new App({ fixedHz: 60, now: () => 0 })
  const test: Plugin = definePlugin({
    name: 'test/hordes',
    build: (a) => {
      a.addSystems(Last, hordesSystem())
    },
  })
  app.addPlugin(TransformPlugin, ScenePlugin, partitionPlugin(), test)
  await app.init()
  deterministic(app.world)
  app.world.spawn([PartitionInstance, { partition: TOWN, seed: 7, secretSeed: 99 }])
  for (const [x, z] of sources)
    app.world.spawn([Transform, { translation: [x, 1, z] }], [StreamingSource, {}])
  return app
}

async function steps(apps: App[], n: number, each?: () => void): Promise<void> {
  for (let i = 0; i < n; i++) {
    each?.()
    for (const a of apps) await partitionSettled(a.world)
    for (const a of apps) a.update(1 / 60)
  }
}

function cellEntity(world: World, x: number, z: number): Entity | undefined {
  for (const t of world.query({ with: [HordeCell] }).tables) {
    for (let r = 0; r < t.count; r++) {
      if (t.column(HordeCell, 'x')[r] === x && t.column(HordeCell, 'z')[r] === z)
        return t.entities[r]!
    }
  }
  return undefined
}

describe('characters/hordes on the server (0115)', () => {
  it('writes ids and looks only when membership changes; dormant cells only when their delta does', {
    timeout: timeout(60_000),
  }, async () => {
    const app = await serverApp([[32, 32]])
    const w = app.world
    await steps([app], 10)
    const live: Entity[] = []
    for (let i = 0; i < 20; i++)
      live.push(zombie(w, 20 + (i % 5) * 4, 20 + Math.floor(i / 5) * 4, 1 + i, 0, false))
    await steps([app], 40, () => walk(w, live, 30, 30, 1 / 60))
    const cell = cellEntity(w, 0, 0)!
    expect(cell).toBeDefined()
    expect(w.get(cell, HordeCell).ids).toEqual(Array.from({ length: 20 }, (_, i) => 1 + i))
    const stats = hordeServerStats(w)!
    const membership = stats.membershipWrites
    const cellTick = w.entityTable(cell).changedTicks(HordeCell)[w.entityRow(cell)]
    const positions = stats.positionWrites
    // Two seconds of walking inside the cell: positions every refresh, membership never.
    await steps([app], 120, () => walk(w, live, 30, 30, 1 / 60))
    expect(stats.membershipWrites).toBe(membership)
    expect(w.entityTable(cell).changedTicks(HordeCell)[w.entityRow(cell)]).toBe(cellTick)
    expect(stats.positionWrites - positions).toBeGreaterThanOrEqual(3)
    // One leaves: the next refresh rewrites ids and looks.
    w.despawn(live.pop()!)
    await steps([app], 31, () => walk(w, live, 30, 30, 1 / 60))
    expect(stats.membershipWrites).toBe(membership + 1)
    expect(w.get(cell, HordeCell).ids).toHaveLength(19)
    expect(w.get(cell, HordeMembers).rev).toBe(w.get(cell, HordeCell).rev)

    // A dormant group 400 m away (drawn at far, not simulated): read once, not again until it moves.
    for (let i = 0; i < 30; i++) zombie(w, 10 + i, 400, 100 + i, 1, false)
    await steps([app], 40)
    expect(dormantEntities(w, TOWN, 0, 0, 6)).toHaveLength(30)
    const far = cellEntity(w, 0, 6)!
    expect(w.get(far, HordeCell).ids).toHaveLength(30)
    const reads = stats.dormantReads
    const farTick = w.entityTable(far).changedTicks(HordeMembers)[w.entityRow(far)]
    await steps([app], 90)
    expect(stats.dormantReads).toBe(reads)
    expect(w.entityTable(far).changedTicks(HordeMembers)[w.entityRow(far)]).toBe(farTick)
    // moveDormant bumps both cells' dormant revs: both are re-read and rewritten.
    // (A cell new to the system is found at the next period's start, then refreshed in its slot.)
    moveDormant(w, TOWN, 0, { x: 0, z: 6 }, { x: 1, z: 6 }, 0)
    await steps([app], 61)
    expect(stats.dormantReads).toBe(reads + 2)
    expect(w.get(far, HordeCell).ids).toHaveLength(29)
    expect(w.get(cellEntity(w, 1, 6)!, HordeCell).ids).toEqual([100])
    // Past 1.25 × the far range of every source: the cell entity goes.
    w.despawn(w.query({ with: [StreamingSource] }).tables.find((t) => t.count > 0)!.entities[0]!)
    w.spawn([Transform, { translation: [5000, 1, 5000] }], [StreamingSource, {}])
    await steps([app], 40)
    expect(cellEntity(w, 0, 6)).toBeUndefined()
    await app.dispose()
  })

  it('stays within budget with 2,000 members (500 live, 1,500 dormant) near two players', {
    timeout: timeout(120_000),
  }, async () => {
    const app = await serverApp([
      [32, 32],
      [332, 32],
    ])
    const w = app.world
    await steps([app], 10)
    const live: Entity[] = []
    const dormant = FULL ? 1500 : 300
    const liveCount = FULL ? 500 : 100
    let id = 1
    for (let i = 0; i < liveCount; i++) {
      const a = (i / liveCount) * Math.PI * 2
      live.push(
        zombie(
          w,
          332 + Math.cos(a) * (4 + (i % 30)),
          32 + Math.sin(a) * (4 + (i % 30)),
          id++,
          0,
          false,
        ),
      )
    }
    // Dormant groups in six unloaded cells, 300–450 m out.
    for (let i = 0; i < dormant; i++) {
      const c = i % 6
      zombie(w, c * 64 + 5 + (i % 50), 400 + (Math.floor(i / 50) % 40), id++, 1, false)
    }
    await steps([app], 60, () => walk(w, live, 332, 32, 1 / 60))
    const s = w.resource(HordeServer)
    // A member crossing between two cells' slots can be listed in both for a period.
    expect(s.stats.members).toBeGreaterThanOrEqual(liveCount + dormant)
    expect(s.stats.members).toBeLessThanOrEqual(liveCount + dormant + 10)
    const frames = FULL ? 600 : 60
    let total = 0
    await steps([app], frames, () => {
      walk(w, live, 332, 32, 1 / 60)
      total += s.stats.ms
    })
    // stats.ms is the last run's: summed after each frame's update above, one frame behind.
    const mean = total / frames
    if (process.env.DEBUG_HORDES)
      console.log(`characters/hordes: ${mean.toFixed(4)} ms mean per tick`)
    if (timingMode === 'bench') expect(mean).toBeLessThanOrEqual(budget('characters/hordes'))
    await app.dispose()
  })
})

// --- two peers ----------------------------------------------------------------------------------

let h: NetHarness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

/**
 * B (peer 1) at 320,32 in the live horde, on a cell edge (members keep crossing it); A (peer 2)
 * joins later at 8,32: 312 m from the horde, its nearest cell 248 m off (past 1.5 × 160 m).
 */
async function harness(): Promise<NetHarness> {
  const starts: [number, number][] = [
    [320, 32],
    [8, 32],
  ]
  const harness = await netHarness({
    clients: 1,
    plugins: () => [
      TransformPlugin,
      ScenePlugin,
      partitionPlugin(),
      charactersPlugin(),
      hordesPlugin(),
    ],
    server: () => [partitionNetPlugin()],
    client: () => [partitionNetPlugin()],
    net: partitionNet({
      replicate: [replicate(Transform, { mode: 'interpolate' }), ...hordeReplicate()],
    }),
    serverNet: {
      interest: anyOf(ownerInterest(), streamInterest(), hordeInterest()),
      players: {
        spawn(world, { peer }) {
          const [x, z] = starts[(peer - 1) % starts.length]!
          world.spawn(
            [Transform, { translation: [x, 1, z] }],
            [StreamingSource, {}],
            [Replicated, { owner: peer }],
          )
        },
      },
    },
    afterInit: async (app) => {
      deterministic(app.world)
      lookAll(app.world)
    },
  })
  harness.server.world.spawn([PartitionInstance, { partition: TOWN, seed: 7, secretSeed: 99 }])
  await harness.connect()
  return harness
}

async function tick(harness: NetHarness, each?: () => void): Promise<void> {
  each?.()
  await Promise.all([harness.server, ...harness.clients].map((a) => partitionSettled(a.world)))
  harness.step(1)
}

function playerOf(world: World, peer: number): Entity {
  for (const t of world.query({ with: [StreamingSource, Replicated] }).tables) {
    for (let r = 0; r < t.count; r++)
      if (t.column(Replicated, 'owner')[r] === peer) return t.entities[r]!
  }
  throw new Error(`no player for ${peer}`)
}

/** The client's live members by id. */
function liveOn(world: World): Map<number, Entity> {
  const out = new Map<number, Entity>()
  for (const t of world.query({ with: [HordeMember, Transform] }).tables) {
    for (let r = 0; r < t.count; r++) out.set(t.column(HordeMember, 'id')[r]!, t.entities[r]!)
  }
  return out
}

/** Where the client draws member `id`: its live entity, or its proxy. Counts both, to check once. */
function drawn(
  world: World,
  live: Map<number, Entity>,
  id: number,
): { at: number[]; count: number } {
  const e = live.get(id)
  const p = hordeProxyOf(world, id)
  const count = (e === undefined ? 0 : 1) + (p ? 1 : 0)
  if (e !== undefined) return { at: [...world.get(e, Transform).translation], count }
  return { at: p ? [p.at[0]!, p.at[1]!, p.at[2]!] : [], count }
}

function bytesOf(world: World, peer: number): number {
  const by = netSession(world).server!.peers.get(peer)!.stats.bytesByComponent
  return (by['characters/HordeCell'] ?? 0) + (by['characters/HordeMembers'] ?? 0)
}

describe('a far horde shows (0115)', () => {
  it('draws live and dormant members past replication on a joining client, and hands them off exactly once', {
    timeout: timeout(FULL ? 600_000 : 240_000),
  }, async () => {
    h = await harness()
    const server = h.server.world
    for (let i = 0; i < 40; i++) await tick(h)
    const liveCount = FULL ? 300 : 60
    const dormantCount = FULL ? 200 : 40
    const live: Entity[] = []
    for (let i = 0; i < liveCount; i++) {
      const a = (i / liveCount) * Math.PI * 2
      const r = 4 + (i % 16)
      live.push(zombie(server, 320 + Math.cos(a) * r, 32 + Math.sin(a) * r))
    }
    for (let i = 0; i < dormantCount; i++)
      zombie(server, 6 + (i % 50), 418 + Math.floor(i / 50) * 4)
    const move = () => walk(server, live, 320, 32, 1 / 60)
    for (let i = 0; i < 10; i++) await tick(h, move)
    expect(dormantEntities(server, TOWN, 0, 0, 6)).toHaveLength(dormantCount)
    const ids = [...live.map((e) => server.get(e, HordeMember).id)]
    const dormantIds = dormantEntities(server, TOWN, 0, 0, 6).map(
      (d) => (d.components['characters/HordeMember'] as { id: number }).id,
    )
    const all = [...ids, ...dormantIds]
    expect(new Set(all).size).toBe(liveCount + dormantCount)

    // A joins, 312 m from the live horde and about 400 m from the dormant one.
    const appA = await h.addClient()
    const A = appA.world
    let ticks = 0
    while (!A.resource(NetRole).connected) {
      await tick(h, move)
      ticks++
      expect(ticks).toBeLessThan(600)
    }
    const peerA = A.resource(NetRole).peer
    let shownAt = -1
    for (let i = 0; i < 120; i++) {
      await tick(h, move)
      if (shownAt < 0 && (hordeClientStats(A)?.proxies ?? 0) === all.length) shownAt = i + 1
    }
    expect(shownAt).toBeGreaterThan(0)
    expect(hordeClientStats(A)!.proxies).toBe(all.length)
    // Each within 0.5 m plus 2 s of travel of where the server has it.
    const serverAt = new Map<number, number[]>()
    for (const e of live)
      serverAt.set(server.get(e, HordeMember).id, [...server.get(e, Transform).translation])
    for (const d of dormantEntities(server, TOWN, 0, 0, 6)) {
      const m = d.components['characters/HordeMember'] as { id: number }
      serverAt.set(m.id, (d.components['core/Transform'] as { translation: number[] }).translation)
    }
    let worst = 0
    for (const id of all) {
      const p = hordeProxyOf(A, id)!
      const s = serverAt.get(id)!
      worst = Math.max(worst, Math.hypot(p.at[0]! - s[0]!, p.at[2]! - s[2]!))
    }
    expect(worst).toBeLessThanOrEqual(0.5 + 2 * SPEED)
    // Proxies are far-tier stand-ins: tagged, never near, no rig.
    const proxy = hordeProxyOf(A, all[0]!)!.entity
    expect(A.resource(CharacterStates).get(proxy)!.rigInstance).toBeNull()
    expect(A.get(proxy, CharacterTier).tier).not.toBe('near')

    // Traffic past range, steady state, per peer. Dormant members cost nothing once sent, so the
    // bytes are put on the moving members alone, then scaled to 2,000 of them.
    const bytes0 = bytesOf(server, peerA)
    const window = 6 * 60
    for (let i = 0; i < window; i++) await tick(h, move)
    const rate = ((bytesOf(server, peerA) - bytes0) / (window / 60)) * (2000 / liveCount)

    // Walk A to 50 m from the horde's centre at 30 m/s: every member drawn exactly once, every
    // frame, and nothing drawn moves more than 0.5 m in a frame.
    const player = playerOf(server, peerA)
    const last = new Map<number, number[]>()
    let jump = 0
    let twice = 0
    let missing = 0
    const check = () => {
      const liveA = liveOn(A)
      for (const id of all) {
        const d = drawn(A, liveA, id)
        if (d.count > 1) twice++
        if (d.count === 0) {
          missing++
          last.delete(id)
          continue
        }
        const before = last.get(id)
        if (before)
          jump = Math.max(
            jump,
            Math.hypot(d.at[0]! - before[0]!, d.at[1]! - before[1]!, d.at[2]! - before[2]!),
          )
        last.set(id, d.at)
      }
    }
    let x = 8
    while (x < 270) {
      x = Math.min(270, x + 0.5)
      const at = x
      await tick(h, () => {
        move()
        server.add(player, Transform, { translation: [at, 1, 32] })
      })
      check()
    }
    for (let i = 0; i < 120; i++) {
      await tick(h, move)
      check()
    }
    const stats = hordeClientStats(A)!
    expect(stats.handoffs).toBeGreaterThanOrEqual(liveCount * 0.9)
    expect(stats.live).toBe(liveCount)
    // And back out past replication: live ones leave interest, their proxies resume.
    while (x > 70) {
      x -= 0.5
      const at = x
      await tick(h, () => {
        move()
        server.add(player, Transform, { translation: [at, 1, 32] })
      })
      check()
    }
    for (let i = 0; i < 180; i++) {
      await tick(h, move)
      check()
    }
    if (process.env.DEBUG_HORDES) {
      console.log(
        `shown after ${shownAt} ticks; worst proxy error ${worst.toFixed(3)} m; ${(rate / 1024).toFixed(2)} KB/s per peer for 2,000; worst frame move ${jump.toFixed(3)} m; handoffs ${stats.handoffs}, resumed ${hordeClientStats(A)!.resumed}; twice ${twice}, missing ${missing}`,
      )
    }
    expect(twice).toBe(0)
    expect(missing).toBe(0)
    expect(jump).toBeLessThanOrEqual(0.5)
    expect(hordeClientStats(A)!.resumed).toBeGreaterThanOrEqual(liveCount * 0.9)
    expect(hordeClientStats(A)!.proxies).toBe(all.length)
    // Under 6 KB/s for 2,000 (bench, full size). Scaled up from 60 members, per-cell overhead
    // weighs more: a looser bound.
    expect(rate).toBeLessThan((FULL ? 6 : 8) * 1024)
  })
})
