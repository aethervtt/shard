import {
  type AssetRef,
  ChildOf,
  Derived,
  defineSystem,
  type Entity,
  ProfilerResource,
  type Query,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Mesh } from '@aethervtt/shard-mesh'
import { computeOrigins } from '@aethervtt/shard-noise'
import {
  Camera3d,
  Cameras,
  DebugOverlays,
  GpuAssetsResource,
  Graph,
  InstanceData,
  isOverlayOn,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  NotShadowCaster,
  NotShadowReceiver,
  RenderPhase,
  Shaders,
  Visibility,
} from '@aethervtt/shard-render'
import type { App } from '@aethervtt/shard-runtime'
import { Time } from '@aethervtt/shard-runtime'
import { Texture, Textures, toHalf } from '@aethervtt/shard-texture'
import {
  GlobalTransform,
  placeInGrid,
  propagateSubtree,
  Transform,
} from '@aethervtt/shard-transform'
import { chunkCenter, chunkIndices, chunkLayout } from './chunk'
import { type ColliderChunk, collidersOf, skirtDepth } from './colliders'
import { Chunk, TerrainBudget } from './components'
import { keyString } from './cube'
import { Terrain } from './heights'
import {
  GEN_CLIMATE,
  GEN_HEIGHT,
  GEN_OCEAN,
  GEN_ROOT,
  type KernelGraph,
  kernelGraph,
  PARAMS_BYTES,
  POINT_FLOATS,
  registerKernel,
} from './kernel'
import { OceanMaterial, PlanetMaterial, TERRAIN_SHADERS, TEXTURE_PERIOD } from './material'
import type { PlanetRuntime } from './planet'
import { createChunkPoints, prepareChunkPoints, SNAP } from './points'
import { NODE_READY, type NodeTree, type SelectionParams, selectNodes } from './quadtree'
import { createView, perspectiveView } from './view'

const TERRAIN = 0
const OCEAN = 1
const NONE = -1

/**
 * One render chunk: an entity drawing its range of an arena's vertex buffers, which a GPU job
 * writes (or a collider chunk's vertices are copied into).
 */
interface Slot {
  id: number
  kind: number
  mesh: Mesh
  meshRef: AssetRef
  entity: Entity
  /** Tree node it holds, or −1. */
  node: number
  /** Edge lock bits (two per edge), fade, and InstanceData.x (fade + 2 × mask) now. */
  bits: number
  fade: number
  packed: number
  /** The collider chunk whose vertices it holds (source 1). */
  cpu: ColliderChunk | undefined
  /** Frame it was last rendered. */
  used: number
  shown: boolean
  /** Where its vertices came from: 0 a GPU job, 1 a collider chunk (the collider's own numbers). */
  source: number
  /** The index set drawn: quadrant mask + 16 × stitched edges (`chunkIndices`). */
  indexKey: number
  /** A job for it is queued. */
  pending: boolean
  /** Its GPU mesh holds this node at this planet version (−1: nothing valid). */
  gpuNode: number
  gpuVersion: number
  /** Increments per job, so a late readback for an older job is ignored. */
  jobId: number
  center: Float64Array
}

/** A grid a job samples: its points, their origins per graph, and the kernel's uniform. */
interface JobGrid {
  count: number
  points: Float32Array
  originsH: Int32Array
  originsT: Int32Array
  originsM: Int32Array
  params: ArrayBuffer
}

interface Job extends JobGrid {
  slot: Slot
  id: number
  tree: NodeTree
  node: number
  kind: number
  version: number
  /** Only the normal tile (the slot shows a collider chunk's own vertices). */
  normalsOnly: boolean
  /** The normal tile's grid (twice the vertex density), with tiles on. */
  fine: JobGrid | undefined
}

interface GridResources {
  params: GPUBuffer
  points: GPUBuffer
  pointsSize: number
  values: GPUBuffer
  valuesSize: number
  origins: (GPUBuffer | undefined)[]
  originSizes: number[]
}

interface GpuJobResources extends GridResources {
  stats: GPUBuffer
  fine: GridResources
}

/** GPU state of one planet's generation: kernels and per-job buffers (one set per job per frame). */
interface PlanetGpu {
  gpu: GpuContext
  generation: number
  resources: GpuJobResources[]
  readbacks: GPUBuffer[]
}

/** Render-side state of one planet. */
export class PlanetRender {
  readonly slots: Slot[] = []
  /** Vertex buffers shared by ARENA_SLOTS slots each, so chunks draw without rebinding. */
  readonly arenas: Mesh[] = []
  material: MaterialAsset
  materialRef: AssetRef<'Material'>
  ocean: MaterialAsset
  oceanRef: AssetRef<'Material'>
  biomeTexture: Texture | undefined
  biomeRef: AssetRef | undefined
  biomeVersion = -1
  /** Every slot's normal tile (TILE_LAYER² layers of `tileGeometry` tiles), grown with the pool. */
  tiles: Texture | undefined
  tilesRef: AssetRef | undefined
  jobs: Job[] = []
  /** Each tree's walk stamp last frame (what was on screen then). */
  lastStamp = [0, 0]
  readonly view = createView()
  /** The selecting camera in the origin frame (xyz) and pixels per radian / errorPixels (w). */
  readonly camera = new Float32Array(4)
  hasCamera = false
  gpu: PlanetGpu | undefined
  /**
   * The planet version on screen. After an edit (hot reload) every chunk keeps its old contents
   * until the new kernels compile; then every visible chunk regenerates in one frame, so old and
   * new never meet at a seam.
   */
  shownVersion = -1
  /** The version whose generation pipelines are compiled. */
  kernelsReady = -1
  /** Jobs per generation pass (moving average), to turn the pass's GPU time into ms per job. */
  jobsPerPass = 0
  /** GPU milliseconds per job, from timestamp queries (0: not measured). */
  msPerJob = 0
  /** Kernel graphs, refreshed with the planet's version. */
  kernels: { version: number; terrain: KernelGraph[]; ocean: KernelGraph[] } | undefined
  stats = {
    generated: 0,
    fromColliders: 0,
    readbacks: 0,
    evicted: 0,
    locks: 0,
    gpuFrames: 0,
    lastFrameJobs: 0,
  }
  private jobCounter = 0

  constructor(world: World) {
    this.material = new MaterialAsset({ roughness: 0.9, baseColor: [1, 1, 1, 1] }, PlanetMaterial)
    this.materialRef = world.resource(Materials).add(this.material, 'terrain/planet')
    this.ocean = new MaterialAsset({ roughness: 0.05, baseColor: [1, 1, 1, 1] }, OceanMaterial)
    this.oceanRef = world.resource(Materials).add(this.ocean, 'terrain/ocean')
  }

  nextJobId(): number {
    return ++this.jobCounter
  }
}

export function renderOf(world: World, rt: PlanetRuntime): PlanetRender {
  let r = rt.parts.get('render') as PlanetRender | undefined
  if (!r) {
    r = new PlanetRender(world)
    rt.parts.set('render', r)
  }
  return r
}

// --- selection ---------------------------------------------------------------------------------

const camPos = new Float64Array(3)
const right = new Float64Array(3)
const up = new Float64Array(3)
const forward = new Float64Array(3)

function normalize3(v: Float64Array): void {
  const l = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!) || 1
  v[0] = v[0]! / l
  v[1] = v[1]! / l
  v[2] = v[2]! / l
}

/** The camera that drives selection: the active one with the lowest `order`, then the lowest entity. */
function pickCamera(q: Query): { entity: Entity; table: number; row: number } | undefined {
  let best: { entity: Entity; table: number; row: number } | undefined
  let bestOrder = Infinity
  for (let t = 0; t < q.tables.length; t++) {
    const table = q.tables[t]!
    const order = table.column(Camera3d, 'order')
    const active = table.column(Camera3d, 'active')
    for (let row = 0; row < table.count; row++) {
      if (active[row] === 0) continue
      const o = order[row]!
      const e = table.entities[row]!
      if (o < bestOrder || (o === bestOrder && best && e < best.entity)) {
        bestOrder = o
        best = { entity: e, table: t, row }
      }
    }
  }
  return best
}

