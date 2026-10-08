import type { Webgl2BindGroup } from './binding'
import { unsupported } from './errors'
import type { Webgl2RenderPipeline } from './pipeline'
import type { Webgl2QuerySet } from './queries'
import type { Webgl2Buffer, Webgl2TextureView } from './resources'

// Command encoders. WebGPU runs an encoder's commands at submit, after every queue write made
// before it, so encoders record: numbers into a typed array, objects into a list. The device
// replays a stream at submit (replay.ts), then pools the stream and the encoder (with its pass and
// command buffer objects) for the next frame: recording allocates nothing once warm.

export const OP = {
  BEGIN_PASS: 1,
  END_PASS: 2,
  SET_PIPELINE: 3,
  SET_BIND_GROUP: 4,
  SET_VERTEX_BUFFER: 5,
  SET_INDEX_BUFFER: 6,
  DRAW: 7,
  DRAW_INDEXED: 8,
  VIEWPORT: 9,
  SCISSOR: 10,
  STENCIL_REFERENCE: 11,
  BLEND_CONSTANT: 12,
  COPY_BUFFER: 13,
  COPY_BUFFER_TO_TEXTURE: 14,
  COPY_TEXTURE_TO_BUFFER: 15,
  COPY_TEXTURE: 16,
  CLEAR_BUFFER: 17,
  BEGIN_QUERY: 18,
  END_QUERY: 19,
  RESOLVE_QUERIES: 20,
} as const

export class CommandStream {
  nums = new Float64Array(1024)
  n = 0
  readonly refs: unknown[] = []
  r = 0

  num(value: number): void {
    if (this.n === this.nums.length) {
      const grown = new Float64Array(this.nums.length * 2)
      grown.set(this.nums)
      this.nums = grown
    }
    this.nums[this.n++] = value
  }

  ref(value: unknown): void {
    this.refs[this.r++] = value
  }

  /** Empties it, dropping its references so recorded objects can be collected. */
  reset(): void {
    for (let i = 0; i < this.r; i++) this.refs[i] = undefined
    this.n = 0
    this.r = 0
  }
}

export class Webgl2CommandBuffer {
  label = ''
  /** What to replay; undefined once submitted. */
  stream: CommandStream | undefined
  /** The encoder that made it, pooled again after the submit. */
  readonly encoder: Webgl2CommandEncoder
  constructor(encoder: Webgl2CommandEncoder) {
    this.encoder = encoder
  }
}

type Origin = GPUOrigin3D | undefined
type Extent = GPUExtent3D

function originOf(o: Origin, i: 0 | 1 | 2): number {
  if (!o) return 0
  if (Array.isArray(o)) return (o[i] as number | undefined) ?? 0
  const d = o as GPUOrigin3DDict
  return (i === 0 ? d.x : i === 1 ? d.y : d.z) ?? 0
}

function extentOf(e: Extent, i: 0 | 1 | 2): number {
  if (Array.isArray(e)) return (e[i] as number | undefined) ?? 1
  const d = e as GPUExtent3DDict
  return (i === 0 ? d.width : i === 1 ? d.height : d.depthOrArrayLayers) ?? 1
}

function colorOf(c: GPUColor | undefined, i: 0 | 1 | 2 | 3): number {
  if (!c) return 0
  if (Array.isArray(c)) return (c[i] as number | undefined) ?? 0
  const d = c as GPUColorDict
  return i === 0 ? d.r : i === 1 ? d.g : i === 2 ? d.b : d.a
}

export class Webgl2CommandEncoder {
  label = ''
  /** @internal The pass being recorded times itself (`timestampWrites`): its end ends the query. */
  timedPass = false
  private stream: CommandStream | undefined
  private readonly pass: Webgl2RenderPassEncoder
  private readonly buffer: Webgl2CommandBuffer

  constructor() {
    this.pass = new Webgl2RenderPassEncoder(this)
    this.buffer = new Webgl2CommandBuffer(this)
  }

