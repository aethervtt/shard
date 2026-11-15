import type { Entity, World } from '@aethervtt/shard-core'
import {
  registerSurfaceResolver,
  SURFACE_PRESETS,
  type SurfacePreset,
  type SurfaceResolver,
  type SurfaceSample,
  Surfaces,
  surfacePreset,
} from '@aethervtt/shard-physics/surface'
import { TerrainWorld } from '../heights'
import { TerrainChunk } from './component'
import { PAGE } from './kernel'
import { finestPage } from './queries'
import type { HeightfieldRuntime } from './runtime'

/** Layer names that mean a preset of another name. */
const ALIASES: Record<string, SurfacePreset> = {
  soil: 'dirt',
  earth: 'dirt',
  rock: 'concrete',
  stone: 'concrete',
  road: 'asphalt',
  tarmac: 'asphalt',
  beach: 'sand',
}

/** A layer's surface path: its own, else the preset it's named like, else none (asphalt). */
export function layerSurfacePath(layer: { name: string; surface: string | null }): string | null {
  if (layer.surface) return layer.surface
  const name = layer.name.toLowerCase()
  if (name in SURFACE_PRESETS) return surfacePreset(name as SurfacePreset).path!
  const alias = ALIASES[name]
  return alias ? surfacePreset(alias).path! : null
}

/** Per runtime: its layers' registry indices (−1 unresolved), and the source they came from. */
const layerIndices = new WeakMap<HeightfieldRuntime, { source: unknown; indices: Int32Array }>()
const point = new Float64Array(3)

/** Collider tile entity → its terrain (or −1: not a terrain tile). */
const tileTerrain = new Map<Entity, Entity>()

function terrainOf(world: World, collider: Entity): Entity {
  let terrain = tileTerrain.get(collider)
  if (terrain !== undefined && (terrain < 0 || world.isAlive(terrain))) return terrain
  const chunk = world.tryGet(collider, TerrainChunk)
  terrain = chunk && chunk.kind === 'collider' && chunk.terrain !== null ? chunk.terrain : -1
  if (tileTerrain.size > 8192) tileTerrain.clear()
  tileTerrain.set(collider, terrain as Entity)
  return terrain as Entity
}

function indexOf(world: World, rt: HeightfieldRuntime, layer: number): number {
  const source = rt.asset?.source
  if (!source) return 0
  let cached = layerIndices.get(rt)
  if (!cached || cached.source !== source) {
    cached = { source, indices: new Int32Array(source.layers.length).fill(-1) }
    layerIndices.set(rt, cached)
  }
  const indices = cached.indices
  if (layer >= indices.length) return 0
  let index = indices[layer]!
  if (index >= 0) return index
  const path = layerSurfacePath(source.layers[layer]!)
  index = path
    ? world.resource(Surfaces).index(world, { type: 'physics/Surface', guid: undefined, path })
    : 0
  if (index >= 0) indices[layer] = index
  return index < 0 ? 0 : index
}

/**
 * The surface under a point of a heightfield collider tile (0071): the two heaviest layers of the
 * nearest control texel, mapped to their `surface` and blended by their share. Allocates nothing
 * once a tile and its layers are known.
 */
export const heightfieldSurfaceResolver: SurfaceResolver = (
  world: World,
  collider: Entity,
  at: ArrayLike<number>,
  out: SurfaceSample,
): boolean => {
  const terrain = terrainOf(world, collider)
  if (terrain < 0) return false
  const rt = world.tryResource(TerrainWorld)?.heightfields.get(terrain)
  if (!rt?.ready || !rt.layout || !rt.pages) return false
  rt.frame.pointToPlanet(at[0]!, at[1]!, at[2]!, point)
  const x = point[0]!
  const z = point[2]!
  const page = finestPage(rt, x, z)
  if (!page) return false
  const size = rt.nodeSize(page.depth)
  const fx = ((x - page.x * size) / size) * PAGE
  const fz = ((z - page.z * size) / size) * PAGE
  const cells = rt.layout.cells
  const k = PAGE / cells
  const ci = Math.min(cells, Math.max(0, Math.round(fx / k)))
  const cj = Math.min(cells, Math.max(0, Math.round(fz / k)))
  const o = (cj * (cells + 1) + ci) * 4
  const control = page.control
  out.a = indexOf(world, rt, control[o]!)
  out.b = indexOf(world, rt, control[o + 1]!)
  out.weight = out.a === out.b ? 0 : control[o + 2]! / 255
  return true
}

/** Registers the heightfield resolver with physics (the terrain plugin does, when physics is on). */
export function registerTerrainSurfaces(world: World): void {
  if (world.tryResource(Surfaces)) registerSurfaceResolver(world, heightfieldSurfaceResolver)
}
