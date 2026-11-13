import type { Entity, World } from '@aethervtt/shard-core'
import {
  anyOf,
  NetRole,
  netSession,
  ownerInterest,
  Replicated,
  replicate,
  sendCommand,
} from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { type App, LogResource } from '@aethervtt/shard-runtime'
import { InstancePart } from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import { cellOf, configureCommits, loadedCells, spawnTown, townPlugins } from './fixtures/apps'
import { Contents, defineTown } from './fixtures/town'
import {
  CellBound,
  cellDistance,
  cellKey,
  PartitionInstance,
  partitionSettled,
  StreamingSource,
} from './index'
import {
  CellsCommand,
  divergences,
  generatorMismatch,
  type PartitionNetOptions,
  partitionNet,
  partitionNetPlugin,
  reportedCells,
  streamInterest,
} from './net'

// A 64 m full ring: cell 2,0 (96 m from the start) is far on a client and simulated on the server.
const TOWN = defineTown({
  name: 'net-town',
  props: 2,
  levels: [
    { name: 'full', range: 64 },
    { name: 'far', range: 512 },
  ],
})

let h: NetHarness | undefined
afterEach(async () => {
  await h?.dispose()
  h = undefined
})

/** Peers the game has revealed each crate to (opened, in reach). */
const revealed = new Map<Entity, Set<number>>()

interface Setup {
  clients?: number
  starts?: [number, number][]
  client?: PartitionNetOptions
}

async function setup(options: Setup = {}): Promise<NetHarness> {
  revealed.clear()
  const starts = options.starts ?? [
    [32, 32],
    [1032, 32],
  ]
  const harness = await netHarness({
    clients: options.clients ?? 2,
    plugins: () => townPlugins(),
    server: () => [partitionNetPlugin()],
    client: () => [partitionNetPlugin(options.client)],
    net: partitionNet({
      replicate: [
        replicate(Transform, { mode: 'interpolate' }),
        replicate(Contents, { visibleTo: (_w, peer, e) => revealed.get(e)?.has(peer) ?? false }),
      ],
    }),
    serverNet: {
      interest: anyOf(ownerInterest(), streamInterest()),
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
  })
  for (const app of [harness.server, ...harness.clients]) configureCommits(app.world, {})
  spawnTown(harness.server.world, TOWN, 7, 4242)
  await harness.connect()
  return harness
}

async function run(harness: NetHarness, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) {
    await Promise.all([harness.server, ...harness.clients].map((a) => partitionSettled(a.world)))
    harness.step(1)
  }
}

function peerOf(app: App): number {
  return app.world.resource(NetRole).peer
}

/** The server's per-peer state (what the peer has). */
function knownBy(world: World, peer: number): Entity[] {
  const p = netSession(world).server!.peers.get(peer)!
  return [...p.known.values()].map((k) => k.entity)
}

function playerOf(world: World, peer: number): Entity {
  const q = world.query({ with: [StreamingSource, Replicated] })
  for (const t of q.tables) {
    for (let r = 0; r < t.count; r++) {
      if (t.column(Replicated, 'owner')[r] === peer) return t.entities[r]!
    }
  }
  throw new Error(`no player for ${peer}`)
}

function zombie(world: World, x: number, z: number): Entity {
  return world.spawn(
    [Transform, { translation: [x, 0, z] }],
    [CellBound, {}],
    [Replicated, { owner: 0 }],
  )
}

