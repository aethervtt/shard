import { defineResource } from '@shard/core'
import { GpuBuffer, type GpuContext } from '@shard/gpu'
import { readBuffer } from './debug-views'
import type { NodeContext } from './graph'
import {
  type CullParams,
  type DrawList,
  InstanceFlags,
  type InstanceStore,
  LOD_UNSET,
  SLOT_MASK,
} from './instances'
import { Shaders } from './plugin'

/** Words per indirect draw: indexed (count, instances, first index, base vertex, first instance). */
const ARGS_WORDS = 5
const VIEW_FLOATS = 32
const BATCH_WORDS = 8
const LOD_WORDS = 20

const VIEW_CASTERS = 1
const VIEW_UPDATE_LOD = 2
const VIEW_ORTHO = 4
const VIEW_NO_PLANES = 8

const BATCH_TRANSPARENT = 1
const BATCH_NOT_READY = 2

interface CullView {
  list: DrawList
  forwardOnly: DrawList | undefined
  /** Copies: callers reuse their scratch planes between views. */
  planes: Float32Array
  hasPlanes: boolean
  eye: Float32Array
  hasEye: boolean
  lodScale: number
  flags: number
  lodCamera: number
}

/**
 * GPU culling: one compute pass per frame culls every instance slot against every draw view
 * (cameras first, which choose LOD levels, then shadow views, which reuse them), writing indirect
 * draw arguments and compacted visible lists. Nothing is read back in the frame; visible counts
 * come back asynchronously for `render.describe`.
 */
