import {
  type AssetRef,
  ChildOf,
  Derived,
  defineSystem,
  type Entity,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import { Mesh } from '@aethervtt/shard-mesh'
import {
  Camera3d,
  Cameras,
  DebugOverlays,
  GpuAssetsResource,
  InstanceData,
  isOverlayOn,
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  Visibility,
} from '@aethervtt/shard-render'
import { Time } from '@aethervtt/shard-runtime'
import { Texture, Textures, toHalf } from '@aethervtt/shard-texture'
import {
  GlobalTransform,
  placeInGrid,
  propagateSubtree,
  Transform,
} from '@aethervtt/shard-transform'
import { TerrainBudget } from '../components'
import { chunkIndices, chunkLayout } from '../grid-mesh'
import { TerrainWorld } from '../heights'
import { adaptLodBias } from '../lod'
import { TEXTURE_PERIOD } from '../material'
import { NODE_READY, nearAnchor, type SelectionParams, selectNodes } from '../quadtree'
import { pickCamera } from '../render'
import { createView, perspectiveView } from '../view'
import { TerrainChunk } from './component'
import { LEAF_SIDE, PAGE } from './kernel'
import { CHUNK_TABLE_WIDTH, TerrainSurfaceMaterial } from './material'
import { keyDepth, keyX, keyZ, type LoadedPage, nodeKey } from './pages'
import type { HeightfieldRuntime } from './runtime'

const NONE = -1
/** Atlas side of the page pool (texels): within WebGL2's floor of 2048. */
export const ATLAS = 2048
/** Pages per atlas row, and per layer. */
export const PER_ROW = Math.floor(ATLAS / LEAF_SIDE)
export const PER_LAYER = PER_ROW * PER_ROW
/** Frames a page must go unrendered before a speculative upload may evict it (0043's rule). */
const IDLE_FRAMES = 60
/** Seconds a chunk takes to ease from its parent's shape to its own after replacing it. */
const FADE = 0.5
/** Reads in flight per terrain, at most. */
const MAX_READS = 32

/** Debug shading and test hooks for heightfields. */
export const HeightfieldDebug = {
  /** 0 off, 1 layers, 2 seams, 3 levels, 4 normals, 5 pages. */
  mode: 0,
}

/** The chunk drawing one pool slot. */
interface ChunkEntity {
  entity: Entity
  /** The node it's placed for (nodeKey), or −1. */
  key: number
  /** Index set drawn: quadrant mask + 16 × stitched edges. */
  variant: number
  shown: boolean
  fade: number
  used: number
}

/**
 * Render-side state of one heightfield (spec 0071): the GPU page pool (two texture arrays: page
 * texels and control texels, `TerrainBudget.pages` slots, least recently used out, coarse levels
 * pinned), the chunk table, reads in flight and pages waiting to upload, and one chunk entity per
 * slot drawing the shared grid mesh with its index set.
 */
export class HeightfieldRender {
  readonly material: MaterialAsset
  readonly materialRef: AssetRef<'Material'>
  capacity = 0
  layers = 0
  pages: Texture | undefined
  pagesRef: AssetRef | undefined
  control: Texture | undefined
  controlRef: AssetRef | undefined
  chunksTexture: Texture | undefined
  chunksRef: AssetRef | undefined
  layerRef: AssetRef | undefined
  layerHash = ''
  /** Per slot: node key (−1 free), frame last drawn, pinned. */
  slotKey = new Float64Array(0)
  slotUsed = new Uint32Array(0)
  slotPinned = new Uint8Array(0)
  readonly keySlot = new Map<number, number>()
  /** Chunk table bytes (RGBA8 per slot: lock bits, quadrant mask, fade, depth). */
  table = new Uint8Array(0)
  tableDirty = true
  chunks: (ChunkEntity | undefined)[] = []
  /** Pages read and waiting to upload, in arrival order. */
  arrived: LoadedPage[] = []
  /** Keys read or waiting, so a node is asked for once. */
  readonly pending = new Set<number>()
  readonly meshes = new Map<number, AssetRef<'Mesh'>>()
  readonly view = createView()
  /** The selecting camera in the origin frame (xyz), pixels per radian / errorPixels (w). */
  readonly camera = new Float32Array(4)
  hasCamera = false
  /** The walk stamp last frame (what was on screen then). */
  lastStamp = 0
  /** The terrain version the pool's pages are from. */
  version = 0
  stats = { uploaded: 0, evicted: 0, uploadedLastFrame: 0, requested: 0, skippedFull: 0 }

  constructor(world: World) {
    this.material = new MaterialAsset(
      { roughness: 0.9, baseColor: [1, 1, 1, 1] },
      TerrainSurfaceMaterial,
    )
    this.materialRef = world.resource(Materials).add(this.material, 'terrain/heightfield')
  }

  /** The pool slot holding a node's page, or −1. */
  slotOf(key: number): number {
    return this.keySlot.get(key) ?? NONE
  }

  get used(): number {
    return this.keySlot.size
  }
}

export function heightfieldRenderOf(world: World, rt: HeightfieldRuntime): HeightfieldRender {
  let r = rt.parts.get('render') as HeightfieldRender | undefined
  if (!r) {
    r = new HeightfieldRender(world)
    rt.parts.set('render', r)
    const render = r
    rt.parts.set('ready', (key: number) => render.slotOf(key))
  }
  return r
}

/** Sizes the pool for `pages` slots (both atlases), and the chunk table. Only grows. */
function ensurePool(
  world: World,
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  pages: number,
): void {
  const layout = rt.layout!
  if (r.capacity >= pages && r.pages) return
  const capacity = Math.max(pages, r.capacity)
  const layers = Math.max(2, Math.ceil(capacity / PER_LAYER))
  const textures = world.initResource(Textures)
  const cside = layout.cells + 1
  const grow = <T extends Float64Array | Uint32Array | Uint8Array>(
    old: T,
    n: number,
    fill: number,
  ): T => {
    const next = new (old.constructor as new (n: number) => T)(n)
    next.fill(fill as never)
    next.set(old as never)
    return next
  }
  r.slotKey = grow(r.slotKey, capacity, NONE)
  r.slotUsed = grow(r.slotUsed, capacity, 0)
  r.slotPinned = grow(r.slotPinned, capacity, 0)
  r.table = grow(r.table, CHUNK_TABLE_WIDTH * Math.ceil(capacity / CHUNK_TABLE_WIDTH) * 4, 0)
  r.tableDirty = true
  if (layers !== r.layers || !r.pages) {
    // A new pool: what was in the old one uploads again (its pages are in the CPU cache or reread).
    for (const ref of [r.pagesRef, r.controlRef]) if (ref?.guid) textures.delete(ref.guid)
    r.pages = Texture.gpu({ width: ATLAS, height: ATLAS, layers, format: 'rgba8unorm' })
    r.control = Texture.gpu({
      width: PER_ROW * cside,
      height: PER_ROW * cside,
      layers,
      format: 'rgba8unorm',
    })
    r.pagesRef = textures.add(r.pages, 'terrain/heightfield-pages')
    r.controlRef = textures.add(r.control, 'terrain/heightfield-control')
    r.layers = layers
    for (const key of [...r.keySlot.keys()]) dropSlot(rt, r, r.keySlot.get(key)!)
  }
  if (r.chunksRef?.guid) textures.delete(r.chunksRef.guid)
  r.chunksTexture = Texture.gpu({
    width: CHUNK_TABLE_WIDTH,
    height: Math.max(2, Math.ceil(capacity / CHUNK_TABLE_WIDTH)),
    format: 'rgba8unorm',
  })
  r.chunksRef = textures.add(r.chunksTexture, 'terrain/heightfield-chunks')
  r.capacity = capacity
  const v = r.material.value as Record<string, unknown>
  v.pages = r.pagesRef
  v.control = r.controlRef
  v.chunks = r.chunksRef
  r.material.version++
}

/** Empties a slot: its node loses its page (and its ready flag). */
function dropSlot(rt: HeightfieldRuntime, r: HeightfieldRender, slot: number): void {
  const key = r.slotKey[slot]!
  if (key < 0) return
  r.keySlot.delete(key)
  r.slotKey[slot] = NONE
  r.slotPinned[slot] = 0
  const n = rt.nodeOf(keyDepth(key), keyX(key), keyZ(key))
  if (n >= 0) {
    rt.tree.flags[n]! &= ~NODE_READY
    rt.tree.slot[n] = NONE
  }
  const chunk = r.chunks[slot]
  if (chunk) chunk.key = NONE
}

/**
 * A slot for a page: a free one, else the least recently drawn unpinned one that isn't needed this
 * frame. A speculative page (prefetched, out of view) only takes a slot idle for IDLE_FRAMES, so
 * prefetches never evict each other.
 */
function acquireSlot(
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  frame: number,
  needed: boolean,
): number {
  let best = NONE
  let bestUsed = Infinity
  for (let s = 0; s < r.capacity; s++) {
    if (r.slotKey[s]! < 0) return s
    if (r.slotPinned[s]) continue
    const used = r.slotUsed[s]!
    if (used >= frame) continue
    if (!needed && used > frame - IDLE_FRAMES) continue
    const key = r.slotKey[s]!
    const n = rt.nodeOf(keyDepth(key), keyX(key), keyZ(key))
    if (n >= 0 && rt.tree.neededAt[n]! >= frame) continue
    if (used < bestUsed) {
      bestUsed = used
      best = s
    }
  }
  if (best !== NONE) {
    dropSlot(rt, r, best)
    r.stats.evicted++
  }
  return best
}

/** Writes a page's texels and control into its slot. */
function writeSlot(
  gpu: GpuContext,
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  slot: number,
  page: LoadedPage,
) {
  const layout = rt.layout!
  const cside = layout.cells + 1
  const layer = Math.floor(slot / PER_LAYER)
  const cell = slot % PER_LAYER
  const col = cell % PER_ROW
  const row = Math.floor(cell / PER_ROW)
  const queue = gpu.device.queue
  const pages = (r as { gpuPages?: GPUTexture }).gpuPages!
  const control = (r as { gpuControl?: GPUTexture }).gpuControl!
  queue.writeTexture(
    { texture: pages, origin: { x: col * LEAF_SIDE, y: row * LEAF_SIDE, z: layer } },
    page.texels! as Uint8Array<ArrayBuffer>,
    { bytesPerRow: LEAF_SIDE * 4, rowsPerImage: LEAF_SIDE },
    { width: LEAF_SIDE, height: LEAF_SIDE, depthOrArrayLayers: 1 },
  )
  queue.writeTexture(
    { texture: control, origin: { x: col * cside, y: row * cside, z: layer } },
    page.control as Uint8Array<ArrayBuffer>,
    { bytesPerRow: cside * 4, rowsPerImage: cside },
    { width: cside, height: cside, depthOrArrayLayers: 1 },
  )
}

/**
 * Uploads pages that arrived into the pool (spec 0071), in `First`: pinned coarse levels first and
 * all at once, then in arrival order (reads start highest projected error first), at most
 * `TerrainBudget.pagesPerFrame` a frame. A node becomes drawable the frame its page lands. Writes
 * go through the GPU queue, so 0055's upload accounting counts them.
 */
export const uploadHeightfieldPages = defineSystem({
  name: 'terrain/heightfield-upload',
  description:
    'Uploads streamed heightfield pages into the GPU page pool, at most TerrainBudget.pagesPerFrame a frame, evicting the least recently drawn pages that are not needed now.',
  run: (_s, world) => {
    const assets = world.tryResource(GpuAssetsResource)
    const state = world.tryResource(TerrainWorld)
    if (!assets || !state) return
    const budget = world.resource(TerrainBudget)
    const frame = state.frame
    for (const rt of state.heightfields.values()) {
      const r = rt.parts.get('render') as HeightfieldRender | undefined
      if (!r || !rt.layout || r.arrived.length === 0) {
        if (r) r.stats.uploadedLastFrame = 0
        continue
      }
      ensurePool(world, rt, r, budget.pages)
      const gpuPages = assets.texture(r.pages!)?.texture
      const gpuControl = assets.texture(r.control!)?.texture
      if (!gpuPages || !gpuControl) continue
      ;(r as { gpuPages?: GPUTexture }).gpuPages = gpuPages
      ;(r as { gpuControl?: GPUTexture }).gpuControl = gpuControl
      // Pinned pages first (stable order otherwise).
      r.arrived.sort(
        (a, b) => (b.depth <= rt.residentDepth ? 1 : 0) - (a.depth <= rt.residentDepth ? 1 : 0),
      )
      let uploaded = 0
      let i = 0
      for (; i < r.arrived.length; i++) {
        const page = r.arrived[i]!
        const pinned = page.depth <= rt.residentDepth
        // The coarse levels go in at once, outside the budget (at start, and after a rebake):
        // until they're in, there's nothing to draw.
        if (!pinned && uploaded >= budget.pagesPerFrame) break
        r.pending.delete(page.key)
        if (!page.texels) continue
        let slot = r.slotOf(page.key)
        if (slot === NONE) {
          const n = rt.nodeOf(page.depth, page.x, page.z)
          const needed = pinned || (n >= 0 && rt.tree.neededAt[n]! >= frame - 1)
          slot = acquireSlot(rt, r, frame, needed)
          if (slot === NONE) {
            r.stats.skippedFull++
            continue
          }
          r.slotKey[slot] = page.key
          r.keySlot.set(page.key, slot)
        }
        r.slotPinned[slot] = pinned ? 1 : 0
        r.slotUsed[slot] = frame
        writeSlot(assets.gpu, rt, r, slot, page)
        page.texels = undefined
        if (!pinned) uploaded++
        r.stats.uploaded++
        const n = rt.nodeOf(page.depth, page.x, page.z)
        if (n >= 0) {
          rt.tree.flags[n]! |= NODE_READY
          rt.tree.slot[n] = slot
          rt.tree.gen[n] = rt.version
          if (!(rt.tree.flags[n]! & 2)) rt.refreshBounds(n)
        }
      }
      r.arrived.splice(0, i)
      r.stats.uploadedLastFrame = uploaded
    }
  },
})

// --- selection ---------------------------------------------------------------------------------

const camPos = new Float64Array(3)
const right = new Float64Array(3)
const up = new Float64Array(3)
const forward = new Float64Array(3)
const g = new Float64Array(2)

function normalize3(v: Float64Array): void {
  const l = Math.sqrt(v[0]! * v[0]! + v[1]! * v[1]! + v[2]! * v[2]!) || 1
  v[0] = v[0]! / l
  v[1] = v[1]! / l
  v[2] = v[2]! / l
}

function updateView(world: World, rt: HeightfieldRuntime, r: HeightfieldRender, camera: Entity) {
  const m = world.get(camera, GlobalTransform).matrix
  const cam = world.get(camera, Camera3d)
  const data = world.tryResource(Cameras)?.get(camera)
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
  perspectiveView(r.view, camPos, right, up, forward, fovY, aspect, height)
  r.camera[0] = m[3]!
  r.camera[1] = m[7]!
  r.camera[2] = m[11]!
  r.camera[3] = r.view.pixelsPerRadian / (rt.settings!.errorPixels * rt.lodBias)
}

function selectionParams(rt: HeightfieldRuntime): SelectionParams {
  const D = rt.layout!.depth
  return {
    maxDepth: D,
    errors: rt.errors,
    errorPixels: rt.settings!.errorPixels * rt.lodBias,
    occluder: 0,
    colliderDepth: D,
    anchorPos: rt.anchorPos,
    anchorRadius: rt.anchorRadius,
    anchors: rt.anchors,
  }
}

// Reads wanted this frame: keys and priorities (reused).
let wantKeys = new Float64Array(256)
let wantPriority = new Float32Array(256)

/** Starts reads for the most important pages not resident, up to MAX_READS in flight. */
function requestPages(rt: HeightfieldRuntime, r: HeightfieldRender): void {
  const sel = rt.selection
  const tree = rt.tree
  const pages = rt.pages!
  let count = 0
  for (let i = 0; i < sel.requestedCount; i++) {
    const n = sel.requested[i]!
    rt.grid.globalOf(tree, n, g)
    const depth = tree.depth[n]!
    const key = nodeKey(depth, g[0]!, g[1]!)
    const slot = r.slotOf(key)
    if (slot !== NONE) {
      // Resident already (uploaded before this node existed in the tree).
      tree.flags[n]! |= NODE_READY
      tree.slot[n] = slot
      continue
    }
    if (r.pending.has(key)) continue
    if (count === wantKeys.length) {
      const k = new Float64Array(count * 2)
      k.set(wantKeys)
      wantKeys = k
      const p = new Float32Array(count * 2)
      p.set(wantPriority)
      wantPriority = p
    }
    wantKeys[count] = key
    wantPriority[count] = tree.priority[n]!
    count++
  }
  let inflight = pages.pendingReads
  while (inflight < MAX_READS && count > 0) {
    // The highest priority left.
    let best = 0
    for (let k = 1; k < count; k++) if (wantPriority[k]! > wantPriority[best]!) best = k
    const key = wantKeys[best]!
    wantKeys[best] = wantKeys[count - 1]!
    wantPriority[best] = wantPriority[count - 1]!
    count--
    r.pending.add(key)
    r.stats.requested++
    inflight++
    const version = rt.version
    void pages.load(keyDepth(key), keyX(key), keyZ(key)).then(
      (page) => {
        if (page && rt.version === version) r.arrived.push(page)
        else r.pending.delete(key)
      },
      () => r.pending.delete(key),
    )
  }
}

function meshFor(
  world: World,
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  variant: number,
): AssetRef<'Mesh'> {
  let ref = r.meshes.get(variant)
  if (ref) return ref
  const n = PAGE + 1
  const layout = chunkLayout(n)
  const positions = new Float32Array(layout.vertexCount * 3)
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const v = layout.index[i + j * n]!
      positions[v * 3] = i
      positions[v * 3 + 2] = j
    }
  }
  for (let k = 0; k < layout.ring; k++) {
    const v = layout.surface + k
    positions[v * 3] = layout.ringPoints[k * 2]!
    positions[v * 3 + 1] = 1
    positions[v * 3 + 2] = layout.ringPoints[k * 2 + 1]!
  }
  const normals = new Float32Array(layout.vertexCount * 3)
  for (let v = 0; v < layout.vertexCount; v++) normals[v * 3 + 1] = 1
  const indices = chunkIndices(n, variant & 15, variant >> 4, rt.settings!.skirts, 'anti')
  const mesh = Mesh.create({
    positions,
    normals,
    uvs: new Float32Array(layout.vertexCount * 2),
    indices,
  })
  // Object space is the page's grid (±32) and metres of height; the vertex stage places it.
  const skirt = rt.rawErrors[0]! * 2 + rt.spacing(0)
  const b = mesh.bounds as Float64Array | Float32Array
  b[0] = -PAGE / 2
  b[1] = rt.lo - skirt
  b[2] = -PAGE / 2
  b[3] = PAGE / 2
  b[4] = rt.hi
  b[5] = PAGE / 2
  ref = world.resource(Meshes).add(mesh, `terrain/heightfield/${variant}`)
  r.meshes.set(variant, ref)
  return ref
}

