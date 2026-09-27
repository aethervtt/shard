import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'

/**
 * Per-slot deform record, 12 words (mirrors `Deform` in `shard::mesh` and `shard::cull`):
 *
 *   0-3  world bounding sphere (skinned slots; radius 0 means "use the mesh bounds")
 *   4    first joint matrix (vec4 index into poses; 3 rows per joint)   5  joint count
 *   6    first word of the mesh's skin data (joints, weights)           7  first morph delta word
 *   8    vertex count      9  active morph targets (≤ 8)               10  their (index, weight)
 *                                                                          pairs (vec4 index)
 *  11    unused
 */
export const DEFORM_WORDS = 12
const DEFORM_BYTES = DEFORM_WORDS * 4
/** Words of skin data per vertex: joints packed as two u16 pairs, then four f32 weights. */
export const SKIN_WORDS = 6
/** Floats per vertex per morph target: position, normal, and tangent deltas. */
export const MORPH_WORDS = 9

/** Where a mesh's static deform data sits in the shared vertex-data buffer. */
export interface MeshDeform {
  version: number
  /** First word of skin data, or -1 without joints and weights. */
  skinBase: number
  /** First word of morph deltas, or -1 without targets. */
  morphBase: number
  vertexCount: number
  targetCount: number
  /** Per joint: the farthest vertex it mainly moves, in joint space (bounds padding); by skin. */
  radii: Float32Array | undefined
  radiiFor: object | undefined
  /** Frame last used, so meshes that went away are dropped when the buffer repacks. */
  used: number
}

/**
 * GPU data for skinned and morphed instances: per-slot records, this frame's joint matrices and
 * morph weights (`poses`), and every deforming mesh's joints, weights, and morph deltas, packed
 * into one buffer the vertex stage indexes by vertex. Meshes stay in the instanced path; a slot
 * with `InstanceFlags.Skinned` or `Morph` reads its record.
 */
