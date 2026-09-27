import { defineSystem, type Entity, quat, Update, type World } from '@shard/core'
import {
  Atmosphere,
  type AtmospherePreset,
  AtmospherePresets,
  AtmosphereSettings,
  describeAtmospheres,
} from '@shard/render'
import { definePlugin, Time } from '@shard/runtime'
import { placeInGrid, Transform } from '@shard/transform'
import { hudExtras } from './hud'
import { altitude, fly, planetDemo, startPlanet } from './terrain'

/**
 * Atmospheres (spec 0044): the #terrain planet with an atmosphere, from orbit to the ground, and a
 * moon with its own. T/G move the sun through the day (dusk turns the light and the terrain
 * orange), P cycles presets (earth, mars, thin, thick-haze, alien-violet), H toggles aerial
 * perspective. The HUD shows the primary atmosphere, the sunlight at the camera, and GPU time.
 */

const PRESETS: AtmospherePreset[] = ['earth', 'mars', 'thin', 'thick-haze', 'alien-violet']
const R = 6_371_000

interface Sky {
  sun: Entity
  /** Sun elevation above the camera's start point, degrees. */
  elevation: number
  preset: number
  keys: Set<string>
}

let sky: Sky | undefined

/** Points the sun at `elevation` degrees over the start point's horizon. */
function placeSun(world: World, s: Sky): void {
  const e = (s.elevation * Math.PI) / 180
  world.set(s.sun, Transform, {
    rotation: quat.fromEuler([0, 0, 0, 1], -e, 0.55, 0) as [number, number, number, number],
  })
}

const day = defineSystem({
  name: 'atmosphere-demo/day',
  run: (_, world) => {
    const s = sky
    if (!s) return
    const dt = world.resource(Time).delta
    const d = (s.keys.has('KeyT') ? 1 : 0) - (s.keys.has('KeyG') ? 1 : 0)
    if (d !== 0) {
      s.elevation = Math.max(-20, Math.min(90, s.elevation + d * 12 * dt))
      placeSun(world, s)
    }
  },
})

export const atmosphereDemoPlugin = definePlugin({
  name: 'atmosphere-demo',
  build(app) {
    app.addSystems(Update, fly, day)
    hudExtras.push((world) => {
      const d = planetDemo()
      const s = sky
      if (!d || !s) return []
      const view = describeAtmospheres(world)?.views[`camera:${d.camera}`] as
        | {
            primary: { altitude: number; inside: boolean } | null
            secondaries: { pixels: number | string }[]
            suns: { illuminance: number; illuminanceAtCamera: number; transmittance: number[] }[]
            aerialPerspective: boolean
          }
        | undefined
      const km = (m: number) =>
        m >= 1000
          ? `${(m / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
          : `${m.toFixed(1)} m`
      const sun = view?.suns[0]
      const t = sun?.transmittance.map((v) => v.toFixed(2)).join(' ') ?? '-'
      const p = view?.primary
      return [
        '',
        `altitude  ${km(altitude(world, d))}   ${p ? (p.inside ? 'inside' : 'outside') : 'no'} atmosphere, preset ${PRESETS[s.preset]}`,
        `sun       ${s.elevation.toFixed(1)}° at start, ${Math.round(sun?.illuminanceAtCamera ?? 0).toLocaleString()} of ${Math.round(sun?.illuminance ?? 0).toLocaleString()} lux here (T ${t})`,
        `limbs     ${view?.secondaries.length ?? 0} secondary, haze ${view?.aerialPerspective ? 'on' : 'off'}`,
        'w/s speed  a/d turn  r/f pitch  t/g sun  p preset  h haze',
      ]
    })
  },
  async ready(app) {
    const world = app.world
    const d = await startPlanet(app, true)
    world.add(d.planet, Atmosphere, AtmospherePresets.earth)
    world.add(d.camera, AtmosphereSettings, {})
    // A moon with thin air, out past the start orbit.
    const moon = world.spawn(
      [
        Atmosphere,
        {
          ...AtmospherePresets.earth,
          bottomRadius: 1_737_000,
          thickness: 120_000,
          rayleighScale: 18_000,
        },
      ],
      Transform,
    )
    placeInGrid(world, moon, d.planet, [R * 2.6, R * 2.2, R * 3.4])
    sky = { sun: d.sun, elevation: 35, preset: 0, keys: new Set() }
    placeSun(world, sky)
    window.addEventListener('keydown', (e) => {
      const s = sky
      if (!s) return
      s.keys.add(e.code)
      if (e.code === 'KeyP') {
        s.preset = (s.preset + 1) % PRESETS.length
        world.set(d.planet, Atmosphere, AtmospherePresets[PRESETS[s.preset]!])
      }
      if (e.code === 'KeyH') {
        const on = world.get(d.camera, AtmosphereSettings).aerialPerspective
        world.set(d.camera, AtmosphereSettings, { aerialPerspective: !on })
      }
    })
    window.addEventListener('keyup', (e) => sky?.keys.delete(e.code))
    Object.assign(globalThis, { sky })
  },
})