function updateView(world: World, rt: PlanetRuntime, pr: PlanetRender, camera: Entity): void {
  const m = world.get(camera, GlobalTransform).matrix
  const cam = world.get(camera, Camera3d)
  const data = world.tryResource(Cameras)?.get(camera)
  // In CSS pixels (0051): errorPixels means the same on a Retina display as on any other, and
  // doesn't move with the render scale (which would feed back into the scale's own controller).
  const height = data && data.height > 1 ? data.displayHeight / data.pixelRatio : 720
  const aspect = data && data.height > 1 ? data.width / data.height : 16 / 9
  const fovY = (cam.fovY * Math.PI) / 180
  rt.frame.pointToPlanet(m[3]!, m[7]!, m[11]!, camPos)
  rt.frame.vectorToPlanet(m[0]!, m[4]!, m[8]!, right)
  rt.frame.vectorToPlanet(m[1]!, m[5]!, m[9]!, up)
  rt.frame.vectorToPlanet(-m[2]!, -m[6]!, -m[10]!, forward)
  normalize3(right)
  normalize3(up)
  normalize3(forward)
  perspectiveView(pr.view, camPos, right, up, forward, fovY, aspect, height)
  pr.camera[0] = m[3]!
  pr.camera[1] = m[7]!
  pr.camera[2] = m[11]!
  pr.camera[3] = pr.view.pixelsPerRadian / (rt.settings!.errorPixels * rt.lodBias)
}

function selectionParams(rt: PlanetRuntime, kind: number): SelectionParams {
  const s = rt.settings!
  const minShape = Math.min(s.shape[0]!, s.shape[1]!, s.shape[2]!)
  const lowest = kind === TERRAIN ? rt.lowest : s.seaLevel
  return {
    maxDepth: rt.maxDepth,
    errors: kind === TERRAIN ? rt.errors : rt.oceanErrors,
    errorPixels: s.errorPixels * rt.lodBias,
    occluder: Math.max(0, s.radius * minShape + Math.min(lowest, rt.lowest)),
    colliderDepth: kind === TERRAIN ? rt.colliderDepth : rt.maxDepth,
    anchorPos: rt.anchorPos,
    anchorRadius: rt.anchorRadius,
    anchors: kind === TERRAIN ? rt.anchors : 0,
  }
}

/** Triangles one terrain chunk draws (its surface; skirts are thin). */
const chunkTriangles = (n: number) => 2 * (n - 1) * (n - 1)

/**
 * Steers the planet's LOD bias toward TerrainBudget.triangles: up 1% a frame while over it, back
 * down 0.5% a frame once under 85% of it, never below 1 (the planet's own settings) or above 16.
 * Slow on purpose: the bias moves split distances, so morphs shift with it (2× in about a second).
 */
function adaptDetail(rt: PlanetRuntime, triangles: number): void {
  const drawn = rt.selection.renderedCount * chunkTriangles(rt.settings!.resolution)
  if (triangles > 0 && drawn > triangles) rt.lodBias = Math.min(16, rt.lodBias * 1.01)
  else if (triangles <= 0 || drawn < triangles * 0.85) rt.lodBias = Math.max(1, rt.lodBias / 1.005)
}

/**
 * Chooses each planet's chunks for the selecting camera (spec 0043): walks both quadtrees, gives
 * new nodes pool slots and queues their GPU jobs within the frame's budget (nodes at collider depth
 * near anchors show the collider chunk's own vertices instead, with no job), shows exactly the
 * selected chunks, writes edge locks, and refreshes the planet's materials.
 */
export const selectChunks = defineSystem({
  name: 'terrain/select',
  description:
    'Selects each Planet’s chunks for the camera (screen-space error, horizon and frustum culling, 2:1 balance), queues their GPU generation within TerrainBudget, and shows exactly the selected ones.',
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, GlobalTransform] }) }),
  run: (s, world) => {
    if (!world.tryResource(GpuAssetsResource)) return
    const state = world.resource(Terrain)
    const frame = state.frame
    const budget = world.resource(TerrainBudget)
    let jobs = budget.chunksPerFrame
    // GPU time: where timestamps measure it, fewer jobs when chunksPerFrame would exceed msPerFrame.
    if (frame % 30 === 0) {
      const timing = world.tryResource(ProfilerResource)?.timing('gpu:terrain/generate')
      for (const rt of state.planets.values()) {
        const pr = rt.parts.get('render') as PlanetRender | undefined
        if (pr && timing && pr.jobsPerPass > 0) pr.msPerJob = timing.avg / pr.jobsPerPass
      }
    }
    for (const rt of state.planets.values()) {
      const pr = rt.parts.get('render') as PlanetRender | undefined
      if (pr && pr.msPerJob > 0)
        jobs = Math.min(jobs, Math.max(1, Math.floor(budget.msPerFrame / pr.msPerJob)))
    }
    // Jobs still queued (kernels compiling) count against this frame's.
    for (const rt of state.planets.values()) {
      const pr = rt.parts.get('render') as PlanetRender | undefined
      if (pr) jobs -= pr.jobs.length
    }
    const picked = pickCamera(s.cameras)
    for (const rt of state.planets.values()) {
      if (!rt.ready || !world.isAlive(rt.entity)) continue
      const pr = renderOf(world, rt)
      updateMaterials(world, rt, pr)
      if (!picked) {
        pr.hasCamera = false
        hideAll(world, pr, frame)
        continue
      }
      pr.hasCamera = true
      updateView(world, rt, pr, picked.entity)
      selectNodes(rt.tree, pr.view, selectionParams(rt, TERRAIN), frame, rt.selection)
      adaptDetail(rt, budget.triangles)
      const ocean = rt.settings!.ocean
      if (ocean)
        selectNodes(rt.ocean, pr.view, selectionParams(rt, OCEAN), frame, rt.oceanSelection)
      const hold = syncVersion(rt, pr)
      jobs -= queueJobs(
        world,
        rt,
        pr,
        rt.tree,
        TERRAIN,
        rt.selection,
        frame,
        jobs,
        budget.pool,
        hold,
      )
      if (ocean)
        jobs -= queueJobs(
          world,
          rt,
          pr,
          rt.ocean,
          OCEAN,
          rt.oceanSelection,
          frame,
          jobs,
          budget.pool,
          hold,
        )
      showSelected(world, rt, pr, frame)
      if (frame % 120 === 0) {
        const release = (n: number) => releaseNode(pr, rt.tree, n)
        rt.tree.prune(frame - 600, release)
        rt.ocean.prune(frame - 600, (n) => releaseNode(pr, rt.ocean, n))
      }
    }
  },
})

/**
 * Whether the planet's new version must wait (true) because chunks with the old one are on screen
 * and its kernels aren't compiled yet. When it stops waiting, nodes with old contents that aren't
 * on screen lose their ready flag (they'd meet new ones at seams), and the ones on screen all
 * regenerate this frame (queueJobs).
 */
function syncVersion(rt: PlanetRuntime, pr: PlanetRender): boolean {
  if (pr.shownVersion === rt.version) return false
  let shown = false
  for (const slot of pr.slots) {
    if (slot.shown) {
      shown = true
      break
    }
  }
  if (shown && pr.kernelsReady !== rt.version) return true
  pr.shownVersion = rt.version
  const trees = [rt.tree, rt.ocean] as const
  const stamps = [rt.selection.stamp, rt.oceanSelection.stamp] as const
  for (let kind = 0; kind < 2; kind++) {
    const tree = trees[kind]!
    for (let n = 0; n < tree.count; n++) {
      if (
        !(tree.flags[n]! & NODE_READY) ||
        tree.gen[n] === rt.version ||
        tree.rendered[n] === stamps[kind]
      )
        continue
      const slot = pr.slots[tree.slot[n]!]
      if (slot?.pending) continue
      tree.flags[n]! &= ~NODE_READY
    }
  }
  return false
}

