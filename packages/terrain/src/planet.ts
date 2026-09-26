import { assetServer } from '@shard/assets'
import { type AssetRef, type Entity, ShardError, type World } from '@shard/core'
import { type NoiseGraph, NoiseGraphs } from '@shard/noise'
import { LogResource } from '@shard/runtime'
import {
  Biome,
  BiomeSet,
  type BiomeSetValue,
  type BiomeTable,
  type BiomeValue,
  biomeTable,
} from './biomes'
import { checkResolution } from './chunk'
import { Planet } from './components'
import { MAX_RADIUS, maxDepthFor, nodeSpacing } from './cube'
import { PlanetFrame } from './frame'
import { measureErrors } from './lod'
import { createSelection, NODE_BOUNDS, NodeTree } from './quadtree'

/** Collider chunks are the first depth whose vertices are at most this far apart (m). */
export const COLLIDER_SPACING = 1

/** A planet's settings as numbers, read from its component when it changes. */
export interface PlanetSettings {
  radius: number
  shape: Float64Array
  heightScale: number
  seed: number
  ocean: boolean
  seaLevel: number
  resolution: number
  minSpacing: number
  errorPixels: number
  colliderRadius: number
  skirts: boolean
  height: AssetRef | null
  climate: AssetRef | null
  biomes: AssetRef | null
}

/**
 * Everything the terrain keeps per Planet entity: resolved graphs and biomes, per-depth errors, the
 * terrain and ocean quadtrees, the planet's frame, and the collider and render state (added by
 * those modules). `version` bumps whenever what a chunk contains changes (a graph edit, a new seed),
 * which makes every generated chunk stale; stale chunks keep rendering until their replacement is
 * ready, so an edit never shows a hole.
 */
export class PlanetRuntime {
  readonly entity: Entity
  settings: PlanetSettings | undefined
  /** Component change tick last read. */
  tick = -1
  /** Bumps when chunk contents change. */
  version = 0
  /** What the quadtree's shape depends on (radius, shape, resolution, depth). */
  private structureKey = ''
  private contentKey = ''
  height: NoiseGraph | undefined
  climate: NoiseGraph | undefined
  set: BiomeSetValue | undefined
  biomes: (BiomeValue | undefined)[] = []
  table: BiomeTable = biomeTable(undefined, [])
  /** Bumps when the biome table changes. */
  biomeVersion = 0
  private biomeKey = ''
  /** Geometric error per depth (terrain), and for the flat ocean surface. */
  errors: Float32Array = new Float32Array(2)
  oceanErrors: Float32Array = new Float32Array(2)
  maxDepth = 0
  colliderDepth = 0
  readonly tree = new NodeTree()
  readonly ocean = new NodeTree(256)
  readonly frame = new PlanetFrame()
  readonly selection = createSelection()
  readonly oceanSelection = createSelection()
  /** Why the planet can't generate, if it can't (bad settings). */
  problem: ShardError | null = null
  /** What it's waiting for (a graph or biome loading), if anything. */
  waiting: string | null = null
  /** Anchors this frame, in the planet frame. */
  anchorPos = new Float64Array(0)
  anchorRadius = new Float64Array(0)
  anchorEntity: Entity[] = []
  anchors = 0
  /** Module state (colliders, render, nav) keyed by module. */
  readonly parts = new Map<string, unknown>()

  constructor(entity: Entity) {
    this.entity = entity
  }

  /** Whether the planet has what it needs to generate chunks. */
  get ready(): boolean {
    return this.problem === null && this.waiting === null && this.settings !== undefined
  }

  /** Lowest the surface gets (m above radius): the horizon occluder and default bounds. */
  get lowest(): number {
    const s = this.settings
    if (!s) return 0
    return this.height ? -s.heightScale : 0
  }

  get highest(): number {
    const s = this.settings
    if (!s) return 0
    return this.height ? s.heightScale : 0
  }

