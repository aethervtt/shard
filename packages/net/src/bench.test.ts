import { allocationChecks, budget, gcWindow, timingMode } from '@aethervtt/shard-core/test-env'
import { FixedTime } from '@aethervtt/shard-runtime'
import { Transform } from '@aethervtt/shard-transform'
import { expect, it } from 'vitest'
import { netSession, Replicated, replicate } from '.'
import { netHarness } from './testing'
import type { NetConnection } from './transport'

function median(times: Float64Array): number {
  const sorted = [...times].sort((a, b) => a - b)
  return sorted[sorted.length >> 1]!
}

const settle = () => {
  globalThis.gc?.()
  return new Promise((r) => setTimeout(r, timingMode === 'bench' ? 200 : 0))
}

it('encodes and applies 10k changed Transforms within budget, allocating nothing', async () => {
  const net = await netHarness({
    clients: 1,
    net: { replicate: [replicate(Transform, { quantize: { translation: { step: 0.001 } } })] },
  })
  await net.connect()
  const world = net.server.world
  for (let i = 0; i < 10_000; i++) {
    world.spawn(Replicated, [
      Transform,
      { translation: [i, i * 0.5, -i], rotation: [0, 0.6, 0, 0.8] },
    ])
  }
  net.step(20)
  expect(net.converged(Transform)).toBe(true)

  // From here the server's sends go nowhere except one captured message: the bench times the
  // encoder, not the loopback's copy.
  const server = netSession(world).server!
  const peer = [...server.peers.values()][0]!
  let captured: Uint8Array | undefined
  ;(peer.connection as { send: NetConnection['send'] }).send = (channel, bytes) => {
    if (channel === 'unreliable' && !captured) captured = bytes.slice()
  }
  const fixed = world.resource(FixedTime)
  const tables = world.query({ with: [Replicated, Transform] }).tables
  const encode = () => {
    world.incrementTick()
    for (const table of tables) table.markChanged(Transform)
    fixed.tick += 2
    server.send()
  }
  for (let i = 0; i < 50; i++) encode()
  expect(captured!.length).toBeGreaterThan(10_000 * 15)

  // The timed loops only feed timing and allocation checks: `pnpm bench` runs them.
  const runs = timingMode === 'bench' ? 200 : 1
  const encodeTimes = new Float64Array(runs)
  await settle()
  let gcs = gcWindow()
  for (let i = 0; i < encodeTimes.length; i++) {
    const t0 = performance.now()
    encode()
    encodeTimes[i] = performance.now() - t0
  }
  let collections = await gcs.end()
  if (allocationChecks) expect(collections).toBe(0)
  expect(median(encodeTimes)).toBeLessThan(budget('net/encode'))

  // Apply: the client reads the captured state message, 10k updates, over and over.
  const client = netSession(net.clients[0]!.world).client!
  const inbox = (client as unknown as { inbox: { channel: string; bytes: Uint8Array }[] }).inbox
  const apply = () => {
    inbox.push({ channel: 'unreliable', bytes: captured! })
    client.receive()
  }
  for (let i = 0; i < 50; i++) apply()
  expect(net.converged(Transform)).toBe(true)
  const applyTimes = new Float64Array(runs)
  await settle()
  gcs = gcWindow()
  for (let i = 0; i < applyTimes.length; i++) {
    const t0 = performance.now()
    apply()
    applyTimes[i] = performance.now() - t0
  }
  collections = await gcs.end()
  if (allocationChecks) expect(collections).toBe(0)
  expect(median(applyTimes)).toBeLessThan(budget('net/apply'))
  await net.dispose()
})