export class GpuCuller {
  readonly supported: boolean
  /** Turn off to force CPU culling (tests, debugging). */
  enabled = true
  private readonly views: CullView[] = []
  private viewCount = 0
  private cameraViews = 0
  /** LOD camera index per camera entity, stable while the camera lives. */
  private readonly lodCameras = new Map<number, number>()
  private viewData = new Float32Array(VIEW_FLOATS * 16)
  private viewU32 = new Uint32Array(this.viewData.buffer)
  private batchData = new Uint32Array(BATCH_WORDS * 64)
  private batchF32 = new Float32Array(this.batchData.buffer)
  private lodData = new Uint32Array(LOD_WORDS * 16)
  private lodF32 = new Float32Array(this.lodData.buffer)
  private readonly params = new Uint32Array(8)
  readonly viewBuffer: GpuBuffer
  readonly batchBuffer: GpuBuffer
  readonly lodBuffer: GpuBuffer
  readonly args: GpuBuffer
  readonly visible: GpuBuffer
  readonly lodState: GpuBuffer
  readonly paramBuffers: GpuBuffer[] = []
  /** Instances a view's region can hold: the sum of batch capacities. */
  regionSize = 0
  private batchCount = 0
  private lodStateCapacity = 0
  private readonly gpu: GpuContext
  private bindGroups: { key: string; groups: GPUBindGroup[] } | undefined
  private readonly readbacks: { buffer: GPUBuffer; busy: boolean; generation: number }[] = []
  /** Visible instances per DrawList, from the last readback (a frame or two late). */
  readonly counts = new WeakMap<DrawList, number>()
  /** Per-LOD-level instance counts per DrawList, from the last readback. */
  readonly lodCounts = new WeakMap<DrawList, number[]>()
  /** Batches that drew at least one instance, per DrawList, from the last readback. */
  readonly drawCounts = new WeakMap<DrawList, number>()
  /** Instances per batch index, per DrawList, from the last readback. */
  readonly batchCounts = new WeakMap<DrawList, Uint32Array>()
  private frameViews: CullView[] = []
  private readonly pending = new Set<Promise<void>>()

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.supported = gpu.features.has('indirect-first-instance')
    const storage = GPUBufferUsage.STORAGE
    this.viewBuffer = new GpuBuffer(gpu, { label: 'cull/views', usage: storage, size: 4096 })
    this.batchBuffer = new GpuBuffer(gpu, { label: 'cull/batches', usage: storage, size: 2048 })
    this.lodBuffer = new GpuBuffer(gpu, { label: 'cull/lod-sets', usage: storage, size: 1280 })
    this.args = new GpuBuffer(gpu, {
      label: 'cull/args',
      usage: storage | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_SRC,
      size: 4096,
    })
    this.visible = new GpuBuffer(gpu, {
      label: 'cull/visible',
      usage: storage | GPUBufferUsage.COPY_SRC,
      size: 4096,
    })
    this.lodState = new GpuBuffer(gpu, { label: 'cull/lod-state', usage: storage, size: 4096 })
  }

  get active(): boolean {
    return this.supported && this.enabled
  }

  beginFrame(): void {
    this.viewCount = 0
    this.cameraViews = 0
  }

  /** The LOD state row of a camera (cameras choose; their shadow views reuse the choice). */
  lodCamera(entity: number): number {
    let i = this.lodCameras.get(entity)
    if (i === undefined) {
      i = this.lodCameras.size
      this.lodCameras.set(entity, i)
    }
    return i
  }

  /**
   * Adds a view to this frame's cull. Camera views must come before shadow views (they choose LOD
   * levels). The list gets one indirect draw per live batch; deferred views split non-deferrable
   * batches into `forwardOnly`.
   */
  add(
    store: InstanceStore,
    list: DrawList,
    params: CullParams,
    lodCamera: number,
    forwardOnly?: DrawList,
  ): number {
    const v = this.viewCount++
    let view = this.views[v]
    if (!view) {
      view = {
        list,
        forwardOnly,
        planes: new Float32Array(24),
        hasPlanes: false,
        eye: new Float32Array(3),
        hasEye: false,
        lodScale: 1,
        flags: 0,
        lodCamera: 0,
      }
      this.views.push(view)
    }
    view.list = list
    view.forwardOnly = forwardOnly
    view.hasPlanes = params.planes !== null
    if (params.planes) view.planes.set(params.planes)
    view.hasEye = params.eye !== undefined
    if (params.eye) view.eye.set(params.eye)
    view.lodScale = params.lodScale
    view.lodCamera = lodCamera
    view.flags =
      (params.require & InstanceFlags.Caster ? VIEW_CASTERS : 0) |
      (params.updateLod ? VIEW_UPDATE_LOD : 0) |
      (params.orthographic ? VIEW_ORTHO : 0) |
      (params.planes ? 0 : VIEW_NO_PLANES)
    if (params.updateLod) this.cameraViews = v + 1
    list.cullView = v
    list.culled = 0
    list.hidden = 0
    list.pending = store.pending.size
    list.visible = this.counts.get(list) ?? 0
    if (forwardOnly) {
      forwardOnly.cullView = v
      forwardOnly.visible = this.counts.get(forwardOnly) ?? 0
    }
    // One indirect draw per live, ready, opaque batch, in draw order.
    let n = 0
    let m = 0
    for (const batch of store.sorted) {
      if (batch.count === 0 || batch.transparent) continue
      // Waiting on its material's GPU resources: its members count as pending, so readiness
      // checks (settle, asset previews) wait for them.
      if (!batch.ready) {
        list.pending += batch.count
        continue
      }
      const target = forwardOnly && !batch.deferrable ? forwardOnly : list
      const k = target === list ? n++ : m++
      let item = target.items[k]
      if (!item) {
        item = { batch, first: 0, count: 0, indirect: 0 }
        target.items.push(item)
      }
      item.batch = batch
      item.first = 0
      item.count = 0
      item.indirect = -2 - batch.index // resolved to a byte offset in `prepare`
    }
    list.length = n
    if (forwardOnly) forwardOnly.length = m
    return v
  }

  /** Uploads the frame's view, batch, and LOD tables, and sizes the buffers. */
  prepare(store: InstanceStore): void {
    if (this.viewCount === 0) return
    const batches = store.batches
    this.batchCount = batches.length
    // Regions: each batch gets room for every instance that can land in it.
    if (this.batchData.length < batches.length * BATCH_WORDS) {
      this.batchData = new Uint32Array(batches.length * BATCH_WORDS * 2)
      this.batchF32 = new Float32Array(this.batchData.buffer)
    }
    let region = 0
    for (const batch of batches) {
      batch.region = region
      region += batch.count
      const o = batch.index * BATCH_WORDS
      const b = batch.mesh.bounds
      this.batchF32[o] = (b[0]! + b[3]!) * 0.5
      this.batchF32[o + 1] = (b[1]! + b[4]!) * 0.5
      this.batchF32[o + 2] = (b[2]! + b[5]!) * 0.5
      const ex = (b[3]! - b[0]!) * 0.5
      const ey = (b[4]! - b[1]!) * 0.5
      const ez = (b[5]! - b[2]!) * 0.5
      this.batchF32[o + 3] = Math.fround(Math.sqrt(ex * ex + ey * ey + ez * ez))
      this.batchData[o + 4] = batch.mesh.drawCount
      this.batchData[o + 5] = batch.mesh.indices ? 1 : 0
      this.batchData[o + 6] = batch.region
      this.batchData[o + 7] =
        (batch.transparent ? BATCH_TRANSPARENT : 0) | (batch.ready ? 0 : BATCH_NOT_READY)
    }
    this.regionSize = Math.max(1, region)
    this.batchBuffer.write(this.batchData, 0, 0, Math.max(1, batches.length) * BATCH_WORDS)
    // LOD sets.
    const sets = store.lodSets
    if (this.lodData.length < Math.max(1, sets.length) * LOD_WORDS) {
      this.lodData = new Uint32Array(sets.length * LOD_WORDS * 2)
      this.lodF32 = new Float32Array(this.lodData.buffer)
    }
    for (const set of sets) {
      const o = set.index * LOD_WORDS
      this.lodData[o] = set.batches.length
      this.lodF32[o + 1] = set.hysteresis
      this.lodF32[o + 2] = set.bias
      this.lodData[o + 3] = 0
      for (let k = 0; k < 8; k++) {
        this.lodF32[o + 4 + k] = k < set.thresholds.length ? set.thresholds[k]! : 0
        this.lodData[o + 12 + k] = k < set.batches.length ? set.batches[k]! : 0
      }
    }
    this.lodBuffer.write(this.lodData, 0, 0, Math.max(1, sets.length) * LOD_WORDS)
    // Views.
    if (this.viewData.length < this.viewCount * VIEW_FLOATS) {
      this.viewData = new Float32Array(this.viewCount * VIEW_FLOATS * 2)
      this.viewU32 = new Uint32Array(this.viewData.buffer)
    }
    for (let v = 0; v < this.viewCount; v++) {
      const view = this.views[v]!
      const o = v * VIEW_FLOATS
      if (view.hasPlanes) this.viewData.set(view.planes, o)
      else this.viewData.fill(0, o, o + 24)
      this.viewData[o + 24] = view.eye[0]!
      this.viewData[o + 25] = view.eye[1]!
      this.viewData[o + 26] = view.eye[2]!
      this.viewData[o + 27] = view.lodScale
      this.viewU32[o + 28] = view.flags | (view.hasEye ? 0 : 16)
      this.viewU32[o + 29] = view.lodCamera
      this.viewU32[o + 30] = v * batches.length
      this.viewU32[o + 31] = v * this.regionSize
      // Draw items: byte offsets of their indirect arguments.
      for (const list of [view.list, view.forwardOnly]) {
        if (!list) continue
        for (let d = 0; d < list.length; d++) {
          const item = list.items[d]!
          item.indirect = (v * batches.length + item.batch.index) * ARGS_WORDS * 4
          item.first = v * this.regionSize + item.batch.region
        }
      }
    }
    this.viewBuffer.write(this.viewData, 0, 0, this.viewCount * VIEW_FLOATS)
    this.args.ensureCapacity(Math.max(1, this.viewCount * batches.length) * ARGS_WORDS * 4)
    this.visible.ensureCapacity(this.viewCount * this.regionSize * 4)
    const lodCams = Math.max(1, this.lodCameras.size)
    if (this.lodStateCapacity !== store.capacity * lodCams) {
      // New capacity: every entry starts unset (the fill is a one-time upload, not per frame).
      this.lodStateCapacity = store.capacity * lodCams
      const fill = new Uint32Array(this.lodStateCapacity).fill(LOD_UNSET)
      this.lodState.write(fill)
    }
    this.frameViews = this.views.slice(0, this.viewCount)
    this.slotCount = store.high
    this.slotCapacity = store.capacity
  }

  private slotCount = 0
  private slotCapacity = 0

  /** Encodes the cull: reset arguments, cull camera views, then shadow views. */
  encode(ctx: NodeContext, store: InstanceStore): void {
    if (this.viewCount === 0) return
    const gpu = ctx.gpu
    const world = ctx.world
    const module = world.resource(Shaders).module(gpu, { root: 'shard::cull' })
    if (!module) {
      gpu.pipelines.skipped++
      return
    }
    const layout = cullLayout(gpu)
    const pipelineLayout = gpu.layouts.pipelineLayout({ label: 'cull', bindGroupLayouts: [layout] })
    const reset = gpu.pipelines.compute({
      label: 'cull/reset',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'reset' },
    })
    const cull = gpu.pipelines.compute({
      label: 'cull/instances',
      layout: pipelineLayout,
      compute: { module, entryPoint: 'cull' },
    })
    if (!reset || !cull) return
    // Three dispatch parameter sets: reset, cameras, shadows.
    const passes = [
      [0, this.viewCount],
      [0, this.cameraViews],
      [this.cameraViews, this.viewCount - this.cameraViews],
    ] as const
    for (let i = 0; i < 3; i++) {
      let buffer = this.paramBuffers[i]
      if (!buffer) {
        buffer = new GpuBuffer(gpu, {
          label: `cull/params${i}`,
          usage: GPUBufferUsage.UNIFORM,
          size: 32,
        })
        this.paramBuffers.push(buffer)
      }
      this.params[0] = this.slotCount
      this.params[1] = passes[i]![0]
      this.params[2] = passes[i]![1]
      this.params[3] = this.batchCount
      this.params[4] = this.slotCapacity
      buffer.write(this.params)
    }
    const key = [
      gpu.generation,
      store.instanceBuffer.version,
      this.batchBuffer.version,
      this.lodBuffer.version,
      this.viewBuffer.version,
      this.args.version,
      this.visible.version,
      this.lodState.version,
      ...this.paramBuffers.map((b) => b.version),
    ].join('/')
    if (!this.bindGroups || this.bindGroups.key !== key) {
      this.bindGroups = {
        key,
        groups: this.paramBuffers.map((params) =>
          gpu.device.createBindGroup({
            label: 'cull',
            layout,
            entries: [
              { binding: 0, resource: { buffer: store.instanceBuffer.buffer } },
              { binding: 1, resource: { buffer: this.batchBuffer.buffer } },
              { binding: 2, resource: { buffer: this.lodBuffer.buffer } },
              { binding: 3, resource: { buffer: this.viewBuffer.buffer } },
              { binding: 4, resource: { buffer: this.args.buffer } },
              { binding: 5, resource: { buffer: this.visible.buffer } },
              { binding: 6, resource: { buffer: this.lodState.buffer } },
              { binding: 7, resource: { buffer: params.buffer } },
            ],
          }),
        ),
      }
    }
    const pass = ctx.encoder.beginComputePass({
      label: 'instance-cull',
      timestampWrites: ctx.timestamps('instance-cull'),
    })
    const argGroups = Math.ceil((this.viewCount * this.batchCount) / 64)
    if (argGroups > 0) {
      pass.setPipeline(reset)
      pass.setBindGroup(0, this.bindGroups.groups[0]!)
      pass.dispatchWorkgroups(argGroups)
    }
    pass.setPipeline(cull)
    const slotGroups = Math.ceil(this.slotCount / 64)
    if (this.cameraViews > 0 && slotGroups > 0) {
      pass.setBindGroup(0, this.bindGroups.groups[1]!)
      pass.dispatchWorkgroups(slotGroups, this.cameraViews)
    }
    if (this.viewCount > this.cameraViews && slotGroups > 0) {
      pass.setBindGroup(0, this.bindGroups.groups[2]!)
      pass.dispatchWorkgroups(slotGroups, this.viewCount - this.cameraViews)
    }
    pass.end()
    const map = this.readback(ctx.encoder, store)
    if (map) ctx.afterSubmit(map)
  }

  /** Copies the arguments to a readback buffer; resolves visible counts when it maps. */
  private readback(encoder: GPUCommandEncoder, store: InstanceStore): (() => void) | undefined {
    const gen = this.gpu.generation
    const bytes = this.viewCount * this.batchCount * ARGS_WORDS * 4
    if (bytes === 0) return undefined
    for (let i = this.readbacks.length - 1; i >= 0; i--) {
      const r = this.readbacks[i]!
      if (r.generation !== gen || (!r.busy && r.buffer.size < bytes)) {
        if (!r.busy) r.buffer.destroy()
        this.readbacks.splice(i, 1)
      }
    }
    let rb = this.readbacks.find((r) => !r.busy)
    if (!rb && this.readbacks.length < 2) {
      rb = {
        buffer: this.gpu.device.createBuffer({
          label: 'cull/readback',
          size: Math.max(256, bytes * 2),
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
        generation: gen,
      }
      this.readbacks.push(rb)
    }
    if (!rb) return undefined
    encoder.copyBufferToBuffer(this.args.buffer, 0, rb.buffer, 0, bytes)
    rb.busy = true
    const target = rb
    const views = this.frameViews
    const batchCount = this.batchCount
    const lodLevel = new Map<number, number>()
    for (const set of store.lodSets) {
      for (let k = 0; k < set.batches.length; k++) lodLevel.set(set.batches[k]!, k)
    }
    return () => {
      const done = target.buffer.mapAsync(GPUMapMode.READ, 0, bytes).then(
        () => {
          const args = new Uint32Array(target.buffer.getMappedRange(0, bytes).slice(0))
          target.buffer.unmap()
          target.busy = false
          views.forEach((view, v) => {
            let main = 0
            let forward = 0
            let mainDraws = 0
            let forwardDraws = 0
            const lods: number[] = []
            const perBatch = new Uint32Array(batchCount)
            for (let b = 0; b < batchCount; b++) {
              const n = args[(v * batchCount + b) * ARGS_WORDS + 1]!
              perBatch[b] = n
              const batch = store.batches[b]
              if (!batch) continue
              if (view.forwardOnly && !batch.deferrable) {
                forward += n
                if (n > 0) forwardDraws++
              } else {
                main += n
                if (n > 0) mainDraws++
              }
              const level = lodLevel.get(b)
              if (level !== undefined) lods[level] = (lods[level] ?? 0) + n
            }
            this.counts.set(view.list, main)
            this.batchCounts.set(view.list, perBatch)
            if (view.forwardOnly) this.batchCounts.set(view.forwardOnly, perBatch)
            this.drawCounts.set(view.list, mainDraws)
            this.lodCounts.set(view.list, lods)
            if (view.forwardOnly) {
              this.counts.set(view.forwardOnly, forward)
              this.drawCounts.set(view.forwardOnly, forwardDraws)
            }
          })
        },
        () => {
          target.busy = false
        },
      )
      this.pending.add(done)
      done.then(() => this.pending.delete(done))
    }
  }

  /** Resolves once every readback in flight has landed (tests: stats that match the last frame). */
  async whenIdle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all(this.pending)
  }
}