  /**
   * Brings the runtime up to date with the component and the assets it names. Cheap when nothing
   * changed: compares a change tick and graph versions.
   */
  refresh(world: World, dirty: boolean): void {
    const table = world.entityTable(this.entity)
    const tick = table.changedTicks(Planet)[world.entityRow(this.entity)]!
    if (tick !== this.tick || !this.settings) {
      this.tick = tick
      this.settings = readSettings(world.get(this.entity, Planet))
      dirty = true
    }
    const s = this.settings
    if (!dirty && this.waiting === null) {
      // Hot reload bumps a graph's version in place.
      const h = this.height
      const c = this.climate
      if ((!h || h.version === this.heightVersion) && (!c || c.version === this.climateVersion))
        return
    }
    this.problem = null
    this.waiting = null
    try {
      validate(s)
    } catch (err) {
      this.report(world, err as ShardError)
      return
    }
    const height = resolve(world, s.height, (w) => w.initResource(NoiseGraphs))
    const climate = resolve(world, s.climate, (w) => w.initResource(NoiseGraphs))
    if (height === null || climate === null) {
      this.waiting =
        height === null
          ? `height graph ${refName(s.height)}`
          : `climate graph ${refName(s.climate)}`
      return
    }
    if (
      climate &&
      (!climate.graph.nodes.has('temperature') || !climate.graph.nodes.has('moisture'))
    ) {
      this.report(
        world,
        new ShardError(
          'terrain/climate-outputs',
          `Climate graph ${refName(s.climate)} needs nodes named "temperature" and "moisture"`,
          {
            path: refName(s.climate),
            hint: 'Name the two climate layers "temperature" and "moisture"; each should stay in [−1, 1].',
          },
        ),
      )
      return
    }
    const set = resolve(world, s.biomes, (w) => w.initResource(BiomeSet.store))
    if (set === null) {
      this.waiting = `biome set ${refName(s.biomes)}`
      return
    }
    const biomes: (BiomeValue | undefined)[] = []
    for (const ref of set?.biomes ?? []) {
      const b = resolve(world, ref, (w) => w.initResource(Biome.store))
      if (b === null) {
        this.waiting = `biome ${refName(ref)}`
        return
      }
      biomes.push(b)
    }
    try {
      const biomeKey = JSON.stringify([set ?? null, biomes])
      if (biomeKey !== this.biomeKey) {
        this.table = biomeTable(set, biomes)
        this.biomeKey = biomeKey
        this.biomeVersion++
      }
    } catch (err) {
      this.report(world, err as ShardError)
      return
    }
    this.set = set
    this.biomes = biomes
    this.height = height
    this.climate = climate
    this.heightVersion = height?.version ?? -1
    this.climateVersion = climate?.version ?? -1
    const maxDepth = maxDepthFor(s.radius, s.resolution, s.minSpacing)
    const structureKey = JSON.stringify([s.radius, [...s.shape], s.resolution, maxDepth])
    const contentKey = JSON.stringify([
      structureKey,
      height?.hash ?? null,
      climate?.hash ?? null,
      s.heightScale,
      s.seed,
      s.ocean,
      s.seaLevel,
    ])
    if (contentKey === this.contentKey) return
    this.maxDepth = maxDepth
    this.colliderDepth = Math.min(
      maxDepth,
      maxDepthFor(s.radius, s.resolution, Math.max(COLLIDER_SPACING, s.minSpacing)),
    )
    this.errors = measureErrors({
      radius: s.radius,
      shape: s.shape,
      heightScale: s.heightScale,
      seed: s.seed,
      resolution: s.resolution,
      maxDepth,
      height,
    })
    this.oceanErrors = measureErrors({
      radius: s.radius,
      shape: s.shape,
      heightScale: 0,
      seed: s.seed,
      resolution: s.resolution,
      maxDepth,
      height: undefined,
      heightOffset: s.seaLevel,
    })
    if (structureKey !== this.structureKey) {
      this.tree.reset(s.radius, s.shape, this.lowest, this.highest)
      this.ocean.reset(s.radius, s.shape, s.seaLevel, s.seaLevel)
      this.structureKey = structureKey
    } else {
      // Same shape, new contents: bounds widen back to the planet's range until regenerated.
      this.tree.lowest = this.lowest
      this.tree.highest = this.highest
      this.ocean.lowest = s.seaLevel
      this.ocean.highest = s.seaLevel
      widen(this.tree)
      widen(this.ocean)
    }
    this.contentKey = contentKey
    this.version++
  }

  private heightVersion = -1
  private climateVersion = -1

  private report(world: World, err: ShardError): void {
    this.problem = err
    world.tryResource(LogResource)?.error(err)
  }

  /** Vertex spacing at a depth (m). */
  spacing(depth: number): number {
    return nodeSpacing(this.settings?.radius ?? 1, depth, this.settings?.resolution ?? 33)
  }
}

function widen(tree: NodeTree): void {
  for (let n = 0; n < tree.count; n++) {
    tree.flags[n]! &= ~NODE_BOUNDS
    tree.minH[n] = tree.lowest
    tree.maxH[n] = tree.highest
    tree.updateSphere(n)
  }
}

function readSettings(v: ReturnType<typeof Planet.defaults>): PlanetSettings {
  return {
    radius: v.radius,
    shape: Float64Array.from(v.shape),
    heightScale: v.heightScale,
    seed: v.seed >>> 0,
    ocean: v.ocean,
    seaLevel: v.seaLevel,
    resolution: v.resolution,
    minSpacing: v.minSpacing,
    errorPixels: v.errorPixels,
    colliderRadius: v.colliderRadius,
    skirts: v.skirts,
    height: v.height,
    climate: v.climate,
    biomes: v.biomes,
  }
}

function validate(s: PlanetSettings): void {
  if (s.radius > MAX_RADIUS) {
    throw new ShardError(
      'terrain/radius-too-large',
      `Planet radius ${s.radius} m is over ${MAX_RADIUS} m (50 000 km)`,
      {
        hint: 'Rocky planets go up to about 16 000 km; gas giants have no surface (spec 0046 renders them).',
      },
    )
  }
  checkResolution(s.resolution)
}

function refName(ref: AssetRef | null | undefined): string {
  return ref?.path ?? ref?.guid ?? '(none)'
}

/**
 * An asset a handle names: the value, undefined for no handle, or null while it loads (the load
 * starts here).
 */
function resolve<T>(
  world: World,
  ref: AssetRef | null | undefined,
  store: (world: World) => { get(ref: { guid: string | undefined }): T | undefined },
): T | undefined | null {
  if (!ref || (ref.guid === undefined && ref.path === undefined)) return undefined
  const value = ref.guid !== undefined ? store(world).get(ref) : undefined
  if (value !== undefined) return value
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (entry) {
    if (entry.state !== 'failed') void server.request(entry.guid).catch(() => {})
    const loaded = store(world).get({ guid: entry.guid })
    if (loaded !== undefined) return loaded
  }
  return null
}
