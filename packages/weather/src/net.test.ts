import { NetClock } from '@aethervtt/shard-net'
import { type NetHarness, netHarness } from '@aethervtt/shard-net/testing'
import type { App } from '@aethervtt/shard-runtime'
import { definePlugin, FixedTime } from '@aethervtt/shard-runtime'
import { CloudMotion, Clouds, Sky, skyPlugin, TimeOfDay } from '@aethervtt/shard-sky'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { afterEach, describe, expect, it } from 'vitest'
import { CH, Weather, WeatherState } from './components'
import { weatherPlugin } from './plugin'

// The sky (0130, 0131) and weather (0133) on multiplayer clients: each draws its own, on the
// server's tick, and the server has none (as in a game whose server doesn't draw).

let net: NetHarness | undefined
afterEach(async () => {
  await net?.dispose()
  net = undefined
})

/** The sky and weather simulate without drawing: a stand-in for the renderer they draw with. */
const noRenderer = () => definePlugin({ name: 'render/forward', build() {} })

/** Each client's sky: weather from a random climate that changes every 2 s of real time. */
const skyScene = () =>
  definePlugin({
    name: 'test/sky-scene',
    build() {},
    ready(app) {
      app.world.spawn(
        [Sky, {}],
        [Clouds, {}],
        [Weather, { source: 'random', changeEvery: 0.02, transition: 1.5, seed: 4 }],
      )
    },
  })

/** What a player sees of the sky: the time, the clouds' offset, and the weather channels. */
function sky(app: App) {
  const world = app.world
  const c = world.resource(TimeOfDay)
  const m = world.resource(CloudMotion)
  const ch = world.resource(WeatherState).channels
  return {
    tick: world.resource(NetClock).serverTick,
    hours: c.day * 24 + c.hours,
    x: m.offset[0]!,
    z: m.offset[1]!,
    coverage: ch[CH.cloudCoverage]!,
    wind: ch[CH.wind]!,
    rain: ch[CH.rain]!,
  }
}

describe('the sky on multiplayer clients (0130, 0131, 0133)', () => {
  it('shows two clients who joined 12 s apart the same time, clouds and weather', async () => {
    net = await netHarness({
      clients: 1,
      plugins: () => [TransformPlugin],
      client: () => [noRenderer(), skyPlugin, weatherPlugin, skyScene()],
    })
    await net.connect()
    const world = net.server.world
    while (world.resource(FixedTime).tick < 720) await net.run(10)
    await net.addClient()
    await net.connect()
    const [a, b] = net.clients as [App, App]
    const step = world.resource(FixedTime).step
    let compared = 0
    let changed = 0
    let last = Number.NaN
    while (world.resource(FixedTime).tick < 1500) {
      await net.run(1)
      const sa = sky(a)
      const sb = sky(b)
      // Their estimates of the server's tick agree within one, and so does what they show.
      const ticks = Math.abs(sa.tick - sb.tick)
      expect(ticks).toBeLessThan(1)
      const slack = ticks + 1e-6
      // A day of 12 h passes in 1200 s; clouds move at most 42 m/s (3 × 14 m/s of wind).
      expect(Math.abs(sa.hours - sb.hours)).toBeLessThan((12 / 1200) * step * slack + 1e-9)
      expect(Math.abs(sa.x - sb.x)).toBeLessThan(42 * step * slack + 1e-6)
      expect(Math.abs(sa.z - sb.z)).toBeLessThan(42 * step * slack + 1e-6)
      // A change takes 1.5 s: a channel moves at most 1.5 / 90 a tick.
      for (const k of ['coverage', 'wind', 'rain'] as const) {
        expect(Math.abs(sa[k] - sb[k]), k).toBeLessThan((1.5 / 90) * slack + 1e-5)
      }
      if (sa.coverage !== last) changed++
      last = sa.coverage
      compared++
    }
    expect(compared).toBeGreaterThan(700)
    // The weather changed while they watched, and the clouds had moved.
    expect(changed).toBeGreaterThan(30)
    expect(Math.hypot(sky(a).x, sky(a).z)).toBeGreaterThan(100)
  }, 60_000)
})