const center = new Float64Array(3)

function chunkFor(
  world: World,
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  slot: number,
): ChunkEntity {
  let c = r.chunks[slot]
  if (c) return c
  const entity = world.spawn(
    [Mesh3d, { mesh: meshFor(world, rt, r, 15) }],
    [MeshMaterial, { material: r.materialRef }],
    [TerrainChunk, { terrain: rt.entity, key: '', kind: 'render' }],
    [ChildOf, { parent: rt.entity }],
    [Visibility, { mode: 'hidden' }],
    [InstanceData, { x: 0, y: slot }],
    Transform,
    Derived,
  )
  c = { entity, key: NONE, variant: 15, shown: false, fade: 0, used: 0 }
  r.chunks[slot] = c
  return c
}

function setShown(world: World, c: ChunkEntity, shown: boolean): void {
  if (c.shown === shown) return
  c.shown = shown
  world.set(c.entity, Visibility, { mode: shown ? 'inherit' : 'hidden' })
}

/**
 * Shows the selected nodes' chunks and nothing else: each at its node (a grid child of the
 * terrain, scaled to the node), with its index set, and its locks, quadrants and fade in the chunk
 * table. A chunk that replaces its parent starts at its parent's shape (fade 1) and eases to its
 * own, so a late split slides instead of popping.
 */