function releaseNode(pr: PlanetRender, tree: NodeTree, n: number): void {
  const id = tree.slot[n]!
  if (id === NONE) return
  const slot = pr.slots[id]
  if (slot && slot.node === n) {
    slot.node = NONE
    slot.gpuNode = NONE
  }
  tree.slot[n] = NONE
}

function hideAll(world: World, pr: PlanetRender, frame: number): void {
  for (const slot of pr.slots) if (slot.shown) setShown(world, slot, false, frame)
}

function setShown(world: World, slot: Slot, shown: boolean, frame: number): void {
  if (shown) slot.used = frame
  if (slot.shown === shown) return
  slot.shown = shown
  world.set(slot.entity, Visibility, { mode: shown ? 'inherit' : 'hidden' })
}

/** A free slot, a new one while under the pool size, or the least recently shown idle one. */
/** Frames a chunk must go unused before a speculative request (prefetch) may evict it. */
const IDLE_FRAMES = 60

function acquireSlot(
  world: World,
  rt: PlanetRuntime,
  pr: PlanetRender,
  kind: number,
  frame: number,
  pool: number,
  needed: boolean,
): Slot | undefined {
  for (const slot of pr.slots)
    if (slot.node === NONE && slot.kind === kind && !slot.pending) return slot
  if (pr.slots.length < pool) return makeSlot(world, rt, pr, kind)
  const tree = kind === TERRAIN ? rt.tree : rt.ocean
  // Never what's on screen or blocking a split this frame; idle nodes before prefetched ones
  // (generated ahead, or out of view), least recently shown first. A speculative request (prefetch,
  // out of view) only takes a chunk idle for IDLE_FRAMES: with a full pool, prefetches evicting
  // each other would regenerate the same chunks every frame.
  let best: Slot | undefined
  let bestRank = 0
  for (const slot of pr.slots) {
    if (slot.kind !== kind || slot.pending) continue
    let rank = 0
    if (slot.node !== NONE) {
      if (tree.neededAt[slot.node]! >= frame) continue
      if (!needed && tree.used[slot.node]! > frame - IDLE_FRAMES) continue
      rank = tree.used[slot.node]! >= frame ? 1 : 0
    }
    if (!best || rank < bestRank || (rank === bestRank && slot.used < best.used)) {
      best = slot
      bestRank = rank
    }
  }
  if (!best) return undefined
  if (best.node !== NONE) {
    tree.slot[best.node] = NONE
    tree.flags[best.node]! &= ~NODE_READY
  }
  best.node = NONE
  best.gpuNode = NONE
  pr.stats.evicted++
  return best
}

/** Slots per shared vertex arena. */
const ARENA_SLOTS = 256

/** Side of a normal-tile layer (texels). */
const TILE_LAYER = 2048

/**
 * A chunk's normal tile: its grid at twice the vertex density (2(n − 1) + 1 texels a side), and how
 * many fit a layer. Off above 33 vertices per edge: those chunks are dense already, and uv1.x
 * (grid point + n² × tile) must stay exact in f32.
 */
export function tileGeometry(n: number): { size: number; perRow: number; perLayer: number } {
  const size = n <= 33 ? 2 * (n - 1) + 1 : 0
  const perRow = size > 0 ? Math.floor(TILE_LAYER / size) : 1
  return { size, perRow, perLayer: perRow * perRow }
}

/**
 * Vertices a slot takes in its arena: its vertex count rounded up to 64, so every attribute's
 * range starts at a multiple of 256 bytes (storage binding offsets must).
 */
export const slotStride = (vertexCount: number) => Math.ceil(vertexCount / 64) * 64

function makeSlot(world: World, rt: PlanetRuntime, pr: PlanetRender, kind: number): Slot {
  const layout = chunkLayout(rt.settings!.resolution)
  const indices = rt.settings!.skirts ? layout.indices : layout.surfaceIndices
  const stride = slotStride(layout.vertexCount)
  const id = pr.slots.length
  const a = Math.floor(id / ARENA_SLOTS)
  pr.arenas[a] ??= Mesh.gpu({
    vertexCount: stride * ARENA_SLOTS,
    indices,
    bounds: [-1, -1, -1, 1, 1, 1],
  })
  const mesh = Mesh.gpu({
    vertexCount: layout.vertexCount,
    indices,
    bounds: [-1, -1, -1, 1, 1, 1],
    share: pr.arenas[a],
    baseVertex: (id % ARENA_SLOTS) * stride,
  })
  const meshRef = world.resource(Meshes).add(mesh, `terrain/chunk/${pr.slots.length}`)
  const entity = world.spawn(
    [Mesh3d, { mesh: meshRef }],
    [MeshMaterial, { material: kind === TERRAIN ? pr.materialRef : pr.oceanRef }],
    [Chunk, { planet: rt.entity, key: '', kind: kind === TERRAIN ? 'render' : 'ocean' }],
    [ChildOf, { parent: rt.entity }],
    [Visibility, { mode: 'hidden' }],
    [InstanceData, { x: 30, y: 0 }],
    Transform,
    Derived,
  )
  if (kind === OCEAN) {
    world.add(entity, NotShadowCaster)
    world.add(entity, NotShadowReceiver)
  }
  const slot: Slot = {
    id: pr.slots.length,
    kind,
    mesh,
    meshRef,
    entity,
    node: NONE,
    bits: 0,
    fade: 0,
    packed: 30,
    cpu: undefined,
    used: 0,
    shown: false,
    source: 0,
    indexKey: 15,
    pending: false,
    gpuNode: NONE,
    gpuVersion: -1,
    jobId: 0,
    center: new Float64Array(3),
  }
  pr.slots.push(slot)
  return slot
}

/** Moves a slot's entity to a node's chunk center and points it at the node. */
function assign(world: World, rt: PlanetRuntime, slot: Slot, tree: NodeTree, n: number): void {
  const s = rt.settings!
  slot.node = n
  tree.slot[n] = slot.id
  chunkCenter(tree.face[n]!, tree.depth[n]!, tree.x[n]!, tree.y[n]!, s.radius, s.shape, slot.center)
  if (slot.kind === OCEAN) {
    // The ocean surface sits at sea level: the center moves out with it.
    const k = (s.radius + s.seaLevel) / s.radius
    slot.center[0] = slot.center[0]! * k
    slot.center[1] = slot.center[1]! * k
    slot.center[2] = slot.center[2]! * k
  }
  placeInGrid(world, slot.entity, rt.entity, slot.center)
  propagateSubtree(world, slot.entity)
  world.set(slot.entity, Chunk, {
    planet: rt.entity,
    key: keyString(tree.face[n]!, tree.depth[n]!, tree.x[n]!, tree.y[n]!),
    kind: slot.kind === TERRAIN ? 'render' : 'ocean',
  })
  tree.bounds(n, slot.center, slot.mesh.bounds)
  slot.cpu = undefined
}

/** Draws the slot with the triangles for its quadrant mask and stitched edges. */
function setIndices(rt: PlanetRuntime, slot: Slot, mask: number, stitch: number): void {
  const key = mask + 16 * stitch
  if (key === slot.indexKey) return
  slot.indexKey = key
  const s = rt.settings!
  slot.mesh.setIndices(chunkIndices(s.resolution, mask, stitch, s.skirts))
}

/**
 * Shows a collider chunk's own vertices in a slot (what the character stands on is what you see):
 * copies them into the slot's range of its arena, replacing any job queued for it.
 */
