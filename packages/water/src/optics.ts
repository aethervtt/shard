import { assetServer, defineDataType } from '@aethervtt/shard-assets'
import { type AssetRef, ShardError, t, type World } from '@aethervtt/shard-core'

const rgb = (description: string, fallback: [number, number, number]) =>
  t.vec3({ default: fallback, unit: '1/m', description })

/** How a body of water absorbs, scatters and ripples (0097): a `*.water.json` data asset. */
export const WaterOptics = defineDataType(
  'water/WaterOptics',
  {
    absorption: rgb(
      'Absorption per metre in red, green and blue. Pure water: 0.34, 0.057, 0.009 (Pope & Fry): red goes first, so depth turns it blue.',
      [0.34, 0.057, 0.009],
    ),
    scattering: rgb(
      'Scattering per metre in red, green and blue: what turns deep water a color of its own (blue open sea, green coast, brown silt).',
      [0.0007, 0.0019, 0.0045],
    ),
    phase: t.f32({
      default: 0.8,
      min: -0.99,
      max: 0.99,
      description:
        'Henyey–Greenstein g of the scattering: 0 the same every way, near 1 bright looking toward the sun.',
    }),
    roughness: t.f32({
      default: 0.03,
      min: 0,
      max: 1,
      description:
        'Surface roughness under the ripples: blurs reflections and the sun’s highlight, and the refraction behind.',
    }),
    foamColor: t.vec3({
      default: [0.9, 0.93, 0.95],
      description: 'Linear color of foam (shore foam lands with 0097 part 2).',
    }),
    foam: t.f32({ default: 0.5, min: 0, description: 'How much foam (part 2).' }),
    ripples: t.f32({
      default: 1,
      min: 0,
      description: 'Wind ripples’ strength: 0 a mirror, 1 as the wind makes them.',
    }),
  },
  {
    extension: 'water',
    description:
      'Water optics (0097): absorption and scattering per metre (RGB), phase g, roughness, foam, ripple strength. Presets: water/clear, ocean, coastal, lake, river, murky, pool.',
  },
)

export interface WaterOpticsValue {
  absorption: [number, number, number]
  scattering: [number, number, number]
  phase: number
  roughness: number
  foamColor: [number, number, number]
  foam: number
  ripples: number
}

const preset = (
  absorption: [number, number, number],
  scattering: [number, number, number],
  phase: number,
  roughness: number,
): WaterOpticsValue => ({
  absorption,
  scattering,
  phase,
  roughness,
  foamColor: [0.9, 0.93, 0.95],
  foam: 0.5,
  ripples: 1,
})

/**
 * The optics that ship (0097), by name. `clear` is pure water (Pope & Fry absorption, molecular
 * scattering); the rest add what's in real water: plankton and dissolved matter (green, brown) and
 * silt (scattering).
 */
export const WATER_OPTICS_PRESETS = {
  clear: preset([0.34, 0.057, 0.009], [0.0007, 0.0019, 0.0045], 0.8, 0.03),
  ocean: preset([0.45, 0.07, 0.03], [0.003, 0.006, 0.012], 0.8, 0.04),
  coastal: preset([0.5, 0.12, 0.15], [0.06, 0.08, 0.06], 0.75, 0.04),
  lake: preset([0.6, 0.16, 0.24], [0.03, 0.04, 0.03], 0.7, 0.03),
  river: preset([0.7, 0.26, 0.36], [0.12, 0.12, 0.1], 0.7, 0.05),
  murky: preset([1.2, 0.9, 1.0], [0.5, 0.45, 0.32], 0.6, 0.06),
  pool: preset([0.34, 0.06, 0.012], [0.002, 0.004, 0.008], 0.8, 0.01),
} as const satisfies Record<string, WaterOpticsValue>

export type WaterOpticsPreset = keyof typeof WATER_OPTICS_PRESETS

/** A preset's asset reference: `water/<name>.water.json`, registered by waterPlugin. */
export function waterOptics(name: WaterOpticsPreset): AssetRef<'water/WaterOptics'> {
  if (!(name in WATER_OPTICS_PRESETS)) {
    throw new ShardError('water/unknown-optics', `No water optics preset "${name}"`, {
      hint: `Presets: ${Object.keys(WATER_OPTICS_PRESETS).join(', ')}.`,
    })
  }
  return { type: 'water/WaterOptics', guid: `water:${name}`, path: `water/${name}.water.json` }
}

/** Registers the presets as virtual assets (`water/<name>.water.json`), so scenes can name them. */
export function registerOpticsPresets(world: World): void {
  const store = world.initResource(WaterOptics.store)
  const server = assetServer(world)
  for (const name of Object.keys(WATER_OPTICS_PRESETS) as WaterOpticsPreset[]) {
    const ref = waterOptics(name)
    const value = structuredClone(WATER_OPTICS_PRESETS[name]) as WaterOpticsValue
    store.set(ref.guid!, value as never)
    server.virtual(ref.guid!, ref.path!, WaterOptics.type.name, () => value)
  }
}

/**
 * A body's optics: its asset when loaded, `clear` when it has none (and `missing` says so), and
 * `undefined` while its asset is still loading or failed.
 */
export function resolveOptics(
  world: World,
  ref: AssetRef | null | undefined,
): { value: WaterOpticsValue | undefined; missing: boolean } {
  const store = world.initResource(WaterOptics.store)
  if (!ref || (ref.guid === undefined && ref.path === undefined))
    return { value: WATER_OPTICS_PRESETS.clear, missing: true }
  if (ref.guid !== undefined) {
    const v = store.get(ref as { guid: string })
    if (v) return { value: v as unknown as WaterOpticsValue, missing: false }
  }
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (!entry) return { value: undefined, missing: false }
  const v = store.get({ guid: entry.guid })
  if (v) return { value: v as unknown as WaterOpticsValue, missing: false }
  if (entry.state !== 'failed') void server.request(entry.guid).catch(() => {})
  return { value: undefined, missing: false }
}