function showSelected(
  world: World,
  rt: HeightfieldRuntime,
  r: HeightfieldRender,
  frame: number,
  params: SelectionParams,
) {
  const dt = world.tryResource(Time)?.delta ?? 1 / 60
  const tree = rt.tree
  const sel = rt.selection
  for (let i = 0; i < sel.renderedCount; i++) {
    const n = sel.rendered[i]!
    const slot = tree.slot[n]!
    if (slot < 0 || slot >= r.capacity) continue
    rt.grid.globalOf(tree, n, g)
    const depth = tree.depth[n]!
    const key = nodeKey(depth, g[0]!, g[1]!)
    if (r.slotKey[slot] !== key) continue
    r.slotUsed[slot] = frame
    const c = chunkFor(world, rt, r, slot)
    c.used = frame
    if (c.key !== key) {
      const size = rt.nodeSize(depth)
      center[0] = (g[0]! + 0.5) * size
      center[1] = 0
      center[2] = (g[1]! + 0.5) * size
      placeInGrid(world, c.entity, rt.entity, center)
      const s = size / PAGE
      world.set(c.entity, Transform, { ...world.get(c.entity, Transform), scale: [s, 1, s] })
      propagateSubtree(world, c.entity)
      world.set(c.entity, TerrainChunk, {
        terrain: rt.entity,
        key: `${depth}/${g[0]}/${g[1]}`,
        kind: 'render',
      })
      c.key = key
      // A new node in this slot: it fades in from its parent's shape like any new chunk.
      setShown(world, c, false)
    }
    let fade = c.fade
    if (!c.shown) {
      const parent = tree.parent[n]!
      fade = parent !== NONE && tree.rendered[parent] === r.lastStamp ? 1 : 0
    } else if (fade > 0) fade = Math.max(0, fade - dt / FADE)
    const mask = tree.mask[n]!
    let bits = 0
    let stitch = 0
    for (let e = 0; e < 4; e++) {
      const lock = tree.locks[n * 4 + e]!
      bits |= (lock < 0 ? 0 : lock === 0 ? 1 : 2) << (e * 2)
      if (lock === 1) stitch |= 1 << e
    }
    const variant = mask + 16 * stitch
    if (variant !== c.variant) {
      c.variant = variant
      world.set(c.entity, Mesh3d, {
        ...world.get(c.entity, Mesh3d),
        mesh: meshFor(world, rt, r, variant),
      })
    }
    setShown(world, c, true)
    c.fade = fade
    const o = slot * 4
    const fb = Math.round(fade * 255)
    // A leaf near an anchor draws exactly its collider: its distance morph is off (bit 7).
    const anchored = depth === rt.layout!.depth && nearAnchor(tree, n, params) ? 128 : 0
    const db = depth | anchored
    if (
      r.table[o] !== bits ||
      r.table[o + 1] !== mask ||
      r.table[o + 2] !== fb ||
      r.table[o + 3] !== db
    ) {
      r.table[o] = bits
      r.table[o + 1] = mask
      r.table[o + 2] = fb
      r.table[o + 3] = db
      r.tableDirty = true
    }
  }
  r.lastStamp = sel.stamp
  for (const c of r.chunks) if (c?.shown && c.used !== frame) setShown(world, c, false)
}