function useCollider(
  world: World,
  rt: PlanetRuntime,
  pr: PlanetRender,
  slot: Slot,
  tree: NodeTree,
  n: number,
  chunk: ColliderChunk,
): void {
  if (slot.cpu === chunk && slot.source === 1) return
  const assets = world.resource(GpuAssetsResource)
  const gm = assets.mesh(slot.mesh)
  const queue = assets.gpu.device.queue
  const data = chunk.mesh.data
  const base = gm.baseVertex
  queue.writeBuffer(gm.positions, base * 12, data.positions)
  queue.writeBuffer(gm.normals, base * 12, data.normals!)
  queue.writeBuffer(gm.uvs, base * 8, data.uvs!)
  queue.writeBuffer(gm.uvs1, base * 8, withTile(data.uvs1!, rt.settings!.resolution, slot.id))
  queue.writeBuffer(gm.tangents, base * 16, data.tangents!)
  slot.cpu = chunk
  slot.source = 1
  slot.gpuNode = slot.node
  slot.gpuVersion = chunk.version
  // A queued job would overwrite it: drop it (encodePlanet skips jobs whose id moved on).
  slot.jobId = pr.nextJobId()
  slot.pending = false
  // Its normal tile still comes from the GPU (the collider chunk has vertex normals only).
  if (tileGeometry(rt.settings!.resolution).size > 0) queueJob(rt, pr, slot, tree, TERRAIN, n, true)
}

let tileScratch = new Float32Array(0)

/** A CPU chunk's uv1 (grid points, tile 0) drawn from a slot's tile: n² × tile added to x. */
function withTile(uvs1: Float32Array, resolution: number, tile: number): Float32Array {
  if (tileScratch.length < uvs1.length) tileScratch = new Float32Array(uvs1.length)
  const out = tileScratch.subarray(0, uvs1.length)
  const add = resolution * resolution * tile
  for (let i = 0; i < uvs1.length; i += 2) {
    out[i] = uvs1[i]! + add
    out[i + 1] = uvs1[i + 1]!
  }
  return out
}

/** The current collider chunk for a node, if it's at collider depth and one is built. */
function colliderFor(
  rt: PlanetRuntime,
  tree: NodeTree,
  kind: number,
  n: number,
): ColliderChunk | undefined {
  if (kind !== TERRAIN || tree.depth[n] !== rt.colliderDepth) return undefined
  const chunk = collidersOf(rt).chunks.get(
    keyString(tree.face[n]!, tree.depth[n]!, tree.x[n]!, tree.y[n]!),
  )
  return chunk && chunk.version === rt.version ? chunk : undefined
}

// Requests with collider chunks this frame, and the highest-priority others (reused).
let order = new Int32Array(256)
const best = new Int32Array(64)

/**
 * Gives requested nodes slots and queues GPU jobs for them (highest projected error first, at most
 * `budget`), then regenerates stale visible chunks. Returns jobs queued.
 */
function queueJobs(
  world: World,
  rt: PlanetRuntime,
  pr: PlanetRender,
  tree: NodeTree,
  kind: number,
  sel: typeof rt.selection,
  frame: number,
  budget: number,
  pool: number,
  hold: boolean,
): number {
  const count = sel.requestedCount
  if (order.length < count) order = new Int32Array(count * 2)
  // Requests with a collider chunk cost no job: all of them. The rest: the `budget` highest
  // priorities (kept sorted in `best`).
  const k = Math.max(0, Math.min(budget, best.length))
  let chunks = 0
  let top = 0
  for (let i = 0; i < count; i++) {
    const n = sel.requested[i]!
    if (tree.flags[n]! & NODE_READY) continue
    const existing = tree.slot[n]!
    if (existing !== NONE && pr.slots[existing]?.pending) continue
    if (!hold && colliderFor(rt, tree, kind, n)) {
      order[chunks++] = n
      continue
    }
    const p = tree.priority[n]!
    if (k === 0 || (top === k && tree.priority[best[top - 1]!]! >= p)) continue
    let j = top < k ? top++ : k - 1
    while (j > 0 && tree.priority[best[j - 1]!]! < p) {
      best[j] = best[j - 1]!
      j--
    }
    best[j] = n
  }
  let queued = 0
  for (let i = 0; i < chunks + top; i++) {
    const n = i < chunks ? order[i]! : best[i - chunks]!
    const existing = tree.slot[n]!
    const chunk = i < chunks ? colliderFor(rt, tree, kind, n) : undefined
    const needed = tree.neededAt[n]! >= frame
    const slot =
      existing !== NONE
        ? pr.slots[existing]!
        : acquireSlot(world, rt, pr, kind, frame, pool, needed)
    // No room for a prefetch: later (lower-priority) prefetches wouldn't find any either.
    if (!slot && !needed) continue
    if (!slot) break
    if (existing === NONE) assign(world, rt, slot, tree, n)
    if (chunk) {
      useCollider(world, rt, pr, slot, tree, n, chunk)
      tree.flags[n]! |= NODE_READY
      tree.gen[n] = rt.version
      tree.setHeights(n, chunk.mesh.minHeight, chunk.mesh.maxHeight)
      tree.bounds(n, slot.center, slot.mesh.bounds)
      pr.stats.fromColliders++
      continue
    }
    queueJob(rt, pr, slot, tree, kind, n)
    queued++
  }
  // Old contents on screen (a graph edit): all of them regenerate, outside the budget. Their jobs
  // wait while the new kernels compile (hold), then run in one frame, with the new collider
  // chunks' copies.
  for (let r = 0; r < sel.renderedCount; r++) {
    const n = sel.rendered[r]!
    if (tree.gen[n] === rt.version) continue
    const slot = pr.slots[tree.slot[n]!]
    if (!slot) continue
    if (!hold) {
      const chunk = colliderFor(rt, tree, kind, n)
      if (chunk) {
        useCollider(world, rt, pr, slot, tree, n, chunk)
        tree.gen[n] = rt.version
        continue
      }
    }
    if (!slot.pending) queueJob(rt, pr, slot, tree, kind, n)
    // Its ancestors too: the walk goes through them, and a merge shows them.
    for (let p = tree.parent[n]!; p !== NONE; p = tree.parent[p]!) {
      if (tree.gen[p] === rt.version || !(tree.flags[p]! & NODE_READY)) continue
      const ps = pr.slots[tree.slot[p]!]
      if (ps && !ps.pending) queueJob(rt, pr, ps, tree, kind, p)
    }
  }
  return queued
}

const jobPoints = createChunkPoints()

type Program = { terms: Parameters<typeof computeOrigins>[0]; zeroOrigins: Int32Array }

/**
 * A grid of a node for the kernels: the bordered points at `resolution` (the vertex grid, or the
 * normal tile's at twice the density), their origins for each graph, and the uniform.
 */
