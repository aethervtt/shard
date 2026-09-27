import { ChildOf, Derived, type Entity, type Query, type World } from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import { NavAgent, NavSource } from '@aethervtt/shard-nav'
import { sampleNoiseAsync } from '@aethervtt/shard-noise'
import { CharacterController, Collider, PhysicsParked, RigidBody } from '@aethervtt/shard-physics'
import type { Workers } from '@aethervtt/shard-platform'
import { Meshes } from '@aethervtt/shard-render'
import {
  GlobalTransform,
  placeInGrid,
  propagateSubtree,
  Transform,
} from '@aethervtt/shard-transform'
import { assembleChunk, buildChunk, type ChunkMesh, type ChunkSpec, chunkLayout } from './chunk'
import { Chunk, PlanetNav, TerrainAnchor } from './components'
import { faceToDirection, keyString, nodeAt, nodeExtent } from './cube'
import type { PlanetRuntime } from './planet'
import { type ChunkPoints, createChunkPoints, prepareChunkPoints } from './points'

/** Frames between asking for a collider chunk and it appearing. Always this many, pool or not. */
export const COLLIDER_DELAY = 2

/** A cached collider chunk: its CPU mesh, the collider mesh, and its entity while wanted. */
export interface ColliderChunk {
  key: string
  face: number
  depth: number
  x: number
  y: number
  mesh: ChunkMesh
  /** Surface triangles (no skirts), sharing the mesh's positions. */
  collider: Mesh
  colliderRef: { guid: string | undefined; path: string | undefined; type: 'Mesh' }
  /** The collider entity, or −1 while not wanted. */
  entity: Entity
  /** Planet version it was built for. */
  version: number
  /** Frame it was last wanted. */
  used: number
}

interface ColliderJob {
  key: string
  face: number
  depth: number
  x: number
  y: number
  /** Frame it becomes a chunk. */
  due: number
  version: number
  pts: ChunkPoints | undefined
  values: Float32Array | undefined
  temps: Float32Array | undefined
  moist: Float32Array | undefined
  /** All pool results are in. */
  ready: boolean
  cancelled: boolean
}

/** A planet's collider chunks and the jobs making them. */
export class ColliderSet {
  readonly chunks = new Map<string, ColliderChunk>()
  readonly jobs = new Map<string, ColliderJob>()
  /** Keys wanted this frame, sorted. */
  wanted: string[] = []
  /** Chunks built on the main thread because the pool hadn't finished by the due frame. */
  builtSync = 0
  /** Chunks finished from pool results. */
  builtPool = 0
}

export function collidersOf(planet: PlanetRuntime): ColliderSet {
  let set = planet.parts.get('colliders') as ColliderSet | undefined
  if (!set) {
    set = new ColliderSet()
    planet.parts.set('colliders', set)
  }
  return set
}

export interface AnchorQueries {
  anchors: Query
  characters: Query
  bodies: Query
  agents: Query
}

export function anchorQueries(world: World): AnchorQueries {
  return {
    anchors: world.query({ with: [TerrainAnchor, GlobalTransform] }),
    characters: world.query({ with: [CharacterController, GlobalTransform] }),
    bodies: world.query({ with: [RigidBody, GlobalTransform], without: [PhysicsParked] }),
    agents: world.query({ with: [NavAgent, GlobalTransform] }),
  }
}

const seen = new Set<Entity>()
const scratch = new Float64Array(3)

/**
 * Anchors near the planet this frame, in the planet frame: every TerrainAnchor (unless disabled),
 * character, and awake dynamic body, with its reach.
 */
