import { defineSystem, PreUpdate, type World } from '@aethervtt/shard-core'
import { replicate } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { definePlugin, FixedTime } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import { windPlugin } from './plugin'
import { scheduleWind, serverTick, syncWind, WindState } from './state'
import { Wind, windAt, windSample } from './wind'

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

const POINT = [12, 2, -30]

/**
 * Records windAt at a point once per server tick, right after wind/sync applied WindState, at that
 * tick's wind-clock time: what every machine should agree on.
 */
function recorder(samples: Map<number, number[]>) {
  const sample = windSample()
  return definePlugin({
    name: 'test/wind-recorder',
    build(app) {
      app.addSystems(
        PreUpdate,
        defineSystem({
          name: 'test/record-wind',
          run: (_, world: World) => {
            const tick = serverTick(world)
            const step = world.resource(FixedTime).step
            windAt(world, POINT, sample, tick * step)
            const d = sample.direction
            samples.set(tick, [
              d[0] * sample.speed,
              d[1] * sample.speed,
              d[2] * sample.speed,
              sample.gust,
            ])
          },
        }).after(syncWind),
      )
    },
  })
}

describe('wind across multiplayer clients (0096)', () => {
  it('two clients that change wind at tick 600 report the same windAt from tick 600 on', async () => {
    const records: Map<number, number[]>[] = []
    net = await netHarness({
      clients: 2,
      plugins: () => {
        const samples = new Map<number, number[]>()
        records.push(samples)
        return [TransformPlugin, windPlugin, recorder(samples)]
      },
      net: { replicate: [replicate(WindState, { channel: 'reliable' })] },
      conditions: { latency: 0.05, jitter: 0.01, loss: 0.05 },
    })
    await net.connect()
    const [server, ...clients] = records as [Map<number, number[]>, ...Map<number, number[]>[]]
    const world = net.server.world
    while (world.resource(FixedTime).tick < 500) await net.run(10)
    // The server schedules a gale for tick 600, ahead of time, so every client has it by then.
    scheduleWind(world, { speed: 18, direction: [0, 0, 1] }, 600)
    while (world.resource(FixedTime).tick < 800) await net.run(10)

    let compared = 0
    for (let tick = 560; tick <= 780; tick++) {
      const s = server.get(tick)!
      expect(s, `server tick ${tick}`).toBeDefined()
      const speed = Math.hypot(s[0]!, s[1]!, s[2]!)
      expect(speed).toBeCloseTo(tick < 600 ? 6 : 18, 6)
      for (const c of clients) {
        // A client's estimate of the server tick can skip one now and then; compare where it has one.
        const v = c.get(tick)
        if (!v) continue
        expect(v, `tick ${tick}`).toEqual(s)
        compared++
      }
    }
    expect(compared).toBeGreaterThan(2 * 220 * 0.8)
    for (const c of net.clients) expect(c.world.resource(Wind).speed).toBe(18)
  }, 60_000)

  it('a server that writes Wind directly reaches clients a latency later', async () => {
    net = await netHarness({
      clients: 2,
      plugins: () => [TransformPlugin, windPlugin],
      net: { replicate: [replicate(WindState, { channel: 'reliable' })] },
      conditions: { latency: 0.05 },
    })
    await net.connect()
    await net.run(30)
    net.server.world.resource(Wind).speed = 2
    net.server.world.resource(Wind).gustiness = 0.6
    await net.run(30)
    for (const c of net.clients) {
      expect(c.world.resource(Wind)).toMatchObject({ speed: 2, gustiness: expect.closeTo(0.6, 6) })
    }
  }, 60_000)
})