function hideAll(world: World, r: HeightfieldRender): void {
  for (const c of r.chunks) if (c?.shown) setShown(world, c, false)
}

/** Triangles a chunk draws (its surface; skirts are thin). */
const CHUNK_TRIANGLES = 2 * PAGE * PAGE

/**
 * Chooses each heightfield's nodes for the selecting camera (spec 0071, 0043's selection on the
 * root grid), reads the pages they need (highest projected error first), and shows exactly the
 * selected chunks. Pages arrive asynchronously and upload in `First`; a split waits for its
 * children's pages, drawing its own quadrants meanwhile.
 */
export const selectHeightfields = defineSystem({
  name: 'terrain/heightfield-select',
  description:
    'Selects each Terrain’s chunks for the camera (screen-space error, frustum culling, 2:1 balance on the root grid), requests their pages, and shows exactly the selected ones.',
  setup: (world) => ({ cameras: world.query({ with: [Camera3d, GlobalTransform] }) }),
  run: (s, world) => {
    if (!world.tryResource(GpuAssetsResource)) return
    const state = world.tryResource(TerrainWorld)
    if (!state) return
    const budget = world.resource(TerrainBudget)
    const frame = state.frame
    const picked = pickCamera(s.cameras)
    for (const rt of state.heightfields.values()) {
      if (!rt.ready || !rt.streaming || !world.isAlive(rt.entity)) continue
      const r = heightfieldRenderOf(world, rt)
      ensurePool(world, rt, r, budget.pages)
      if (r.version !== rt.version) reloadPool(rt, r)
      updateMaterial(world, rt, r)
      if (!picked) {
        r.hasCamera = false
        hideAll(world, r)
        continue
      }
      r.hasCamera = true
      updateView(world, rt, r, picked.entity)
      const params = selectionParams(rt)
      selectNodes(rt.tree, r.view, params, frame, rt.selection)
      rt.lodBias = adaptLodBias(
        rt.lodBias,
        rt.selection.renderedCount * CHUNK_TRIANGLES,
        budget.triangles,
      )
      requestPages(rt, r)
      showSelected(world, rt, r, frame, params)
      writeTable(world, r)
      if (frame % 120 === 0) {
        rt.tree.prune(frame - 600, (n: number) => {
          rt.tree.slot[n] = NONE
        })
      }
    }
  },
})

