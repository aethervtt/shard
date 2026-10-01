import { AssetStore, defineAssetType } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineComponent,
  defineResource,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { type CoverageShape, parseCoverageShape } from '@aethervtt/shard-vector'

// Projected fog (0058): layers of darkness drawn from ordered regions, composed in world space.
// Fog never decides visibility: it darkens what the host sends, from the regions the host gives.

/** One region of a fog layer: hide or reveal, by how much, with how soft an edge. */
export interface FogRegion {
  op: 'reveal' | 'hide'
  /** 0..1: how much of the region's coverage applies. Default 1. */
  strength?: number
  /** Width of the soft edge outside the shape, in world units. Default 0. */
  feather?: number
  shape: CoverageShape
}

/** A layer's regions, in the order they apply. The host bumps `rev` when it changes them. */
export interface FogRegionsValue {
  rev: number
  regions: readonly FogRegion[]
}

export const FogRegionsStore = defineResource<AssetStore<FogRegionsValue, 'FogRegions'>>(
  'fog/Regions',
  {
    description: 'Fog region lists by guid: what FogLayer.regions refers to.',
    init: () => new AssetStore('FogRegions'),
  },
)

function invalid(message: string, path: string): ShardError {
  return new ShardError('fog/invalid-regions', message, {
    path,
    hint: '{ rev, regions: [{ op: "hide" | "reveal", strength?, feather?, shape }] } with shapes rect, polygon, multipolygon or brush.',
  })
}

/** Checks a region list (a data file, or JSON from a host) and returns it typed. */
export function parseFogRegions(json: unknown, path = ''): FogRegionsValue {
  if (!json || typeof json !== 'object') throw invalid('Expected { rev, regions }', path || '/')
  const v = json as Record<string, unknown>
  const rev = v.rev ?? 0
  if (typeof rev !== 'number' || !Number.isFinite(rev))
    throw invalid('Expected a number', `${path}/rev`)
  if (!Array.isArray(v.regions)) throw invalid('Expected a list of regions', `${path}/regions`)
  const regions = v.regions.map((r, i): FogRegion => {
    const at = `${path}/regions/${i}`
    if (!r || typeof r !== 'object') throw invalid('Expected a region object', at)
    const o = r as Record<string, unknown>
    if (o.op !== 'hide' && o.op !== 'reveal')
      throw invalid('Expected "hide" or "reveal"', `${at}/op`)
    const strength = o.strength ?? 1
    if (typeof strength !== 'number' || !(strength >= 0 && strength <= 1))
      throw invalid('Expected a number from 0 to 1', `${at}/strength`)
    const feather = o.feather ?? 0
    if (typeof feather !== 'number' || !(feather >= 0))
      throw invalid('Expected a non-negative number', `${at}/feather`)
    return { op: o.op, strength, feather, shape: parseCoverageShape(o.shape, `${at}/shape`) }
  })
  return { rev, regions }
}

/** Region lists as assets: `*.fog.json` data, or `FogRegionsStore.add` from host code. */
export const FogRegionsAssetType = defineAssetType<FogRegionsValue>('FogRegions', {
  store: FogRegionsStore,
  load: (artifact, ctx) => parseFogRegions(artifact.json, ctx.path),
})

/**
 * Replaces a region list and wakes the app, so an on-demand app renders the change (0052). Appending
 * regions to the same list (the same objects, in order) redraws only the new ones.
 */
export function setFogRegions(
  world: World,
  ref: AssetRef<'FogRegions'>,
  value: FogRegionsValue,
): void {
  world.resource(FogRegionsStore).set(ref.guid!, value)
  world.wake()
}

export const FogLayer = defineComponent(
  'fog/FogLayer',
  {
    base: t.enum(['hidden', 'revealed'], {
      description: 'What the layer is before any region, and outside its extent.',
    }),
    extent: t.struct(
      {
        min: t.vec2({ description: 'The corner with the least x and z, in world units.' }),
        max: t.vec2({ default: [16, 16], description: 'The corner with the most x and z.' }),
      },
      { description: 'The world XZ rectangle the layer covers; outside it, the base applies.' },
    ),
    texelSize: t.f32({
      default: 0.05,
      min: 0.001,
      unit: 'm',
      description:
        'World units per mask texel. The mask is clamped to 4096² (or the device limit).',
    }),
    color: t.color({ default: [0, 0, 0, 1], description: 'The color fog darkens toward.' }),
    opacity: t.f32({ default: 1, min: 0, max: 1, description: 'How dark full fog is.' }),
    regions: t.handle('FogRegions', { description: 'The layer’s ordered regions.' }),
  },
  {
    description:
      'A layer of projected fog (0058): a mask drawn from ordered hide/reveal regions over its extent, darkening every pixel whose world position falls in it, floors and props alike.',
  },
)

export const FogSettings = defineResource<{
  compose: 'union'
  viewerOpacity: number
  floor: number
}>('fog/Settings', {
  description:
    'How fog layers compose (their union), how dark the viewer sees them (a GM sees 0.45), and the floor height background pixels use.',
  init: () => ({ compose: 'union', viewerOpacity: 1, floor: 0 }),
  hostWritable: true,
})

/** Layers composed per view at most; more draw in the first four's union (and are reported). */
export const MAX_FOG_LAYERS = 4