  /** @internal Starts recording into `stream` (a new or pooled encoder). */
  begin(stream: CommandStream, label: string): this {
    this.stream = stream
    this.label = label
    return this
  }

  /** @internal The stream commands record into. */
  get recording(): CommandStream {
    const stream = this.stream
    if (!stream) throw new Error(`Command encoder "${this.label}" was already finished`)
    return stream
  }

  beginRenderPass(d: GPURenderPassDescriptor): Webgl2RenderPassEncoder {
    const s = this.recording
    if (d.occlusionQuerySet) throw unsupported(`run occlusion queries ("${d.label ?? this.label}")`)
    // A timed pass: a TIME_ELAPSED query around it, recorded as its timestamp pair (0074).
    const writes = d.timestampWrites
    const index = writes?.beginningOfPassWriteIndex ?? writes?.endOfPassWriteIndex
    this.timedPass = writes !== undefined && index !== undefined
    if (this.timedPass) {
      s.num(OP.BEGIN_QUERY)
      s.num(index! >> 1)
      s.ref(writes!.querySet)
    }
    s.num(OP.BEGIN_PASS)
    const colors = d.colorAttachments
    s.num(colors.length)
    for (let i = 0; i < colors.length; i++) {
      const c = colors[i]
      if (!c) {
        s.num(0)
        continue
      }
      s.num(1)
      s.ref(c.view)
      s.ref(c.resolveTarget ?? null)
      s.num(c.loadOp === 'clear' ? 1 : 0)
      s.num(c.storeOp === 'discard' ? 1 : 0)
      s.num(c.depthSlice ?? -1)
      s.num(colorOf(c.clearValue, 0))
      s.num(colorOf(c.clearValue, 1))
      s.num(colorOf(c.clearValue, 2))
      s.num(colorOf(c.clearValue, 3))
    }
    const ds = d.depthStencilAttachment
    if (!ds) {
      s.num(0)
    } else {
      s.num(1)
      s.ref(ds.view)
      s.num(ds.depthLoadOp === 'clear' ? 1 : 0)
      s.num(ds.depthStoreOp === 'discard' ? 1 : 0)
      s.num(ds.depthClearValue ?? 0)
      s.num(ds.depthReadOnly ? 1 : 0)
      s.num(ds.stencilLoadOp === 'clear' ? 1 : 0)
      s.num(ds.stencilStoreOp === 'discard' ? 1 : 0)
      s.num(ds.stencilClearValue ?? 0)
      s.num(ds.stencilReadOnly ? 1 : 0)
    }
    return this.pass
  }

  beginComputePass(d?: GPUComputePassDescriptor): never {
    throw unsupported(
      `run the compute pass "${d?.label ?? this.label}"`,
      'Compute is the full tier: a feature that needs it registers baseline "unsupported" (0064).',
    )
  }

  copyBufferToBuffer(
    source: Webgl2Buffer,
    a: number | Webgl2Buffer,
    b?: Webgl2Buffer | number,
    c?: number,
    d?: number,
  ): void {
    const s = this.recording
    s.num(OP.COPY_BUFFER)
    if (typeof a === 'number') {
      // (source, sourceOffset, destination, destinationOffset, size)
      const destination = b as Webgl2Buffer
      s.num(a)
      s.num(c ?? 0)
      s.num(d ?? source.size - a)
      s.ref(source)
      s.ref(destination)
    } else {
      // (source, destination, size?)
      s.num(0)
      s.num(0)
      s.num((b as number | undefined) ?? source.size)
      s.ref(source)
      s.ref(a)
    }
  }

  copyBufferToTexture(
    source: GPUTexelCopyBufferInfo,
    destination: GPUTexelCopyTextureInfo,
    size: Extent,
  ): void {
    const s = this.recording
    const h = extentOf(size, 1)
    s.num(OP.COPY_BUFFER_TO_TEXTURE)
    s.num(source.offset ?? 0)
    s.num(source.bytesPerRow ?? 0)
    s.num(source.rowsPerImage ?? h)
    s.num(destination.mipLevel ?? 0)
    s.num(originOf(destination.origin, 0))
    s.num(originOf(destination.origin, 1))
    s.num(originOf(destination.origin, 2))
    s.num(extentOf(size, 0))
    s.num(h)
    s.num(extentOf(size, 2))
    s.ref(source.buffer)
    s.ref(destination.texture)
  }

