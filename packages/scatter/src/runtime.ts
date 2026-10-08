import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  ChildOf,
  Derived,
  defineResource,
  type Entity,
  hashSeed,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { type NoiseGraph, NoiseGraphs } from '@aethervtt/shard-noise'
import { Collider } from '@aethervtt/shard-physics'
import type { Workers } from '@aethervtt/shard-platform'
import {
  findGenerator,
  Generated,
  type GenRequest,
  procgen,
  requestOf,
} from '@aethervtt/shard-procgen'
import {
  Lod,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  Visibility,
  VisibilityRange,
} from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { PrefabInstance } from '@aethervtt/shard-scene'
import { Planet, type PlanetRuntime } from '@aethervtt/shard-terrain'
import { Transform } from '@aethervtt/shard-transform'
import {
  isRemoved,
  Prop,
  Removed,
  removedKey,
  type ScatterBudgetValue,
  ScatterChunk,
} from './components'
import type { FoliageRule } from './foliage'
import { GENERATOR_LOOKS, Vegetation } from './material'
import { type CompiledRule, compileRules, PROP, type SetSource } from './rules'
import { ScatterSet, type ScatterSetValue } from './set'
import {
  type ChunkPlacements,
  P_CELL,
  P_ITEM,
  P_QX,
  P_RADIUS,
  P_SCALE,
  P_VARIANT,
  P_X,
  PLACEMENT_STRIDE,
  type PlacementJob,
  type Surface,
  type SurfaceChunk,
} from './surface'

/** Frames between wanting a chunk's placements and having them, pool or not (deterministic). */
export const PLACEMENT_DELAY = 2
/** A spawned chunk despawns once no viewer is within this many times its rule's range. */
const KEEP = 1.15

/** One mesh an item places: a generator variant (with LODs) or a prefab. */
export interface ItemVariant {
  request: GenRequest | undefined
  mesh: AssetRef<'Mesh'> | null
  lods: AssetRef<'Mesh'>[]
  prefab: AssetRef<'Prefab'> | null
  material: AssetRef<'Material'> | null
  /** Bounds height and lowest point (m, before scale). */
  height: number
  minY: number
  /** Footprint radius before scale (m). */
  radius: number
  /** Half extents and center of the bounds (cuboid colliders). */
  half: [number, number, number]
  mid: [number, number, number]
  ready: boolean
  /** The components every prop of this variant spawns with (made on first spawn). */
  parts?: unknown[]
}

/** One rule's chunk: its placements, its job while placing, and its entity while spawned. */
export interface ChunkState {
  id: string
  chunk: SurfaceChunk
  /** Placements before `avoid`. */
  raw: ChunkPlacements | undefined
  /** Placements with `avoid` applied: what spawns. */
  placements: ChunkPlacements | undefined
  job: PlacementJob | undefined
  root: Entity
  /** Frame a viewer last had it within range (spawn) and within KEEP × range (keep). */
  wanted: number
  kept: number
  distance: number
  /** Frame last touched (cache order). */
  used: number
  spawned: number
  /** The next placement to spawn: a chunk spawns over several frames within the budget. */
  next: number
  /** The avoided rules' chunks around it (placed before it spawns). */
  deps?: ChunkState[]
  /** Frame another chunk last needed its placements (for `avoid`). */
  needed?: number
}

/** A chunk's state before anything is placed or spawned. */
export function chunkState(
  id: string,
  chunk: SurfaceChunk,
  frame: number,
  distance = Number.POSITIVE_INFINITY,
): ChunkState {
  return {
    id,
    chunk,
    raw: undefined,
    placements: undefined,
    job: undefined,
    root: -1 as Entity,
    wanted: -1,
    kept: -1,
    distance,
    used: frame,
    spawned: 0,
    next: 0,
  }
}

export interface RuleStats {
  chunks: number
  placed: number
  spawned: number
  candidates: number
}