export class DeformStore {
  records = new Uint32Array(DEFORM_WORDS * 256)
  recordF32 = new Float32Array(this.records.buffer)
  /** vec4s: joint matrix rows and morph (index, weight) pairs, written every frame. */
  poses = new Float32Array(4 * 1024)
  poseCount = 0
  private vertexData = new Uint32Array(1024)
  private vertexF32 = new Float32Array(this.vertexData.buffer)
  private vertexWords = 0
  private wasted = 0
  readonly meshes = new Map<Mesh, MeshDeform>()
  readonly recordBuffer: GpuBuffer
  readonly poseBuffer: GpuBuffer
  readonly vertexBuffer: GpuBuffer
  private recordLo = Number.POSITIVE_INFINITY
  private recordHi = -1
  private vertexDirty = true
  private generation: number
  private frame = 0
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.generation = gpu.generation
    const usage = GPUBufferUsage.STORAGE
    this.recordBuffer = new GpuBuffer(gpu, {
      label: 'deform/records',
      usage,
      size: DEFORM_BYTES * 256,
    })
    this.poseBuffer = new GpuBuffer(gpu, { label: 'deform/poses', usage, size: 16 * 1024 })
    this.vertexBuffer = new GpuBuffer(gpu, { label: 'deform/vertices', usage, size: 4096 })
  }

  /** Slots the record array holds. */
  get capacity(): number {
    return this.records.length / DEFORM_WORDS
  }

  ensureSlots(slots: number): void {
    if (slots <= this.capacity) return
    let n = this.capacity
    while (n < slots) n *= 2
    const grown = new Uint32Array(n * DEFORM_WORDS)
    grown.set(this.records)
    this.records = grown
    this.recordF32 = new Float32Array(grown.buffer)
    // A grown buffer starts empty on the GPU: every record goes up again.
    this.recordLo = 0
    this.recordHi = this.capacity - 1
  }

  beginFrame(): void {
    this.poseCount = 0
    this.frame++
  }

  /** Reserves `n` vec4s of this frame's poses; returns the first index. */
  allocPoses(n: number): number {
    const base = this.poseCount
    if ((base + n) * 4 > this.poses.length) {
      let size = this.poses.length * 2
      while (size < (base + n) * 4) size *= 2
      const grown = new Float32Array(size)
      grown.set(this.poses.subarray(0, base * 4))
      this.poses = grown
    }
    this.poseCount = base + n
    return base
  }

  /** Marks a slot's record for upload (after writing `records` at slot * DEFORM_WORDS). */
  touch(slot: number): void {
    if (slot < this.recordLo) this.recordLo = slot
    if (slot > this.recordHi) this.recordHi = slot
  }

  /** Clears a slot's record (no joints, no targets, no sphere). */
  clear(slot: number): void {
    if (slot >= this.capacity) return
    this.records.fill(0, slot * DEFORM_WORDS, (slot + 1) * DEFORM_WORDS)
    this.touch(slot)
  }

  /** Packs a mesh's joints, weights, and morph deltas (once per mesh version). */
  meshData(mesh: Mesh): MeshDeform {
    let entry = this.meshes.get(mesh)
    if (entry && entry.version === mesh.version) {
      entry.used = this.frame
      return entry
    }
    if (entry) this.wasted += this.wordsOf(entry)
    const n = mesh.vertexCount
    entry = {
      version: mesh.version,
      skinBase: -1,
      morphBase: -1,
      vertexCount: n,
      targetCount: mesh.targets?.length ?? 0,
      radii: undefined,
      radiiFor: undefined,
      used: this.frame,
    }
    this.meshes.set(mesh, entry)
    // Repack once more than half the buffer is stale copies: drop meshes unused for a while.
    if (this.wasted > 1 << 16 && this.wasted > this.vertexWords / 2) this.repack()
    else this.pack(mesh, entry)
    return entry
  }

  private wordsOf(entry: MeshDeform): number {
    return (
      (entry.skinBase >= 0 ? entry.vertexCount * SKIN_WORDS : 0) +
      entry.targetCount * entry.vertexCount * MORPH_WORDS
    )
  }

  private reserve(words: number): number {
    const base = this.vertexWords
    if (base + words > this.vertexData.length) {
      let size = this.vertexData.length * 2
      while (size < base + words) size *= 2
      const grown = new Uint32Array(size)
      grown.set(this.vertexData.subarray(0, base))
      this.vertexData = grown
      this.vertexF32 = new Float32Array(grown.buffer)
    }
    this.vertexWords = base + words
    this.vertexDirty = true
    return base
  }

  private pack(mesh: Mesh, entry: MeshDeform): void {
    const n = mesh.vertexCount
    if (mesh.joints && mesh.weights) {
      const base = this.reserve(n * SKIN_WORDS)
      entry.skinBase = base
      const j = mesh.joints
      const w = mesh.weights
      const u = this.vertexData
      const f = this.vertexF32
      for (let v = 0; v < n; v++) {
        const o = base + v * SKIN_WORDS
        u[o] = (j[v * 4]! | (j[v * 4 + 1]! << 16)) >>> 0
        u[o + 1] = (j[v * 4 + 2]! | (j[v * 4 + 3]! << 16)) >>> 0
        // Weights normalized here, so exporters that don't sum to 1 don't shrink the mesh.
        const sum = w[v * 4]! + w[v * 4 + 1]! + w[v * 4 + 2]! + w[v * 4 + 3]!
        const k = sum > 1e-6 ? 1 / sum : 0
        for (let c = 0; c < 4; c++) f[o + 2 + c] = w[v * 4 + c]! * k
        if (sum <= 1e-6) f[o + 2] = 1
      }
    }
    const targets = mesh.targets
    if (targets?.length) {
      const base = this.reserve(targets.length * n * MORPH_WORDS)
      entry.morphBase = base
      const f = this.vertexF32
      for (let t = 0; t < targets.length; t++) {
        const target = targets[t]!
        for (let v = 0; v < n; v++) {
          const o = base + (t * n + v) * MORPH_WORDS
          for (let c = 0; c < 3; c++) {
            f[o + c] = target.positions[v * 3 + c]!
            f[o + 3 + c] = target.normals ? target.normals[v * 3 + c]! : 0
            f[o + 6 + c] = target.tangents ? target.tangents[v * 3 + c]! : 0
          }
        }
      }
    }
  }

  private repack(): void {
    this.vertexWords = 0
    this.wasted = 0
    for (const [mesh, entry] of this.meshes) {
      if (entry.used < this.frame - 600 && mesh.version === entry.version) {
        this.meshes.delete(mesh)
        continue
      }
      entry.version = mesh.version
      entry.vertexCount = mesh.vertexCount
      entry.targetCount = mesh.targets?.length ?? 0
      entry.skinBase = -1
      entry.morphBase = -1
      entry.radii = undefined
      entry.radiiFor = undefined
      this.pack(mesh, entry)
    }
    this.vertexDirty = true
  }

  /** Uploads changed records, this frame's poses, and (when it changed) the vertex data. */
  upload(): void {
    if (this.generation !== this.gpu.generation) {
      this.generation = this.gpu.generation
      this.vertexDirty = true
      this.recordLo = 0
      this.recordHi = this.capacity - 1
    }
    if (this.recordBuffer.ensureCapacity(this.records.byteLength)) {
      this.recordLo = 0
      this.recordHi = this.capacity - 1
    }
    if (this.recordHi >= this.recordLo) {
      const lo = this.recordLo * DEFORM_WORDS
      const n = (this.recordHi - this.recordLo + 1) * DEFORM_WORDS
      this.recordBuffer.write(this.records, lo * 4, lo, n)
    }
    this.recordLo = Number.POSITIVE_INFINITY
    this.recordHi = -1
    if (this.poseCount > 0) this.poseBuffer.write(this.poses, 0, 0, this.poseCount * 4)
    if (this.vertexDirty) {
      this.vertexDirty = false
      if (this.vertexWords > 0) this.vertexBuffer.write(this.vertexData, 0, 0, this.vertexWords)
    }
  }

  /** Bytes of deform data on the GPU (for describe). */
  get vertexBytes(): number {
    return this.vertexWords * 4
  }
}
