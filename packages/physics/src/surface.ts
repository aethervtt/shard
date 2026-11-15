import { assetServer, defineDataType } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  type Entity,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { LogResource } from '@aethervtt/shard-runtime'
import { Collider } from './components'

/**
 * What the ground is made of (0118): a `*.surface.json` data asset on colliders and terrain layers.
 * Vehicles read grip, rolling resistance and the loose-ground fields; footsteps and impacts can
 * key sounds and effects by its name.
 */
export const Surface = defineDataType(
  'physics/Surface',
  {
    grip: t.f32({
      default: 1,
      min: 0,
      description:
        'Tire grip relative to dry asphalt (μ ≈ 0.85 for a road tire): ice 0.1, snow 0.25, grass 0.45, gravel 0.65.',
    }),
    wetGrip: t.f32({
      default: 0.7,
      min: 0,
      description: 'Grip scale at full wetness (physics/RoadConditions.wetness = 1).',
    }),
    rollingResistance: t.f32({
      default: 0.013,
      min: 0,
      description:
        'Rolling resistance coefficient Crr at walking pace: asphalt 0.013, dirt 0.05, sand 0.3.',
    }),
    loose: t.f32({
      default: 0,
      min: 0,
      max: 1,
      description:
        '0 paved … 1 deep sand: on loose ground grip doesn’t fall past the peak, and the peak comes at more slip.',
    }),
    sinkage: t.f32({
      default: 0,
      min: 0,
      unit: 'm',
      description: 'How far a wheel sinks at its static load.',
    }),
    drag: t.f32({
      default: 0,
      min: 0,
      unit: 'N·s/m²',
      description:
        'Resistance that grows with speed and sinkage (plowing through sand or snow): N per (m/s of speed × m of sinkage).',
    }),
    dig: t.f32({
      default: 0,
      min: 0,
      unit: 'm/s',
      description: 'How fast a spinning wheel digs in, per unit of slip ratio (mud, sand).',
    }),
    maxSinkage: t.f32({
      default: 0,
      min: 0,
      unit: 'm',
      description: 'Deepest a wheel digs in.',
    }),
    bumps: t.struct(
      {
        amplitude: t.f32({ min: 0, unit: 'm', description: 'Height of the bumps.' }),
        wavelength: t.f32({ default: 1, min: 0.01, unit: 'm', description: 'Bump spacing.' }),
      },
      { description: 'Small bumps the suspension feels: gravel, cobbles, washboard.' },
    ),
  },
  {
    extension: 'surface',
    description:
      'A ground material (0118): tire grip, wet grip, rolling resistance, looseness, sinkage, digging and bumps. Presets: physics/asphalt, concrete, gravel, dirt, grass, mud, sand, snow, fresh-snow, ice.',
  },
)

export interface SurfaceValue {
  grip: number
  wetGrip: number
  rollingResistance: number
  loose: number
  sinkage: number
  drag: number
  dig: number
  maxSinkage: number
  bumps: { amplitude: number; wavelength: number }
}

const surface = (
  grip: number,
  rollingResistance: number,
  loose: number,
  sinkage: number,
  dig: number,
  extra: Partial<SurfaceValue> = {},
): SurfaceValue => ({
  grip,
  wetGrip: 0.7,
  rollingResistance,
  loose,
  sinkage,
  drag: 0,
  dig,
  maxSinkage: 0,
  bumps: { amplitude: 0, wavelength: 1 },
  ...extra,
})

/**
 * The surfaces that ship (0118), by name. Grip is relative to dry asphalt; sources are in
 * specs/research/vehicles-2026-11-14.md (grass and mud are guesses).
 */
export const SURFACE_PRESETS = {
  asphalt: surface(1, 0.013, 0, 0, 0),
  concrete: surface(1, 0.012, 0, 0, 0),
  gravel: surface(0.65, 0.02, 0.5, 0.01, 0, { bumps: { amplitude: 0.01, wavelength: 0.6 } }),
  dirt: surface(0.6, 0.05, 0.4, 0.02, 0.01, { wetGrip: 0.6, maxSinkage: 0.05, drag: 400 }),
  grass: surface(0.45, 0.06, 0.3, 0.01, 0, { wetGrip: 0.6 }),
  mud: surface(0.35, 0.12, 0.8, 0.06, 0.05, { wetGrip: 0.9, maxSinkage: 0.2, drag: 2500 }),
  sand: surface(0.4, 0.3, 1, 0.05, 0.04, { wetGrip: 1.1, maxSinkage: 0.15, drag: 2000 }),
  snow: surface(0.25, 0.03, 0.4, 0, 0, { wetGrip: 0.9 }),
  'fresh-snow': surface(0.25, 0.08, 0.8, 0.08, 0.03, {
    wetGrip: 0.9,
    maxSinkage: 0.15,
    drag: 1500,
  }),
  ice: surface(0.1, 0.01, 0, 0, 0, { wetGrip: 0.6 }),
} as const satisfies Record<string, SurfaceValue>

export type SurfacePreset = keyof typeof SURFACE_PRESETS

/** A preset's asset reference: `physics/<name>.surface.json`, registered by the physics plugin. */
export function surfacePreset(name: SurfacePreset): AssetRef<'physics/Surface'> {
  if (!(name in SURFACE_PRESETS)) {
    throw new ShardError('physics/unknown-surface', `No surface preset "${name}"`, {
      hint: `Presets: ${Object.keys(SURFACE_PRESETS).join(', ')}.`,
    })
  }
  return { type: 'physics/Surface', guid: `physics:${name}`, path: `physics/${name}.surface.json` }
}