function jobGrid(
  rt: PlanetRuntime,
  slot: Slot,
  tree: NodeTree,
  n: number,
  resolution: number,
  programs: (Program | undefined)[],
  params: (pts: ReturnType<typeof prepareChunkPoints>, pu: Uint32Array, pf: Float32Array) => void,
  snap?: number,
): JobGrid {
  const s = rt.settings!
  const pts = prepareChunkPoints(
    tree.face[n]!,
    tree.depth[n]!,
    tree.x[n]!,
    tree.y[n]!,
    resolution,
    s.radius,
    jobPoints,
    snap,
  )
  const count = pts.count
  const points = new Float32Array(count * POINT_FLOATS)
  const u32 = new Uint32Array(points.buffer)
  const sx = s.shape[0]!
  const sy = s.shape[1]!
  const sz = s.shape[2]!
  for (let k = 0; k < count; k++) {
    const o = k * POINT_FLOATS
    const dx = pts.dirs[k * 3]!
    const dy = pts.dirs[k * 3 + 1]!
    const dz = pts.dirs[k * 3 + 2]!
    points[o] = pts.local[k * 3]!
    points[o + 1] = pts.local[k * 3 + 1]!
    points[o + 2] = pts.local[k * 3 + 2]!
    // q: the point at zero height relative to the chunk center; the kernel adds the height (the
    // ocean's sea level) along the direction.
    points[o + 3] = dx * sx * s.radius - slot.center[0]!
    points[o + 4] = dy * sy * s.radius - slot.center[1]!
    points[o + 5] = dz * sz * s.radius - slot.center[2]!
    points[o + 6] = dx
    points[o + 7] = dy
    points[o + 8] = dz
    u32[o + 9] = pts.group[k]!
  }
  const groups = pts.groups
  const origins = (program: Program | undefined) => {
    if (!program) return new Int32Array(0)
    const len = Math.max(8, program.zeroOrigins.length)
    const out = new Int32Array(groups * len)
    for (let g = 0; g < groups; g++) {
      computeOrigins(
        program.terms,
        pts.origins.subarray(g * 4, g * 4 + 4),
        out.subarray(g * len, g * len + program.zeroOrigins.length),
      )
    }
    return out
  }
  const buffer = new ArrayBuffer(PARAMS_BYTES)
  const pu = new Uint32Array(buffer)
  const pf = new Float32Array(buffer)
  pu[0] = count
  pu[1] = pts.side
  pu[5] = s.seed
  pf[8] = sx
  pf[9] = sy
  pf[10] = sz
  pf[11] = s.heightScale
  params(pts, pu, pf)
  return {
    count,
    points,
    originsH: origins(programs[0]),
    originsT: origins(programs[1]),
    originsM: origins(programs[2]),
    params: buffer,
  }
}

/**
 * The lattice a normal tile's points are grouped by: a quarter of the chunk (a power of two times
 * the vertex grid's SNAP), so a coarse chunk's tile is ~25 groups, not one per point. Its inputs
 * stay within a few km of their origins (~1 mm in f32); tiles don't need the vertex grid's
 * bit-identical edges.
 */
function tileSnap(rt: PlanetRuntime, depth: number): number {
  const size = rt.spacing(depth) * (rt.settings!.resolution - 1)
  let snap = SNAP
  while (snap * 4 < size) snap *= 2
  return snap
}

/**
 * Prepares a job's CPU data: the vertex grid (unless `normalsOnly`) and, with tiles on, the normal
 * tile's grid. Normal tiles need only the height graph.
 */
function queueJob(
  rt: PlanetRuntime,
  pr: PlanetRender,
  slot: Slot,
  tree: NodeTree,
  kind: number,
  n: number,
  normalsOnly = false,
): void {
  const s = rt.settings!
  const depth = tree.depth[n]!
  const height = rt.height?.program
  const temperature =
    kind === TERRAIN && rt.climate ? rt.climate.programFor('temperature') : undefined
  const moisture = kind === TERRAIN && rt.climate ? rt.climate.programFor('moisture') : undefined
  const vertexGrid = normalsOnly
    ? undefined
    : jobGrid(rt, slot, tree, n, s.resolution, [height, temperature, moisture], (_, pu, pf) => {
        pu[2] = s.resolution
        pu[3] = s.resolution * s.resolution
        pu[4] = 4 * (s.resolution - 1)
        pu[6] =
          (height ? GEN_HEIGHT : 0) |
          (temperature ? GEN_CLIMATE : 0) |
          (depth === 0 ? GEN_ROOT : 0) |
          (kind === OCEAN ? GEN_OCEAN : 0)
        pu[7] = slot.id
        pf[12] = kind === OCEAN ? s.seaLevel : 0
        pf[13] = depth === 0 ? 0 : (kind === TERRAIN ? rt.errors : rt.oceanErrors)[depth]!
        pf[14] = skirtDepth(rt, depth)
      })
  const tile = tileGeometry(s.resolution)
  const fine =
    kind === TERRAIN && tile.size > 0
      ? jobGrid(
          rt,
          slot,
          tree,
          n,
          tile.size,
          [height],
          (_, pu) => {
            // The tile's corner in its layer rides in surface (x) and ring (y); its layer in tile.
            const cell = slot.id % tile.perLayer
            pu[2] = tile.size
            pu[3] = (cell % tile.perRow) * tile.size
            pu[4] = Math.floor(cell / tile.perRow) * tile.size
            pu[6] = height ? GEN_HEIGHT : 0
            pu[7] = Math.floor(slot.id / tile.perLayer)
          },
          tileSnap(rt, depth),
        )
      : undefined
  if (normalsOnly && !fine) return
  slot.pending = true
  slot.jobId = pr.nextJobId()
  const empty = new Int32Array(0)
  pr.jobs.push({
    slot,
    id: slot.jobId,
    tree,
    node: n,
    kind,
    version: rt.version,
    normalsOnly,
    count: vertexGrid?.count ?? 0,
    points: vertexGrid?.points ?? new Float32Array(0),
    originsH: vertexGrid?.originsH ?? empty,
    originsT: vertexGrid?.originsT ?? empty,
    originsM: vertexGrid?.originsM ?? empty,
    params: vertexGrid?.params ?? new ArrayBuffer(PARAMS_BYTES),
    fine,
  })
}

/** Seconds a chunk takes to ease from its parent's shape to its own after replacing it. */
const FADE = 0.5

/**
 * Shows the selected chunks and nothing else, with their edge locks and fades in InstanceData: a
 * chunk that just replaced its parent starts fully morphed to the parent's shape (fade 1) and
 * eases to its own, so a split that happens late (children arriving after the camera got close)
 * slides instead of popping.
 */
function showSelected(world: World, rt: PlanetRuntime, pr: PlanetRender, frame: number): void {
  const dt = world.tryResource(Time)?.delta ?? 1 / 60
  const trees = [rt.tree, rt.ocean] as const
  const selections = [rt.selection, rt.oceanSelection] as const
  for (let kind = 0; kind < 2; kind++) {
    const tree = trees[kind]!
    const sel = selections[kind]!
    if (kind === OCEAN && !rt.settings!.ocean) continue
    const last = pr.lastStamp[kind]!
    for (let r = 0; r < sel.renderedCount; r++) {
      const n = sel.rendered[r]!
      const slot = pr.slots[tree.slot[n]!]
      if (!slot) continue
      // A collider chunk that appeared since the node was generated. (One that went away leaves
      // its copy, which is still this node's surface.)
      if (kind === TERRAIN && pr.shownVersion === rt.version) {
        const chunk = colliderFor(rt, tree, TERRAIN, n)
        if (chunk) useCollider(world, rt, pr, slot, tree, n, chunk)
      }
      let fade = slot.fade
      if (!slot.shown) {
        const parent = tree.parent[n]!
        fade = parent !== NONE && tree.rendered[parent] === last ? 1 : 0
      } else if (fade > 0) fade = Math.max(0, fade - dt / FADE)
      setShown(world, slot, true, frame)
      const mask = tree.mask[n]!
      const l = tree.locks
      const o = n * 4
      let bits = 0
      let stitch = 0
      for (let e = 0; e < 4; e++) {
        const lock = l[o + e]!
        bits |= (lock < 0 ? 0 : lock === 0 ? 1 : 2) << (e * 2)
        if (lock === 1) stitch |= 1 << e
      }
      setIndices(rt, slot, mask, stitch)
      // x: the fade plus twice the drawn-quadrant mask (the shader locks center lines where a
      // partial draw meets a child); y: two lock bits per edge.
      const packed = fade + 2 * mask
      if (bits !== slot.bits || fade !== slot.fade || packed !== slot.packed) {
        if (bits !== slot.bits) pr.stats.locks++
        slot.bits = bits
        slot.fade = fade
        slot.packed = packed
        world.set(slot.entity, InstanceData, { x: packed, y: bits })
      }
    }
    pr.lastStamp[kind] = sel.stamp
  }
  for (const slot of pr.slots) {
    if (slot.used === frame || !slot.shown) continue
    const tree = slot.kind === TERRAIN ? rt.tree : rt.ocean
    const sel = slot.kind === TERRAIN ? rt.selection : rt.oceanSelection
    if (slot.node === NONE || tree.rendered[slot.node] !== sel.stamp)
      setShown(world, slot, false, frame)
  }
}