function cullLayout(gpu: GpuContext): GPUBindGroupLayout {
  const C = GPUShaderStage.COMPUTE
  const read = (binding: number) => ({
    binding,
    visibility: C,
    buffer: { type: 'read-only-storage' as const },
  })
  const write = (binding: number) => ({
    binding,
    visibility: C,
    buffer: { type: 'storage' as const },
  })
  return gpu.layouts.bindGroupLayout({
    label: 'cull',
    entries: [
      read(0),
      read(1),
      read(2),
      read(3),
      write(4),
      write(5),
      write(6),
      { binding: 7, visibility: C, buffer: { type: 'uniform' } },
    ],
  })
}

export const Culler = defineResource<GpuCuller>('render/Culler', {
  description: 'GPU culling: indirect draws for every camera and shadow view.',
})

/**
 * Culls transparent instances on the CPU (they need a back-to-front sort), iterating only the
 * members of blended batches, so it costs what's transparent, not what exists.
 */
export function cullTransparent(
  store: InstanceStore,
  list: DrawList,
  params: CullParams,
  forward: Float32Array,
): void {
  store.cullTransparentMembers(list, params, forward)
}

/**
 * The CPU-side visible set of a view as slots (tests compare it with the GPU's). Pass
 * `mask = 0xffffffff` to keep the LOD level in the top bits.
 */
export function visibleSlots(store: InstanceStore, list: DrawList, mask = SLOT_MASK): Set<number> {
  const out = new Set<number>()
  for (let d = 0; d < list.length; d++) {
    const item = list.items[d]!
    for (let i = 0; i < item.count; i++) out.add((store.visible[item.first + i]! & mask) >>> 0)
  }
  return out
}

/** Reads back a GPU-culled view's visible set as slots (tests). */
export async function readVisibleSlots(
  gpu: GpuContext,
  culler: GpuCuller,
  list: DrawList,
  mask = SLOT_MASK,
): Promise<Set<number>> {
  const out = new Set<number>()
  if (list.cullView < 0 || list.length === 0) return out
  const args = new Uint32Array(await readBuffer(gpu, culler.args.buffer, culler.args.byteLength))
  const visible = new Uint32Array(
    await readBuffer(gpu, culler.visible.buffer, culler.visible.byteLength),
  )
  for (let d = 0; d < list.length; d++) {
    const item = list.items[d]!
    const n = args[item.indirect / 4 + 1]!
    for (let i = 0; i < n; i++) out.add((visible[item.first + i]! & mask) >>> 0)
  }
  return out
}