/** A surface's scatter state: compiled rules, item meshes, chunks, jobs. */
export class SurfaceScatter {
  readonly surface: Surface
  /** What the compiled rules came from (sets as JSON, seeds, planet contents). */
  key = ''
  /** The surface's content version last refreshed against. */
  content = ''
  problem: ShardError | null = null
  waiting: string | null = null
  /** [rule][item][variant] */
  variants: ItemVariant[][][] = []
  readonly chunks = new Map<string, ChunkState>()
  /** Chunks spawned or waiting to, by id. */
  ready = false
  readonly stats: RuleStats[] = []
  /** Foliage rules' GPU layers (with a renderer), by rule index, and the rules' version they're for. */
  readonly foliage = new Map<number, FoliageRule>()
  foliageVersion = -1
  /** Props spawned and despawned last frame, main-thread ms of the scatter system. */
  spawnedLast = 0
  despawnedLast = 0
  ms = 0
  /** Main-thread ms spawning and despawning props last frame. */
  spawnMs = 0

  constructor(surface: Surface) {
    this.surface = surface
  }
}

/** Every surface's scatter state and the frame counter. */
export class ScatterState {
  readonly surfaces = new Map<Entity, SurfaceScatter>()
  frame = 0
  workers: Workers | undefined
  /** Set when an asset (re)loaded: surfaces re-resolve their sets. */
  dirty = true
  /** True while scatter despawns its own chunks (so props aren't recorded as removed). */
  despawning = false
  /** Default vegetation materials, per generator name. */
  readonly materials = new Map<string, AssetRef<'Material'>>()
  /** Props despawned outside scatter since the last frame (checked, then recorded as removed). */
  readonly pendingRemovals: { rule: string; chunk: string; index: number; root: Entity }[] = []
}

export const Scatter = defineResource<ScatterState>('scatter/Scatter', {
  description: 'Per-surface scatter state: compiled rules, placed chunks, spawned props.',
  init: () => new ScatterState(),
})

/** A loaded asset, undefined for no handle, or null while it loads (the load starts here). */
export function resolveAsset<T>(
  world: World,
  ref: AssetRef | null | undefined,
  get: (guid: string) => T | undefined,
): T | undefined | null {
  if (!ref || (ref.guid === undefined && ref.path === undefined)) return undefined
  if (ref.guid !== undefined) {
    const v = get(ref.guid)
    if (v !== undefined) return v
  }
  const server = assetServer(world)
  const entry = server.entry(ref)
  if (!entry) return null
  if (entry.state === 'failed') return null
  const v = get(entry.guid)
  if (v !== undefined) return v
  void server.request(entry.guid).catch(() => {})
  return null
}

const refName = (ref: AssetRef | null | undefined) => ref?.path ?? ref?.guid ?? '(none)'

/** The sets a planet scatters: its own, then each biome's (where that biome dominates). */
export function planetSources(
  world: World,
  rt: PlanetRuntime,
): { sources: SetSource[]; waiting: string | null } {
  const sets = world.initResource(ScatterSet.store)
  const sources: SetSource[] = []
  const own = world.get(rt.entity, Planet).scatter
  const set = resolveAsset(world, own, (g) => sets.get({ guid: g }) as ScatterSetValue | undefined)
  if (set === null) return { sources, waiting: `scatter set ${refName(own)}` }
  if (set) sources.push({ path: refName(own), set, biome: -1 })
  const biomes = rt.set?.biomes ?? []
  for (let b = 0; b < rt.biomes.length; b++) {
    const ref = rt.biomes[b]?.scatter
    const bs = resolveAsset(world, ref, (g) => sets.get({ guid: g }) as ScatterSetValue | undefined)
    if (bs === null) return { sources, waiting: `scatter set ${refName(ref)}` }
    if (bs) sources.push({ path: `${refName(biomes[b])}>${refName(ref)}`, set: bs, biome: b })
  }
  return { sources, waiting: null }
}

/** Whether a planet scatters anything (its own set, or any biome's). */
export function planetScatters(world: World, rt: PlanetRuntime): boolean {
  if (world.get(rt.entity, Planet).scatter) return true
  for (const b of rt.biomes) if (b?.scatter) return true
  return false
}

/**
 * Brings a surface's compiled rules and item meshes up to date. Cheap when nothing changed (a key
 * compare). Returns whether it can place.
 */