export function gatherAnchors(world: World, planet: PlanetRuntime, q: AnchorQueries): void {
  const s = planet.settings!
  seen.clear()
  planet.anchors = 0
  planet.anchorEntity.length = 0
  const add = (entity: Entity, m: Float32Array, row: number, radius: number) => {
    if (seen.has(entity)) return
    seen.add(entity)
    planet.frame.pointToPlanet(m[row * 12 + 3]!, m[row * 12 + 7]!, m[row * 12 + 11]!, scratch)
    // Too high above the surface to need colliders.
    const d = Math.sqrt(scratch[0]! ** 2 + scratch[1]! ** 2 + scratch[2]! ** 2)
    const top = s.radius * Math.max(s.shape[0]!, s.shape[1]!, s.shape[2]!) + planet.highest
    if (d - top > radius) return
    const i = planet.anchors++
    if (planet.anchorPos.length < planet.anchors * 3) {
      const pos = new Float64Array(planet.anchors * 6)
      pos.set(planet.anchorPos)
      planet.anchorPos = pos
      const r = new Float64Array(planet.anchors * 2)
      r.set(planet.anchorRadius)
      planet.anchorRadius = r
    }
    planet.anchorPos[i * 3] = scratch[0]!
    planet.anchorPos[i * 3 + 1] = scratch[1]!
    planet.anchorPos[i * 3 + 2] = scratch[2]!
    planet.anchorRadius[i] = radius
    planet.anchorEntity.push(entity)
  }
  for (const table of q.anchors.tables) {
    const enabled = table.column(TerrainAnchor, 'enabled')
    const radius = table.column(TerrainAnchor, 'radius')
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      const entity = table.entities[row]!
      if (!enabled[row]) {
        seen.add(entity)
        continue
      }
      add(entity, m, row, radius[row]! > 0 ? radius[row]! : s.colliderRadius)
    }
  }
  // Navigation agents need ground (and navmesh) out to PlanetNav's radius.
  if (world.has(planet.entity, PlanetNav)) {
    const reach = Math.max(s.colliderRadius, world.get(planet.entity, PlanetNav).radius)
    for (const table of q.agents.tables) {
      const m = table.column(GlobalTransform, 'matrix') as Float32Array
      for (let row = 0; row < table.count; row++) add(table.entities[row]!, m, row, reach)
    }
  }
  for (const table of q.characters.tables) {
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) add(table.entities[row]!, m, row, s.colliderRadius)
  }
  for (const table of q.bodies.tables) {
    const kind = table.column(RigidBody, 'kind')
    const m = table.column(GlobalTransform, 'matrix') as Float32Array
    for (let row = 0; row < table.count; row++) {
      if (kind[row] !== 0) continue // dynamic only
      add(table.entities[row]!, m, row, s.colliderRadius)
    }
  }
}

const node = new Float64Array(3)
const dir = new Float64Array(3)
const wantedKeys = new Set<string>()

/** The collider nodes within reach of the planet's anchors, as sorted keys. */
export function wantedColliders(planet: PlanetRuntime): string[] {
  wantedKeys.clear()
  const s = planet.settings!
  const depth = planet.colliderDepth
  const n = 2 ** depth
  const ext = nodeExtent(depth)
  const size = planet.spacing(depth) * (s.resolution - 1)
  for (let i = 0; i < planet.anchors; i++) {
    const ax = planet.anchorPos[i * 3]!
    const ay = planet.anchorPos[i * 3 + 1]!
    const az = planet.anchorPos[i * 3 + 2]!
    const r = planet.anchorRadius[i]!
    const len = Math.sqrt(ax * ax + ay * ay + az * az)
    if (len === 0) continue
    nodeAt(ax / len, ay / len, az / len, depth, node)
    const face = node[0]!
    const cx = node[1]!
    const cy = node[2]!
    const k = Math.ceil(r / size) + 1
    for (let dj = -k; dj <= k; dj++) {
      for (let di = -k; di <= k; di++) {
        let f = face
        let x = cx + di
        let y = cy + dj
        if (x < 0 || y < 0 || x >= n || y >= n) {
          // Past the face edge: the node on the next face under the extrapolated center.
          faceToDirection(face, -1 + (x + 0.5) * ext, -1 + (y + 0.5) * ext, dir)
          nodeAt(dir[0]!, dir[1]!, dir[2]!, depth, node)
          f = node[0]!
          x = node[1]!
          y = node[2]!
        }
        faceToDirection(f, -1 + (x + 0.5) * ext, -1 + (y + 0.5) * ext, dir)
        // Nearest the node gets to the anchor: its center column at the anchor's height, less its
        // half-diagonal.
        const px = dir[0]! * len * s.shape[0]! - ax
        const py = dir[1]! * len * s.shape[1]! - ay
        const pz = dir[2]! * len * s.shape[2]! - az
        if (Math.sqrt(px * px + py * py + pz * pz) - size * 0.75 > r) continue
        wantedKeys.add(keyString(f, depth, x, y))
      }
    }
  }
  return [...wantedKeys].sort()
}

