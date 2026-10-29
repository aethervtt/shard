import { fileURLToPath } from 'node:url'
import { NetRole, Replicated, sendCommand } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { type HeadlessCode, loadHeadlessCode } from '@aethervtt/shard-node'
import { projectNet } from '@aethervtt/shard-project'
import { Transform } from '@aethervtt/shard-transform'
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { BOT_SECONDS, botDirection, Coin, Move, Player, playerOf, Score } from '../scripts/main'

const root = fileURLToPath(new URL('..', import.meta.url))
let code: HeadlessCode
let net: NetHarness | undefined

beforeAll(async () => {
  code = await loadHeadlessCode({ root, code: 'source' })
})
afterAll(() => code.close())
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

/** A server and `clients` headless clients built from the project, as `shard run --net` does. */
function session(clients: number, conditions = {}) {
  return netHarness({
    clients,
    net: projectNet(code.project)!,
    createApp: () => code.build(),
    afterInit: (app) => code.prepare(app),
    conditions,
  })
}

it('spawns a player per client and keeps ten coins, the same on every client', async () => {
  net = await session(2, { latency: 0.05, jitter: 0.01, loss: 0.05, seed: 3 })
  await net.connect()
  await net.run(30)
  const world = net.server.world
  expect(world.query({ with: [Player] }).tables.reduce((n, t) => n + t.count, 0)).toBe(2)
  expect(world.query({ with: [Coin] }).tables.reduce((n, t) => n + t.count, 0)).toBe(10)
  // The bots stop after BOT_SECONDS; a second later every client matches the server.
  await net.run(60 * (BOT_SECONDS + 1))
  expect(net.differences(Transform, Player, Score, Coin)).toEqual([])
})

it('moves a player with Move commands until it collects a coin, and every client sees the score', async () => {
  net = await session(2)
  await net.connect()
  await net.run(10)
  const world = net.server.world
  const client = net.clients[0]!.world
  const peer = client.resource(NetRole).peer
  const mine = playerOf(world, peer)!
  // Steer from what this client sees: toward its nearest replicated coin.
  for (let i = 0; i < 600 && world.get(mine, Score).points === 0; i += 6) {
    sendCommand(client, Move, { direction: botDirection(client) })
    await net.run(6)
  }
  expect(world.get(mine, Score).points).toBeGreaterThan(0)
  expect(world.get(mine, Replicated).owner).toBe(peer)
  await net.run(60 * BOT_SECONDS)
  expect(net.differences(Score)).toEqual([])
})

it('bots collect coins in a headless run', async () => {
  net = await session(3)
  await net.connect()
  await net.run(60 * BOT_SECONDS)
  let total = 0
  for (const table of net.server.world.query({ with: [Score] }).tables) {
    for (let row = 0; row < table.count; row++) total += table.column(Score, 'points')[row]!
  }
  expect(total).toBeGreaterThan(3)
  await net.run(60)
  expect(net.differences(Score, Player)).toEqual([])
})