export function refreshSurface(
  world: World,
  ss: SurfaceScatter,
  sources: SetSource[],
  seed: number,
  contentKey: string,
): boolean {
  const key = JSON.stringify([sources.map((s) => [s.path, s.biome, s.set]), seed, contentKey])
  if (key !== ss.key) {
    ss.key = key
    ss.problem = null
    clearChunks(world, ss)
    let rules: CompiledRule[]
    try {
      rules = compileRules(sources, seed)
    } catch (err) {
      ss.problem = err as ShardError
      world.tryResource(LogResource)?.error(err as ShardError)
      configure(ss, [], [])
      return false
    }
    const masks: (NoiseGraph | undefined)[] = rules.map(() => undefined)
    configure(ss, rules, masks)
    ss.variants = rules.map((rule) => rule.items.map((item) => variantsOf(world, rule, item)))
    ss.stats.length = 0
    for (let i = 0; i < rules.length; i++)
      ss.stats.push({ chunks: 0, placed: 0, spawned: 0, candidates: 0 })
    ss.ready = false
  }
  if (ss.problem) return false
  // Masks and item meshes: everything placement and spawning read, loaded.
  ss.waiting = null
  const rules = ss.surface.rules
  const graphs = world.initResource(NoiseGraphs)
  const masks: (NoiseGraph | undefined)[] = []
  for (const rule of rules) {
    const g = resolveAsset(world, rule.noise, (guid) => graphs.get({ guid } as never) as NoiseGraph)
    if (g === null) {
      ss.waiting = `noise mask ${refName(rule.noise)} of rule "${rule.name}"`
      return false
    }
    masks.push(g)
  }
  if (masks.some((m, i) => m !== ss.surface.masks[i])) configure(ss, rules as CompiledRule[], masks)
  if (!ss.ready) {
    const meshes = world.initResource(Meshes)
    for (const [r, items] of ss.variants.entries()) {
      for (const variants of items) {
        for (const v of variants) {
          if (v.ready) continue
          if (v.prefab) {
            v.ready = true
            continue
          }
          const mesh = resolveAsset(world, v.mesh, (g) => meshes.get({ guid: g } as never) as Mesh)
          if (!mesh) {
            ss.waiting = `${refName(v.mesh)} (rule "${rules[r]!.name}")`
            continue
          }
          measure(v, mesh)
          v.lods = lodRefs(world, v)
          // Lod draws once every level is loaded: load them all before spawning.
          let lods = true
          for (const lod of v.lods) {
            if (!resolveAsset(world, lod, (g) => meshes.get({ guid: g } as never) as Mesh)) {
              ss.waiting = `${refName(lod)} (rule "${rules[r]!.name}")`
              lods = false
            }
          }
          if (!lods) continue
          v.ready = true
        }
      }
    }
    if (ss.waiting) return false
    ss.ready = true
  }
  return true
}

function configure(ss: SurfaceScatter, rules: CompiledRule[], masks: (NoiseGraph | undefined)[]) {
  ss.surface.configure(rules, masks, ss.surface.version + 1)
}

/** An item's variants: generator requests (seeds are the rule seed's children) or its prefab. */
function variantsOf(
  world: World,
  rule: CompiledRule,
  item: CompiledRule['items'][number],
): ItemVariant[] {
  const out: ItemVariant[] = []
  const blank = () => ({
    request: undefined,
    mesh: null,
    lods: [],
    prefab: null,
    material: item.material as AssetRef<'Material'> | null,
    height: 1,
    minY: 0,
    radius: item.radius || (rule.spacing > 0 ? rule.spacing / 2 : 0.5),
    half: [0.5, 0.5, 0.5] as [number, number, number],
    mid: [0, 0.5, 0] as [number, number, number],
    ready: false,
  })
  if (item.prefab) {
    const v: ItemVariant = { ...blank(), prefab: item.prefab as AssetRef<'Prefab'> }
    v.height = v.radius * 2
    out.push(v)
    return out
  }
  const gen = findGenerator(item.generator)
  if (!gen) {
    throw new ShardError('procgen/unknown-generator', `No generator named "${item.generator}"`, {
      hint: 'Engine generators: shard/Rock, shard/Tree, shard/Bush, shard/GrassClump, shard/Crystal.',
    })
  }
  if (gen.output !== 'mesh') {
    throw new ShardError(
      'scatter/item-not-mesh',
      `Rule "${rule.name}" places ${gen.name}, which makes ${gen.output}, not a mesh`,
      { hint: 'Scatter items are mesh generators or prefabs.' },
    )
  }
  for (let i = 0; i < item.variants; i++) {
    const request = requestOf(gen, item.params, hashSeed(rule.seed, i))
    const entry = procgen(world).entryFor(request)
    out.push({
      ...blank(),
      request,
      mesh: { type: 'Mesh', guid: entry.guid, path: entry.path },
      material: (item.material as AssetRef<'Material'> | null) ?? defaultMaterial(world, gen.name),
    })
  }
  return out
}