function specFor(
  planet: PlanetRuntime,
  face: number,
  depth: number,
  x: number,
  y: number,
): ChunkSpec {
  const s = planet.settings!
  return {
    face,
    depth,
    x,
    y,
    radius: s.radius,
    shape: s.shape,
    heightScale: s.heightScale,
    seed: s.seed,
    resolution: s.resolution,
    height: planet.height,
    climate: planet.climate,
    morphError: planet.errors[depth] ?? 0,
    skirtDepth: skirtDepth(planet, depth),
  }
}

/** How far skirts hang: past any morph mismatch between neighbors at this depth (true errors). */
export function skirtDepth(planet: PlanetRuntime, depth: number): number {
  return 2 * (planet.rawErrors[Math.max(0, depth - 1)] ?? 0) + planet.spacing(depth)
}

/**
 * Keeps the planet's collider chunks around its anchors (spec 0043): a chunk is asked for when an
 * anchor comes within reach and appears exactly COLLIDER_DELAY frames later, from pool results when
 * they're in and built on the main thread when they aren't, so which frame it appears never depends
 * on thread timing (the world hash is the same on every host). Unwanted chunks lose their entity
 * but stay cached (least recently used first out).
 */
export function updateColliders(
  world: World,
  planet: PlanetRuntime,
  workers: Workers | undefined,
  frame: number,
  cacheSize: number,
): void {
  const set = collidersOf(planet)
  if (!planet.ready) return
  const wanted = wantedColliders(planet)
  set.wanted = wanted
  const keep = new Set(wanted)
  for (const key of wanted) {
    const chunk = set.chunks.get(key)
    if (chunk && chunk.version === planet.version) {
      chunk.used = frame
      if (chunk.entity < 0) spawnCollider(world, planet, chunk)
      continue
    }
    let job = set.jobs.get(key)
    if (job && job.version !== planet.version) {
      job.cancelled = true
      set.jobs.delete(key)
      job = undefined
    }
    if (!job) {
      const [face, depth, x, y] = key.split('/').map(Number) as [number, number, number, number]
      job = startJob(planet, workers, key, face, depth, x, y, frame + COLLIDER_DELAY)
      set.jobs.set(key, job)
    }
    if (frame < job.due) continue
    set.jobs.delete(key)
    const spec = specFor(planet, job.face, job.depth, job.x, job.y)
    let mesh: ChunkMesh
    if (job.ready && job.pts && job.values && job.temps && job.moist) {
      mesh = assembleChunk(spec, job.pts, job.values, job.temps, job.moist)
      set.builtPool++
    } else {
      job.cancelled = true
      mesh = buildChunk(spec)
      set.builtSync++
    }
    const next = makeChunk(world, key, job, mesh, planet.version, frame)
    if (chunk) replaceChunk(world, chunk)
    set.chunks.set(key, next)
    spawnCollider(world, planet, next)
  }
  for (const [key, job] of set.jobs) {
    if (!keep.has(key)) {
      job.cancelled = true
      set.jobs.delete(key)
    }
  }
  for (const chunk of set.chunks.values()) {
    if (!keep.has(chunk.key) && chunk.entity >= 0) despawnCollider(world, chunk)
  }
  if (set.chunks.size > cacheSize) {
    const idle = [...set.chunks.values()]
      .filter((c) => c.entity < 0)
      .sort((a, b) => a.used - b.used || (a.key < b.key ? -1 : 1))
    for (let i = 0; i < idle.length && set.chunks.size > cacheSize; i++) {
      dropChunk(world, idle[i]!)
      set.chunks.delete(idle[i]!.key)
    }
  }
}

