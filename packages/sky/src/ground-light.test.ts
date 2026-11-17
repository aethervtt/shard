import { App, definePlugin } from '@aethervtt/shard-runtime'
import { TransformPlugin } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import { SkyFrame } from './celestial'
import { setTimeOfDay } from './clock'
import { Sky } from './components'
import { skyPlugin } from './plugin'

/** The sky simulates without drawing: a stand-in for the renderer it draws with. */
const noRenderer = definePlugin({ name: 'render/forward', build() {} })

describe("the sky's light at the ground (0130)", () => {
  it('reports the sun through the air: full at noon, red and dim low, none at night', async () => {
    const app = new App().addPlugin(TransformPlugin, noRenderer, skyPlugin)
    await app.init()
    const world = app.world
    world.spawn([Sky, { sunIlluminance: 100000 }])
    const at = (hours: number) => {
      setTimeOfDay(world, hours)
      app.update(1 / 60)
      const f = world.resource(SkyFrame)
      return {
        elevation: f.celestial.sunElevation,
        lux: f.sunGround.illuminance,
        color: [...f.sunGround.color],
        moon: f.moonGround.illuminance,
      }
    }
    const noon = at(12)
    expect(noon.elevation).toBeGreaterThan(45)
    expect(noon.lux).toBeGreaterThan(70000)
    expect(noon.lux).toBeLessThan(100000)
    // Sunset's light: a few degrees up, a fraction of noon's, and red.
    let low = at(17.5)
    for (let h = 17.5; low.elevation > 4 && h < 18; h += 0.02) low = at(h)
    expect(low.elevation).toBeGreaterThan(0)
    expect(low.lux).toBeLessThan(noon.lux / 2)
    expect(low.color[0]!).toBeGreaterThan(low.color[2]! * 1.5)
    const night = at(0)
    expect(night.elevation).toBeLessThan(-10)
    expect(night.lux).toBe(0)
    expect(night.moon).toBeGreaterThanOrEqual(0)
    await app.dispose()
  })
})