/** The engine's look for a generator's items (scatter/Vegetation), made once per world. */
export function defaultMaterial(world: World, generator: string): AssetRef<'Material'> | null {
  const state = world.resource(Scatter)
  let ref = state.materials.get(generator)
  if (ref) return ref
  const look = GENERATOR_LOOKS[generator] ?? GENERATOR_LOOKS['shard/Rock']!
  const material = new MaterialAsset(
    {
      baseTint: look.baseTint,
      tipTint: look.tipTint,
      roughness: look.roughness,
      sway: look.sway,
      doubleSided: look.doubleSided ?? false,
    },
    Vegetation,
  )
  ref = world.initResource(Materials).add(material, `scatter/${generator}`) as AssetRef<'Material'>
  state.materials.set(generator, ref)
  return ref
}

function measure(v: ItemVariant, mesh: Mesh): void {
  const b = mesh.bounds
  v.height = Math.max(1e-3, b[4]! - b[1]!)
  v.minY = b[1]!
  v.radius ||= 0
  const r = Math.max(Math.abs(b[0]!), Math.abs(b[3]!), Math.abs(b[2]!), Math.abs(b[5]!))
  if (!(v.radius > 0) || v.request) v.radius = r
  v.half = [(b[3]! - b[0]!) / 2, (b[4]! - b[1]!) / 2, (b[5]! - b[2]!) / 2]
  v.mid = [(b[3]! + b[0]!) / 2, (b[4]! + b[1]!) / 2, (b[5]! + b[2]!) / 2]
}

/** The variant's LOD sub-assets (`#LOD1`, …) that its generator made. */
function lodRefs(world: World, v: ItemVariant): AssetRef<'Mesh'>[] {
  if (!v.request || !v.mesh) return []
  const record = procgen(world).recordOf(v.mesh.guid!)
  const out: AssetRef<'Mesh'>[] = []
  const labels = (record?.assets ?? [])
    .map((a) => a.label)
    .filter((l) => /^LOD\d+$/.test(l))
    .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)))
  for (const label of labels) {
    const e = procgen(world).entryFor(v.request, label)
    out.push({ type: 'Mesh', guid: e.guid, path: e.path })
  }
  return out
}

/** Despawns every chunk and forgets placements (rules or the surface changed). */
export function clearChunks(world: World, ss: SurfaceScatter): void {
  const state = world.resource(Scatter)
  state.despawning = true
  try {
    for (const c of ss.chunks.values()) {
      if (c.job) c.job.cancelled = true
      if (c.root >= 0 && world.isAlive(c.root)) world.despawn(c.root)
    }
  } finally {
    state.despawning = false
  }
  ss.chunks.clear()
}

// --- the frame ---------------------------------------------------------------------------------

const viewers = { points: new Float64Array(24), cameras: 0, anchors: 0 }
const order: ChunkState[] = []
const deps: ChunkState[] = []

/**
 * One frame of a surface's props (spec 0045): which chunks viewers want, placement (on the pool,
 * finished inline when due), `avoid`, then spawning nearest first within the budget and despawning
 * what's out of range. Deterministic: the same viewers give the same entities on every host.
 */