/**
 * After a rebake the pool's pages are stale: every one is read again and replaced in place (it keeps
 * drawing its old contents until then), coarse levels first.
 */
function reloadPool(rt: HeightfieldRuntime, r: HeightfieldRender): void {
  r.version = rt.version
  r.arrived.length = 0
  r.pending.clear()
  const version = rt.version
  const pages = rt.pages!
  const keys = [...r.keySlot.keys()].sort((a, b) => keyDepth(a) - keyDepth(b))
  for (const key of keys) {
    r.pending.add(key)
    void pages.load(keyDepth(key), keyX(key), keyZ(key)).then(
      (page) => {
        if (page && rt.version === version) r.arrived.push(page)
      },
      () => r.pending.delete(key),
    )
  }
  // Pinned pages that aren't in the pool yet.
  enqueueResident(rt, r)
}

/** The coarse levels, pinned in the CPU cache, go to the pool once streaming starts. */
export function enqueueResident(rt: HeightfieldRuntime, r: HeightfieldRender): void {
  for (const page of rt.pages!.pages()) {
    if (page.depth > rt.residentDepth || r.pending.has(page.key) || r.slotOf(page.key) !== NONE)
      continue
    if (!page.texels) continue
    r.pending.add(page.key)
    r.arrived.push(page)
  }
}

