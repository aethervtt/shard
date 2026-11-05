import { defineSystem, PostUpdate, type World } from '@aethervtt/shard-core'
import { replicate } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import { definePlugin, FixedTime } from '@aethervtt/shard-runtime'
import { Transform, TransformPlugin } from '@aethervtt/shard-transform'
import { scheduleWind, WindState } from '@aethervtt/shard-wind'
import { afterEach, describe, expect, it } from 'vitest'
import { WaterBody } from '../components'
import { waterOptics } from '../optics'
import { waterPlugin } from '../plugin'
import { waterAt, waterSample } from '../query'
import { oceanWavesPlugin } from './plugin'
import { updateWaves, waveTick } from './sea'
import { OceanWaves } from './spectrum'

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

const POINTS = [
  [12, 0, -30],
  [-140, 0, 75],
  [300, 0, 410],
]

/** Each machine's own ocean (the same values everywhere), and waterAt at three points a tick. */
function seaAndRecorder(samples: Map<number, number[]>) {
  const sample = waterSample()
  return definePlugin({
    name: 'test/sea-recorder',
    build(app) {
      app.addSystems(
        PostUpdate,
        defineSystem({
          name: 'test/record-sea',
          run: (_, world: World) => {
            const row: number[] = []
            for (const p of POINTS) {
              waterAt(world, p, sample)
              row.push(sample.surfaceHeight, sample.normal[0], sample.normal[2])
            }
            samples.set(waveTick(world), row)
          },
        }).after(updateWaves),
      )
    },
    ready(app) {
      app.world.spawn(
        [WaterBody, { kind: 'ocean', optics: waterOptics('ocean') }],
        [OceanWaves, { seed: 9, fetch: 120, resolution: 128 }],
        Transform,
      )
    },
  })
}

describe('ocean waves across multiplayer clients (0098)', () => {
  it('two clients report the same waterAt as the server at every tick, through a wind change', async () => {
    const records: Map<number, number[]>[] = []
    net = await netHarness({
      clients: 2,
      plugins: () => {
        const samples = new Map<number, number[]>()
        records.push(samples)
        return [TransformPlugin, waterPlugin(), oceanWavesPlugin(), seaAndRecorder(samples)]
      },
      net: { replicate: [replicate(WindState, { channel: 'reliable' })] },
      conditions: { latency: 0.05, jitter: 0.01, loss: 0.05 },
    })
    await net.connect()
    const [server, ...clients] = records as [Map<number, number[]>, ...Map<number, number[]>[]]
    const world = net.server.world
    while (world.resource(FixedTime).tick < 500) await net.run(10)
    // A gale from tick 600: every machine starts the 120-tick crossfade there.
    scheduleWind(world, { speed: 18 }, 600)
    while (world.resource(FixedTime).tick < 800) await net.run(10)
    let compared = 0
    let moved = 0
    for (let tick = 560; tick <= 780; tick++) {
      const s = server.get(tick)
      if (!s) continue
      if (tick > 560 && server.get(tick - 1) && s[0] !== server.get(tick - 1)![0]) moved++
      for (const c of clients) {
        const v = c.get(tick)
        if (!v) continue
        expect(v, `tick ${tick}`).toEqual(s)
        compared++
      }
    }
    expect(moved).toBeGreaterThan(150)
    expect(compared).toBeGreaterThan(2 * 220 * 0.7)
  }, 90_000)
})