export function updateProps(
  world: World,
  ss: SurfaceScatter,
  frame: number,
  budget: ScatterBudgetValue,
  workers: Workers | undefined,
): void {
  const surface = ss.surface
  surface.viewers(world, viewers)
  const total = viewers.cameras + viewers.anchors
  for (const rule of surface.rules) {
    if (rule.kind !== PROP) continue
    const s = ss.stats[rule.index]!
    s.chunks = 0
    surface.chunksNear(rule, viewers.points, 0, total, rule.range * KEEP, (chunk, distance) => {
      const id = `${rule.index}|${chunk.key}`
      let c = ss.chunks.get(id)
      if (!c) {
        c = chunkState(id, chunk, frame, distance)
        ss.chunks.set(id, c)
      }
      if (c.kept !== frame) {
        c.kept = frame
        c.distance = distance
        s.chunks++
      } else c.distance = Math.min(c.distance, distance)
      if (distance <= rule.range) c.wanted = frame
      c.used = frame
    })
  }
  // Chunks of rules that avoid others need the avoided rules' chunks around them placed first:
  // they're wanted too (placed on the pool like any other), so spawning never places inline.
  deps.length = 0
  for (const c of ss.chunks.values()) {
    if (c.wanted !== frame) continue
    const rule = surface.rules[c.chunk.rule]!
    if (rule.avoid.length === 0) continue
    c.deps ??= rule.avoid.flatMap((a) => neighborChunks(ss, surface.rules[a]!, c.chunk, frame))
    for (const d of c.deps) deps.push(d)
  }
  for (const d of deps) {
    d.used = frame
    if (d.wanted !== frame) d.needed = frame
  }
  // Start placements, nearest first.
  order.length = 0
  for (const c of ss.chunks.values()) {
    if ((c.wanted === frame || c.needed === frame) && !c.raw && !c.job) order.push(c)
  }
  order.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
  for (let i = 0; i < order.length && i < budget.chunksPerFrame; i++) {
    const c = order[i]!
    c.job = surface.startPlacement(c.chunk, frame + PLACEMENT_DELAY, workers)
  }
  // Finish due (or answered) jobs, in a fixed order so inline work is the same every run.
  order.length = 0
  for (const c of ss.chunks.values()) if (c.job && c.job.due <= frame) order.push(c)
  order.sort((a, b) => (a.id < b.id ? -1 : 1))
  for (const c of order) finish(ss, c)
  // Spawn: chunks wanted and placed that aren't fully spawned, nearest first, within the budget.
  order.length = 0
  for (const c of ss.chunks.values()) {
    if (c.wanted !== frame || !c.raw) continue
    if (c.deps && !c.deps.every((d) => d.raw)) continue
    if (c.root < 0 || (c.placements && c.next < c.placements.count)) order.push(c)
  }
  order.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : 1))
  let spawned = 0
  const t0 = performance.now()
  for (const c of order) {
    if (spawned >= budget.propsPerFrame) break
    const fp = finalPlacements(ss, c, frame)
    spawned += spawnChunk(world, ss, c, fp, budget.propsPerFrame - spawned)
  }
  ss.spawnedLast = spawned
  // Despawn what no viewer keeps; trim the cache of placed chunks.
  let despawned = 0
  const state = world.resource(Scatter)
  state.despawning = true
  try {
    for (const c of ss.chunks.values()) {
      if (c.root >= 0 && c.kept !== frame) {
        if (world.isAlive(c.root)) world.despawn(c.root)
        despawned += c.spawned
        ss.stats[c.chunk.rule]!.spawned -= c.spawned
        c.root = -1 as Entity
        c.spawned = 0
        c.next = 0
      }
    }
  } finally {
    state.despawning = false
  }
  ss.spawnMs = performance.now() - t0
  ss.despawnedLast = despawned
  if (ss.chunks.size > budget.cache) trimCache(ss, budget.cache, frame)
}

function finish(ss: SurfaceScatter, c: ChunkState): void {
  const job = c.job!
  c.job = undefined
  if (job.cancelled) return
  c.raw = ss.surface.finishPlacement(job)
  const s = ss.stats[c.chunk.rule]!
  s.placed += c.raw.count
  s.candidates += c.raw.candidates
}

/** A chunk's placements before `avoid`, placed inline now if they aren't yet. */
function rawPlacements(ss: SurfaceScatter, c: ChunkState, frame: number): ChunkPlacements {
  if (!c.raw) {
    if (!c.job) c.job = ss.surface.startPlacement(c.chunk, frame, undefined)
    finish(ss, c)
  }
  return c.raw!
}

const probe = new Float64Array(3)
const tangent = new Float64Array(3)

/**
 * A chunk's placements with `avoid` applied: anything within an avoided item's footprint is
 * dropped. The avoided rules' chunks around it are placed first (inline if they aren't yet).
 */