// --- materials ---------------------------------------------------------------------------------

const origin = new Float64Array(3)

/** Keeps the planet's materials in step: biome table, texture arrays, and the per-frame frame. */
function updateMaterials(world: World, rt: PlanetRuntime, pr: PlanetRender): void {
  const s = rt.settings!
  if (pr.biomeVersion !== rt.biomeVersion) {
    pr.biomeVersion = rt.biomeVersion
    const table = rt.table
    const width = 6
    const data = new Float32Array(width * table.count * 4)
    for (let b = 0; b < table.count; b++) {
      const o = b * width * 4
      data.set(table.ranges.subarray(b * 12, b * 12 + 8), o)
      data.set(table.tints.subarray(b * 4, b * 4 + 4), o + 8)
      data[o + 12] = table.ranges[b * 12 + 8]!
      data[o + 13] = table.ranges[b * 12 + 9]!
      data.set(table.layers.subarray(b * 8, b * 8 + 4), o + 16)
      for (let l = 0; l < 4; l++) {
        // Scales nudged so a whole number of repeats fits in the texture period (no seams).
        const scale = table.layers[b * 8 + 4 + l]!
        data[o + 20 + l] = TEXTURE_PERIOD / Math.max(1, Math.round(TEXTURE_PERIOD / scale))
      }
    }
    const bytes = new Uint8Array(toHalf(data).buffer)
    const texture = Texture.create({
      width,
      height: table.count,
      format: 'rgba16float',
      usage: 'data',
      mips: [bytes],
    })
    const textures = world.initResource(Textures)
    if (pr.biomeRef?.guid) textures.delete(pr.biomeRef.guid)
    pr.biomeTexture = texture
    pr.biomeRef = textures.add(texture, 'terrain/biomes')
    const v = pr.material.value as Record<string, unknown>
    v.biomeTable = pr.biomeRef
    v.albedoArray = rt.set?.albedo ?? null
    v.normalArray = rt.set?.normal ?? null
    v.ormArray = rt.set?.orm ?? null
    let farthest = 4
    for (let b = 0; b < table.count; b++)
      for (let l = 0; l < 4; l++) farthest = Math.max(farthest, table.layers[b * 8 + 4 + l]!)
    v.biomeParams = [table.count, table.latitudeBias, table.snowLine, TEXTURE_PERIOD]
    v.debugParams = [debugMode(world), Math.max(200, farthest * 50), rt.set?.orm ? 1 : 0, 0]
    pr.material.version++
  }
  // The planet's frame and the camera move every frame; written straight to the GPU copies.
  const toPlanet = rt.frame.toPlanet
  rt.frame.pointToOrigin(0, 0, 0, origin)
  const period = TEXTURE_PERIOD
  const wrap = (v: number) => ((v % period) + period) % period
  for (const material of [pr.material, pr.ocean]) {
    const v = material.value as Record<string, number[]>
    v.center = [origin[0]!, origin[1]!, origin[2]!, s.radius]
    v.rot0 = [toPlanet[0]!, toPlanet[1]!, toPlanet[2]!, wrap(toPlanet[3]!)]
    v.rot1 = [toPlanet[4]!, toPlanet[5]!, toPlanet[6]!, wrap(toPlanet[7]!)]
    v.rot2 = [toPlanet[8]!, toPlanet[9]!, toPlanet[10]!, wrap(toPlanet[11]!)]
    v.camera = [pr.camera[0]!, pr.camera[1]!, pr.camera[2]!, pr.camera[3]!]
    // Normal tiles once the array exists (the ocean reads the resolution for its lock codes).
    const tile = tileGeometry(s.resolution)
    const on = pr.tiles !== undefined && material === pr.material && TerrainDebug.normalTiles
    v.tiles = [s.resolution, on ? tile.size : 0, tile.perRow, TILE_LAYER]
  }
  const debug = debugMode(world)
  const dp = (pr.material.value as Record<string, number[]>).debugParams!
  if (dp[0] !== debug) {
    dp[0] = debug
    pr.material.version++
  }
}

/**
 * Debug shading (0 off, 1 biomes, 2 seams, 3 levels, 4 normals), for tests and tools. The
 * terrain-biomes and terrain-lod overlays turn modes 1 and 3 on too.
 */
export const TerrainDebug = {
  mode: 0,
  /** False shades from vertex normals even where normal tiles exist (comparisons, tests). */
  normalTiles: true,
}

function debugMode(world: World): number {
  const o = world.tryResource(DebugOverlays)
  if (o && isOverlayOn(o, 'terrain-lod')) return 3
  if (o && isOverlayOn(o, 'terrain-biomes')) return 1
  return TerrainDebug.mode
}

// --- GPU ---------------------------------------------------------------------------------------

function planetGpu(pr: PlanetRender, gpu: GpuContext): PlanetGpu {
  if (!pr.gpu || pr.gpu.gpu !== gpu || pr.gpu.generation !== gpu.generation) {
    pr.gpu = { gpu, generation: gpu.generation, resources: [], readbacks: [] }
  }
  return pr.gpu
}