describe('server-driven streaming', () => {
  it('loads both players’ cells on the server, and each peer only gets its own cells’ entities', async () => {
    h = await setup()
    const server = h.server.world
    await run(h, 20)
    const zombies = [zombie(server, 40, 40), zombie(server, 1040, 40)]
    const leaks: string[] = []
    for (let tick = 0; tick < 90; tick++) {
      await run(h, 1)
      h.clients.forEach((app, i) => {
        const peer = peerOf(app)
        const cells = reportedCells(server, peer)
        for (const e of knownBy(server, peer)) {
          const owner = server.get(e, Replicated).owner
          if (owner === peer) continue
          const t = server.get(e, Transform).translation
          const key = cellKey(0, Math.floor(t[0] / 64), Math.floor(t[2] / 64))
          if (!cells.has(key)) leaks.push(`client ${i} got ${e} in ${key}`)
        }
      })
    }
    expect(leaks).toEqual([])
    const cells = loadedCells(server)
    expect(cells['0:0,0']).toBe('full')
    expect(cells['0:16,0']).toBe('full')
    // Each peer has its own zombie and not the other's, nor the other player.
    const [a, b] = h.clients.map(peerOf) as [number, number]
    expect(knownBy(server, a)).toContain(zombies[0])
    expect(knownBy(server, a)).not.toContain(zombies[1])
    expect(knownBy(server, a)).not.toContain(playerOf(server, b))
    expect(knownBy(server, b)).toContain(zombies[1])
    expect(knownBy(server, b)).not.toContain(zombies[0])
    // Clients draw further than the server simulates: far cells around their own player only.
    const client = loadedCells(h.clients[0]!.world)
    expect(client['0:0,0']).toBe('full')
    expect(client['0:6,0']).toBe('far')
    expect(client['0:16,0']).toBeUndefined()
    // describe reports each peer's cells.
    const described = (await import('./methods')).partitionMethods
      .find((m) => m.name === 'partition.describe')!
      .handler({ world: server } as never, {} as never) as { peers: { reported: number }[] }
    expect(described.peers).toHaveLength(2)
    for (const p of described.peers) expect(p.reported).toBeGreaterThan(0)
    // No generated entity ever reached a client, except bound crates (secrets only).
    for (const app of h.clients) {
      for (const e of knownBy(server, peerOf(app))) {
        if (server.has(e, InstancePart)) expect(server.get(e, Replicated).bound).toBe(true)
      }
    }
  })

  it('replicates a zombie outside the full ring at its band’s lower rate', async () => {
    h = await setup({ clients: 1 })
    const server = h.server.world
    await run(h, 20)
    // 130 m east: past the client's full ring (96 m), inside replication (160 m), band every 4.
    const far = zombie(server, 162, 32)
    const near = zombie(server, 52, 32)
    await run(h, 30)
    const peer = peerOf(h.clients[0]!)
    expect(loadedCells(h.clients[0]!.world)['0:2,0']).toBe('far')
    const relevant = netSession(server).server!.peers.get(peer)!.relevant
    expect(relevant.everyOf(far)).toBe(4)
    expect(relevant.everyOf(near)).toBe(1)
    const local = h.clientEntity(0, far)
    expect(local).toBeDefined()
    const client = netSession(h.clients[0]!.world).client!
    expect(client.everyOf(server.get(far, (await import('@aethervtt/shard-net')).NetId).id)).toBe(4)
    // It moves every tick; the client's copy moves on (nearly) every frame between samples.
    let still = 0
    let last = h.clients[0]!.world.get(local!, Transform).translation[2]
    for (let i = 0; i < 60; i++) {
      const t = server.get(far, Transform).translation
      server.add(far, Transform, { translation: [t[0], t[1], t[2] + 0.1] })
      await run(h, 1)
      const now = h.clients[0]!.world.get(local!, Transform).translation[2]
      if (i > 20 && now === last) still++
      last = now
    }
    expect(still).toBeLessThanOrEqual(2)
  })

  it('keeps container contents server-side until the game reveals them', async () => {
    h = await setup({ clients: 1 })
    const server = h.server.world
    await run(h, 20)
    const serverCell = cellOf(server, '0:0,0')!
    const crate = serverCell.entities.get('b0/crate')!
    expect(server.get(crate, Contents).items.length).toBeGreaterThan(0)
    const client = h.clients[0]!.world
    const contents = () => {
      let n = 0
      for (const t of client.query({ with: [Contents] }).tables) n += t.count
      return n
    }
    expect(contents()).toBe(0)
    // Emptying it is a change, but not one a client hears about.
    server.add(crate, Contents, { items: [] })
    await run(h, 10)
    expect(contents()).toBe(0)
    const clientCrate = cellOf(client, '0:0,0')!.entities.get('b0/crate')!
    // Revealed: it arrives on the client's own crate entity.
    server.add(crate, Contents, { items: ['axe'] })
    revealed.set(crate, new Set([peerOf(h.clients[0]!)]))
    await run(h, 10)
    expect(client.get(clientCrate, Contents).items).toEqual(['axe'])
    revealed.clear()
    server.add(crate, Contents, { items: ['axe', 'nails'] })
    await run(h, 10)
    expect(client.has(clientCrate, Contents)).toBe(false)
    expect(client.isAlive(clientCrate)).toBe(true)
  })

  it('sends deltas to clients, and far-level cells show visible changes', async () => {
    h = await setup({ clients: 1 })
    const server = h.server.world
    await run(h, 20)
    const client = h.clients[0]!.world
    // Cell 2,0 is far on the client and simulated on the server.
    expect(loadedCells(client)['0:2,0']).toBe('far')
    const wall = cellOf(server, '0:2,0')!.entities.get('b0/n')!
    expect(cellOf(client, '0:2,0')!.entities.has('b0/n')).toBe(true)
    server.despawn(wall)
    const door = cellOf(server, '0:0,0')!.entities.get('b1/door')!
    server.add(door, (await import('./fixtures/town')).Door, { open: true })
    await run(h, 10)
    expect(cellOf(client, '0:2,0')!.entities.has('b0/n')).toBe(false)
    const clientDoor = cellOf(client, '0:0,0')!.entities.get('b1/door')!
    expect(client.get(clientDoor, (await import('./fixtures/town')).Door).open).toBe(true)
  })

  it('reports a generated entity given net/Replicated', async () => {
    h = await setup({ clients: 1 })
    const server = h.server.world
    await run(h, 20)
    const codes: string[] = []
    server.resource(LogResource).subscribe((e) => {
      if (e.code) codes.push(e.code)
    })
    server.add(cellOf(server, '0:0,0')!.entities.get('b0/door')!, Replicated, {})
    expect(codes).toContain('partition/generated-replicated')
  })

  it('refuses a client whose generators differ', async () => {
    h = await setup({
      clients: 1,
      client: { generators: (name) => ({ version: 1, codeHash: `other:${name}` }) },
    })
    await run(h, 10)
    expect(generatorMismatch(h.clients[0]!.world)?.code).toBe('partition/generator-mismatch')
    const q = h.clients[0]!.world.query({ with: [PartitionInstance] })
    expect(q.tables.reduce((n, t) => n + t.count, 0)).toBe(0)
  })

  it('logs a diverged cell and keeps the session', async () => {
    h = await setup({ clients: 1 })
    await run(h, 20)
    const app = h.clients[0]!
    sendCommand(app.world, CellsCommand, {
      add: [[0, 1, 1, 0, 'not-the-hash', 'test']],
      update: [],
      remove: [],
      loaded: [],
    })
    await run(h, 20)
    // The server hashes its own copy off the frame (crypto.subtle): give it a moment.
    await new Promise((r) => setTimeout(r, 50))
    expect(divergences(h.server.world)).toContainEqual({
      peer: peerOf(app),
      cell: cellKey(0, 1, 1),
      level: 0,
    })
    expect(app.world.resource(NetRole).connected).toBe(true)
  })

  it('streams a client around its player, not a camera flying away', async () => {
    h = await setup({ clients: 1 })
    await run(h, 20)
    const client = h.clients[0]!.world
    // A free camera with a source of its own, 1 km off: not this peer's, so it doesn't count.
    client.spawn([Transform, { translation: [1032, 50, 32] }], [StreamingSource, {}])
    await run(h, 60)
    for (const key of Object.keys(loadedCells(client))) {
      const [x, z] = key.slice(2).split(',').map(Number) as [number, number]
      expect(cellDistance(64, x, z, 32, 32)).toBeLessThanOrEqual(512 * 1.2)
    }
    const ns = netSession(h.server.world).server!
    expect(ns.recentCommands.filter((c) => c.status === 'rejected')).toEqual([])
  })
})