export function finalPlacements(ss: SurfaceScatter, c: ChunkState, frame: number): ChunkPlacements {
  if (c.placements) return c.placements
  const raw = rawPlacements(ss, c, frame)
  const rule = ss.surface.rules[c.chunk.rule]!
  fillRadii(ss, raw)
  if (rule.avoid.length === 0 || raw.count === 0) {
    c.placements = raw
    return raw
  }
  const keep = new Uint8Array(raw.count).fill(1)
  // The avoided items that can reach this chunk, relative to its center (most of the neighbors'
  // items can't): then each candidate tests only those.
  const near: number[] = []
  const cx = c.chunk.center[0]!
  const cy = c.chunk.center[1]!
  const cz = c.chunk.center[2]!
  // How far from the center this chunk's candidates reach (chunks aren't square on a sphere).
  let extent = 0
  for (let i = 0; i < raw.count; i++) {
    const o = i * PLACEMENT_STRIDE
    const x = raw.data[o + P_X]!
    const y = raw.data[o + P_X + 1]!
    const z = raw.data[o + P_X + 2]!
    extent = Math.max(extent, x * x + y * y + z * z)
  }
  extent = Math.sqrt(extent)
  for (const a of rule.avoid) {
    const avoided = ss.surface.rules[a]!
    for (const other of c.deps ?? neighborChunks(ss, avoided, c.chunk, frame)) {
      if (other.chunk.rule !== a) continue
      const op = finalPlacements(ss, other, frame)
      fillRadii(ss, op)
      for (let j = 0; j < op.count; j++) {
        const oo = j * PLACEMENT_STRIDE
        const ox = other.chunk.center[0]! + op.data[oo + P_X]! - cx
        const oy = other.chunk.center[1]! + op.data[oo + P_X + 1]! - cy
        const oz = other.chunk.center[2]! + op.data[oo + P_X + 2]! - cz
        const r = op.data[oo + P_RADIUS]!
        const reach = extent + r
        if (ox * ox + oy * oy + oz * oz > reach * reach) continue
        near.push(ox, oy, oz, r)
      }
    }
  }
  // Candidates sorted along their widest axis: each avoided item tests only the slice within its
  // radius along it.
  let lo0 = Infinity
  let hi0 = -Infinity
  let lo1 = Infinity
  let hi1 = -Infinity
  let lo2 = Infinity
  let hi2 = -Infinity
  for (let i = 0; i < raw.count; i++) {
    const o = i * PLACEMENT_STRIDE + P_X
    lo0 = Math.min(lo0, raw.data[o]!)
    hi0 = Math.max(hi0, raw.data[o]!)
    lo1 = Math.min(lo1, raw.data[o + 1]!)
    hi1 = Math.max(hi1, raw.data[o + 1]!)
    lo2 = Math.min(lo2, raw.data[o + 2]!)
    hi2 = Math.max(hi2, raw.data[o + 2]!)
  }
  const axis = hi0 - lo0 >= hi1 - lo1 && hi0 - lo0 >= hi2 - lo2 ? 0 : hi1 - lo1 >= hi2 - lo2 ? 1 : 2
  const order = new Int32Array(raw.count)
  const coord = new Float64Array(raw.count)
  for (let i = 0; i < raw.count; i++) order[i] = i
  order.sort(
    (a, b) =>
      raw.data[a * PLACEMENT_STRIDE + P_X + axis]! - raw.data[b * PLACEMENT_STRIDE + P_X + axis]!,
  )
  for (let i = 0; i < raw.count; i++)
    coord[i] = raw.data[order[i]! * PLACEMENT_STRIDE + P_X + axis]!
  for (let k = 0; k < near.length; k += 4) {
    const ox = near[k]!
    const oy = near[k + 1]!
    const oz = near[k + 2]!
    const r = near[k + 3]!
    const r2 = r * r
    const along = axis === 0 ? ox : axis === 1 ? oy : oz
    // First candidate at or past along − r.
    let a = 0
    let b = raw.count
    while (a < b) {
      const m = (a + b) >> 1
      if (coord[m]! < along - r) a = m + 1
      else b = m
    }
    for (let s = a; s < raw.count && coord[s]! <= along + r; s++) {
      const i = order[s]!
      if (!keep[i]) continue
      const o = i * PLACEMENT_STRIDE
      const dx = raw.data[o + P_X]! - ox
      const dy = raw.data[o + P_X + 1]! - oy
      const dz = raw.data[o + P_X + 2]! - oz
      if (dx * dx + dy * dy + dz * dz < r2) keep[i] = 0
    }
  }
  let n = 0
  const data = new Float32Array(raw.data.length)
  for (let i = 0; i < raw.count; i++) {
    if (!keep[i]) continue
    data.set(
      raw.data.subarray(i * PLACEMENT_STRIDE, (i + 1) * PLACEMENT_STRIDE),
      n * PLACEMENT_STRIDE,
    )
    n++
  }
  c.placements = { chunk: raw.chunk, count: n, data, candidates: raw.candidates }
  return c.placements
}

