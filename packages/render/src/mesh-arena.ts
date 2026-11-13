import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'

// Mesh arenas (0116): CPU meshes that opt in with `Mesh.arena` share one set of vertex buffers and
// one index buffer per arena. A draw of any of them binds nothing new: its base vertex and first
// index say where it lives. Structure's chunk meshes use one, so a pass over thousands of chunks
// is draws, not draws and binds (measured 12x cheaper to encode).

/** First-fit free list over [0, capacity), coalescing neighbors. */
export class RangeAllocator {
  capacity = 0
  /** Free ranges, sorted by start. */
  private readonly starts: number[] = []
  private readonly sizes: number[] = []

  /** A range of `n` units, or -1 if none is free. */
  alloc(n: number): number {
    for (let i = 0; i < this.starts.length; i++) {
      const size = this.sizes[i]!
      if (size < n) continue
      const start = this.starts[i]!
      if (size === n) {
        this.starts.splice(i, 1)
        this.sizes.splice(i, 1)
      } else {
        this.starts[i] = start + n
        this.sizes[i] = size - n
      }
      return start
    }
    return -1
  }

  free(start: number, n: number): void {
    if (n <= 0) return
    let i = 0
    while (i < this.starts.length && this.starts[i]! < start) i++
    this.starts.splice(i, 0, start)
    this.sizes.splice(i, 0, n)
    // With the next, then with the previous.
    if (i + 1 < this.starts.length && start + this.sizes[i]! === this.starts[i + 1]) {
      this.sizes[i]! += this.sizes[i + 1]!
      this.starts.splice(i + 1, 1)
      this.sizes.splice(i + 1, 1)
    }
    if (i > 0 && this.starts[i - 1]! + this.sizes[i - 1]! === this.starts[i]) {
      this.sizes[i - 1]! += this.sizes[i]!
      this.starts.splice(i, 1)
      this.sizes.splice(i, 1)
    }
  }

  /** Adds [capacity, to) to the free list. */
  grow(to: number): void {
    const from = this.capacity
    this.capacity = to
    this.free(from, to - from)
  }

  /** Units free in all. */
  get available(): number {
    let n = 0
    for (let i = 0; i < this.sizes.length; i++) n += this.sizes[i]!
    return n
  }
}

/** Where an arena mesh lives: its vertex and index ranges. */
export interface ArenaPlace {
  vertexStart: number
  vertexCount: number
  indexStart: number
  indexCount: number
}

/** Bytes per vertex of each attribute buffer: positions, normals, uvs, uvs1, tangents. */
const STRIDES = [12, 12, 8, 8, 16] as const
const LABELS = ['positions', 'normals', 'uvs', 'uvs1', 'tangents'] as const

/**
 * One arena's buffers. Indices are uint32 and absolute (offset by each mesh's first vertex), so a
 * draw needs no base vertex: WebGL2 can't offset vertex_index by one (0064).
 */