function gridResources(d: GPUDevice, label: string): GridResources {
  return {
    params: d.createBuffer({
      label: `${label}/params`,
      size: PARAMS_BYTES,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    points: d.createBuffer({
      label: `${label}/points`,
      size: 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    pointsSize: 16,
    values: d.createBuffer({ label: `${label}/values`, size: 16, usage: GPUBufferUsage.STORAGE }),
    valuesSize: 16,
    origins: [undefined, undefined, undefined],
    originSizes: [0, 0, 0],
  }
}

function jobResources(pg: PlanetGpu, index: number): GpuJobResources {
  let r = pg.resources[index]
  if (!r) {
    const d = pg.gpu.device
    r = {
      ...gridResources(d, 'terrain'),
      stats: d.createBuffer({
        label: 'terrain/stats',
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
      fine: gridResources(d, 'terrain/tile'),
    }
    pg.resources[index] = r
  }
  return r
}

/** Uploads a grid's uniform, points, and origins into its resources; returns the sample bind group entries. */
function uploadGrid(pg: PlanetGpu, r: GridResources, grid: JobGrid): GPUBindGroupEntry[] {
  const device = pg.gpu.device
  const storage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  const p = sized(pg, r.points, grid.points.byteLength, r.pointsSize, storage, 'terrain/points')
  r.points = p.buffer
  r.pointsSize = p.size
  const v = sized(
    pg,
    r.values,
    grid.count * 12,
    r.valuesSize,
    GPUBufferUsage.STORAGE,
    'terrain/values',
  )
  r.values = v.buffer
  r.valuesSize = v.size
  device.queue.writeBuffer(r.params, 0, grid.params)
  device.queue.writeBuffer(r.points, 0, grid.points)
  const entries: GPUBindGroupEntry[] = [
    { binding: 0, resource: { buffer: r.params } },
    { binding: 1, resource: { buffer: r.points } },
    { binding: 2, resource: { buffer: r.values } },
  ]
  const origins = [grid.originsH, grid.originsT, grid.originsM]
  for (let i = 0; i < 3; i++) {
    const data = origins[i]!
    if (data.length === 0) continue
    const o = sized(
      pg,
      r.origins[i],
      data.byteLength,
      r.originSizes[i]!,
      storage,
      'terrain/origins',
    )
    r.origins[i] = o.buffer
    r.originSizes[i] = o.size
    device.queue.writeBuffer(o.buffer, 0, data)
    entries.push({ binding: 3 + i, resource: { buffer: o.buffer } })
  }
  return entries
}

/**
 * Makes sure the tile array has a tile for every slot: a new array with more layers when the pool
 * grows, the old layers copied in, and the material pointed at it.
 */
function ensureTiles(
  world: World,
  rt: PlanetRuntime,
  pr: PlanetRender,
  encoder: GPUCommandEncoder,
  after: (fn: () => void) => void,
): GPUTexture | undefined {
  const tile = tileGeometry(rt.settings!.resolution)
  if (tile.size === 0) return undefined
  const layers = Math.max(1, Math.ceil(pr.slots.length / tile.perLayer))
  const assets = world.resource(GpuAssetsResource)
  if (pr.tiles && pr.tiles.layers >= layers) return assets.texture(pr.tiles)?.texture
  const next = Texture.gpu({ width: TILE_LAYER, height: TILE_LAYER, layers, format: 'rgba8unorm' })
  const handle = assets.texture(next)!.texture
  const textures = world.initResource(Textures)
  const old = pr.tiles
  if (old) {
    const from = assets.texture(old)?.texture
    if (from) {
      encoder.copyTextureToTexture(
        { texture: from },
        { texture: handle },
        { width: TILE_LAYER, height: TILE_LAYER, depthOrArrayLayers: old.layers },
      )
    }
    const ref = pr.tilesRef
    after(() => {
      if (ref?.guid) textures.delete(ref.guid)
    })
  }
  pr.tiles = next
  pr.tilesRef = textures.add(next, 'terrain/normal-tiles')
  ;(pr.material.value as Record<string, unknown>).normalTiles = pr.tilesRef
  pr.material.version++
  return handle
}

function sized(
  pg: PlanetGpu,
  buffer: GPUBuffer | undefined,
  size: number,
  have: number,
  usage: number,
  label: string,
) {
  if (buffer && have >= size) return { buffer, size: have }
  buffer?.destroy()
  let n = Math.max(16, have)
  while (n < size) n *= 2
  return { buffer: pg.gpu.device.createBuffer({ label, size: n, usage }), size: n }
}

const statsInit = new Int32Array([0x7fffffff, -0x7fffffff, 0, 0])

function kernelsOf(rt: PlanetRuntime, pr: PlanetRender) {
  if (!pr.kernels || pr.kernels.version !== rt.version) {
    const terrain: KernelGraph[] = []
    const ocean: KernelGraph[] = []
    if (rt.height) {
      terrain.push(kernelGraph(rt.height))
      ocean.push(kernelGraph(rt.height))
    }
    if (rt.climate) {
      terrain.push(kernelGraph(rt.climate, 'temperature'), kernelGraph(rt.climate, 'moisture'))
    }
    pr.kernels = { version: rt.version, terrain, ocean }
  }
  return pr.kernels
}

/**
 * Encodes one planet's queued jobs: the sampling and vertex dispatches into each slot's mesh, and
 * a copy of the job's stats for the readback. Jobs wait (stay queued) while kernels compile.
 */
function encodePlanet(
  world: World,
  rt: PlanetRuntime,
  pr: PlanetRender,
  encoder: GPUCommandEncoder,
  gpu: GpuContext,
  after: (fn: () => void) => void,
  timestamps: (name: string) => GPUComputePassTimestampWrites | undefined,
): void {
  const library = world.resource(Shaders)
  const assets = world.resource(GpuAssetsResource)
  const pg = planetGpu(pr, gpu)
  const k = kernelsOf(rt, pr)
  const pipelines: (GPUComputePipeline | undefined)[][] = []
  let tilePipelines: (GPUComputePipeline | undefined)[] = [undefined, undefined]
  for (const kind of [TERRAIN, OCEAN]) {
    const graphs = kind === TERRAIN ? k.terrain : k.ocean
    const height = rt.height ? graphs[0] : undefined
    const temperature = kind === TERRAIN && rt.climate ? graphs[rt.height ? 1 : 0] : undefined
    const moisture = kind === TERRAIN && rt.climate ? graphs[rt.height ? 2 : 1] : undefined
    const key = [height?.hash, temperature?.hash, moisture?.hash]
      .map((h) => h ?? '-')
      .join('_')
      .replace(/[^a-z0-9_]/gi, '')
    const roots = registerKernel(library, key, height, temperature, moisture)
    const sampleModule = library.module(gpu, { root: roots.sample, label: 'terrain sample' })
    const vertexModule = library.module(gpu, { root: roots.vertices, label: 'terrain vertices' })
    if (kind === TERRAIN) {
      // Normal tiles sample the height graph alone.
      const hKey = (height?.hash ?? '-').replace(/[^a-z0-9_]/gi, '')
      const tileRoots = registerKernel(library, `${hKey}_h`, height, undefined, undefined)
      const tileSample = library.module(gpu, {
        root: tileRoots.sample,
        label: 'terrain tile sample',
      })
      const normals = library.module(gpu, { root: tileRoots.normals, label: 'terrain normals' })
      tilePipelines = [
        tileSample
          ? gpu.pipelines.compute({
              label: `terrain/tile-sample/${hKey}`,
              layout: 'auto',
              compute: { module: tileSample, entryPoint: 'main' },
            })
          : undefined,
        normals
          ? gpu.pipelines.compute({
              label: 'terrain/normals',
              layout: 'auto',
              compute: { module: normals, entryPoint: 'main' },
            })
          : undefined,
      ]
    }
    pipelines[kind] = [
      sampleModule
        ? gpu.pipelines.compute({
            label: `terrain/sample/${key}`,
            layout: 'auto',
            compute: { module: sampleModule, entryPoint: 'main' },
          })
        : undefined,
      vertexModule
        ? gpu.pipelines.compute({
            label: 'terrain/vertices',
            layout: 'auto',
            compute: { module: vertexModule, entryPoint: 'main' },
          })
        : undefined,
    ]
  }
  const ocean = rt.settings!.ocean
  const tilesOn = tileGeometry(rt.settings!.resolution).size > 0
  if (
    pipelines[TERRAIN]![0] &&
    pipelines[TERRAIN]![1] &&
    (!tilesOn || (tilePipelines[0] && tilePipelines[1])) &&
    (!ocean || (pipelines[OCEAN]![0] && pipelines[OCEAN]![1]))
  )
    pr.kernelsReady = rt.version
  const tiles = tilesOn ? ensureTiles(world, rt, pr, encoder, after) : undefined
  const tile = tileGeometry(rt.settings!.resolution)
  const stride = slotStride(chunkLayout(rt.settings!.resolution).vertexCount)
  const device = gpu.device
  let index = 0
  const remaining: Job[] = []
  // One timed pass for the frame's jobs; the stats copies follow it.
  let pass: GPUComputePassEncoder | undefined
  const copies: GpuJobResources[] = []
  const readbacks: GPUBuffer[] = []
  for (const job of pr.jobs) {
    const [sample, vertices] = pipelines[job.kind]!
    // A job for a slot that moved on, or an older planet version, is dropped.
    if (job.slot.node !== job.node || job.slot.jobId !== job.id || job.version !== rt.version) {
      if (job.slot.jobId === job.id) job.slot.pending = false
      continue
    }
    const [tileSample, normals] = tilePipelines
    const needsTile = job.fine !== undefined && tiles !== undefined
    // A new version's jobs wait until the switch (syncVersion), then all run in one frame.
    if (
      (!job.normalsOnly && (!sample || !vertices)) ||
      (needsTile && (!tileSample || !normals)) ||
      job.version !== pr.shownVersion
    ) {
      remaining.push(job)
      continue
    }
    const r = jobResources(pg, index++)
    pass ??= encoder.beginComputePass({
      label: 'terrain/generate',
      timestampWrites: timestamps('terrain/generate'),
    })
    if (needsTile) {
      const fine = job.fine!
      const entries = uploadGrid(pg, r.fine, fine)
      pass.setPipeline(tileSample!)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          label: 'terrain/tile-sample',
          layout: tileSample!.getBindGroupLayout(0),
          entries,
        }),
      )
      pass.dispatchWorkgroups(Math.ceil(fine.count / 64))
      const layer = Math.floor(job.slot.id / tile.perLayer)
      pass.setPipeline(normals!)
      pass.setBindGroup(
        0,
        device.createBindGroup({
          label: 'terrain/normals',
          layout: normals!.getBindGroupLayout(0),
          entries: [
            entries[0]!,
            entries[1]!,
            entries[2]!,
            {
              binding: 3,
              resource: tiles!.createView({
                dimension: '2d',
                baseArrayLayer: layer,
                arrayLayerCount: 1,
              }),
            },
          ],
        }),
      )
      pass.dispatchWorkgroups(Math.ceil((tile.size * tile.size) / 64))
    }
    if (job.normalsOnly) {
      job.slot.pending = false
      continue
    }
    device.queue.writeBuffer(r.stats, 0, statsInit)
    const sampleEntries = uploadGrid(pg, r, job)
    const gm = assets.mesh(job.slot.mesh)
    // The slot's range of its arena's buffers.
    const base = gm.baseVertex
    const sampleGroup = device.createBindGroup({
      label: 'terrain/sample',
      layout: sample!.getBindGroupLayout(0),
      entries: sampleEntries,
    })
    const vertexGroup = device.createBindGroup({
      label: 'terrain/vertices',
      layout: vertices!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: r.params } },
        { binding: 1, resource: { buffer: r.points } },
        { binding: 2, resource: { buffer: r.values } },
        { binding: 3, resource: { buffer: gm.positions, offset: base * 12, size: stride * 12 } },
        { binding: 4, resource: { buffer: gm.normals, offset: base * 12, size: stride * 12 } },
        { binding: 5, resource: { buffer: gm.uvs, offset: base * 8, size: stride * 8 } },
        { binding: 6, resource: { buffer: gm.uvs1, offset: base * 8, size: stride * 8 } },
        { binding: 7, resource: { buffer: gm.tangents, offset: base * 16, size: stride * 16 } },
        { binding: 8, resource: { buffer: r.stats } },
      ],
    })
    pass.setPipeline(sample!)
    pass.setBindGroup(0, sampleGroup)
    pass.dispatchWorkgroups(Math.ceil(job.count / 64))
    pass.setPipeline(vertices!)
    pass.setBindGroup(0, vertexGroup)
    const n = rt.settings!.resolution
    pass.dispatchWorkgroups(Math.ceil((n * n) / 64))
    const readback =
      pg.readbacks.pop() ??
      device.createBuffer({
        label: 'terrain/readback',
        size: 16,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      })
    copies.push(r)
    readbacks.push(readback)
    // Ready from this frame on: the dispatch runs before any draw in the same submission.
    const { tree, node, slot } = job
    tree.flags[node]! |= NODE_READY
    tree.gen[node] = job.version
    slot.pending = false
    slot.gpuNode = node
    slot.gpuVersion = job.version
    slot.source = 0
    slot.cpu = undefined
    pr.stats.generated++
    const id = job.id
    const version = job.version
    after(() => {
      readback.mapAsync(GPUMapMode.READ).then(
        () => {
          const stats = new Int32Array(readback.getMappedRange().slice(0, 16))
          readback.unmap()
          pg.readbacks.push(readback)
          pr.stats.readbacks++
          if (slot.jobId !== id || slot.node !== node || rt.version !== version) return
          if (stats[0]! > stats[1]!) return
          tree.setHeights(node, stats[0]! / 1000, stats[1]! / 1000)
          tree.bounds(node, slot.center, slot.mesh.bounds)
        },
        () => {},
      )
    })
  }
  if (pass) {
    pass.end()
    for (let i = 0; i < copies.length; i++)
      encoder.copyBufferToBuffer(copies[i]!.stats, 0, readbacks[i]!, 0, 16)
  }
  pr.stats.lastFrameJobs = index
  if (index > 0) pr.jobsPerPass = pr.jobsPerPass === 0 ? index : pr.jobsPerPass * 0.9 + index * 0.1
  pr.jobs = remaining
}

