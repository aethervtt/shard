import {
  type AssetRef,
  defineResource,
  ProfilerResource,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { definePlugin } from '@aethervtt/shard-runtime'
import { type MaterialAsset, Materials, Meshes } from './assets'
import { addRenderFeatures } from './features'
import { FoliagePath, type FoliageSupport } from './foliage-path'
import {
  CHUNK_FLOATS,
  CULL_PARAMS_FLOATS,
  FOLIAGE_SHADERS,
  MAX_FOLIAGE_MESHES,
  PATCH_FLOATS,
  PLACE_PARAMS_BYTES,
} from './foliage-shaders'
import {
  ForwardStateResource,
  INTERIOR_DEFINES,
  PASS_GBUFFER,
  PASS_OPAQUE,
  VERTEX_BUFFERS,
  viewBindGroup,
} from './forward'
import { GpuAssetsResource } from './gpu-assets'
import { type NodeContext, RenderPhase } from './graph'
import { materialVariant, typeOrdinal, variantBlend, variantCull } from './material-pipelines'
import { Graph, Shaders } from './plugin'
import { registerShaders } from './shaders'
import { type CameraData, cameraOf } from './view'

/** A chunk of foliage to place: its ground (a patch grid) and its lattice. */
export interface FoliageChunk {
  /** Patch vertices per side (the ground's grid, e.g. a terrain chunk's 33). */
  grid: number
  /** grid² positions (xyz), in the chunk's frame (see `FoliageLayer.setTransform`). */
  positions: Float32Array
  /** grid² unit normals (xyz). */
  normals: Float32Array
  /** grid² density factors in [0, 1]: masks and biomes, interpolated between vertices. */
  density: Float32Array
  /** Global lattice coordinates of the chunk's first cell, and its lattice domain (a cube face). */
  cell0: readonly [number, number]
  domain: number
  /** Chance a cell holds an item (density × cell area, ≤ 1) and jitter as a fraction of a cell. */
  accept: number
  jitter: number
  /**
   * The chunk's origin in its surface's frame: up is radial from the surface's center (a planet).
   * Undefined: up is the chunk frame's +Y (a mesh).
   */
  radial?: readonly [number, number, number]
  /** Footprints kept clear (x, y, z, radius), in the chunk's frame: props' bounds. */
  avoid?: Float32Array
}

export interface FoliageLayerOptions {
  label: string
  /** The meshes it draws (a rule's variants), all with `material`. */
  meshes: AssetRef<'Mesh'>[]
  /** Cumulative chance of each mesh, ending at 1. */
  weights: ArrayLike<number>
  material: AssetRef<'Material'>
  /** The rule's seed: placement hashes it with each cell. */
  seed: number
  /** Lattice cells per chunk side (instances a chunk holds: cells²). */
  cells: number
  /** Distance from the camera at which it exists (m). */
  range: number
  /** Casts shadows within this distance of the camera (0: never). */
  shadowRange: number
  /** Scale range [min, max]. */
  scale: readonly [number, number]
  /** Up from radial (0) to the ground's normal (1). */
  align: number
  /** Where thinning starts, as a fraction of `range` (default 0.5). */
  thinFrom?: number
  /**
   * Each mesh's lower levels of detail (fewer triangles), drawn farther out: `lods[m]` for
   * `meshes[m]`. Grass clumps come with blades of 2 and 1 segments.
   */
  lods?: readonly (readonly AssetRef<'Mesh'>[])[]
  /** Where each lower level begins, as fractions of `range` (default 0.3, 0.6). */
  lodDistances?: readonly number[]
}

/** A placement waiting for this frame's dispatch. */
interface Pending {
  slot: number
  chunk: FoliageChunk
}

interface ViewBuffers {
  visible: GPUBuffer
  args: GPUBuffer
  classes: GPUBuffer
  counts: GPUBuffer
  params: GPUBuffer
  draw: GPUBuffer
  cullGroup: GPUBindGroup | undefined
  drawGroup: GPUBindGroup | undefined
  /** Capacity, drawable count and buffers' generation it was made for. */
  capacity: number
  drawables: number
  generation: number
  /** Frame it was last culled, so draws skip views that weren't. */
  culled: number
  /** Instance counts read back per (list, drawable), and whether a read is in flight. */
  read_: Uint32Array
  reading: boolean
  readback: GPUBuffer | undefined
  /** Frame of the last read-back. */
  read: number
}

const scratchParams = new ArrayBuffer(PLACE_PARAMS_BYTES)
const paramsU32 = new Uint32Array(scratchParams)
const paramsI32 = new Int32Array(scratchParams)
const paramsF32 = new Float32Array(scratchParams)
const cullData = new Float32Array(CULL_PARAMS_FLOATS)
const cullU32 = new Uint32Array(cullData.buffer)
const drawData = new Float32Array(8)

/**
 * GPU-only instances of a rule's meshes (spec 0045): one storage buffer of 16-byte instances,
 * `cells²` per chunk slot, placed by compute from each chunk's ground patch, culled per camera
 * (frustum, distance, thinning) into indirect draws, drawn with the material's own hooks. No
 * entities, and no per-instance CPU work.
 */
export class FoliageLayer {
  readonly options: FoliageLayerOptions
  readonly perChunk: number
  /** What draws: each mesh's levels in order (`meshes[m]` then `lods[m]`), and where each mesh's start. */
  readonly drawables: AssetRef<'Mesh'>[] = []
  readonly levels: Uint32Array
  /** Chunks in the layer: their inputs (kept to place again after growth or device loss). */
  readonly chunks = new Map<number, FoliageChunk>()
  /** Per slot: chunk → origin-relative world rows (12), bounds (min xyz, size xyz), active. */
  private records = new Float32Array(CHUNK_FLOATS * 8)
  private slots = 0
  private readonly free: number[] = []
  readonly pending: Pending[] = []
  /** Buffers, made in the place node. */
  instances: GPUBuffer | undefined
  chunkBuffer: GPUBuffer | undefined
  meshInfo: GPUBuffer | undefined
  levelBuffer: GPUBuffer | undefined
  /** Slots the instance buffer holds, and its device generation. */
  capacitySlots = 0
  generation = -1
  readonly views = new Map<string, ViewBuffers>()
  /** Largest mesh bounding radius (m, unscaled): culling's sphere. */
  meshRadius = 1
  disposed = false

  constructor(options: FoliageLayerOptions) {
    if (options.meshes.length === 0 || options.meshes.length > MAX_FOLIAGE_MESHES) {
      throw new ShardError(
        'render/foliage-meshes',
        `A foliage layer draws 1 to ${MAX_FOLIAGE_MESHES} meshes, not ${options.meshes.length}`,
        { hint: 'Fewer variants: 4–8 read as unique once scaled and rotated.' },
      )
    }
    this.options = options
    this.perChunk = Math.max(1, options.cells * options.cells)
    this.levels = new Uint32Array(options.meshes.length * 2)
    for (let m = 0; m < options.meshes.length; m++) {
      const lods = options.lods?.[m] ?? []
      this.levels[m * 2] = this.drawables.length
      this.levels[m * 2 + 1] = 1 + lods.length
      this.drawables.push(options.meshes[m]!, ...lods)
    }
  }

  /** A free chunk slot. */
  allocate(): number {
    const slot = this.free.length > 0 ? this.free.pop()! : this.slots++
    const need = (slot + 1) * CHUNK_FLOATS
    if (this.records.length < need) {
      const grown = new Float32Array(Math.max(need, this.records.length * 2))
      grown.set(this.records)
      this.records = grown
    }
    return slot
  }

  /** Places a chunk in a slot (on the GPU, in the next frame's place pass). */
  setChunk(slot: number, chunk: FoliageChunk): void {
    const n = chunk.grid * chunk.grid
    if (
      chunk.positions.length < n * 3 ||
      chunk.normals.length < n * 3 ||
      chunk.density.length < n
    ) {
      throw new ShardError(
        'render/foliage-patch',
        `A foliage chunk's patch has fewer than ${n} vertices`,
        {
          hint: 'positions and normals: 3 floats per grid point; density: 1.',
        },
      )
    }
    this.chunks.set(slot, chunk)
    // Bounds of the positions, padded so instances encode without clamping.
    let x0 = Infinity
    let y0 = Infinity
    let z0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    let z1 = -Infinity
    const p = chunk.positions
    for (let i = 0; i < n; i++) {
      x0 = Math.min(x0, p[i * 3]!)
      y0 = Math.min(y0, p[i * 3 + 1]!)
      z0 = Math.min(z0, p[i * 3 + 2]!)
      x1 = Math.max(x1, p[i * 3]!)
      y1 = Math.max(y1, p[i * 3 + 1]!)
      z1 = Math.max(z1, p[i * 3 + 2]!)
    }
    const r = this.records
    const o = slot * CHUNK_FLOATS
    r[o + 12] = x0 - 0.01
    r[o + 13] = y0 - 0.01
    r[o + 14] = z0 - 0.01
    // Inactive until its placement runs: the slot may still hold another chunk's instances.
    r[o + 15] = 0
    r[o + 16] = x1 - x0 + 0.02
    r[o + 17] = y1 - y0 + 0.02
    r[o + 18] = z1 - z0 + 0.02
    this.queue(slot, chunk)
  }

  private queue(slot: number, chunk: FoliageChunk): void {
    for (const p of this.pending) {
      if (p.slot === slot) {
        p.chunk = chunk
        return
      }
    }
    this.pending.push({ slot, chunk })
  }

  /** Frees a slot: its instances stop drawing at once. */
  removeChunk(slot: number): void {
    if (!this.chunks.delete(slot)) return
    this.records[slot * CHUNK_FLOATS + 15] = 0
    for (let i = this.pending.length - 1; i >= 0; i--)
      if (this.pending[i]!.slot === slot) this.pending.splice(i, 1)
    this.free.push(slot)
  }

  /**
   * The chunk's frame in the world, origin-relative, as an affine's three rows (12 floats,
   * row-major: rotation and translation). Set it every frame the frame moves (an origin shift).
   */
  setTransform(slot: number, rows: ArrayLike<number>): void {
    const o = slot * CHUNK_FLOATS
    for (let i = 0; i < 12; i++) this.records[o + i] = rows[i]!
  }

  /** Chunk slots in use. */
  get chunkCount(): number {
    return this.chunks.size
  }

  /** Instances this layer can hold. */
  get capacity(): number {
    return this.capacitySlots * this.perChunk
  }

  /** The last read-back instance counts for a camera: in view, and casting shadows. */
  visible(view: string): { drawn: number; shadows: number } {
    const v = this.views.get(view)
    if (!v) return { drawn: 0, shadows: 0 }
    const m = this.drawables.length
    let drawn = 0
    let shadows = 0
    for (let i = 0; i < m; i++) {
      drawn += v.read_[i] ?? 0
      shadows += v.read_[m + i] ?? 0
    }
    return { drawn, shadows }
  }

  /**
   * The last read-back counts per drawable for a camera (`drawables[d]`: a mesh or one of its
   * LODs), in view and casting shadows.
   */
  visibleByDrawable(view: string): { drawn: number[]; shadows: number[] } {
    const v = this.views.get(view)
    const m = this.drawables.length
    const drawn: number[] = []
    const shadows: number[] = []
    for (let i = 0; i < m; i++) {
      drawn.push(v?.read_[i] ?? 0)
      shadows.push(v?.read_[m + i] ?? 0)
    }
    return { drawn, shadows }
  }

  /** Slot records for the GPU this frame. */
  get chunkRecords(): Float32Array {
    return this.records
  }

  get slotCount(): number {
    return this.slots
  }

  /** Releases its GPU buffers (the layer stops drawing). */
  dispose(): void {
    this.disposed = true
    this.instances?.destroy()
    this.chunkBuffer?.destroy()
    this.meshInfo?.destroy()
    this.levelBuffer?.destroy()
    for (const v of this.views.values()) {
      v.visible.destroy()
      v.args.destroy()
      v.classes.destroy()
      v.counts.destroy()
      v.params.destroy()
      v.draw.destroy()
      v.readback?.destroy()
    }
    this.views.clear()
  }
}

/** Every foliage layer, drawn by `foliagePlugin`. */
export class FoliageLayerSet {
  readonly layers = new Set<FoliageLayer>()
  /** The shared GPU objects (pipelines, staging buffers), made on first use. */
  gpu: FoliageGpu | undefined

  add(layer: FoliageLayer): FoliageLayer {
    this.layers.add(layer)
    return layer
  }

  remove(layer: FoliageLayer): void {
    if (!this.layers.delete(layer)) return
    layer.dispose()
  }

  /** Releases every layer and the shared buffers (the app is going away). */
  dispose(): void {
    for (const layer of this.layers) layer.dispose()
    this.layers.clear()
    this.gpu?.params.destroy()
    this.gpu?.patch.destroy()
    this.gpu?.avoid.destroy()
    this.gpu = undefined
  }
}

export const FoliageLayers = defineResource<FoliageLayerSet>('render/FoliageLayers', {
  description: 'GPU foliage layers (0045): instances placed, culled and drawn on the GPU.',
  init: () => new FoliageLayerSet(),
})

// --- GPU side -------------------------------------------------------------------------------------

interface FoliageGpu {
  generation: number
  placeLayout: GPUBindGroupLayout
  cullLayout: GPUBindGroupLayout
  drawLayout: GPUBindGroupLayout
  place: GPUComputePipeline | undefined
  reset: GPUComputePipeline | undefined
  cull: GPUComputePipeline | undefined
  scan: GPUComputePipeline | undefined
  scatter: GPUComputePipeline | undefined
  params: GPUBuffer
  paramsSize: number
  patch: GPUBuffer
  patchSize: number
  avoid: GPUBuffer
  avoidSize: number
}

function foliageGpu(gpu: GpuContext, set: FoliageLayerSet): FoliageGpu {
  if (set.gpu && set.gpu.generation === gpu.generation) return set.gpu
  const d = gpu.device
  const storage = (binding: number, type: GPUBufferBindingType, visibility: number) => ({
    binding,
    visibility,
    buffer: { type },
  })
  const C = GPUShaderStage.COMPUTE
  const V = GPUShaderStage.VERTEX
  set.gpu = {
    generation: gpu.generation,
    placeLayout: gpu.layouts.bindGroupLayout({
      label: 'foliage/place',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform', hasDynamicOffset: true } },
        storage(1, 'read-only-storage', C),
        storage(2, 'read-only-storage', C),
        storage(3, 'storage', C),
      ],
    }),
    cullLayout: gpu.layouts.bindGroupLayout({
      label: 'foliage/cull',
      entries: [
        { binding: 0, visibility: C, buffer: { type: 'uniform' } },
        storage(1, 'read-only-storage', C),
        storage(2, 'read-only-storage', C),
        storage(3, 'storage', C),
        storage(4, 'storage', C),
        storage(5, 'read-only-storage', C),
        storage(6, 'storage', C),
        storage(7, 'storage', C),
        storage(8, 'read-only-storage', C),
      ],
    }),
    drawLayout: gpu.layouts.bindGroupLayout({
      label: 'foliage/draw',
      entries: [
        storage(0, 'read-only-storage', V),
        storage(1, 'read-only-storage', V),
        storage(2, 'read-only-storage', V),
        { binding: 3, visibility: V, buffer: { type: 'uniform' } },
      ],
    }),
    place: undefined,
    reset: undefined,
    cull: undefined,
    scan: undefined,
    scatter: undefined,
    params: d.createBuffer({
      label: 'foliage/place-params',
      size: PLACE_PARAMS_BYTES * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    paramsSize: PLACE_PARAMS_BYTES * 16,
    patch: d.createBuffer({
      label: 'foliage/patch',
      size: 4096,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    patchSize: 4096,
    avoid: d.createBuffer({
      label: 'foliage/avoid',
      size: 256,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    }),
    avoidSize: 256,
  }
  return set.gpu
}

function pipelines(ctx: NodeContext, f: FoliageGpu): boolean {
  if (f.place && f.reset && f.cull && f.scan && f.scatter) return true
  const shaders = ctx.world.resource(Shaders)
  const gpu = ctx.gpu
  const place = shaders.module(gpu, { root: 'shard::foliage::place', label: 'foliage place' })
  const cull = shaders.module(gpu, { root: 'shard::foliage::cull', label: 'foliage cull' })
  if (!place || !cull) return false
  f.place = gpu.pipelines.compute({
    label: 'foliage/place',
    layout: gpu.layouts.pipelineLayout({
      label: 'foliage/place',
      bindGroupLayouts: [f.placeLayout],
    }),
    compute: { module: place, entryPoint: 'place' },
  })
  const cullLayout = gpu.layouts.pipelineLayout({
    label: 'foliage/cull',
    bindGroupLayouts: [f.cullLayout],
  })
  f.reset = gpu.pipelines.compute({
    label: 'foliage/reset',
    layout: cullLayout,
    compute: { module: cull, entryPoint: 'reset' },
  })
  f.cull = gpu.pipelines.compute({
    label: 'foliage/classify',
    layout: cullLayout,
    compute: { module: cull, entryPoint: 'classify' },
  })
  f.scan = gpu.pipelines.compute({
    label: 'foliage/scan',
    layout: cullLayout,
    compute: { module: cull, entryPoint: 'scan' },
  })
  f.scatter = gpu.pipelines.compute({
    label: 'foliage/scatter',
    layout: cullLayout,
    compute: { module: cull, entryPoint: 'scatter' },
  })
  return (
    f.place !== undefined &&
    f.reset !== undefined &&
    f.cull !== undefined &&
    f.scan !== undefined &&
    f.scatter !== undefined
  )
}

function grow(
  gpu: GpuContext,
  buffer: GPUBuffer,
  size: number,
  need: number,
  label: string,
  usage: number,
) {
  if (need <= size) return { buffer, size }
  let s = size
  while (s < need) s *= 2
  buffer.destroy()
  return { buffer: gpu.device.createBuffer({ label, size: s, usage }), size: s }
}

/** The layer's own buffers, sized for its slots; growth (or a new device) places every chunk again. */
function ensureLayer(gpu: GpuContext, layer: FoliageLayer, world: World): void {
  const d = gpu.device
  const lost = layer.generation !== gpu.generation
  if (lost || layer.slotCount > layer.capacitySlots) {
    let slots = Math.max(8, layer.capacitySlots)
    while (slots < layer.slotCount) slots *= 2
    if (!lost) layer.instances?.destroy()
    if (!lost) layer.chunkBuffer?.destroy()
    layer.instances = d.createBuffer({
      label: `foliage/${layer.options.label}/instances`,
      size: slots * layer.perChunk * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    layer.chunkBuffer = d.createBuffer({
      label: `foliage/${layer.options.label}/chunks`,
      size: slots * CHUNK_FLOATS * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    layer.capacitySlots = slots
    layer.generation = gpu.generation
    layer.views.clear()
    layer.meshInfo = undefined
    layer.levelBuffer = undefined
    // Every chunk places again into the new buffer.
    for (const [slot, chunk] of layer.chunks) layer.pending.push({ slot, chunk })
    dedupePending(layer)
  }
  if (!layer.meshInfo) {
    layer.meshInfo = d.createBuffer({
      label: `foliage/${layer.options.label}/meshes`,
      size: Math.max(16, layer.drawables.length * 16),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    layer.levelBuffer = d.createBuffer({
      label: `foliage/${layer.options.label}/levels`,
      size: Math.max(16, layer.levels.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })
    d.queue.writeBuffer(layer.levelBuffer, 0, layer.levels)
  }
  // Mesh draw info (index count, first index, base vertex): cheap, so every frame.
  const meshes = world.resource(Meshes)
  const assets = world.resource(GpuAssetsResource)
  const info = new Uint32Array(layer.drawables.length * 4)
  let radius = 0
  for (let m = 0; m < layer.drawables.length; m++) {
    const mesh = meshes.get(layer.drawables[m]!) as Mesh | undefined
    if (!mesh) continue
    const gm = assets.mesh(mesh)
    info[m * 4] = gm.count
    info[m * 4 + 2] = 0
    info[m * 4 + 3] = gm.baseVertex
    const b = mesh.bounds
    radius = Math.max(radius, Math.hypot(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) / 2)
  }
  layer.meshRadius = radius || 1
  d.queue.writeBuffer(layer.meshInfo, 0, info)
  d.queue.writeBuffer(
    layer.chunkBuffer!,
    0,
    layer.chunkRecords,
    0,
    layer.capacitySlots * CHUNK_FLOATS,
  )
}

function dedupePending(layer: FoliageLayer): void {
  const seen = new Set<number>()
  for (let i = layer.pending.length - 1; i >= 0; i--) {
    const slot = layer.pending[i]!.slot
    if (seen.has(slot)) layer.pending.splice(i, 1)
    else seen.add(slot)
  }
}

/** Placement dispatches a frame may run, across layers (each is one chunk). */
const PLACE_PER_FRAME = 16

/** Places queued chunks: one dispatch each, a thread per lattice cell. */
function placeChunks(ctx: NodeContext, f: FoliageGpu, layers: Iterable<FoliageLayer>): void {
  const gpu = ctx.gpu
  const d = gpu.device
  const work: { layer: FoliageLayer; p: Pending }[] = []
  for (const layer of layers) {
    while (layer.pending.length > 0 && work.length < PLACE_PER_FRAME)
      work.push({ layer, p: layer.pending.shift()! })
  }
  if (work.length === 0) return
  // Pack every dispatch's patch, avoid list, and params.
  let patchFloats = 0
  let avoidFloats = 0
  for (const w of work) {
    patchFloats += w.p.chunk.grid * w.p.chunk.grid * PATCH_FLOATS
    avoidFloats += w.p.chunk.avoid?.length ?? 0
  }
  const patch = new Float32Array(Math.max(4, patchFloats))
  const avoid = new Float32Array(Math.max(4, avoidFloats))
  const params = new Uint8Array(work.length * PLACE_PARAMS_BYTES)
  let pb = 0
  let ab = 0
  for (const [k, { layer, p }] of work.entries()) {
    const c = p.chunk
    const n = c.grid * c.grid
    for (let i = 0; i < n; i++) {
      const o = pb + i * PATCH_FLOATS
      patch[o] = c.positions[i * 3]!
      patch[o + 1] = c.positions[i * 3 + 1]!
      patch[o + 2] = c.positions[i * 3 + 2]!
      patch[o + 3] = c.normals[i * 3]!
      patch[o + 4] = c.normals[i * 3 + 1]!
      patch[o + 5] = c.normals[i * 3 + 2]!
      patch[o + 6] = c.density[i]!
    }
    const avoidCount = c.avoid ? c.avoid.length / 4 : 0
    if (c.avoid) avoid.set(c.avoid, ab)
    const opts = layer.options
    paramsU32.fill(0)
    paramsU32[0] = opts.cells
    paramsU32[1] = c.grid
    paramsU32[2] = p.slot
    paramsU32[3] = layer.perChunk
    paramsI32[4] = c.cell0[0]
    paramsI32[5] = c.cell0[1]
    paramsU32[6] = c.domain >>> 0
    paramsU32[7] = opts.seed >>> 0
    paramsF32[8] = c.accept
    paramsF32[9] = c.jitter
    paramsF32[10] = opts.scale[0]
    paramsF32[11] = opts.scale[1]
    paramsF32[12] = opts.align
    paramsU32[13] = opts.meshes.length
    paramsU32[14] = avoidCount
    paramsU32[15] = c.radial ? 1 : 0
    paramsU32[16] = pb
    paramsU32[17] = ab / 4
    if (c.radial) {
      paramsF32[20] = c.radial[0]
      paramsF32[21] = c.radial[1]
      paramsF32[22] = c.radial[2]
    }
    const r = layer.chunkRecords
    const ro = p.slot * CHUNK_FLOATS
    paramsF32[24] = r[ro + 12]!
    paramsF32[25] = r[ro + 13]!
    paramsF32[26] = r[ro + 14]!
    paramsF32[28] = r[ro + 16]!
    paramsF32[29] = r[ro + 17]!
    paramsF32[30] = r[ro + 18]!
    for (let m = 0; m < opts.meshes.length; m++) paramsF32[32 + m] = opts.weights[m]!
    params.set(new Uint8Array(scratchParams), k * PLACE_PARAMS_BYTES)
    pb += n * PATCH_FLOATS
    ab += avoidCount * 4
  }
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST
  const pg = grow(gpu, f.patch, f.patchSize, patch.byteLength, 'foliage/patch', usage)
  f.patch = pg.buffer
  f.patchSize = pg.size
  const ag = grow(gpu, f.avoid, f.avoidSize, avoid.byteLength, 'foliage/avoid', usage)
  f.avoid = ag.buffer
  f.avoidSize = ag.size
  const prm = grow(
    gpu,
    f.params,
    f.paramsSize,
    params.byteLength,
    'foliage/place-params',
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  )
  f.params = prm.buffer
  f.paramsSize = prm.size
  d.queue.writeBuffer(f.patch, 0, patch)
  d.queue.writeBuffer(f.avoid, 0, avoid)
  d.queue.writeBuffer(f.params, 0, params)
  const pass = ctx.encoder.beginComputePass({
    label: 'foliage/place',
    timestampWrites: ctx.timestamps('foliage/place'),
  })
  pass.setPipeline(f.place!)
  let bound: FoliageLayer | undefined
  let group: GPUBindGroup | undefined
  for (const [k, { layer, p }] of work.entries()) {
    if (layer !== bound) {
      group = d.createBindGroup({
        label: 'foliage/place',
        layout: f.placeLayout,
        entries: [
          { binding: 0, resource: { buffer: f.params, size: PLACE_PARAMS_BYTES } },
          { binding: 1, resource: { buffer: f.patch } },
          { binding: 2, resource: { buffer: f.avoid } },
          { binding: 3, resource: { buffer: layer.instances! } },
        ],
      })
      bound = layer
    }
    pass.setBindGroup(0, group!, [k * PLACE_PARAMS_BYTES])
    pass.dispatchWorkgroups(Math.ceil((layer.options.cells * layer.options.cells) / 64))
    // Now its instances are its own: the record goes live (the write lands before this frame's
    // commands, and the place pass runs before the cull).
    const records = layer.chunkRecords
    records[p.slot * CHUNK_FLOATS + 15] = 1
    d.queue.writeBuffer(
      layer.chunkBuffer!,
      p.slot * CHUNK_FLOATS * 4,
      records,
      p.slot * CHUNK_FLOATS,
      CHUNK_FLOATS,
    )
  }
  pass.end()
}

function viewBuffers(
  gpu: GpuContext,
  f: FoliageGpu,
  layer: FoliageLayer,
  name: string,
): ViewBuffers {
  const capacity = layer.capacity
  const drawables = layer.drawables.length
  let v = layer.views.get(name)
  if (v && v.capacity === capacity && v.drawables === drawables && v.generation === gpu.generation)
    return v
  if (v) {
    v.visible.destroy()
    v.args.destroy()
    v.classes.destroy()
    v.counts.destroy()
    v.params.destroy()
    v.draw.destroy()
    v.readback?.destroy()
  }
  const d = gpu.device
  v = {
    // The camera's list and its shadow list, each at most every instance.
    visible: d.createBuffer({
      label: `foliage/${layer.options.label}/visible/${name}`,
      size: Math.max(16, 2 * capacity * 4),
      usage: GPUBufferUsage.STORAGE,
    }),
    args: d.createBuffer({
      label: `foliage/${layer.options.label}/args/${name}`,
      size: Math.max(16, 2 * drawables * 20),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
    }),
    classes: d.createBuffer({
      label: `foliage/${layer.options.label}/classes/${name}`,
      size: Math.max(16, capacity * 4),
      usage: GPUBufferUsage.STORAGE,
    }),
    counts: d.createBuffer({
      label: `foliage/${layer.options.label}/counts/${name}`,
      size: Math.max(16, 2 * drawables * 4),
      usage: GPUBufferUsage.STORAGE,
    }),
    params: d.createBuffer({
      label: `foliage/${layer.options.label}/cull/${name}`,
      size: CULL_PARAMS_FLOATS * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    draw: d.createBuffer({
      label: `foliage/${layer.options.label}/draw/${name}`,
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }),
    cullGroup: undefined,
    drawGroup: undefined,
    capacity,
    drawables,
    generation: gpu.generation,
    culled: -1,
    read_: new Uint32Array(2 * drawables),
    reading: false,
    readback: undefined,
    read: -READBACK_EVERY,
  }
  v.cullGroup = d.createBindGroup({
    label: 'foliage/cull',
    layout: f.cullLayout,
    entries: [
      { binding: 0, resource: { buffer: v.params } },
      { binding: 1, resource: { buffer: layer.instances! } },
      { binding: 2, resource: { buffer: layer.chunkBuffer! } },
      { binding: 3, resource: { buffer: v.visible } },
      { binding: 4, resource: { buffer: v.args } },
      { binding: 5, resource: { buffer: layer.meshInfo! } },
      { binding: 6, resource: { buffer: v.classes } },
      { binding: 7, resource: { buffer: v.counts } },
      { binding: 8, resource: { buffer: layer.levelBuffer! } },
    ],
  })
  v.drawGroup = d.createBindGroup({
    label: 'foliage/draw',
    layout: f.drawLayout,
    entries: [
      { binding: 0, resource: { buffer: layer.instances! } },
      { binding: 1, resource: { buffer: v.visible } },
      { binding: 2, resource: { buffer: layer.chunkBuffer! } },
      { binding: 3, resource: { buffer: v.draw } },
    ],
  })
  layer.views.set(name, v)
  return v
}

/** Lower levels of detail start at these fractions of the range by default. */
const DEFAULT_LODS = [0.3, 0.6]

/** Reads the args' instance counts back every this many culls (for describe output). */
const READBACK_EVERY = 30

/** Resets and culls a layer for one camera: its list and its shadow casters' list. */
function cullLayer(
  ctx: NodeContext,
  f: FoliageGpu,
  layer: FoliageLayer,
  cam: CameraData,
  frame: number,
): void {
  const gpu = ctx.gpu
  const v = viewBuffers(gpu, f, layer, ctx.view.name)
  const o = layer.options
  // Foliage casts only into the nearest cascade (0055's far ones see it as texture-sized noise),
  // within its shadow range.
  const cascades = ctx.world.resource(ForwardStateResource).views.get(ctx.view.name)?.cascades
  const shadowRange =
    cascades && cascades.count > 0 ? Math.min(o.shadowRange, cascades.splits[0]!) : 0
  const lods = o.lodDistances ?? DEFAULT_LODS
  cullData.fill(0)
  cullData.set(cam.frustum, 0)
  cullData[24] = cam.position[0]!
  cullData[25] = cam.position[1]!
  cullData[26] = cam.position[2]!
  cullData[27] = o.range
  cullData[28] = shadowRange
  cullData[29] = o.thinFrom ?? 0.5
  cullData[30] = layer.meshRadius
  for (let l = 0; l < 4; l++) cullData[32 + l] = lods[l] ?? 2
  cullU32[36] = layer.perChunk
  cullU32[37] = layer.capacitySlots
  cullU32[38] = o.meshes.length
  cullU32[39] = layer.drawables.length
  cullData[40] = o.scale[0]
  cullData[41] = o.scale[1]
  gpu.device.queue.writeBuffer(v.params, 0, cullData)
  drawData[0] = cam.position[0]!
  drawData[1] = cam.position[1]!
  drawData[2] = cam.position[2]!
  drawData[3] = o.range
  drawData[4] = o.thinFrom ?? 0.5
  drawData[5] = o.scale[0]
  drawData[6] = o.scale[1]
  drawData[7] = layer.perChunk
  gpu.device.queue.writeBuffer(v.draw, 0, drawData)
  const pass = ctx.encoder.beginComputePass({
    label: 'foliage/cull',
    timestampWrites: ctx.timestamps('foliage/cull'),
  })
  pass.setBindGroup(0, v.cullGroup!)
  // Count per drawable, prefix-sum, then scatter into each drawable's range.
  pass.setPipeline(f.reset!)
  pass.dispatchWorkgroups(Math.ceil((2 * layer.drawables.length) / 64))
  const total = layer.capacity
  // A dispatch dimension holds at most 65 535 workgroups.
  const groups = Math.ceil(total / 64)
  const gx = Math.min(groups, 65535)
  const gy = Math.ceil(groups / 65535)
  if (total > 0) {
    pass.setPipeline(f.cull!)
    pass.dispatchWorkgroups(gx, gy)
  }
  pass.setPipeline(f.scan!)
  pass.dispatchWorkgroups(1)
  if (total > 0) {
    pass.setPipeline(f.scatter!)
    pass.dispatchWorkgroups(gx, gy)
  }
  pass.end()
  v.culled = frame
  if (!v.reading && frame - v.read >= READBACK_EVERY) {
    v.read = frame
    readCounts(ctx, v)
  }
}

function readCounts(ctx: NodeContext, v: ViewBuffers): void {
  const size = v.drawables * 2 * 20
  v.readback ??= ctx.gpu.device.createBuffer({
    label: 'foliage/readback',
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  })
  ctx.encoder.copyBufferToBuffer(v.args, 0, v.readback, 0, size)
  v.reading = true
  const buffer = v.readback
  ctx.afterSubmit(() => {
    buffer.mapAsync(GPUMapMode.READ).then(
      () => {
        const words = new Uint32Array(buffer.getMappedRange())
        for (let k = 0; k < v.read_.length; k++) v.read_[k] = words[k * 5 + 1]!
        buffer.unmap()
        v.reading = false
      },
      () => {
        v.reading = false
      },
    )
  })
}

// --- drawing ---------------------------------------------------------------------------------------

/** Pipeline keys of foliage draws, above every other pass's (forward uses up to 2^43). */
const FOLIAGE_KEY = 2 ** 45
const KIND_FORWARD = 0
const KIND_GBUFFER = 1
const KIND_SHADOW = 2

function foliagePipeline(
  ctx: NodeContext,
  f: FoliageGpu,
  material: MaterialAsset,
  kind: number,
  msaa: number,
): GPURenderPipeline | undefined {
  const world = ctx.world
  const gpu = ctx.gpu
  const state = world.resource(ForwardStateResource)
  const assets = world.resource(GpuAssetsResource)
  const type = material.type
  const variant = materialVariant(material)
  const mask = variantBlend(variant) === 'mask'
  const mode = kind === KIND_FORWARD ? state.interiorMode : 0
  const key =
    FOLIAGE_KEY + (((kind * 1024 + typeOrdinal(type)) * 16 + variant) * 8 + msaa) + mode * 2 ** 42
  const cached = state.pipelines.cached(key)
  if (cached) return cached
  // Module slots no other pass uses: forward 24–31 (by mask and interior mode), G-buffer 9–10,
  // shadows 11–12.
  const slot =
    kind === KIND_FORWARD
      ? 24 + (mask ? 1 : 0) + mode * 2
      : (kind === KIND_GBUFFER ? 9 : 11) + (mask ? 1 : 0)
  const root =
    kind === KIND_FORWARD
      ? 'shard::foliage::forward'
      : kind === KIND_GBUFFER
        ? 'shard::foliage::gbuffer'
        : 'shard::foliage::shadow'
  const defines =
    kind === KIND_FORWARD
      ? { PREMULTIPLY: false, MASK: mask, OPAQUE: true, ...(INTERIOR_DEFINES[mode] ?? {}) }
      : { MASK: mask }
  const module = state.pipelines.module(world, gpu, type, slot, root, defines)
  if (!module) return undefined
  const layouts =
    kind === KIND_SHADOW
      ? [state.layouts.shadowView, assets.layoutOf(type), f.drawLayout]
      : [state.layouts.view, assets.layoutOf(type), f.drawLayout]
  return state.pipelines.create(
    gpu,
    key,
    {
      label: `foliage/${['forward', 'gbuffer', 'shadow'][kind]}/${type.name}/${mask ? 'mask' : 'opaque'}`,
      layout: gpu.layouts.pipelineLayout({
        label: `foliage/${type.name}/${kind}`,
        bindGroupLayouts: layouts,
      }),
      vertex: { module, entryPoint: 'vs', buffers: VERTEX_BUFFERS },
      fragment:
        kind === KIND_SHADOW
          ? mask
            ? { module, entryPoint: 'fs_mask', targets: [] }
            : undefined
          : {
              module,
              entryPoint: 'fs',
              targets: kind === KIND_GBUFFER ? state.gbufferTargets : [{ format: 'rgba16float' }],
            },
      primitive: { topology: 'triangle-list', cullMode: variantCull(variant), frontFace: 'ccw' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: kind === KIND_FORWARD ? msaa : 1 },
    },
    type,
  )
}

function drawLayer(
  ctx: NodeContext,
  f: FoliageGpu,
  layer: FoliageLayer,
  v: ViewBuffers,
  kind: number,
  msaa: number,
  pass: GPURenderPassEncoder,
): void {
  const world = ctx.world
  const material = world.resource(Materials).get(layer.options.material) as
    | MaterialAsset
    | undefined
  if (!material?.type.standard) return
  const pipeline = foliagePipeline(ctx, f, material, kind, msaa)
  if (!pipeline) {
    ctx.gpu.pipelines.skipped++
    return
  }
  const assets = world.resource(GpuAssetsResource)
  const gm = assets.material(world, material)
  if (!gm?.bindGroup) return
  pass.setPipeline(pipeline)
  pass.setBindGroup(1, gm.bindGroup)
  pass.setBindGroup(2, v.drawGroup!)
  const meshes = world.resource(Meshes)
  const list = kind === KIND_SHADOW ? 1 : 0
  const count = layer.drawables.length
  for (let m = 0; m < count; m++) {
    const mesh = meshes.get(layer.drawables[m]!) as Mesh | undefined
    if (!mesh) continue
    const g = assets.mesh(mesh)
    if (!g.indices) continue
    pass.setVertexBuffer(0, g.positions)
    pass.setVertexBuffer(1, g.normals)
    pass.setVertexBuffer(2, g.uvs)
    pass.setVertexBuffer(3, g.uvs1)
    pass.setVertexBuffer(4, g.tangents)
    pass.setIndexBuffer(g.indices, g.indexFormat)
    pass.drawIndexedIndirect(v.args, (list * count + m) * 5 * 4)
  }
}

/** Whether foliage can run on this device (full tier, indirect draws with a first instance). */
function supported(gpu: GpuContext): boolean {
  return gpu.tier === 'full' && gpu.features.has('indirect-first-instance')
}

function support(world: World): FoliageSupport {
  const ready = (ctx: NodeContext, cam: CameraData) => {
    const layers = world.tryResource(FoliageLayers)
    if (!layers || layers.layers.size === 0 || !supported(ctx.gpu) || !layers.gpu) return undefined
    void cam
    return layers
  }
  return {
    draw(ctx, cam, pass, renderPass) {
      const layers = ready(ctx, cam)
      if (!layers) return
      const kind = pass === PASS_GBUFFER ? KIND_GBUFFER : pass === PASS_OPAQUE ? KIND_FORWARD : -1
      if (kind < 0) return
      const state = world.resource(ForwardStateResource)
      const pv = state.views.get(ctx.view.name)
      if (!pv) return
      // The batches may have drawn nothing (and so bound nothing): group 0 is the camera's view.
      renderPass.setBindGroup(0, viewBindGroup(ctx.gpu, world, pv, cam))
      for (const layer of layers.layers) {
        const v = layer.views.get(ctx.view.name)
        if (!v || v.culled !== state.frame || layer.chunkCount === 0) continue
        drawLayer(
          ctx,
          layers.gpu!,
          layer,
          v,
          kind,
          kind === KIND_FORWARD ? cam.msaa : 1,
          renderPass,
        )
      }
    },
    drawShadow(ctx, cam, renderPass, offset, cascade) {
      if (cascade !== 0) return
      const layers = ready(ctx, cam)
      if (!layers) return
      void offset
      const frame = world.resource(ForwardStateResource).frame
      for (const layer of layers.layers) {
        if (!(layer.options.shadowRange > 0)) continue
        const v = layer.views.get(ctx.view.name)
        if (!v || v.culled !== frame || layer.chunkCount === 0) continue
        drawLayer(ctx, layers.gpu!, layer, v, KIND_SHADOW, 1, renderPass)
      }
    },
    animatedShadows(cam) {
      const layers = world.tryResource(FoliageLayers)
      if (!layers) return false
      void cam
      for (const layer of layers.layers)
        if (layer.options.shadowRange > 0 && layer.chunkCount > 0) return true
      return false
    },
  }
}

/**
 * GPU foliage (0045): layers of instances placed by compute from ground patches, culled per camera,
 * drawn indirectly with their material's hooks in the forward, G-buffer and shadow passes. The
 * scatter package feeds it; no entities are involved.
 */
export const foliagePlugin = definePlugin({
  name: 'render/foliage',
  dependencies: ['render/forward'],
  provides: [FoliageLayers, FoliagePath],
  build(app) {
    app.world.initResource(FoliageLayers)
    app.insertResource(FoliagePath, support(app.world))
  },
  dispose(app) {
    app.world.tryResource(FoliageLayers)?.dispose()
  },
  ready(app) {
    const world = app.world
    const graph = world.tryResource(Graph)
    if (!graph) return
    registerShaders(world.resource(Shaders), FOLIAGE_SHADERS)
    addRenderFeatures(world, {
      name: 'render/foliage',
      description: 'GPU foliage: instances placed and culled by compute, drawn indirectly.',
      nodes: ['foliage/place', 'foliage/cull'],
      baseline: 'unsupported',
    })
    let placed = -1
    graph.addNode('foliage/place', {
      kind: 'raw',
      phase: RenderPhase.Setup + 5,
      sideEffects: true,
      enabled: (view) => cameraOf(view) !== undefined,
      run(ctx) {
        const state = world.resource(ForwardStateResource)
        if (placed === state.frame) return
        placed = state.frame
        const set = world.resource(FoliageLayers)
        const layers = set.layers
        if (layers.size === 0 || !supported(ctx.gpu)) return
        const f = foliageGpu(ctx.gpu, set)
        if (!pipelines(ctx, f)) {
          // Waiting on a compile is a skipped draw: tests settle until there are none.
          ctx.gpu.pipelines.skipped++
          return
        }
        const t0 = performance.now()
        for (const layer of layers) ensureLayer(ctx.gpu, layer, world)
        placeChunks(ctx, f, layers)
        world.tryResource(ProfilerResource)?.record('foliage/place', performance.now() - t0)
      },
    })
    graph.addNode('foliage/cull', {
      kind: 'raw',
      phase: RenderPhase.Setup + 6,
      sideEffects: true,
      after: ['foliage/place'],
      enabled: (view) => cameraOf(view) !== undefined,
      run(ctx) {
        const set = world.resource(FoliageLayers)
        const f = set.gpu
        if (set.layers.size === 0 || !supported(ctx.gpu) || !f?.cull) return
        const cam = cameraOf(ctx.view)!
        const frame = world.resource(ForwardStateResource).frame
        for (const layer of set.layers) {
          if (layer.chunkCount === 0 || !layer.instances) continue
          cullLayer(ctx, f, layer, cam, frame)
        }
      },
    })
  },
})
