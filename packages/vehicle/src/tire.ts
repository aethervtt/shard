import { assetServer, defineDataType } from '@aethervtt/shard-assets'
import { type AssetRef, ShardError, t, type World } from '@aethervtt/shard-core'

const curve = (description: string, peak: number, slideSlip: number, slide: number) =>
  t.struct(
    {
      peakSlip: t.f32({
        default: peak,
        min: 1e-4,
        description: 'Slip at peak grip.',
      }),
      slideSlip: t.f32({
        default: slideSlip,
        min: 1e-4,
        description: 'Slip where grip has fallen to slide.',
      }),
      slide: t.f32({
        default: slide,
        min: 0,
        description: 'Grip past slideSlip, as a share of the peak.',
      }),
    },
    { description },
  )

/**
 * A tire (0118): a `*.tire.json` data asset. Grip rises with slip to a peak and falls to a slide
 * value: Unity's extremum and asymptote with the peak normalized, PhysX's three-point curve.
 */
export const Tire = defineDataType(
  'vehicle/Tire',
  {
    grip: t.f32({
      default: 1,
      min: 0,
      description: 'Peak friction coefficient on a grip-1 surface (dry asphalt).',
    }),
    longitudinal: curve('Grip against slip ratio (accelerating and braking).', 0.1, 0.4, 0.75),
    lateral: curve('Grip against slip angle, in degrees (cornering).', 8, 20, 0.8),
    loadSensitivity: t.f32({
      default: 0.1,
      min: 0,
      max: 1,
      description:
        'Grip lost per unit of load over the static load: weight transfer costs an axle grip.',
    }),
    rollingResistance: t.f32({
      default: 1,
      min: 0,
      description: 'Scales the surface’s rolling resistance.',
    }),
    surfaces: t.list(
      t.struct({
        surface: t.string({ description: 'Surface name (gravel, snow, or an asset’s name).' }),
        grip: t.f32({ default: 1, min: 0, description: 'Grip scale on it.' }),
        loose: t.f32({ default: 1, min: 0, description: 'Scales its looseness.' }),
      }),
      { description: 'Per surface: winter tires on snow, off-road tires in mud, slicks on dirt.' },
    ),
  },
  {
    extension: 'tire',
    description:
      'A tire (0118): peak grip, longitudinal and lateral slip curves, load sensitivity, per-surface grip. Presets: vehicle/road, sport, offroad, winter.',
  },
)

export interface TireCurve {
  peakSlip: number
  slideSlip: number
  slide: number
}

export interface TireValue {
  grip: number
  longitudinal: TireCurve
  lateral: TireCurve
  loadSensitivity: number
  rollingResistance: number
  surfaces: { surface: string; grip: number; loose: number }[]
}

const tire = (
  grip: number,
  longitudinal: [number, number, number],
  lateral: [number, number, number],
  surfaces: [string, number, number][] = [],
): TireValue => ({
  grip,
  longitudinal: { peakSlip: longitudinal[0], slideSlip: longitudinal[1], slide: longitudinal[2] },
  lateral: { peakSlip: lateral[0], slideSlip: lateral[1], slide: lateral[2] },
  loadSensitivity: 0.1,
  rollingResistance: 1,
  surfaces: surfaces.map(([surface, g, loose]) => ({ surface, grip: g, loose })),
})

/** The tires that ship (0118), by name. */
export const TIRE_PRESETS = {
  road: tire(1, [0.1, 0.4, 0.75], [8, 20, 0.8]),
  sport: tire(
    1.15,
    [0.08, 0.3, 0.7],
    [6, 15, 0.75],
    [
      ['gravel', 0.85, 1],
      ['dirt', 0.85, 1],
      ['grass', 0.8, 1],
      ['mud', 0.6, 1],
      ['sand', 0.7, 1],
      ['snow', 0.7, 1],
      ['fresh-snow', 0.6, 1],
    ],
  ),
  offroad: tire(
    0.95,
    [0.12, 0.5, 0.85],
    [9, 24, 0.85],
    [
      ['gravel', 1.15, 0.8],
      ['dirt', 1.25, 0.8],
      ['grass', 1.2, 1],
      ['mud', 1.5, 0.7],
      ['sand', 1.3, 0.8],
      ['fresh-snow', 1.2, 0.8],
    ],
  ),
  winter: tire(
    0.92,
    [0.1, 0.4, 0.8],
    [8, 20, 0.85],
    [
      ['snow', 1.5, 1],
      ['fresh-snow', 1.4, 1],
      ['ice', 1.6, 1],
    ],
  ),
} as const satisfies Record<string, TireValue>

export type TirePreset = keyof typeof TIRE_PRESETS

/** A preset's asset reference: `vehicle/<name>.tire.json`, registered by vehiclePlugin. */
export function tirePreset(name: TirePreset): AssetRef<'vehicle/Tire'> {
  if (!(name in TIRE_PRESETS)) {
    throw new ShardError('vehicle/unknown-tire', `No tire preset "${name}"`, {
      hint: `Presets: ${Object.keys(TIRE_PRESETS).join(', ')}.`,
    })
  }
  return { type: 'vehicle/Tire', guid: `vehicle:${name}`, path: `vehicle/${name}.tire.json` }
}

/** Registers the presets as virtual assets (`vehicle/<name>.tire.json`). */
export function registerTirePresets(world: World): void {
  const store = world.initResource(Tire.store)
  const server = assetServer(world)
  for (const name of Object.keys(TIRE_PRESETS) as TirePreset[]) {
    const ref = tirePreset(name)
    const value = structuredClone(TIRE_PRESETS[name]) as TireValue
    store.set(ref.guid!, value as never)
    server.virtual(ref.guid!, ref.path!, Tire.type.name, () => value)
  }
}

/**
 * A wheel's tire: its asset when loaded, `road` for none, and `undefined` while it loads (the
 * wheel drives on `road` meanwhile).
 */
export function resolveTire(world: World, ref: AssetRef | null | undefined): TireValue | undefined {
  const store = world.initResource(Tire.store)
  if (!ref || (ref.guid === undefined && ref.path === undefined)) return TIRE_PRESETS.road
  if (ref.guid !== undefined) {
    const v = store.get(ref as { guid: string })
    if (v) return v as unknown as TireValue
  }
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (!entry) return TIRE_PRESETS.road
  const v = store.get({ guid: entry.guid })
  if (v) return v as unknown as TireValue
  if (entry.state === 'failed') return TIRE_PRESETS.road
  void server.request(entry.guid).catch(() => {})
  return undefined
}

/**
 * Normalized grip at normalized slip σ (slip / peakSlip): rises as σ(2 − σ) to 1 at the peak,
 * eases down to `slide` at `slideAt` (slideSlip / peakSlip), and stays there.
 */
export function gripCurve(sigma: number, slideAt: number, slide: number): number {
  if (sigma <= 1) return sigma * (2 - sigma)
  if (sigma >= slideAt) return slide
  const u = (sigma - 1) / (slideAt - 1)
  const s = u * u * (3 - 2 * u)
  return 1 + (slide - 1) * s
}