/** Two surfaces blended at a point: `b` weighs `weight` (0 when there's one). */
export interface SurfaceSample {
  a: number
  b: number
  weight: number
}

export const createSurfaceSample = (): SurfaceSample => ({ a: 0, b: 0, weight: 0 })

/**
 * Answers the surface at a hit point for colliders it knows (terrain heightfields, 0071), writing
 * registry indices into `out`. Returns false to leave the collider's own `surface` in charge.
 */
export type SurfaceResolver = (
  world: World,
  collider: Entity,
  point: ArrayLike<number>,
  out: SurfaceSample,
) => boolean

/**
 * Surfaces in use by index, so per-step code holds numbers: index 0 is asphalt, the default for
 * colliders with none. Assets register on first use.
 */
export class SurfaceRegistry {
  readonly values: SurfaceValue[] = []
  readonly names: string[] = []
  readonly byGuid = new Map<string, number>()
  readonly resolvers: SurfaceResolver[] = []
  /** Collider entity → surface index (−1: its asset is still loading). */
  readonly colliders = new Map<Entity, number>()
  /** Bumped when an index's value changes (hot reload), for caches. */
  version = 0

  constructor() {
    this.add('physics:asphalt', 'asphalt', SURFACE_PRESETS.asphalt)
  }

  add(guid: string, name: string, value: SurfaceValue): number {
    const existing = this.byGuid.get(guid)
    if (existing !== undefined) {
      this.values[existing] = value
      this.version++
      return existing
    }
    const index = this.values.length
    this.values.push(value)
    this.names.push(name)
    this.byGuid.set(guid, index)
    return index
  }

  /** The index of a surface asset, or −1 while it loads (and 0 for none or a failed load). */
  index(world: World, ref: AssetRef | null | undefined): number {
    if (!ref || (ref.guid === undefined && ref.path === undefined)) return 0
    if (ref.guid !== undefined) {
      const i = this.byGuid.get(ref.guid)
      if (i !== undefined) return i
    }
    const store = world.initResource(Surface.store)
    const server = assetServer(world)
    const entry = server.entry(ref)
    if (!entry) {
      report(world, ref)
      return 0
    }
    const known = this.byGuid.get(entry.guid)
    if (known !== undefined) return known
    const value = store.get({ guid: entry.guid }) as unknown as SurfaceValue | undefined
    if (value) return this.add(entry.guid, nameOf(entry.path), value)
    if (entry.state === 'failed') return 0
    void server.request(entry.guid).catch(() => {})
    return -1
  }
}

export const Surfaces = defineResource<SurfaceRegistry>('physics/Surfaces', {
  description:
    'Surfaces by index (0118): index 0 is asphalt. Resolvers answer per point for terrain.',
  init: () => new SurfaceRegistry(),
})

/** Road conditions the game sets with its weather (0118). */
export const RoadConditions = defineResource<{ wetness: number }>('physics/RoadConditions', {
  description: 'wetness: 0 dry … 1 soaked; scales every surface’s grip toward its wetGrip.',
  init: () => ({ wetness: 0 }),
})

function nameOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.indexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

const reported = new WeakMap<World, Set<string>>()

function report(world: World, ref: AssetRef): void {
  let seen = reported.get(world)
  if (!seen) {
    seen = new Set()
    reported.set(world, seen)
  }
  const key = ref.guid ?? ref.path ?? ''
  if (seen.has(key)) return
  seen.add(key)
  const err = new ShardError(
    'physics/unknown-surface',
    `No surface asset ${ref.path ?? ref.guid}; using asphalt`,
    { hint: 'Name a *.surface.json, or a preset such as physics/gravel.surface.json.' },
  )
  world.tryResource(LogResource)?.log('warn', err.message, { code: err.code, hint: err.hint })
}

/** Registers the presets as virtual assets (`physics/<name>.surface.json`). */
export function registerSurfacePresets(world: World): void {
  const store = world.initResource(Surface.store)
  const registry = world.initResource(Surfaces)
  const server = assetServer(world)
  for (const name of Object.keys(SURFACE_PRESETS) as SurfacePreset[]) {
    const ref = surfacePreset(name)
    const value = structuredClone(SURFACE_PRESETS[name]) as SurfaceValue
    store.set(ref.guid!, value as never)
    server.virtual(ref.guid!, ref.path!, Surface.type.name, () => value)
    registry.add(ref.guid!, name, value)
  }
}

/** Adds a resolver that answers the surface per point for colliders it knows (terrain). */
export function registerSurfaceResolver(world: World, resolver: SurfaceResolver): void {
  const registry = world.initResource(Surfaces)
  if (!registry.resolvers.includes(resolver)) registry.resolvers.push(resolver)
}

/**
 * The surface under a hit: a resolver's answer, else the collider's own `surface` (asphalt for
 * none or while it loads). Writes registry indices into `out`; allocates nothing once cached.
 */
export function surfaceAt(
  world: World,
  registry: SurfaceRegistry,
  collider: Entity,
  point: ArrayLike<number>,
  out: SurfaceSample,
): SurfaceSample {
  out.a = 0
  out.b = 0
  out.weight = 0
  const resolvers = registry.resolvers
  for (let i = 0; i < resolvers.length; i++) {
    if (resolvers[i]!(world, collider, point, out)) return out
  }
  let index = registry.colliders.get(collider)
  if (index === undefined || index < 0) {
    const c = world.tryGet(collider, Collider)
    index = c ? registry.index(world, c.surface) : 0
    registry.colliders.set(collider, index)
  }
  out.a = index < 0 ? 0 : index
  return out
}