export class MeshArena {
  readonly name: string
  readonly buffers: GPUBuffer[] = []
  indices: GPUBuffer
  readonly vertices = new RangeAllocator()
  readonly indexRanges = new RangeAllocator()
  /** Bumps when the buffers are replaced (grown): holders of them must re-read. */
  version = 0
  /**
   * Buffers replaced by a grow: draws already recorded this frame still use them, so they're
   * destroyed at the next frame (`releaseRetired`).
   */
  private readonly retired: GPUBuffer[] = []
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext, name: string, vertices = 1 << 14, indices = 1 << 16) {
    this.gpu = gpu
    this.name = name
    for (let k = 0; k < 5; k++) this.buffers.push(this.vertexBuffer(k, vertices))
    this.indices = this.indexBuffer(indices)
    this.vertices.grow(vertices)
    this.indexRanges.grow(indices)
  }

  get positions(): GPUBuffer {
    return this.buffers[0]!
  }

  /** Places a mesh's data (indexed CPU meshes only), growing the arena if it must. */
  place(mesh: Mesh, out: ArenaPlace): void {
    const n = mesh.vertexCount
    const m = mesh.indices!.length
    let v = this.vertices.alloc(n)
    let i = this.indexRanges.alloc(m)
    if (v < 0 || i < 0) {
      if (v >= 0) this.vertices.free(v, n)
      if (i >= 0) this.indexRanges.free(i, m)
      this.grow(n, m)
      v = this.vertices.alloc(n)
      i = this.indexRanges.alloc(m)
    }
    out.vertexStart = v
    out.vertexCount = n
    out.indexStart = i
    out.indexCount = m
    this.write(mesh, out)
  }

  /** Whether new data for a placed mesh fits where it is. */
  fits(mesh: Mesh, at: ArenaPlace): boolean {
    return mesh.vertexCount <= at.vertexCount && (mesh.indices?.length ?? 0) <= at.indexCount
  }

  /** Writes a mesh's data at its place (it must fit). */
  write(mesh: Mesh, at: ArenaPlace): void {
    const queue = this.gpu.device.queue
    const n = mesh.vertexCount
    // Missing attributes get neutral defaults so one pipeline fits every mesh.
    const normals = mesh.normals ?? new Float32Array(n * 3).map((_, i) => (i % 3 === 1 ? 1 : 0))
    const uvs = mesh.uvs ?? new Float32Array(n * 2)
    const data = [
      mesh.positions,
      normals,
      uvs,
      mesh.uvs1 ?? uvs,
      mesh.tangents ?? new Float32Array(n * 4),
    ]
    for (let k = 0; k < 5; k++) {
      const d = data[k]!
      if (d.length > 0)
        queue.writeBuffer(this.buffers[k]!, at.vertexStart * STRIDES[k]!, d, 0, d.length)
    }
    const indices = mesh.indices!
    const u32 = new Uint32Array(indices.length)
    const base = at.vertexStart
    for (let i = 0; i < indices.length; i++) u32[i] = indices[i]! + base
    if (u32.length > 0) queue.writeBuffer(this.indices, at.indexStart * 4, u32, 0, u32.length)
  }

  release(at: ArenaPlace): void {
    this.vertices.free(at.vertexStart, at.vertexCount)
    this.indexRanges.free(at.indexStart, at.indexCount)
    at.vertexCount = 0
    at.indexCount = 0
  }

  /** Bytes of GPU memory it holds. */
  get bytes(): number {
    let b = this.indices.size
    for (const buffer of this.buffers) b += buffer.size
    return b
  }

  /** Destroys buffers a grow replaced: call once a frame, before recording. */
  releaseRetired(): void {
    for (const buffer of this.retired) buffer.destroy()
    this.retired.length = 0
  }

  destroy(): void {
    this.releaseRetired()
    for (const buffer of this.buffers) buffer.destroy()
    this.indices.destroy()
  }

  /** Doubles (at least) the room for vertices and indices, copying what's there. */
  private grow(n: number, m: number): void {
    const device = this.gpu.device
    const encoder = device.createCommandEncoder({ label: `arena/${this.name}/grow` })
    const old = this.buffers.slice()
    const oldIndices = this.indices
    const vertices = Math.max(this.vertices.capacity * 2, this.vertices.capacity + n)
    const indices = Math.max(this.indexRanges.capacity * 2, this.indexRanges.capacity + m)
    for (let k = 0; k < 5; k++) {
      const next = this.vertexBuffer(k, vertices)
      encoder.copyBufferToBuffer(old[k]!, 0, next, 0, old[k]!.size)
      this.buffers[k] = next
    }
    this.indices = this.indexBuffer(indices)
    encoder.copyBufferToBuffer(oldIndices, 0, this.indices, 0, oldIndices.size)
    device.queue.submit([encoder.finish()])
    for (const buffer of old) this.retired.push(buffer)
    this.retired.push(oldIndices)
    this.vertices.grow(vertices)
    this.indexRanges.grow(indices)
    this.version++
  }

  private vertexBuffer(k: number, vertices: number): GPUBuffer {
    return this.gpu.device.createBuffer({
      label: `arena/${this.name}/${LABELS[k]}`,
      size: vertices * STRIDES[k]!,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })
  }

  private indexBuffer(indices: number): GPUBuffer {
    return this.gpu.device.createBuffer({
      label: `arena/${this.name}/indices`,
      size: indices * 4,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
    })
  }
}