  copyTextureToBuffer(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyBufferInfo,
    size: Extent,
  ): void {
    const s = this.recording
    const h = extentOf(size, 1)
    s.num(OP.COPY_TEXTURE_TO_BUFFER)
    s.num(source.mipLevel ?? 0)
    s.num(originOf(source.origin, 0))
    s.num(originOf(source.origin, 1))
    s.num(originOf(source.origin, 2))
    s.num(destination.offset ?? 0)
    s.num(destination.bytesPerRow ?? 0)
    s.num(destination.rowsPerImage ?? h)
    s.num(extentOf(size, 0))
    s.num(h)
    s.num(extentOf(size, 2))
    s.ref(source.texture)
    s.ref(destination.buffer)
  }

  copyTextureToTexture(
    source: GPUTexelCopyTextureInfo,
    destination: GPUTexelCopyTextureInfo,
    size: Extent,
  ): void {
    const s = this.recording
    s.num(OP.COPY_TEXTURE)
    s.num(source.mipLevel ?? 0)
    s.num(originOf(source.origin, 0))
    s.num(originOf(source.origin, 1))
    s.num(originOf(source.origin, 2))
    s.num(destination.mipLevel ?? 0)
    s.num(originOf(destination.origin, 0))
    s.num(originOf(destination.origin, 1))
    s.num(originOf(destination.origin, 2))
    s.num(extentOf(size, 0))
    s.num(extentOf(size, 1))
    s.num(extentOf(size, 2))
    s.ref(source.texture)
    s.ref(destination.texture)
  }

  clearBuffer(buffer: Webgl2Buffer, offset = 0, size?: number): void {
    const s = this.recording
    s.num(OP.CLEAR_BUFFER)
    s.num(offset)
    s.num(size ?? buffer.size - offset)
    s.ref(buffer)
  }

  /** Pairs of the set to the buffer: written when the buffer is mapped (queries.ts). */
  resolveQuerySet(
    querySet: Webgl2QuerySet,
    firstQuery: number,
    queryCount: number,
    destination: Webgl2Buffer,
    destinationOffset: number,
  ): void {
    const s = this.recording
    s.num(OP.RESOLVE_QUERIES)
    s.num(firstQuery)
    s.num(queryCount)
    s.num(destinationOffset)
    s.ref(querySet)
    s.ref(destination)
  }

  writeTimestamp(): never {
    throw unsupported('write timestamps', 'WebGL2 times passes (timestampWrites) only.')
  }

  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}

  finish(d?: GPUCommandBufferDescriptor): Webgl2CommandBuffer {
    const buffer = this.buffer
    buffer.stream = this.recording
    buffer.label = d?.label ?? this.label
    this.stream = undefined
    return buffer
  }
}

export class Webgl2RenderPassEncoder {
  label = ''
  private readonly encoder: Webgl2CommandEncoder

  constructor(encoder: Webgl2CommandEncoder) {
    this.encoder = encoder
  }

  setPipeline(pipeline: Webgl2RenderPipeline): void {
    const s = this.encoder.recording
    s.num(OP.SET_PIPELINE)
    s.ref(pipeline)
  }

  setBindGroup(
    index: number,
    group: Webgl2BindGroup | null,
    offsets?: Iterable<number> | Uint32Array,
    start = 0,
    length?: number,
  ): void {
    const s = this.encoder.recording
    s.num(OP.SET_BIND_GROUP)
    s.num(index)
    if (!offsets) {
      s.num(0)
    } else if (offsets instanceof Uint32Array) {
      const n = length ?? offsets.length - start
      s.num(n)
      for (let i = 0; i < n; i++) s.num(offsets[start + i]!)
    } else {
      const list = Array.isArray(offsets) ? (offsets as number[]) : [...offsets]
      s.num(list.length)
      for (let i = 0; i < list.length; i++) s.num(list[i]!)
    }
    s.ref(group)
  }