function writeTable(world: World, r: HeightfieldRender): void {
  if (!r.tableDirty || !r.chunksTexture) return
  const assets = world.resource(GpuAssetsResource)
  const tex = assets.texture(r.chunksTexture)?.texture
  if (!tex) return
  const rows = Math.ceil(r.table.length / 4 / CHUNK_TABLE_WIDTH)
  assets.gpu.device.queue.writeTexture(
    { texture: tex },
    r.table as Uint8Array<ArrayBuffer>,
    { bytesPerRow: CHUNK_TABLE_WIDTH * 4, rowsPerImage: rows },
    { width: CHUNK_TABLE_WIDTH, height: rows, depthOrArrayLayers: 1 },
  )
  r.tableDirty = false
}

// --- material ----------------------------------------------------------------------------------

const origin = new Float64Array(3)
const ERRORS = ['errors0', 'errors1', 'errors2'] as const
const SKIRTS = ['skirts0', 'skirts1', 'skirts2'] as const

/** Sets a vec4 field in place (no new array a frame). */
function set4(v: Record<string, unknown>, key: string, x: number, y: number, z: number, w: number) {
  let a = v[key] as number[] | undefined
  if (!Array.isArray(a) || a.length !== 4) {
    a = [0, 0, 0, 0]
    v[key] = a
  }
  a[0] = x
  a[1] = y
  a[2] = z
  a[3] = w
}