function startJob(
  planet: PlanetRuntime,
  workers: Workers | undefined,
  key: string,
  face: number,
  depth: number,
  x: number,
  y: number,
  due: number,
): ColliderJob {
  const job: ColliderJob = {
    key,
    face,
    depth,
    x,
    y,
    due,
    version: planet.version,
    pts: undefined,
    values: undefined,
    temps: undefined,
    moist: undefined,
    ready: false,
    cancelled: false,
  }
  if (!workers || workers.size === 0) return job
  const s = planet.settings!
  const pts = prepareChunkPoints(face, depth, x, y, s.resolution, s.radius, createChunkPoints())
  job.pts = pts
  const count = pts.count
  job.values = new Float32Array(count)
  job.temps = new Float32Array(count)
  job.moist = new Float32Array(count)
  const parts: Promise<void>[] = []
  const origin = new Float64Array(4)
  for (let g = 0; g < pts.groups; g++) {
    const a = pts.start[g]!
    const b = pts.start[g + 1]!
    const local = new Float32Array((b - a) * 3)
    for (let i = a; i < b; i++) {
      const k = pts.order[i]!
      local[(i - a) * 3] = pts.local[k * 3]!
      local[(i - a) * 3 + 1] = pts.local[k * 3 + 1]!
      local[(i - a) * 3 + 2] = pts.local[k * 3 + 2]!
    }
    origin[0] = pts.origins[g * 4]!
    origin[1] = pts.origins[g * 4 + 1]!
    origin[2] = pts.origins[g * 4 + 2]!
    const o = Float64Array.from(origin)
    const scatter = (target: Float32Array) => (values: Float32Array) => {
      for (let i = a; i < b; i++) target[pts.order[i]!] = values[i - a]!
    }
    const run = (graph: typeof planet.height, target: Float32Array, node?: string) => {
      if (!graph) return
      const out = new Float32Array(b - a)
      parts.push(
        sampleNoiseAsync(workers, graph, s.seed, local, out, {
          origin: o,
          ...(node ? { node } : {}),
        }).then(() => scatter(target)(out)),
      )
    }
    run(planet.height, job.values)
    run(planet.climate, job.temps, 'temperature')
    run(planet.climate, job.moist, 'moisture')
  }
  Promise.all(parts).then(
    () => {
      if (!job.cancelled) job.ready = true
    },
    () => {
      // A failed job builds on the main thread at its due frame.
    },
  )
  return job
}

function makeChunk(
  world: World,
  key: string,
  job: ColliderJob,
  mesh: ChunkMesh,
  version: number,
  frame: number,
): ColliderChunk {
  const layout = chunkLayout(Math.round(Math.sqrt(mesh.heights.length)))
  const collider = Mesh.create({ positions: mesh.data.positions, indices: layout.surfaceIndices })
  const colliderRef = world.initResource(Meshes).add(collider, `terrain/collider/${key}`)
  return {
    key,
    face: job.face,
    depth: job.depth,
    x: job.x,
    y: job.y,
    mesh,
    collider,
    colliderRef: colliderRef as ColliderChunk['colliderRef'],
    entity: -1 as Entity,
    version,
    used: frame,
  }
}

function spawnCollider(world: World, planet: PlanetRuntime, chunk: ColliderChunk): void {
  const e = world.spawn(
    [RigidBody, { kind: 'fixed' }],
    [Collider, { shape: 'trimesh', mesh: chunk.colliderRef }],
    [Chunk, { planet: planet.entity, key: chunk.key, kind: 'collider' }],
    [ChildOf, { parent: planet.entity }],
    Transform,
    Derived,
  )
  if (world.has(planet.entity, PlanetNav)) world.add(e, NavSource)
  placeInGrid(world, e, planet.entity, chunk.mesh.center)
  propagateSubtree(world, e)
  chunk.entity = e
}

function despawnCollider(world: World, chunk: ColliderChunk): void {
  if (world.isAlive(chunk.entity)) world.despawn(chunk.entity)
  chunk.entity = -1 as Entity
}

/** A rebuilt chunk replaces a stale one: the old collider goes away. */
function replaceChunk(world: World, chunk: ColliderChunk): void {
  despawnCollider(world, chunk)
  dropChunk(world, chunk)
}

function dropChunk(world: World, chunk: ColliderChunk): void {
  if (chunk.colliderRef.guid) world.initResource(Meshes).delete(chunk.colliderRef.guid)
}

/** Drops every collider chunk (planet despawned). */
export function clearColliders(world: World, planet: PlanetRuntime): void {
  const set = collidersOf(planet)
  for (const chunk of set.chunks.values()) replaceChunk(world, chunk)
  for (const job of set.jobs.values()) job.cancelled = true
  set.chunks.clear()
  set.jobs.clear()
}