  setVertexBuffer(slot: number, buffer: Webgl2Buffer | null, offset = 0, size?: number): void {
    const s = this.encoder.recording
    s.num(OP.SET_VERTEX_BUFFER)
    s.num(slot)
    s.num(offset)
    s.num(size ?? (buffer ? buffer.size - offset : 0))
    s.ref(buffer)
  }

  setIndexBuffer(buffer: Webgl2Buffer, format: GPUIndexFormat, offset = 0, size?: number): void {
    const s = this.encoder.recording
    s.num(OP.SET_INDEX_BUFFER)
    s.num(format === 'uint32' ? 4 : 2)
    s.num(offset)
    s.num(size ?? buffer.size - offset)
    s.ref(buffer)
  }

  draw(vertexCount: number, instanceCount = 1, firstVertex = 0, firstInstance = 0): void {
    const s = this.encoder.recording
    s.num(OP.DRAW)
    s.num(vertexCount)
    s.num(instanceCount)
    s.num(firstVertex)
    s.num(firstInstance)
  }

  drawIndexed(
    indexCount: number,
    instanceCount = 1,
    firstIndex = 0,
    baseVertex = 0,
    firstInstance = 0,
  ): void {
    const s = this.encoder.recording
    s.num(OP.DRAW_INDEXED)
    s.num(indexCount)
    s.num(instanceCount)
    s.num(firstIndex)
    s.num(baseVertex)
    s.num(firstInstance)
  }

  drawIndirect(): never {
    throw unsupported('draw indirectly', 'The baseline tier culls on the CPU and draws directly.')
  }

  drawIndexedIndirect(): never {
    throw unsupported('draw indirectly', 'The baseline tier culls on the CPU and draws directly.')
  }

  setViewport(
    x: number,
    y: number,
    width: number,
    height: number,
    minDepth: number,
    maxDepth: number,
  ): void {
    const s = this.encoder.recording
    s.num(OP.VIEWPORT)
    s.num(x)
    s.num(y)
    s.num(width)
    s.num(height)
    s.num(minDepth)
    s.num(maxDepth)
  }

  setScissorRect(x: number, y: number, width: number, height: number): void {
    const s = this.encoder.recording
    s.num(OP.SCISSOR)
    s.num(x)
    s.num(y)
    s.num(width)
    s.num(height)
  }

  setStencilReference(reference: number): void {
    const s = this.encoder.recording
    s.num(OP.STENCIL_REFERENCE)
    s.num(reference)
  }

  setBlendConstant(color: GPUColor): void {
    const s = this.encoder.recording
    s.num(OP.BLEND_CONSTANT)
    s.num(colorOf(color, 0))
    s.num(colorOf(color, 1))
    s.num(colorOf(color, 2))
    s.num(colorOf(color, 3))
  }

  executeBundles(): never {
    throw unsupported('execute render bundles')
  }

  beginOcclusionQuery(): never {
    throw unsupported('run occlusion queries')
  }

  endOcclusionQuery(): never {
    throw unsupported('run occlusion queries')
  }

  pushDebugGroup(): void {}
  popDebugGroup(): void {}
  insertDebugMarker(): void {}

  end(): void {
    const s = this.encoder.recording
    s.num(OP.END_PASS)
    if (this.encoder.timedPass) {
      s.num(OP.END_QUERY)
      this.encoder.timedPass = false
    }
  }
}

/** Where a view attaches: its array layer, cube face, or (3D) the pass's depth slice. */
export function layerOf(view: Webgl2TextureView, depthSlice: number): number {
  if (view.texture.dimension === '3d') return depthSlice < 0 ? 0 : depthSlice
  return view.baseArrayLayer
}

/** A mip level's extent. */
export function mipSize(size: number, mip: number): number {
  return Math.max(1, size >> mip)
}