const wrap = (x: number, period: number) => ((x % period) + period) % period

/** How far a depth's skirts hang: past any morph mismatch between neighbors there. */
function skirt(rt: HeightfieldRuntime, depth: number): number {
  return depth <= rt.layout!.depth ? 2 * (rt.rawErrors[depth] ?? 0) + rt.spacing(depth) : 0
}

function debugMode(world: World): number {
  const o = world.tryResource(DebugOverlays)
  if (o && isOverlayOn(o, 'terrain-lod')) return 3
  if (o && isOverlayOn(o, 'terrain-pages')) return 5
  return HeightfieldDebug.mode
}

/** Keeps the material in step: layer table, texture arrays, frame, camera, errors, pool layout. */
function updateMaterial(world: World, rt: HeightfieldRuntime, r: HeightfieldRender): void {
  const asset = rt.asset!
  const source = asset.source
  const layout = rt.layout!
  const v = r.material.value as Record<string, unknown>
  const hash = `${asset.hash}:${asset.version}`
  if (hash !== r.layerHash) {
    r.layerHash = hash
    const count = Math.max(1, source.layers.length)
    const data = new Float32Array(2 * count * 4)
    source.layers.forEach((l, i) => {
      const o = i * 8
      data[o] = l.albedo
      data[o + 1] = l.normal
      data[o + 2] = l.orm
      // A whole number of repeats in the texture period (no seams where it wraps).
      data[o + 3] = TEXTURE_PERIOD / Math.max(1, Math.round(TEXTURE_PERIOD / l.scale))
      data[o + 4] = l.tint[0]
      data[o + 5] = l.tint[1]
      data[o + 6] = l.tint[2]
      data[o + 7] = l.triplanar ? 1 : 0
    })
    const textures = world.initResource(Textures)
    if (r.layerRef?.guid) textures.delete(r.layerRef.guid)
    const tex = Texture.create({
      width: 2,
      height: count,
      format: 'rgba16float',
      usage: 'data',
      mips: [new Uint8Array(toHalf(data).buffer)],
    })
    r.layerRef = textures.add(tex, 'terrain/heightfield-layers')
    const deps = asset.deps
    const ref = (t: { path: string } | null) =>
      t && deps[t.path] ? { type: 'Texture', guid: deps[t.path]!.guid, path: t.path } : null
    v.layerTable = r.layerRef
    v.albedoArray = ref(source.textures.albedo)
    v.ormArray = ref(source.textures.orm)
    r.material.version++
  }
  // Per frame: the terrain's frame against the origin, the camera, the pool, errors and skirts.
  const toTerrain = rt.frame.toPlanet
  rt.frame.pointToOrigin(0, 0, 0, origin)
  const period = TEXTURE_PERIOD
  set4(v, 'center', origin[0]!, origin[1]!, origin[2]!, 0)
  set4(v, 'rot0', toTerrain[0]!, toTerrain[1]!, toTerrain[2]!, wrap(toTerrain[3]!, period))
  set4(v, 'rot1', toTerrain[4]!, toTerrain[5]!, toTerrain[6]!, wrap(toTerrain[7]!, period))
  set4(v, 'rot2', toTerrain[8]!, toTerrain[9]!, toTerrain[10]!, wrap(toTerrain[11]!, period))
  set4(v, 'camera', r.camera[0]!, r.camera[1]!, r.camera[2]!, r.camera[3]!)
  set4(v, 'pool', PER_ROW, PER_LAYER, ATLAS, layout.cells + 1)
  set4(v, 'range', rt.lo, rt.hi, layout.cells, Math.max(1, source.layers.length))
  const e = rt.errors
  for (let k = 0; k < 3; k++) {
    set4(v, ERRORS[k]!, e[k * 4] ?? 0, e[k * 4 + 1] ?? 0, e[k * 4 + 2] ?? 0, e[k * 4 + 3] ?? 0)
    set4(
      v,
      SKIRTS[k]!,
      skirt(rt, k * 4),
      skirt(rt, k * 4 + 1),
      skirt(rt, k * 4 + 2),
      skirt(rt, k * 4 + 3),
    )
  }
  const debug = debugMode(world)
  const hasAlbedo = v.albedoArray ? 1 : 0
  const hasOrm = v.ormArray ? 1 : 0
  const dbg = v.debug as number[] | undefined
  if (!dbg || dbg[0] !== debug || dbg[1] !== hasAlbedo || dbg[2] !== hasOrm) {
    v.debug = [debug, hasAlbedo, hasOrm, TEXTURE_PERIOD]
    r.material.version++
  }
}

/** Despawns a heightfield's chunk entities and frees its textures, meshes and material. */
export function cleanupHeightfieldRender(world: World, rt: HeightfieldRuntime): void {
  const r = rt.parts.get('render') as HeightfieldRender | undefined
  if (!r) return
  for (const c of r.chunks) if (c && world.isAlive(c.entity)) world.despawn(c.entity)
  const textures = world.tryResource(Textures)
  for (const ref of [r.pagesRef, r.controlRef, r.chunksRef, r.layerRef])
    if (ref?.guid) textures?.delete(ref.guid)
  const meshes = world.tryResource(Meshes)
  for (const ref of r.meshes.values()) if (ref.guid) meshes?.delete(ref.guid)
  if (r.materialRef.guid) world.tryResource(Materials)?.delete(r.materialRef.guid)
  rt.parts.delete('render')
  rt.parts.delete('ready')
}