/** Footprint radii from the items' bounds, times each placement's scale. */
function fillRadii(ss: SurfaceScatter, p: ChunkPlacements): void {
  const variants = ss.variants[p.chunk.rule]!
  for (let i = 0; i < p.count; i++) {
    const o = i * PLACEMENT_STRIDE
    const v = variants[p.data[o + P_ITEM]!]![p.data[o + P_VARIANT]!]!
    p.data[o + P_RADIUS] = v.radius * p.data[o + P_SCALE]!
  }
}

/** The avoided rule's chunks that could hold an item reaching into `chunk`. */
export function neighborChunks(
  ss: SurfaceScatter,
  avoided: CompiledRule,
  chunk: SurfaceChunk,
  frame: number,
): ChunkState[] {
  const out = new Map<string, ChunkState>()
  const surface = ss.surface
  let reach = 0
  for (const items of ss.variants[avoided.index]!)
    for (const v of items) reach = Math.max(reach, v.radius * avoided.scaleMax)
  const span = chunk.extent + reach
  surface.upAt(chunk.center[0]!, chunk.center[1]!, chunk.center[2]!, probe)
  // A 5×5 grid of probes over the chunk and its margin, in its tangent plane.
  const ux = probe[0]!
  const uy = probe[1]!
  const uz = probe[2]!
  const ax = Math.abs(uy) < 0.9 ? 0 : 1
  const ay = Math.abs(uy) < 0.9 ? 1 : 0
  let e1x = ay * uz
  let e1y = -ax * uz
  let e1z = ax * uy - ay * ux
  const l = Math.sqrt(e1x * e1x + e1y * e1y + e1z * e1z) || 1
  e1x /= l
  e1y /= l
  e1z /= l
  tangent[0] = uy * e1z - uz * e1y
  tangent[1] = uz * e1x - ux * e1z
  tangent[2] = ux * e1y - uy * e1x
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      const s = span / 2
      const x = chunk.center[0]! + (e1x * i + tangent[0]! * j) * s
      const y = chunk.center[1]! + (e1y * i + tangent[1]! * j) * s
      const z = chunk.center[2]! + (e1z * i + tangent[2]! * j) * s
      const found = surface.chunkAt(avoided, x, y, z)
      const id = `${avoided.index}|${found.key}`
      if (out.has(id)) continue
      let c = ss.chunks.get(id)
      if (!c) {
        c = chunkState(id, found, frame)
        ss.chunks.set(id, c)
      }
      out.set(id, c)
    }
  }
  return [...out.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

/**
 * Spawns up to `allowance` more of a chunk's props, under its root entity (made on the first
 * call). A chunk can take several frames; the order is fixed, so which frame a prop appears on
 * depends only on the frames, never on timing. Returns how many it spawned.
 */
function spawnChunk(
  world: World,
  ss: SurfaceScatter,
  c: ChunkState,
  p: ChunkPlacements,
  allowance: number,
): number {
  const rule = ss.surface.rules[c.chunk.rule]!
  const variants = ss.variants[rule.index]!
  const removed = world.initResource(Removed)
  if (c.root < 0) {
    c.root = world.spawn(
      [ScatterChunk, { surface: ss.surface.entity, rule: rule.id, chunk: c.chunk.key }],
      Transform,
      Visibility,
      Derived,
    )
    ss.surface.placeChunkRoot(world, c.root, c.chunk)
    c.next = 0
  }
  let n = 0
  while (c.next < p.count && n < allowance) {
    const i = c.next++
    const o = i * PLACEMENT_STRIDE
    const index = p.data[o + P_CELL]!
    if (isRemoved(removed, removedKey(rule.id, c.chunk.key, index))) continue
    const v = variants[p.data[o + P_ITEM]!]![p.data[o + P_VARIANT]!]!
    const s = p.data[o + P_SCALE]!
    const qx = p.data[o + P_QX]!
    const qy = p.data[o + P_QX + 1]!
    const qz = p.data[o + P_QX + 2]!
    const qw = p.data[o + P_QX + 3]!
    // The item's up axis: +Y rotated by its rotation.
    const ux = 2 * (qx * qy - qw * qz)
    const uy = 1 - 2 * (qx * qx + qz * qz)
    const uz = 2 * (qy * qz + qw * qx)
    const sink = rule.sink * v.height * s
    const transform = {
      translation: [
        p.data[o + P_X]! - ux * sink,
        p.data[o + P_X + 1]! - uy * sink,
        p.data[o + P_X + 2]! - uz * sink,
      ] as [number, number, number],
      rotation: [qx, qy, qz, qw] as [number, number, number, number],
      scale: [s, s, s] as [number, number, number],
    }
    // Every component in one spawn: adding more after moves the entity between tables.
    v.parts ??= partsOf(rule, v)
    const parts = v.parts
    spawnAll(world, [
      ...parts,
      [Transform, transform],
      [Prop, { index }],
      [ChildOf, { parent: c.root }],
    ])
    n++
  }
  c.spawned += n
  ss.stats[rule.index]!.spawned += n
  return n
}

/** What every prop of a variant has: its mesh (or prefab), LODs, range, collider, tags. */
function partsOf(rule: CompiledRule, v: ItemVariant): SpawnPart[] {
  const parts: SpawnPart[] = [Generated, Derived]
  if (v.prefab) {
    parts.push([PrefabInstance, { prefab: v.prefab }])
    return parts
  }
  parts.push(
    [Mesh3d, { mesh: v.mesh }],
    [MeshMaterial, { material: v.material }],
    [VisibilityRange, { start: 0, end: rule.range }],
  )
  if (v.lods.length > 0) {
    const levels = [{ mesh: v.mesh, screenSize: 0.12 }]
    const sizes = [0.04, 0]
    for (let l = 0; l < v.lods.length; l++)
      levels.push({ mesh: v.lods[l]!, screenSize: sizes[Math.min(l, sizes.length - 1)]! })
    levels[levels.length - 1]!.screenSize = 0
    parts.push([Lod, { levels }])
  }
  const collider = colliderOf(rule, v)
  if (collider) parts.push([Collider, collider])
  return parts
}

/** A component a prop spawns with: a tag, or a definition and its value. */
type SpawnPart = unknown

/** world.spawn over a built list (its parameters are typed per call site). */
const spawnAll = (world: World, parts: readonly unknown[]): Entity =>
  (world.spawn as (...parts: unknown[]) => Entity)(...parts)

function colliderOf(rule: CompiledRule, v: ItemVariant): Record<string, unknown> | undefined {
  switch (rule.collider) {
    case 'none':
      return undefined
    case 'convex':
      return v.mesh ? { shape: 'convex', mesh: v.lods.at(-1) ?? v.mesh } : undefined
    case 'trimesh':
      return v.mesh ? { shape: 'trimesh', mesh: v.lods[0] ?? v.mesh } : undefined
    case 'ball':
      return { shape: 'ball', radius: Math.max(v.radius, v.height / 2) * 0.8 }
    case 'cuboid':
      return { shape: 'cuboid', halfExtents: v.half }
  }
}

/** Drops the least recently used placed chunks that aren't spawned. */
function trimCache(ss: SurfaceScatter, size: number, frame: number): void {
  const idle: ChunkState[] = []
  for (const c of ss.chunks.values()) if (c.root < 0 && !c.job && c.used !== frame) idle.push(c)
  idle.sort((a, b) => a.used - b.used || (a.id < b.id ? -1 : 1))
  for (let i = 0; i < idle.length && ss.chunks.size > size; i++) {
    const c = idle[i]!
    if (c.raw) {
      const s = ss.stats[c.chunk.rule]!
      s.placed -= c.raw.count
      s.candidates -= c.raw.candidates
    }
    ss.chunks.delete(c.id)
  }
}
