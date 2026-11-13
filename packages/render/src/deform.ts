import { ShardError } from '@aethervtt/shard-core'
import type { GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { DataStore } from './data-store'

/**
 * Per-slot deform record, 12 words (mirrors `Deform` in `shard::mesh` and `shard::cull`):
 *
 *   0-3  world bounding sphere (skinned slots; radius 0 means "use the mesh bounds")
 *   4    first joint matrix (vec4 index into poses; 3 rows per joint), or with BAKED_BIT the
 *        baked playback header's (spec 0115)
 *   5    joint count, with BAKED_BIT for baked playback (readers mask it)
 *   6    first word of the mesh's skin data (joints, weights)           7  first morph delta word
 *   8    vertex count      9  active morph targets (≤ 8)               10  their (index, weight)
 *                                                                          pairs (vec4 index)
 *  11    1 + first word of the slot's LOD level table, or 0 without Lod (spec 0103)
 *
 * Words 6-8 describe level 0's mesh. A LOD set's level table, in the vertex data, has a row of
 * `LEVEL_WORDS` per level: skin base (`NO_SKIN` without), morph base, vertex count, target count.
 */
export const DEFORM_WORDS = 12
const DEFORM_BYTES = DEFORM_WORDS * 4
/** Words of skin data per vertex: joints packed as two u16 pairs, then four f32 weights. */
export const SKIN_WORDS = 6
/** Floats per vertex per morph target: position, normal, and tangent deltas. */
export const MORPH_WORDS = 9
/** Words per level in a LOD set's level table. */
export const LEVEL_WORDS = 4
/** A level table's skin base for a level whose mesh has no joints and weights. */
export const NO_SKIN = 0xffffffff
/**
 * Record word 5's flag for baked playback (spec 0115): word 4 then points at a 3-vec4 header in
 * the persistent region of `poses`, and the vertex stage computes each joint's rows from it and
 * the clock. The joint count is `word5 & JOINT_COUNT_MASK`.
 */
export const BAKED_BIT = 0x80000000
/** Record word 5 without BAKED_BIT: the joint count. */
export const JOINT_COUNT_MASK = 0x7fffffff
/** Dirty persistent ranges kept apart before the closest two merge. */
const MAX_DIRTY = 32

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
 * GPU data for skinned and morphed instances: per-slot records, joint matrices and morph weights
 * (`poses`), and every deforming mesh's joints, weights, and morph deltas, packed into one buffer
 * the vertex stage indexes by vertex. Meshes stay in the instanced path; a slot with
 * `InstanceFlags.Skinned` or `Morph` reads its record.
 *
 * `poses` has two regions (spec 0115). The **persistent** one, `[0, persistentEnd)`, holds blocks
 * that callers own (`allocPersistent`) and write directly, marking what they wrote
 * (`markPersistent`); only those ranges upload. vec4 0 is the clock (`setClock`) that baked
 * playback reads. The **per-frame** region after it (`allocPoses`) is rewritten every frame.
 */
export class DeformStore {
  records = new Uint32Array(DEFORM_WORDS * 256)
  recordF32 = new Float32Array(this.records.buffer)
  /**
   * vec4s: joint matrix rows and morph (index, weight) pairs. Persistent blocks, then this frame's.
   * Re-read it after `allocPersistent` or `allocPoses`: growing replaces it.
   */
  poses = new Float32Array(4 * 1024)
  /** End of the per-frame region (vec4s): `persistentEnd` plus what this frame allocated. */
  poseCount = 1
  /** End of the persistent region (vec4s), where the per-frame region starts. */
  persistentEnd = 1
  /** Skinned slots playing baked poses this frame (prepare-deforms counts them). */
  bakedSlots = 0
  /** CPU copy of the vertex data (skin words, morph deltas, level tables), for the testing mirror. */
  vertexData = new Uint32Array(1024)
  vertexF32 = new Float32Array(this.vertexData.buffer)
  /** Free persistent blocks, sorted by base: (base, vec4s) pairs. Cold path. */
  private readonly free: number[] = []
  /** Persistent ranges to upload: [lo, hi) vec4 pairs. */
  private readonly dirty = new Uint32Array(MAX_DIRTY * 2)
  private dirtyCount = 0
  /** Frame `markPersistent` last ran in (shadows redraw while poses move). */
  private movedFrame = -2
  private vertexWords = 0
  private wasted = 0
  readonly meshes = new Map<Mesh, MeshDeform>()
  /** Bumped when packed mesh data moves or changes: records that cached it are rewritten. */
  layout = 0
  /** First word of each LOD set's level table, by set (cleared by a repack). */
  private readonly levelTables = new Map<object, number>()
  readonly recordBuffer: DataStore
  readonly poseBuffer: DataStore
  readonly vertexBuffer: DataStore
  private recordLo = Number.POSITIVE_INFINITY
  private recordHi = -1
  private vertexDirty = true
  private generation: number
  private frame = 0
  private readonly gpu: GpuContext

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.generation = gpu.generation
    // Read by the vertex stage: storage on the full tier, data textures on baseline (0064).
    this.recordBuffer = new DataStore(gpu, { label: 'deform/records', size: DEFORM_BYTES * 256 })
    this.poseBuffer = new DataStore(gpu, { label: 'deform/poses', size: 16 * 1024 })
    this.vertexBuffer = new DataStore(gpu, { label: 'deform/vertices', size: 4096 })
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
    this.poseCount = this.persistentEnd
    this.bakedSlots = 0
    this.frame++
  }

  /** Whether poses move this frame: per-frame poses, baked playback, or a persistent write. */
  get deforming(): boolean {
    return (
      this.poseCount > this.persistentEnd ||
      this.bakedSlots > 0 ||
      this.movedFrame >= this.frame - 1
    )
  }

  /** Reserves `n` vec4s of this frame's poses (after the persistent region); returns the first. */
  allocPoses(n: number): number {
    const base = this.poseCount
    this.ensurePoses(base + n)
    this.poseCount = base + n
    return base
  }

  /** Grows `poses` to hold `vec4s`, keeping everything up to `poseCount`. */
  private ensurePoses(vec4s: number): void {
    if (vec4s * 4 <= this.poses.length) return
    let size = this.poses.length * 2
    while (size < vec4s * 4) size *= 2
    const grown = new Float32Array(size)
    grown.set(this.poses.subarray(0, this.poseCount * 4))
    this.poses = grown
  }

  /**
   * Reserves a persistent block of `vec4s` (first fit; the region grows when nothing fits, moving
   * the per-frame region, so call it outside render/prepare-deforms). Returns its first vec4 index
   * (never 0, the clock). The caller writes `poses` there and calls `markPersistent`.
   */
  allocPersistent(vec4s: number): number {
    if (!(vec4s > 0)) {
      throw new ShardError('render/invalid-persistent-size', `Can't allocate ${vec4s} vec4s`, {
        hint: 'Allocate at least one vec4.',
      })
    }
    const free = this.free
    for (let i = 0; i < free.length; i += 2) {
      const size = free[i + 1]!
      if (size < vec4s) continue
      const base = free[i]!
      if (size === vec4s) free.splice(i, 2)
      else {
        free[i] = base + vec4s
        free[i + 1] = size - vec4s
      }
      return base
    }
    // Grow: at least double, so a horde's blocks don't move the frame region each time.
    const end = this.persistentEnd
    let tail = 0
    if (free.length > 0 && free[free.length - 2]! + free[free.length - 1]! === end) {
      tail = free[free.length - 1]!
      free.length -= 2
    }
    const base = end - tail
    const grown = Math.max(end * 2, base + vec4s)
    this.ensurePoses(grown + (this.poseCount - end))
    // The frame region moves up; its contents are rewritten next frame anyway.
    this.poses.fill(0, end * 4, grown * 4)
    this.persistentEnd = grown
    this.poseCount = grown
    if (grown > base + vec4s) this.release(base + vec4s, grown - base - vec4s)
    return base
  }

  /** Returns a persistent block (as allocated) to the free list. */
  freePersistent(base: number, vec4s: number): void {
    if (base < 1 || vec4s <= 0 || base + vec4s > this.persistentEnd) {
      throw new ShardError(
        'render/invalid-persistent-block',
        `Persistent block [${base}, ${base + vec4s}) is outside the region [1, ${this.persistentEnd})`,
        { hint: 'Free exactly what allocPersistent returned, once.' },
      )
    }
    this.release(base, vec4s)
  }

  private release(base: number, vec4s: number): void {
    const free = this.free
    let i = 0
    while (i < free.length && free[i]! < base) i += 2
    const end = base + vec4s
    if ((i > 0 && free[i - 2]! + free[i - 1]! > base) || (i < free.length && free[i]! < end)) {
      throw new ShardError(
        'render/persistent-double-free',
        `Persistent block [${base}, ${end}) overlaps a free block`,
        { hint: 'Free each block once, with the size it was allocated with.' },
      )
    }
    const joinsPrev = i > 0 && free[i - 2]! + free[i - 1]! === base
    const joinsNext = i < free.length && free[i] === end
    if (joinsPrev && joinsNext) {
      free[i - 1] = free[i - 1]! + vec4s + free[i + 1]!
      free.splice(i, 2)
    } else if (joinsPrev) free[i - 1] = free[i - 1]! + vec4s
    else if (joinsNext) {
      free[i] = base
      free[i + 1] = free[i + 1]! + vec4s
    } else free.splice(i, 0, base, vec4s)
  }

  /** Free persistent vec4s and blocks (for describe and tests). */
  get persistentFree(): { vec4s: number; blocks: number } {
    let vec4s = 0
    for (let i = 1; i < this.free.length; i += 2) vec4s += this.free[i]!
    return { vec4s, blocks: this.free.length / 2 }
  }

  /** Marks `[base, base + vec4s)` of the persistent region as written: it uploads next frame. */
  markPersistent(base: number, vec4s: number): void {
    if (vec4s <= 0) return
    this.addDirty(base, base + vec4s)
    if (base > 0 || vec4s > 1) this.movedFrame = this.frame
  }

  /** The clock baked playback reads (poses[0].x), in seconds. */
  setClock(seconds: number): void {
    if (this.poses[0] === seconds) return
    this.poses[0] = seconds
    this.addDirty(0, 1)
  }

  /** The clock as the vertex stage sees it. */
  get clock(): number {
    return this.poses[0]!
  }

  private addDirty(lo: number, hi: number): void {
    const d = this.dirty
    const n = this.dirtyCount
    // Merge into a range it touches or overlaps.
    for (let i = 0; i < n; i++) {
      if (lo <= d[i * 2 + 1]! && hi >= d[i * 2]!) {
        if (lo < d[i * 2]!) d[i * 2] = lo
        if (hi > d[i * 2 + 1]!) d[i * 2 + 1] = hi
        return
      }
    }
    if (n < MAX_DIRTY) {
      d[n * 2] = lo
      d[n * 2 + 1] = hi
      this.dirtyCount = n + 1
      return
    }
    // Full: widen the range that grows least to hold it.
    let best = 0
    let bestCost = Number.POSITIVE_INFINITY
    for (let i = 0; i < n; i++) {
      const cost =
        Math.max(hi, d[i * 2 + 1]!) - Math.min(lo, d[i * 2]!) - (d[i * 2 + 1]! - d[i * 2]!)
      if (cost < bestCost) {
        bestCost = cost
        best = i
      }
    }
    if (lo < d[best * 2]!) d[best * 2] = lo
    if (hi > d[best * 2 + 1]!) d[best * 2 + 1] = hi
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
    // Records that cached this layout (0115's SkinPose rows) write themselves again.
    this.layout++
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

  /**
   * The first word of a LOD set's level table (`levels` rows), reserved on first use and again
   * after a repack. Call it after `meshData` for every level this frame, so none repacks after.
   */
  levelTable(set: object, levels: number): number {
    let base = this.levelTables.get(set)
    if (base === undefined) {
      base = this.reserve(levels * LEVEL_WORDS)
      this.vertexData.fill(0, base, base + levels * LEVEL_WORDS)
      this.levelTables.set(set, base)
    }
    return base
  }

  /** Writes level `k`'s row of the table at `base` (uploading only when it changed). */
  setLevel(base: number, k: number, md: MeshDeform): void {
    const o = base + k * LEVEL_WORDS
    const u = this.vertexData
    const skin = md.skinBase >= 0 ? md.skinBase : NO_SKIN
    const morph = md.morphBase >= 0 ? md.morphBase : 0
    if (
      u[o] === skin &&
      u[o + 1] === morph &&
      u[o + 2] === md.vertexCount &&
      u[o + 3] === md.targetCount
    ) {
      return
    }
    u[o] = skin
    u[o + 1] = morph
    u[o + 2] = md.vertexCount
    u[o + 3] = md.targetCount
    this.vertexDirty = true
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
    this.layout++
    this.vertexWords = 0
    this.wasted = 0
    this.levelTables.clear()
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

  /**
   * Uploads changed records, persistent ranges written since the last upload, this frame's poses,
   * and (when it changed) the vertex data. A new GPU buffer or device uploads everything.
   */
  upload(): void {
    let everything = false
    if (this.generation !== this.gpu.generation) {
      this.generation = this.gpu.generation
      this.vertexDirty = true
      this.recordLo = 0
      this.recordHi = this.capacity - 1
      everything = true
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
    if (this.poseBuffer.ensureCapacity(this.poseCount * 16)) everything = true
    if (everything) {
      this.dirtyCount = 0
      this.poseBuffer.write(this.poses, 0, 0, this.poseCount * 4)
    } else {
      const d = this.dirty
      for (let i = 0; i < this.dirtyCount; i++) {
        const lo = d[i * 2]!
        const hi = Math.min(d[i * 2 + 1]!, this.persistentEnd)
        if (hi > lo) this.poseBuffer.write(this.poses, lo * 16, lo * 4, (hi - lo) * 4)
      }
      this.dirtyCount = 0
      const end = this.persistentEnd
      if (this.poseCount > end) {
        this.poseBuffer.write(this.poses, end * 16, end * 4, (this.poseCount - end) * 4)
      }
    }
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