const ownBytes = new Map<number, DataView>()

/** Writes the planet's per-frame material uniforms straight into their GPU buffers. */
function writeFrameUniforms(world: World, pr: PlanetRender, gpu: GpuContext): void {
  const assets = world.resource(GpuAssetsResource)
  for (const material of [pr.material, pr.ocean]) {
    const gm = assets.materials.get(material)
    const layout = material.type.layout
    if (!gm?.ownBuffer || !layout || gm.version !== material.version) continue
    let view = ownBytes.get(layout.size)
    if (!view) {
      view = new DataView(new ArrayBuffer(layout.size))
      ownBytes.set(layout.size, view)
    }
    layout.write(view, 0, material.value as never)
    gpu.device.queue.writeBuffer(gm.ownBuffer, 0, view.buffer, 0, layout.size)
  }
}

let lastFrame = -1

/** The render graph node: once per frame, every planet's GPU work before anything draws. */
/** Adds the `terrain/generate` render graph node and the terrain shaders (once the GPU is up). */
export function registerNode(app: App): void {
  const graph = app.world.tryResource(Graph)
  if (!graph) return
  for (const [path, source] of Object.entries(TERRAIN_SHADERS)) {
    app.world.resource(Shaders).register(path, source, '@aethervtt/shard-terrain')
  }
  graph.addNode('terrain/generate', {
    kind: 'raw',
    phase: RenderPhase.Setup,
    sideEffects: true,
    run(ctx) {
      const world = ctx.world
      const frame = world.resource(Time).frame
      if (frame === lastFrame) return
      lastFrame = frame
      const state = world.tryResource(Terrain)
      if (!state) return
      for (const rt of state.planets.values()) {
        const pr = rt.parts.get('render') as PlanetRender | undefined
        if (!pr || !rt.ready) continue
        writeFrameUniforms(world, pr, ctx.gpu)
        if (pr.jobs.length > 0) {
          const t0 = performance.now()
          encodePlanet(
            world,
            rt,
            pr,
            ctx.encoder,
            ctx.gpu,
            (fn) => ctx.afterSubmit(fn),
            (name) => ctx.timestamps(name),
          )
          world.tryResource(ProfilerResource)?.record('terrain/encode', performance.now() - t0)
        }
        pr.stats.gpuFrames++
      }
    },
  })
}

/** Despawns a planet's chunk entities and frees its meshes and materials. */
export function cleanupRender(world: World, rt: PlanetRuntime): void {
  const pr = rt.parts.get('render') as PlanetRender | undefined
  if (!pr) return
  const assets = world.tryResource(GpuAssetsResource)
  const meshes = world.tryResource(Meshes)
  for (const arena of pr.arenas) assets?.releaseMesh(arena)
  for (const slot of pr.slots) {
    if (world.isAlive(slot.entity)) world.despawn(slot.entity)
    assets?.releaseMesh(slot.mesh)
    if (slot.meshRef.guid) meshes?.delete(slot.meshRef.guid)
  }
  const materials = world.tryResource(Materials)
  if (pr.materialRef.guid) materials?.delete(pr.materialRef.guid)
  if (pr.oceanRef.guid) materials?.delete(pr.oceanRef.guid)
  if (pr.biomeRef?.guid) world.tryResource(Textures)?.delete(pr.biomeRef.guid)
  rt.parts.delete('render')
}
