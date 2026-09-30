import {
  defineComponent,
  defineResource,
  defineSystem,
  onRemove,
  type Table,
  t,
  type World,
} from '@aethervtt/shard-core'
import { GpuBuffer, type GpuContext } from '@aethervtt/shard-gpu'
import type { Mesh } from '@aethervtt/shard-mesh'
import { LogResource } from '@aethervtt/shard-runtime'
import { toHalf } from '@aethervtt/shard-texture'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { MaterialAsset, Materials, Meshes } from './assets'
import { DEFORM_WORDS, DeformStore } from './deform'
import { GpuAssetsResource } from './gpu-assets'
import { isTransparent } from './materials'
import { ComputedVisibility, Visibility } from './visibility'

export const InstanceSlot = defineComponent(
  'render/InstanceSlot',
  {
    slot: t.u32({
      readonly: true,
      description: 'GPU instance slot + 1 (0 = none yet). Managed by the renderer.',
    }),
  },
  {
    description: "The entity's slot in the renderer's persistent instance buffer. Do not write.",
    serialize: false,
  },
)

export const NotShadowCaster = defineComponent(
  'render/NotShadowCaster',
  {},
  { description: 'Tag: this mesh casts no shadows.' },
)

export const NotShadowReceiver = defineComponent(
  'render/NotShadowReceiver',
  {},
  { description: 'Tag: shadows are not applied to this mesh.' },
)

export const Mesh3d = defineComponent(
  'render/Mesh3d',
  { mesh: t.handle('Mesh', { description: 'The mesh to draw.' }) },
  {
    description: "Draws a mesh at this entity's transform.",
    requires: [Transform, Visibility, InstanceSlot],
  },
)

export const MeshMaterial = defineComponent(
  'render/MeshMaterial',
  {
    material: t.handle('Material', {
      description: 'Standard material; a neutral gray when absent.',
    }),
  },
  { description: 'The material a Mesh3d is drawn with.' },
)

export const MAX_LOD_LEVELS = 8

export const Lod = defineComponent(
  'render/Lod',
  {
    levels: t.list(
      t.struct({
        mesh: t.handle('Mesh', { description: 'The mesh for this level.' }),
        screenSize: t.f32({
          min: 0,
          description:
            'Projected bounding-sphere diameter, as a fraction of viewport height, above which this level draws.',
        }),
      }),
      {
        description:
          'From most to least detailed, with decreasing screenSize. Smaller than the last level: not drawn.',
      },
    ),
    hysteresis: t.f32({
      default: 0.1,
      min: 0,
      max: 0.9,
      description: 'A level changes only once the size crosses a threshold by this fraction.',
    }),
    bias: t.f32({
      description:
        'Scales every size by 2^bias: positive keeps detail longer, negative drops it sooner.',
    }),
  },
  {
    description:
      "Level of detail: the drawn mesh follows the entity's size on screen, chosen per camera (shadows use the camera's choice). Replaces Mesh3d.mesh.",
    requires: [Mesh3d],
  },
)

export const SkinnedMesh = defineComponent(
  'render/SkinnedMesh',
  {
    skin: t.handle('Skin', {
      description: 'The skin: joint paths and inverse bind matrices (imported from glTF).',
    }),
    joints: t.list(t.entity, {
      description:
        "The joint entities, in the skin's order. Resolved from the skin's joint paths when empty (the model's instance spawns them); set it to drive a mesh with other entities.",
    }),
  },
  {
    description:
      "Deforms the mesh by its joints' transforms (linear blend skinning, 4 influences), in every pass that draws it. Culling bounds follow the pose.",
    requires: [Mesh3d],
  },
)

export const MorphWeights = defineComponent(
  'render/MorphWeights',
  {
    weights: t.list(t.f32, {
      description:
        "One weight per morph target of the mesh (0 = none, 1 = the full target). The 8 heaviest are applied. Animation clips' weights channels write it.",
    }),
  },
  {
    description: "Blends the mesh's morph targets (blend shapes) by weight.",
    requires: [Mesh3d],
  },
)

export const VisibilityRange = defineComponent(
  'render/VisibilityRange',
  {
    start: t.f32({ min: 0, unit: 'm', description: 'Hidden when the camera is closer than this.' }),
    end: t.f32({
      default: 100,
      min: 0,
      unit: 'm',
      description: 'Hidden at this distance from the camera and beyond (shadows too).',
    }),
  },
  {
    description:
      "Distance culling from the camera, for small props. Applies to the camera's shadow views too.",
    requires: [Mesh3d],
  },
)

export const InstanceData = defineComponent(
  'render/InstanceData',
  {
    x: t.f32({ description: 'First value (stored as a half float).' }),
    y: t.f32({
      description: 'Second value (stored as a half float; integers up to 2048 are exact).',
    }),
  },
  {
    description:
      "Two numbers this instance's material reads in its vertex stage (vertex_instance_data() in shard::mesh), e.g. a fade or per-edge flags. They share the slot word VisibilityRange uses, so an entity has one or the other.",
    requires: [Mesh3d],
  },
)

/** Floats per instance record: affine rows (12), batch, flags, visibility range, entity. */
export const INSTANCE_FLOATS = 16
export const INSTANCE_BYTES = INSTANCE_FLOATS * 4
/** Bytes of a slot's previous transform (affine rows). */
const PREV_BYTES = 48

export const InstanceFlags = {
  Visible: 1,
  Caster: 2,
  Receiver: 4,
  Range: 8,
  Lod: 16,
  /** Skinned: the vertex stage reads joint matrices; culling reads the slot's own sphere. */
  Skinned: 32,
  /** Morphed: the vertex stage adds morph target deltas. */
  Morph: 64,
} as const

/** Record value for "no batch". LOD slots store `LOD_BIT | lodSet`. */
export const NO_BATCH = 0xffffffff
export const LOD_BIT = 0x80000000
/** Visible-list entries: slot in the low 28 bits, LOD level in the top 4. */
export const SLOT_MASK = 0x0fffffff
/** A LOD state entry with no level chosen yet. */
export const LOD_UNSET = 0xff

/** All instances of one (mesh, material) pair: one draw per view. */
export interface Batch {
  index: number
  mesh: Mesh
  material: MaterialAsset
  meshGuid: string | undefined
  materialGuid: string | undefined
  /** Instances that can land in this batch (LOD slots count for every level of their set). */
  count: number
  /** Whether the material's textures are ready this frame. */
  ready: boolean
  /** Blended (alpha, additive, premultiplied): drawn after opaque, back to front, no shadows. */
  transparent: boolean
  /** Can go through the G-buffer: standard lighting and not blended. */
  deferrable: boolean
  /** Plain (non-LOD) slots in this batch, for culling one batch without scanning all slots. */
  members: Uint32Array
  memberCount: number
  /** Where this batch's instances start in a view's visible region (GPU culling). */
  region: number
  /** Per-cull scratch: slots that passed, before packing. */
  scratch: Uint32Array
  scratchCount: number
  /** Per-cull scratch for forward-only slots in deferred views. */
  forwardScratch: Uint32Array
  forwardCount: number
  /** The mesh version shadows last saw (cached shadows redraw when it changes, 0055). */
  meshVersion: number
}

/** A Lod component's levels resolved to batches, shared by every entity with the same values. */
export interface LodSet {
  index: number
  key: string
  batches: number[]
  thresholds: Float32Array
  hysteresis: number
  bias: number
  count: number
}

export interface DrawItem {
  batch: Batch
  /** First entry in the visible buffer (the draw's firstInstance). */
  first: number
  count: number
  /** Byte offset of the draw's indirect arguments (GPU culling), or -1 for a direct draw. */
  indirect: number
}

/** One view's culled draws: a camera, or a shadow map face. */
export interface DrawList {
  items: DrawItem[]
  length: number
  visible: number
  culled: number
  hidden: number
  pending: number
  /** Index in the frame's GPU cull views, or -1 (CPU culled). */
  cullView: number
}

export function createDrawList(): DrawList {
  return { items: [], length: 0, visible: 0, culled: 0, hidden: 0, pending: 0, cullView: -1 }
}

/** What a view culls with: frustum planes, the camera it measures distance and LOD from. */
export interface CullParams {
  planes: Float32Array | null
  require: number
  /** Where distances (visibility ranges, LOD) are measured from. */
  eye: Float32Array | undefined
  /** Screen size of a sphere: r · lodScale / distance (perspective) or r · lodScale (ortho). */
  lodScale: number
  orthographic: boolean
  /** LOD state per slot for this view's camera; updated when `updateLod`. */
  lodState: Uint8Array | undefined
  updateLod: boolean
}

const halfToFloat = (h: number): number => {
  const s = h & 0x8000 ? -1 : 1
  const e = (h >> 10) & 0x1f
  const f = h & 0x3ff
  if (e === 0) return s * 2 ** -14 * (f / 1024)
  if (e === 31) return f ? Number.NaN : s * Number.POSITIVE_INFINITY
  return s * 2 ** (e - 15) * (1 + f / 1024)
}

const f32 = Math.fround
const scratchSphere = new Float32Array(4)
const halfScratch = new Float32Array(2)

/**
 * World bounding sphere of a slot: the mesh's local sphere (from its bounds) through the slot's
 * affine transform, radius scaled by the largest axis. Mirrors `slot_sphere` in the cull shader.
 */
export function slotSphere(
  out: Float32Array,
  f: Float32Array,
  o: number,
  bounds: Float32Array,
): Float32Array {
  const cx = f32((bounds[0]! + bounds[3]!) * 0.5)
  const cy = f32((bounds[1]! + bounds[4]!) * 0.5)
  const cz = f32((bounds[2]! + bounds[5]!) * 0.5)
  const ex = f32((bounds[3]! - bounds[0]!) * 0.5)
  const ey = f32((bounds[4]! - bounds[1]!) * 0.5)
  const ez = f32((bounds[5]! - bounds[2]!) * 0.5)
  const r = f32(Math.sqrt(ex * ex + ey * ey + ez * ez))
  out[0] = f32(f[o]! * cx + f[o + 1]! * cy + f[o + 2]! * cz + f[o + 3]!)
  out[1] = f32(f[o + 4]! * cx + f[o + 5]! * cy + f[o + 6]! * cz + f[o + 7]!)
  out[2] = f32(f[o + 8]! * cx + f[o + 9]! * cy + f[o + 10]! * cz + f[o + 11]!)
  const sx = f[o]! * f[o]! + f[o + 4]! * f[o + 4]! + f[o + 8]! * f[o + 8]!
  const sy = f[o + 1]! * f[o + 1]! + f[o + 5]! * f[o + 5]! + f[o + 9]! * f[o + 9]!
  const sz = f[o + 2]! * f[o + 2]! + f[o + 6]! * f[o + 6]! + f[o + 10]! * f[o + 10]!
  out[3] = f32(r * Math.sqrt(Math.max(sx, sy, sz)))
  return out
}

/**
 * A slot's world bounding sphere: its skinned pose's sphere when it has one (joints move the mesh
 * away from its bounds), otherwise `slotSphere` from the mesh bounds.
 */
function sphereOfSlot(
  out: Float32Array,
  store: InstanceStore,
  slot: number,
  flags: number,
  bounds: Float32Array,
): Float32Array {
  if (flags & InstanceFlags.Skinned) {
    const r = store.deform.recordF32
    const o = slot * DEFORM_WORDS
    if (r[o + 3]! > 0) {
      out[0] = r[o]!
      out[1] = r[o + 1]!
      out[2] = r[o + 2]!
      out[3] = r[o + 3]!
      return out
    }
  }
  return slotSphere(out, store.f32, slot * INSTANCE_FLOATS, bounds)
}

/** Sphere against six planes (inside where n·p + d ≥ 0). */
export function sphereInFrustum(planes: Float32Array, s: Float32Array): boolean {
  for (let p = 0; p < 24; p += 4) {
    if (
      planes[p]! * s[0]! + planes[p + 1]! * s[1]! + planes[p + 2]! * s[2]! + planes[p + 3]! <
      -s[3]!
    )
      return false
  }
  return true
}

/**
 * The LOD level for a size, from the previous level with hysteresis. Returns `count` (culled) when
 * smaller than the last threshold. Mirrors `select_lod` in the cull shader.
 */
export function selectLod(
  size: number,
  thresholds: ArrayLike<number>,
  count: number,
  hysteresis: number,
  previous: number,
): number {
  let level = previous
  if (previous === LOD_UNSET || previous > count) {
    level = count
    for (let k = 0; k < count; k++) {
      if (size >= thresholds[k]!) {
        level = k
        break
      }
    }
    return level
  }
  while (level > 0 && size > thresholds[level - 1]! * (1 + hysteresis)) level--
  while (level < count && size < thresholds[level]! * (1 - hysteresis)) level++
  return level
}

type LodValue = {
  levels: { mesh: { guid: string | undefined } | null; screenSize: number }[]
  hysteresis: number
  bias: number
}

/**
 * The persistent instance buffer. Each Mesh3d entity owns a slot holding its transform, batch (or
 * LOD set), flags, and visibility range; only slots whose data changed are uploaded, in coalesced
 * runs. Views cull slots on the CPU here, or on the GPU (`GpuCuller`), into per-view visible lists
 * the vertex stage indexes through.
 */
export class InstanceStore {
  capacity = 0
  /** Slots in use or freed; slots >= high were never used. */
  high = 0
  f32 = new Float32Array(0)
  u32 = new Uint32Array(0)
  /**
   * Each slot's InstanceFlags, mirrored from its record: prepare compares against these every
   * frame, and reading them from the 64-byte records would touch a cache line per instance.
   */
  flags = new Uint8Array(0)
  /** Hidden instances per ECS table id, from the last time prepare visited the table. */
  readonly tableHidden: number[] = []
  /** Batch index (>= 0), LOD set (-2 - index), or -1 (none), per slot. */
  batchOf = new Int32Array(0)
  /** Index of the slot in its batch's member list, or -1. */
  private memberIndex = new Int32Array(0)
  /** Visibility range per slot, as the GPU sees it (f16-rounded start, end). */
  ranges = new Float32Array(0)
  meshRefs: ({ guid: string | undefined } | null)[] = []
  materialRefs: ({ guid: string | undefined } | null)[] = []
  /** Lod component value per slot, or null. */
  lods: (LodValue | null)[] = []
  private dirty = new Uint8Array(0)
  private dirtyLo = Number.POSITIVE_INFINITY
  private dirtyHi = -1
  /**
   * Last frame's transform per slot (12 floats), for motion vectors. A slot that moved last frame
   * but not this one catches up, so a stopped object has no velocity.
   */
  prev = new Float32Array(0)
  private prevDirty = new Uint8Array(0)
  private prevLo = Number.POSITIVE_INFINITY
  private prevHi = -1
  private movedFrame = new Uint32Array(0)
  private moved = new Uint32Array(64)
  private movedCount = 0
  private lastMoved = new Uint32Array(64)
  private lastMovedCount = 0
  private frame = 1
  readonly prevBuffer: GpuBuffer
  private readonly free: number[] = []
  /** Slots waiting for their mesh or material to load. */
  readonly pending = new Set<number>()
  readonly batches: Batch[] = []
  /** Batches in draw order (sorted by pipeline, then material, then mesh). */
  readonly sorted: Batch[] = []
  private readonly byMesh = new Map<Mesh, Map<MaterialAsset, Batch>>()
  readonly lodSets: LodSet[] = []
  private readonly lodByKey = new Map<string, LodSet>()
  readonly defaultMaterial = new MaterialAsset()
  /** Bytes of instance data uploaded this frame. */
  uploadedBytes = 0
  /** Slots with a batch and not hidden, and hidden ones: stats for GPU-culled views. */
  drawableCount = 0
  hiddenCount = 0
  /** Bumps when batches or LOD sets change shape (the GPU tables re-upload). */
  structureVersion = 0
  /**
   * Bumps when what casts shadows changes other than by moving: a slot's batch, its caster or
   * visible flag, or a batch's mesh data. Cached shadow maps (0055) redraw when it moves.
   */
  shadowEpoch = 0
  /** Visible slot lists of every CPU-culled view this frame, concatenated. */
  visible = new Uint32Array(1024)
  visibleCount = 0
  readonly instanceBuffer: GpuBuffer
  readonly visibleBuffer: GpuBuffer
  private generation: number
  private readonly gpu: GpuContext
  bindGroup: GPUBindGroup | undefined
  private bound = ''
  layout: GPUBindGroupLayout
  /** Set by the GPU culler: views it culls read their visible lists from this buffer. */
  gpuVisible: GpuBuffer | undefined
  /** Bind group over `gpuVisible`, for draws of GPU-culled views. */
  gpuBindGroup: GPUBindGroup | undefined
  private gpuBound = ''
  /** Joint matrices, morph weights, and deform records of skinned and morphed slots. */
  readonly deform: DeformStore

  constructor(gpu: GpuContext) {
    this.gpu = gpu
    this.generation = gpu.generation
    this.instanceBuffer = new GpuBuffer(gpu, {
      label: 'instances',
      usage: GPUBufferUsage.STORAGE,
      size: INSTANCE_BYTES * 256,
    })
    this.prevBuffer = new GpuBuffer(gpu, {
      label: 'instances/previous',
      usage: GPUBufferUsage.STORAGE,
      size: PREV_BYTES * 256,
    })
    this.visibleBuffer = new GpuBuffer(gpu, {
      label: 'instances/visible',
      usage: GPUBufferUsage.STORAGE,
      size: 4 * 1024,
    })
    this.layout = createInstanceLayout(gpu)
    this.deform = new DeformStore(gpu)
    this.grow(256)
  }

  get live(): number {
    return this.high - this.free.length
  }

  private grow(capacity: number): void {
    const f32a = new Float32Array(capacity * INSTANCE_FLOATS)
    f32a.set(this.f32)
    this.f32 = f32a
    this.u32 = new Uint32Array(f32a.buffer)
    const batchOf = new Int32Array(capacity).fill(-1)
    batchOf.set(this.batchOf)
    this.batchOf = batchOf
    const memberIndex = new Int32Array(capacity).fill(-1)
    memberIndex.set(this.memberIndex)
    this.memberIndex = memberIndex
    const ranges = new Float32Array(capacity * 2)
    ranges.set(this.ranges)
    this.ranges = ranges
    const dirty = new Uint8Array(capacity)
    dirty.set(this.dirty)
    this.dirty = dirty
    const flags = new Uint8Array(capacity)
    flags.set(this.flags)
    this.flags = flags
    const prev = new Float32Array(capacity * 12)
    prev.set(this.prev)
    this.prev = prev
    const prevDirty = new Uint8Array(capacity)
    prevDirty.set(this.prevDirty)
    this.prevDirty = prevDirty
    const movedFrame = new Uint32Array(capacity)
    movedFrame.set(this.movedFrame)
    this.movedFrame = movedFrame
    this.capacity = capacity
    this.deform.ensureSlots(capacity)
  }

  alloc(entity: number): number {
    let slot = this.free.pop()
    if (slot === undefined) {
      if (this.high >= this.capacity) this.grow(this.capacity * 2)
      slot = this.high++
    }
    this.u32[slot * INSTANCE_FLOATS + 12] = NO_BATCH
    this.u32[slot * INSTANCE_FLOATS + 13] = 0
    this.flags[slot] = 0
    this.u32[slot * INSTANCE_FLOATS + 14] = 0
    this.u32[slot * INSTANCE_FLOATS + 15] = entity % 0x100000000
    this.batchOf[slot] = -1
    this.memberIndex[slot] = -1
    this.lods[slot] = null
    this.markDirty(slot)
    return slot
  }

  release(slot: number): void {
    this.assign(slot, -1)
    this.u32[slot * INSTANCE_FLOATS + 13] = 0
    this.flags[slot] = 0
    this.meshRefs[slot] = null
    this.materialRefs[slot] = null
    this.lods[slot] = null
    this.pending.delete(slot)
    this.deform.clear(slot)
    this.markDirty(slot)
    this.free.push(slot)
  }

  private boundsDirty = true
  private readonly cachedBounds = new Float32Array(6)

  /**
   * The world bounds of every shadow caster (spheres), cached until an instance changes. GPU
   * culling fits cascade depth ranges to it, having no CPU cull to take a union from.
   */
  casterBounds(out: Float32Array): Float32Array {
    if (this.boundsDirty) {
      this.boundsDirty = false
      const b = this.cachedBounds
      b[0] = b[1] = b[2] = Number.POSITIVE_INFINITY
      b[3] = b[4] = b[5] = Number.NEGATIVE_INFINITY
      const sphere = scratchSphere
      const need = InstanceFlags.Visible | InstanceFlags.Caster
      for (let s = 0; s < this.high; s++) {
        const a = this.batchOf[s]!
        if (a === -1 || (this.u32[s * INSTANCE_FLOATS + 13]! & need) !== need) continue
        const batch = this.batches[a >= 0 ? a : this.lodSets[-2 - a]!.batches[0]!]!
        if (batch.transparent) continue
        sphereOfSlot(sphere, this, s, this.u32[s * INSTANCE_FLOATS + 13]!, batch.mesh.bounds)
        for (let k = 0; k < 3; k++) {
          if (sphere[k]! - sphere[3]! < b[k]!) b[k] = sphere[k]! - sphere[3]!
          if (sphere[k]! + sphere[3]! > b[k + 3]!) b[k + 3] = sphere[k]! + sphere[3]!
        }
      }
    }
    out.set(this.cachedBounds)
    return out
  }

  markDirty(slot: number): void {
    this.boundsDirty = true
    if (this.dirty[slot]) return
    this.dirty[slot] = 1
    if (slot < this.dirtyLo) this.dirtyLo = slot
    if (slot > this.dirtyHi) this.dirtyHi = slot
  }

  /**
   * Records a transform change: `from` is where the slot's record is now (copied to its previous
   * transform), unless the slot is new, when both get `to`.
   */
  moveSlot(slot: number, g: ArrayLike<number>, offset: number, fresh: boolean): void {
    const f = this.f32
    const p = this.prev
    const o = slot * INSTANCE_FLOATS
    const q = slot * 12
    for (let k = 0; k < 12; k++) {
      p[q + k] = fresh ? g[offset + k]! : f[o + k]!
      f[o + k] = g[offset + k]!
    }
    this.markDirty(slot)
    this.markPrevDirty(slot)
    if (this.movedFrame[slot] !== this.frame) {
      this.movedFrame[slot] = this.frame
      if (this.movedCount >= this.moved.length) {
        const grown = new Uint32Array(this.moved.length * 2)
        grown.set(this.moved)
        this.moved = grown
      }
      this.moved[this.movedCount++] = slot
    }
  }

  /**
   * The floating origin moved (spec 0040): adds `x, y, z` to every slot's current and previous
   * translation, so this frame's moves compare against last frame's pose in the new frame and
   * motion vectors stay continuous. Runs once per shift, not per frame.
   */
  shiftOrigin(x: number, y: number, z: number): void {
    const f = this.f32
    const p = this.prev
    for (let s = 0; s < this.high; s++) {
      const o = s * INSTANCE_FLOATS
      const q = s * 12
      f[o + 3] = f[o + 3]! + x
      f[o + 7] = f[o + 7]! + y
      f[o + 11] = f[o + 11]! + z
      p[q + 3] = p[q + 3]! + x
      p[q + 7] = p[q + 7]! + y
      p[q + 11] = p[q + 11]! + z
    }
    if (this.high === 0) return
    this.boundsDirty = true
    this.dirty.fill(1, 0, this.high)
    this.prevDirty.fill(1, 0, this.high)
    this.dirtyLo = Math.min(this.dirtyLo, 0)
    this.dirtyHi = Math.max(this.dirtyHi, this.high - 1)
    this.prevLo = 0
    this.prevHi = Math.max(this.prevHi, this.high - 1)
  }

  private markPrevDirty(slot: number): void {
    if (this.prevDirty[slot]) return
    this.prevDirty[slot] = 1
    if (slot < this.prevLo) this.prevLo = slot
    if (slot > this.prevHi) this.prevHi = slot
  }

  /** Slots that moved last frame but not this one: their previous transform catches up. */
  settleMoved(): void {
    const f = this.f32
    const p = this.prev
    for (let i = 0; i < this.lastMovedCount; i++) {
      const slot = this.lastMoved[i]!
      if (this.movedFrame[slot] === this.frame || slot >= this.high) continue
      const o = slot * INSTANCE_FLOATS
      const q = slot * 12
      for (let k = 0; k < 12; k++) p[q + k] = f[o + k]!
      this.markPrevDirty(slot)
    }
    // This frame's moves are next frame's catch-ups.
    const t = this.lastMoved
    this.lastMoved = this.moved
    this.lastMovedCount = this.movedCount
    this.moved = t
    this.movedCount = 0
    this.frame++
  }

  /** Assigns a slot to a batch (>= 0), a LOD set (-2 - index), or nothing (-1). */
  assign(slot: number, assignment: number): void {
    const old = this.batchOf[slot]!
    if (old === assignment) return
    this.shadowEpoch++
    if (old >= 0) {
      this.batches[old]!.count--
      this.removeMember(slot, this.batches[old]!)
    } else if (old <= -2) {
      const set = this.lodSets[-2 - old]!
      set.count--
      for (const b of set.batches) this.batches[b]!.count--
    }
    if (assignment >= 0) {
      this.batches[assignment]!.count++
      this.addMember(slot, this.batches[assignment]!)
    } else if (assignment <= -2) {
      const set = this.lodSets[-2 - assignment]!
      set.count++
      for (const b of set.batches) this.batches[b]!.count++
    }
    this.batchOf[slot] = assignment
    this.u32[slot * INSTANCE_FLOATS + 12] =
      assignment >= 0
        ? assignment
        : assignment <= -2
          ? (LOD_BIT | (-2 - assignment)) >>> 0
          : NO_BATCH
    this.markDirty(slot)
  }

  /**
   * Bumps `shadowEpoch` if any batch's mesh data changed since the last call (a structure chunk
   * rebuilt in place). One compare per batch.
   */
  checkMeshVersions(): void {
    const batches = this.batches
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i]!
      if (b.meshVersion !== b.mesh.version) {
        b.meshVersion = b.mesh.version
        this.shadowEpoch++
      }
    }
  }

  /**
   * Whether a visible caster that moved this frame touches the half-spaces `planes`, where it
   * was or where it is now. Call after prepare. Skinned and morphed poses aren't moves; see
   * `deforming`.
   */
  movedCasterIn(planes: Float32Array): boolean {
    const need = InstanceFlags.Visible | InstanceFlags.Caster
    const sphere = scratchSphere
    for (let i = 0; i < this.lastMovedCount; i++) {
      const slot = this.lastMoved[i]!
      if (slot >= this.high || (this.flags[slot]! & need) !== need) continue
      const a = this.batchOf[slot]!
      if (a === -1) continue
      const batch = this.batches[a >= 0 ? a : this.lodSets[-2 - a]!.batches[0]!]!
      if (batch.transparent) continue
      sphereOfSlot(sphere, this, slot, this.flags[slot]!, batch.mesh.bounds)
      if (sphereInFrustum(planes, sphere)) return true
      slotSphere(sphere, this.prev, slot * 12, batch.mesh.bounds)
      if (sphereInFrustum(planes, sphere)) return true
    }
    return false
  }

  /** Whether skinned or morphed poses are being written this frame (their shadows move). */
  get deforming(): boolean {
    return this.deform.poseCount > 0
  }

  /** A plain batch assignment. */
  setBatch(slot: number, index: number): void {
    this.assign(slot, index)
  }

  private addMember(slot: number, batch: Batch): void {
    if (batch.memberCount >= batch.members.length) {
      const grown = new Uint32Array(batch.members.length * 2)
      grown.set(batch.members)
      batch.members = grown
    }
    this.memberIndex[slot] = batch.memberCount
    batch.members[batch.memberCount++] = slot
  }

  private removeMember(slot: number, batch: Batch): void {
    const i = this.memberIndex[slot]!
    if (i < 0) return
    const last = batch.members[--batch.memberCount]!
    batch.members[i] = last
    this.memberIndex[last] = i
    this.memberIndex[slot] = -1
  }

  batchFor(
    mesh: Mesh,
    material: MaterialAsset,
    meshGuid: string | undefined,
    materialGuid: string | undefined,
  ): Batch {
    let byMaterial = this.byMesh.get(mesh)
    if (!byMaterial) {
      byMaterial = new Map()
      this.byMesh.set(mesh, byMaterial)
    }
    let batch = byMaterial.get(material)
    if (!batch) {
      batch = {
        index: this.batches.length,
        mesh,
        material,
        meshGuid,
        materialGuid,
        count: 0,
        ready: false,
        transparent: false,
        deferrable: true,
        members: new Uint32Array(16),
        memberCount: 0,
        region: 0,
        scratch: new Uint32Array(64),
        scratchCount: 0,
        forwardScratch: new Uint32Array(16),
        forwardCount: 0,
        meshVersion: mesh.version,
      }
      byMaterial.set(material, batch)
      this.batches.push(batch)
      if (!this.materialOrder.has(material))
        this.materialOrder.set(material, this.materialOrder.size)
      if (!this.meshOrder.has(mesh)) this.meshOrder.set(mesh, this.meshOrder.size)
      // Into its place in draw order (binary search): a full sort per new batch is quadratic in
      // scenes that make many meshes (terrain chunks).
      let lo = 0
      let hi = this.sorted.length
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (this.compareBatches(this.sorted[mid]!, batch, this.batchKey) <= 0) lo = mid + 1
        else hi = mid
      }
      this.sorted.splice(lo, 0, batch)
      this.structureVersion++
    }
    return batch
  }

  /** The LOD set for a Lod value and material (created on first use). Undefined if a mesh is missing. */
  lodSetFor(
    lod: LodValue,
    material: MaterialAsset,
    materialGuid: string | undefined,
    meshes: import('@aethervtt/shard-assets').AssetStore<Mesh, 'Mesh'>,
  ): LodSet | undefined {
    const levels = lod.levels.slice(0, MAX_LOD_LEVELS)
    const resolved: Mesh[] = []
    for (const level of levels) {
      const mesh = meshes.get(level.mesh)
      if (!mesh) return undefined
      resolved.push(mesh)
    }
    const key = `${levels.map((l, i) => `${idOf(resolved[i]!)}@${l.screenSize}`).join(',')}|${lod.hysteresis}|${lod.bias}|${idOf(material)}`
    let set = this.lodByKey.get(key)
    if (!set) {
      set = {
        index: this.lodSets.length,
        key,
        batches: resolved.map(
          (mesh, i) => this.batchFor(mesh, material, levels[i]!.mesh?.guid, materialGuid).index,
        ),
        thresholds: Float32Array.from(levels.map((l) => l.screenSize)),
        hysteresis: lod.hysteresis,
        bias: lod.bias,
        count: 0,
      }
      this.lodSets.push(set)
      this.lodByKey.set(key, set)
      this.structureVersion++
    }
    return set
  }

  /** Orders batches by pipeline (set by the renderer: material type and variant). */
  batchKey: (b: Batch) => number = () => 0

  /** Draw order: grouped by pipeline, then material, then mesh, so switches stay rare. */
  sortBatches(key: (b: Batch) => number = this.batchKey): void {
    this.sorted.sort((a, b) => this.compareBatches(a, b, key))
  }

  /** Materials and meshes in the order their first batch appeared (draw order within a pipeline). */
  private readonly materialOrder = new Map<MaterialAsset, number>()
  private readonly meshOrder = new Map<Mesh, number>()

  private compareBatches(a: Batch, b: Batch, key: (b: Batch) => number): number {
    return (
      key(a) - key(b) ||
      this.materialOrder.get(a.material)! - this.materialOrder.get(b.material)! ||
      this.meshOrder.get(a.mesh)! - this.meshOrder.get(b.mesh)!
    )
  }

  /** Writes a slot's visibility range (packed as two halves, as the GPU reads it). */
  setRange(slot: number, start: number, end: number): void {
    halfScratch[0] = start
    halfScratch[1] = end
    const h = toHalf(halfScratch)
    const packed = (h[0]! | (h[1]! << 16)) >>> 0
    const o = slot * INSTANCE_FLOATS + 14
    if (this.u32[o] !== packed) {
      this.u32[o] = packed
      this.markDirty(slot)
    }
    this.ranges[slot * 2] = halfToFloat(h[0]!)
    this.ranges[slot * 2 + 1] = halfToFloat(h[1]!)
  }

  /** Uploads dirty slots in coalesced runs. Returns bytes written. */
  upload(): number {
    if (this.generation !== this.gpu.generation) {
      // A new device: the buffer is empty again.
      this.generation = this.gpu.generation
      this.layout = createInstanceLayout(this.gpu)
      this.bindGroup = undefined
      this.gpuBindGroup = undefined
      this.dirtyLo = 0
      this.dirtyHi = this.high - 1
      this.dirty.fill(1, 0, this.high)
      this.prevLo = 0
      this.prevHi = this.high - 1
      this.prevDirty.fill(1, 0, this.high)
    }
    // A grown GPU buffer starts empty: every live slot has to go up again, not just dirty ones.
    if (this.instanceBuffer.ensureCapacity(this.capacity * INSTANCE_BYTES) && this.high > 0) {
      this.dirtyLo = 0
      this.dirtyHi = this.high - 1
      this.dirty.fill(1, 0, this.high)
    }
    if (this.prevBuffer.ensureCapacity(this.capacity * PREV_BYTES) && this.high > 0) {
      this.prevLo = 0
      this.prevHi = this.high - 1
      this.prevDirty.fill(1, 0, this.high)
    }
    let start = -1
    for (let s = this.prevLo; s <= this.prevHi + 1; s++) {
      if (s <= this.prevHi && this.prevDirty[s] === 1) {
        this.prevDirty[s] = 0
        if (start < 0) start = s
      } else if (start >= 0) {
        this.prevBuffer.write(this.prev, start * PREV_BYTES, start * 12, (s - start) * 12)
        start = -1
      }
    }
    this.prevLo = Number.POSITIVE_INFINITY
    this.prevHi = -1
    let bytes = 0
    const lo = this.dirtyLo
    const hi = this.dirtyHi
    let runStart = -1
    for (let s = lo; s <= hi + 1; s++) {
      const d = s <= hi && this.dirty[s] === 1
      if (d) {
        this.dirty[s] = 0
        if (runStart < 0) runStart = s
      } else if (runStart >= 0) {
        const n = s - runStart
        this.instanceBuffer.write(
          this.f32,
          runStart * INSTANCE_BYTES,
          runStart * INSTANCE_FLOATS,
          n * INSTANCE_FLOATS,
        )
        bytes += n * INSTANCE_BYTES
        runStart = -1
      }
    }
    this.dirtyLo = Number.POSITIVE_INFINITY
    this.dirtyHi = -1
    this.uploadedBytes = bytes
    return bytes
  }

  beginFrame(): void {
    this.visibleCount = 0
  }

  // Transparent instances this cull: slot, batch, and view depth, sorted back to front.
  private transparentCount = 0
  private forwardOnlyCount = 0
  private tSlots = new Uint32Array(64)
  private tBatches = new Int32Array(64)
  private tDepths = new Float32Array(64)
  private readonly tOrder: number[] = []

  /**
   * CPU culling of every slot into `list` (and, for camera views, `transparent` back to front and
   * deferred `forwardOnly`). Same tests as the GPU culler: bounding sphere against the frustum,
   * visibility range, LOD level. `bounds` gets the union of what passed (cascade fitting). With
   * `transparentOnly`, only blended batches are culled (the GPU culls the rest).
   */
  cullCpu(
    list: DrawList,
    params: CullParams,
    bounds?: Float32Array,
    transparent?: DrawList,
    forward?: Float32Array,
    forwardOnly?: DrawList,
    transparentOnly = false,
  ): void {
    if (bounds) {
      bounds[0] = bounds[1] = bounds[2] = Number.POSITIVE_INFINITY
      bounds[3] = bounds[4] = bounds[5] = Number.NEGATIVE_INFINITY
    }
    list.length = 0
    list.visible = 0
    list.culled = 0
    list.hidden = 0
    list.pending = this.pending.size
    list.cullView = -1
    this.transparentCount = 0
    this.forwardOnlyCount = 0
    const batches = this.batches
    for (let b = 0; b < batches.length; b++) {
      batches[b]!.scratchCount = 0
      batches[b]!.forwardCount = 0
    }
    const f = this.f32
    const u32 = this.u32
    const mask = InstanceFlags.Visible | params.require
    const eye = params.eye
    const sphere = scratchSphere
    for (let s = 0; s < this.high; s++) {
      const assignment = this.batchOf[s]!
      if (assignment === -1) continue
      const flags = u32[s * INSTANCE_FLOATS + 13]!
      if ((flags & mask) !== mask) {
        if ((flags & InstanceFlags.Visible) === 0) list.hidden++
        continue
      }
      let set: LodSet | undefined
      let b = assignment
      if (assignment <= -2) {
        set = this.lodSets[-2 - assignment]!
        b = set.batches[0]!
      }
      let batch = batches[b]!
      if (transparentOnly && !batch.transparent) continue
      if (!batch.ready) {
        list.pending++
        continue
      }
      // Transparent batches never cast shadows, and only camera views that ask draw them.
      if (batch.transparent && (params.require !== 0 || !transparent)) continue
      if (flags & InstanceFlags.Skinned) sphereOfSlot(sphere, this, s, flags, batch.mesh.bounds)
      else slotSphere(sphere, f, s * INSTANCE_FLOATS, batch.mesh.bounds)
      if (params.planes && !sphereInFrustum(params.planes, sphere)) {
        list.culled++
        continue
      }
      let distance = 0
      if (eye) {
        const dx = sphere[0]! - eye[0]!
        const dy = sphere[1]! - eye[1]!
        const dz = sphere[2]! - eye[2]!
        distance = f32(Math.sqrt(dx * dx + dy * dy + dz * dz))
      }
      if (flags & InstanceFlags.Range && eye) {
        if (distance < this.ranges[s * 2]! || distance >= this.ranges[s * 2 + 1]!) {
          list.culled++
          continue
        }
      }
      let level = 0
      if (set) {
        const state = params.lodState
        const previous = state ? state[s]! : LOD_UNSET
        if (params.updateLod || !state) {
          const size = lodSize(sphere[3]!, distance, params) * 2 ** set.bias
          level = selectLod(size, set.thresholds, set.batches.length, set.hysteresis, previous)
          if (state) state[s] = level
        } else {
          level = previous
        }
        if (level >= set.batches.length) {
          list.culled++
          continue
        }
        b = set.batches[level]!
        batch = batches[b]!
        if (!batch.ready) {
          list.pending++
          continue
        }
      }
      const entry = (s | (level << 28)) >>> 0
      if (bounds) {
        for (let k = 0; k < 3; k++) {
          if (sphere[k]! - sphere[3]! < bounds[k]!) bounds[k] = sphere[k]! - sphere[3]!
          if (sphere[k]! + sphere[3]! > bounds[k + 3]!) bounds[k + 3] = sphere[k]! + sphere[3]!
        }
      }
      if (batch.transparent) {
        this.pushTransparent(entry, b, eye, forward)
        list.visible++
        continue
      }
      if (forwardOnly && !batch.deferrable) {
        if (batch.forwardCount >= batch.forwardScratch.length) {
          const grown = new Uint32Array(batch.forwardScratch.length * 2)
          grown.set(batch.forwardScratch)
          batch.forwardScratch = grown
        }
        batch.forwardScratch[batch.forwardCount++] = entry
        this.forwardOnlyCount++
        continue
      }
      if (batch.scratchCount >= batch.scratch.length) {
        const grown = new Uint32Array(batch.scratch.length * 2)
        grown.set(batch.scratch)
        batch.scratch = grown
      }
      batch.scratch[batch.scratchCount++] = entry
      list.visible++
    }
    this.pack(list)
    if (transparent) this.packTransparent(transparent)
    if (forwardOnly) {
      // Opaque materials the G-buffer can't take, drawn forward after deferred lighting.
      for (const batch of this.batches) {
        const n = batch.forwardCount
        batch.forwardCount = 0
        batch.scratchCount = n
        if (n > 0) {
          if (batch.scratch.length < n) batch.scratch = new Uint32Array(batch.forwardScratch.length)
          batch.scratch.set(batch.forwardScratch.subarray(0, n))
        }
      }
      this.pack(forwardOnly)
      forwardOnly.visible = this.forwardOnlyCount
    }
  }

  /** Transparent-only CPU cull over blended batches' members (LOD slots aren't members). */
  cullTransparentMembers(list: DrawList, params: CullParams, forward: Float32Array): void {
    this.transparentCount = 0
    const u32 = this.u32
    const eye = params.eye
    const sphere = scratchSphere
    for (const batch of this.batches) {
      if (!batch.transparent || !batch.ready || batch.memberCount === 0) continue
      for (let m = 0; m < batch.memberCount; m++) {
        const s = batch.members[m]!
        const flags = u32[s * INSTANCE_FLOATS + 13]!
        if ((flags & InstanceFlags.Visible) === 0) continue
        sphereOfSlot(sphere, this, s, flags, batch.mesh.bounds)
        if (params.planes && !sphereInFrustum(params.planes, sphere)) continue
        if (flags & InstanceFlags.Range && eye) {
          const dx = sphere[0]! - eye[0]!
          const dy = sphere[1]! - eye[1]!
          const dz = sphere[2]! - eye[2]!
          const distance = f32(Math.sqrt(dx * dx + dy * dy + dz * dz))
          if (distance < this.ranges[s * 2]! || distance >= this.ranges[s * 2 + 1]!) continue
        }
        this.pushTransparent(s, batch.index, eye, forward)
      }
    }
    this.packTransparent(list)
  }

  /**
   * CPU culling with positional arguments: planes, flag mask, bounds, transparent list, eye, view
   * direction, and the deferred forward-only list. LOD selects fresh (no hysteresis state).
   */
  cull(
    list: DrawList,
    planes: Float32Array | null,
    require = 0,
    bounds?: Float32Array,
    transparent?: DrawList,
    eye?: Float32Array,
    forward?: Float32Array,
    forwardOnly?: DrawList,
  ): void {
    legacy.planes = planes
    legacy.require = require
    legacy.eye = eye
    this.cullCpu(list, legacy, bounds, transparent, forward, forwardOnly)
  }

  private pushTransparent(
    entry: number,
    batch: number,
    eye: Float32Array | undefined,
    forward: Float32Array | undefined,
  ): void {
    const n = this.transparentCount
    if (n >= this.tSlots.length) {
      const size = this.tSlots.length * 2
      const s = new Uint32Array(size)
      s.set(this.tSlots)
      this.tSlots = s
      const b = new Int32Array(size)
      b.set(this.tBatches)
      this.tBatches = b
      const d = new Float32Array(size)
      d.set(this.tDepths)
      this.tDepths = d
    }
    const o = (entry & SLOT_MASK) * INSTANCE_FLOATS
    // Depth of the instance's origin along the view direction.
    let depth = 0
    if (eye && forward) {
      depth =
        (this.f32[o + 3]! - eye[0]!) * forward[0]! +
        (this.f32[o + 7]! - eye[1]!) * forward[1]! +
        (this.f32[o + 11]! - eye[2]!) * forward[2]!
    }
    this.tSlots[n] = entry
    this.tBatches[n] = batch
    this.tDepths[n] = depth
    this.transparentCount = n + 1
  }

  /** Sorts this cull's transparent instances back to front; runs of one batch share a draw. */
  private packTransparent(list: DrawList): void {
    list.length = 0
    list.cullView = -1
    const n = this.transparentCount
    if (n === 0) {
      list.visible = 0
      return
    }
    const order = this.tOrder
    order.length = n
    for (let i = 0; i < n; i++) order[i] = i
    const depths = this.tDepths
    order.sort((a, b) => depths[b]! - depths[a]! || a - b)
    this.reserve(n)
    let item: DrawItem | undefined
    for (let k = 0; k < n; k++) {
      const i = order[k]!
      const batch = this.batches[this.tBatches[i]!]!
      if (!item || item.batch !== batch) {
        item = this.item(list, batch)
        item.first = this.visibleCount
        item.count = 0
      }
      this.visible[this.visibleCount++] = this.tSlots[i]!
      item.count++
    }
    list.visible = n
  }

  private reserve(n: number): void {
    if (this.visibleCount + n <= this.visible.length) return
    let size = this.visible.length * 2
    while (size < this.visibleCount + n) size *= 2
    const grown = new Uint32Array(size)
    grown.set(this.visible.subarray(0, this.visibleCount))
    this.visible = grown
  }

  private item(list: DrawList, batch: Batch): DrawItem {
    let item = list.items[list.length]
    if (!item) {
      item = { batch, first: 0, count: 0, indirect: -1 }
      list.items.push(item)
    }
    item.batch = batch
    item.indirect = -1
    list.length++
    return item
  }

  /**
   * False only when every instance of a small batch is hidden (Visibility), so views skip its
   * draw. The GPU culler otherwise issues one indirect draw per batch, empty or not: a planet's
   * pooled chunks are mostly hidden, and empty draws still cost their binds and calls.
   */
  anyVisible(batch: Batch): boolean {
    const n = batch.memberCount
    // LOD-set slots aren't members; big batches aren't worth the walk.
    if (n === 0 || n !== batch.count || n > 8) return true
    for (let i = 0; i < n; i++) {
      if (this.u32[batch.members[i]! * INSTANCE_FLOATS + 13]! & InstanceFlags.Visible) return true
    }
    return false
  }

  private nearKeys = new Float64Array(0)
  private nearItems: DrawItem[] = []

  /**
   * Reorders a camera's opaque draws nearest first within each run that shares a pipeline and
   * material, so the depth test rejects hidden fragments before they're shaded (overdraw on heavy
   * shaders, like terrain, costs the most). Pipeline and material switches stay as few as before.
   * A batch's distance is its first member's origin: exact for single-instance draws (terrain
   * chunks), a fair guess for instanced ones. No allocation after warm-up: one typed-array sort of
   * packed keys (run, log distance, index).
   */
  orderNearFirst(list: DrawList, eye: ArrayLike<number>): void {
    const n = list.length
    if (n < 2 || n >= 1 << 16) return
    if (this.nearKeys.length < n) this.nearKeys = new Float64Array(n * 2)
    const keys = this.nearKeys.subarray(0, n)
    const items = list.items
    const f = this.f32
    let run = 0
    for (let i = 0; i < n; i++) {
      const batch = items[i]!.batch
      if (i > 0) {
        const prev = items[i - 1]!.batch
        // Runs also break between shared vertex buffers (GPU mesh arenas, like terrain chunks'):
        // near first within each, so reordering never costs more buffer binds. Meshes with their
        // own buffers bind per draw in any order.
        const a = prev.mesh.gpu?.share
        const b = batch.mesh.gpu?.share
        if (
          prev.material !== batch.material ||
          this.batchKey(prev) !== this.batchKey(batch) ||
          ((a !== undefined || b !== undefined) && a !== b)
        )
          run++
      }
      let q = 0
      if (batch.memberCount > 0) {
        const o = batch.members[0]! * INSTANCE_FLOATS
        const dx = f[o + 3]! - eye[0]!
        const dy = f[o + 7]! - eye[1]!
        const dz = f[o + 11]! - eye[2]!
        // log2(1 + d) · 2^19 fits 24 bits up to 10^8 m.
        q = Math.min(
          0xffffff,
          Math.floor(Math.log2(1 + Math.sqrt(dx * dx + dy * dy + dz * dz)) * 524288),
        )
      }
      // run (13 bits) · 2^40 + distance (24 bits) · 2^16 + index (16 bits): exact in a float64.
      keys[i] = Math.min(run, 8191) * 1099511627776 + q * 65536 + i
    }
    if (run === n - 1) return // every run is one draw: nothing to reorder
    keys.sort()
    const copy = this.nearItems
    for (let i = 0; i < n; i++) copy[i] = items[i]!
    for (let i = 0; i < n; i++) items[i] = copy[keys[i]! % 65536]!
  }

  /** Copies each batch's scratch into the shared visible array, in draw order. */
  pack(list: DrawList): void {
    list.length = 0
    for (const batch of this.sorted) {
      const n = batch.scratchCount
      if (n === 0) continue
      this.reserve(n)
      this.visible.set(batch.scratch.subarray(0, n), this.visibleCount)
      const item = this.item(list, batch)
      item.first = this.visibleCount
      item.count = n
      this.visibleCount += n
      batch.scratchCount = 0
    }
  }

  private createBindGroup(label: string, visible: GPUBuffer): GPUBindGroup {
    return this.gpu.device.createBindGroup({
      label,
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.instanceBuffer.buffer } },
        { binding: 1, resource: { buffer: visible } },
        { binding: 2, resource: { buffer: this.prevBuffer.buffer } },
        { binding: 3, resource: { buffer: this.deform.recordBuffer.buffer } },
        { binding: 4, resource: { buffer: this.deform.poseBuffer.buffer } },
        { binding: 5, resource: { buffer: this.deform.vertexBuffer.buffer } },
      ],
    })
  }

  /** Uploads this frame's CPU visible lists and (re)builds the bind groups the vertex stage reads. */
  finishFrame(): void {
    if (this.generation !== this.gpu.generation) this.upload()
    if (this.visibleCount > 0) this.visibleBuffer.write(this.visible, 0, 0, this.visibleCount)
    this.deform.upload()
    const d = this.deform
    const deformKey = `${d.recordBuffer.version}/${d.poseBuffer.version}/${d.vertexBuffer.version}`
    const key = `${this.instanceBuffer.version}/${this.visibleBuffer.version}/${this.prevBuffer.version}/${deformKey}/${this.gpu.generation}`
    if (!this.bindGroup || this.bound !== key) {
      this.bindGroup = this.createBindGroup('instances', this.visibleBuffer.buffer)
      this.bound = key
    }
    const g = this.gpuVisible
    if (g) {
      const gkey = `${this.instanceBuffer.version}/${g.version}/${this.prevBuffer.version}/${deformKey}/${this.gpu.generation}`
      if (!this.gpuBindGroup || this.gpuBound !== gkey) {
        this.gpuBindGroup = this.createBindGroup('instances/gpu-culled', g.buffer)
        this.gpuBound = gkey
      }
    }
  }
}

const legacy: CullParams = {
  planes: null,
  require: 0,
  eye: undefined,
  lodScale: 1,
  orthographic: false,
  lodState: undefined,
  updateLod: true,
}

/** Projected diameter of a sphere as a fraction of viewport height. Mirrors the cull shader. */
export function lodSize(radius: number, distance: number, params: CullParams): number {
  if (params.orthographic) return f32(radius * params.lodScale)
  return f32((radius * params.lodScale) / Math.max(distance, 1e-4))
}

const ids = new WeakMap<object, number>()
let nextId = 1
function idOf(o: object): number {
  let id = ids.get(o)
  if (id === undefined) {
    id = nextId++
    ids.set(o, id)
  }
  return id
}

export function createInstanceLayout(gpu: GpuContext): GPUBindGroupLayout {
  return gpu.layouts.bindGroupLayout({
    label: 'instances',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      // Deform records, poses (joint matrices, morph weights), and per-vertex deform data.
      { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      { binding: 5, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
    ],
  })
}

export const Instances = defineResource<InstanceStore>('render/Instances', {
  description: 'The persistent GPU instance buffer: one slot per Mesh3d entity.',
})

/** Keeps each Mesh3d's slot current: transform, batch or LOD set, flags, range. Only changed rows upload. */
function tableChanged(table: Table, since: number): boolean {
  return (
    table.lastStructural > since ||
    table.lastChanged(GlobalTransform) > since ||
    table.lastChanged(Mesh3d) > since ||
    table.lastChanged(ComputedVisibility) > since ||
    table.lastChanged(InstanceSlot) > since ||
    (table.has(MeshMaterial) && table.lastChanged(MeshMaterial) > since) ||
    (table.has(Lod) && table.lastChanged(Lod) > since) ||
    (table.has(VisibilityRange) && table.lastChanged(VisibilityRange) > since) ||
    (table.has(InstanceData) && table.lastChanged(InstanceData) > since)
  )
}

let zeros = new Uint32Array(1024)
/** Change ticks of a component a table lacks: never changed. */
function zeroTicks(n: number): Uint32Array {
  if (zeros.length < n) zeros = new Uint32Array(Math.max(n, zeros.length * 2))
  return zeros
}

/** Present when skinningPlugin is installed: SkinnedMesh and MorphWeights deform what they draw. */
export const DeformPath = defineResource<{ installed: true }>('render/DeformPath', {
  description: 'Present when skinning and morph targets (skinningPlugin) are installed.',
})

const warnedDeforms = new WeakSet<World>()

/** Without skinningPlugin, skinned and morphed meshes draw in their rest pose; says so once. */
function warnNoDeforms(world: World): void {
  if (warnedDeforms.has(world)) return
  warnedDeforms.add(world)
  world
    .tryResource(LogResource)
    ?.log(
      'warn',
      "An entity has SkinnedMesh or MorphWeights, but skinningPlugin isn't installed; it draws in its rest pose",
      {
        code: 'render/feature-missing',
        hint: "Add skinningPlugin from '@aethervtt/shard-render' (forwardPlugin includes it).",
      },
    )
}

export const prepareInstances = defineSystem({
  name: 'render/prepare-instances',
  description:
    'Assigns instance slots, writes changed transforms and batches, and uploads dirty slots.',
  setup: (world) => ({
    q: world.query({ with: [Mesh3d, GlobalTransform, ComputedVisibility, InstanceSlot] }),
  }),
  run: ({ q }, world, ctx) => {
    const store = world.resource(Instances)
    const meshes = world.resource(Meshes)
    const materials = world.resource(Materials)
    const assets = world.resource(GpuAssetsResource)
    assets.beginFrame()
    store.beginFrame()
    const deforms = world.hasResource(DeformPath)
    const since = ctx.lastRunTick
    let hidden = 0
    let rows = 0
    const tableHidden = store.tableHidden
    for (const table of q.tables) {
      const n = table.count
      if (n === 0) continue
      // A table where nothing moved, changed, or arrived since the last run needs no visit.
      const cached = tableHidden[table.id]
      if (cached !== undefined && cached >= 0 && !tableChanged(table, since)) {
        hidden += cached
        rows += n
        continue
      }
      const hiddenBefore = hidden
      const slots = table.column(InstanceSlot, 'slot')
      const g = table.column(GlobalTransform, 'matrix')
      const gChanged = table.changedTicks(GlobalTransform)
      const meshRefs = table.column(Mesh3d, 'mesh')
      const meshChanged = table.changedTicks(Mesh3d)
      const hasMaterial = table.has(MeshMaterial)
      const materialRefs = hasMaterial ? table.column(MeshMaterial, 'material') : undefined
      const materialChanged = hasMaterial ? table.changedTicks(MeshMaterial) : zeroTicks(n)
      const hasLod = table.has(Lod)
      const lodLevels = hasLod ? table.column(Lod, 'levels') : undefined
      const lodChanged = hasLod ? table.changedTicks(Lod) : zeroTicks(n)
      const hasRange = table.has(VisibilityRange)
      const rangeStart = hasRange ? table.column(VisibilityRange, 'start') : undefined
      const rangeEnd = hasRange ? table.column(VisibilityRange, 'end') : undefined
      const rangeChanged = hasRange ? table.changedTicks(VisibilityRange) : zeroTicks(n)
      const hasData = !hasRange && table.has(InstanceData)
      const dataX = hasData ? table.column(InstanceData, 'x') : undefined
      const dataY = hasData ? table.column(InstanceData, 'y') : undefined
      const dataChanged = hasData ? table.changedTicks(InstanceData) : zeroTicks(n)
      const vis = table.column(ComputedVisibility, 'visible')
      const deformed = table.has(SkinnedMesh) || table.has(MorphWeights)
      if (deformed && !deforms) warnNoDeforms(world)
      const tableFlags =
        (deforms && table.has(SkinnedMesh) ? InstanceFlags.Skinned : 0) |
        (deforms && table.has(MorphWeights) ? InstanceFlags.Morph : 0) |
        (table.has(NotShadowCaster) ? 0 : InstanceFlags.Caster) |
        (table.has(NotShadowReceiver) ? 0 : InstanceFlags.Receiver) |
        (hasRange ? InstanceFlags.Range : 0) |
        (hasLod ? InstanceFlags.Lod : 0)
      // A changed table visits every row, so this loop stays branch-light: an unchanged row costs
      // a few tick compares.
      let u32 = store.u32
      let slotFlags = store.flags
      for (let i = 0; i < n; i++) {
        let slot = slots[i]! - 1
        let fresh = false
        if (slot < 0) {
          slot = store.alloc(table.entities[i]!)
          slots[i] = slot + 1
          fresh = true
          u32 = store.u32
          slotFlags = store.flags
        }
        const o = slot * INSTANCE_FLOATS
        const visible = vis[i] !== 0
        if (!visible) hidden++
        const flags = tableFlags | (visible ? InstanceFlags.Visible : 0)
        const oldFlags = slotFlags[slot]!
        if (fresh || gChanged[i]! > since) store.moveSlot(slot, g, i * 12, fresh)
        if (
          fresh ||
          ((oldFlags ^ flags) & InstanceFlags.Lod) !== 0 ||
          meshChanged[i]! > since ||
          materialChanged[i]! > since ||
          lodChanged[i]! > since
        ) {
          store.meshRefs[slot] = meshRefs[i] ?? null
          store.materialRefs[slot] = materialRefs?.[i] ?? null
          store.lods[slot] = hasLod
            ? {
                levels: lodLevels![i] as LodValue['levels'],
                hysteresis: table.column(Lod, 'hysteresis')[i]!,
                bias: table.column(Lod, 'bias')[i]!,
              }
            : null
          resolveSlot(store, slot, meshes, materials)
        }
        if (oldFlags !== flags) {
          u32[o + 13] = flags
          slotFlags[slot] = flags
          store.markDirty(slot)
          if ((oldFlags ^ flags) & (InstanceFlags.Visible | InstanceFlags.Caster))
            store.shadowEpoch++
        }
        if (fresh || rangeChanged[i]! > since) {
          if (hasRange) store.setRange(slot, rangeStart![i]!, rangeEnd![i]!)
        }
        if (hasData && (fresh || dataChanged[i]! > since))
          store.setRange(slot, dataX![i]!, dataY![i]!)
      }
      tableHidden[table.id] = hidden - hiddenBefore
      rows += n
    }
    store.settleMoved()
    store.hiddenCount = hidden
    store.drawableCount = rows - store.pending.size
    // Retry slots whose assets weren't loaded.
    if (store.pending.size > 0) {
      for (const slot of store.pending) resolveSlot(store, slot, meshes, materials)
    }
    // A batch whose mesh or material left its store (unloaded) re-resolves its slots.
    for (const batch of store.batches) {
      if (batch.count === 0) continue
      const meshGone = batch.meshGuid !== undefined && meshes.byGuid(batch.meshGuid) !== batch.mesh
      const materialGone =
        batch.materialGuid !== undefined && materials.byGuid(batch.materialGuid) !== batch.material
      if (meshGone || materialGone) {
        for (let s = 0; s < store.high; s++) {
          const a = store.batchOf[s]!
          const inSet = a <= -2 && store.lodSets[-2 - a]!.batches.includes(batch.index)
          if (a === batch.index || inSet) resolveSlot(store, s, meshes, materials)
        }
      }
    }
    for (const batch of store.batches) {
      batch.ready = batch.count > 0 && assets.materialReady(world, batch.material)
      const material = batch.material
      batch.transparent = isTransparent(material.type.blendOf(material.value))
      batch.deferrable = material.type.deferrable(material.value)
    }
    store.upload()
  },
})

function resolveSlot(
  store: InstanceStore,
  slot: number,
  meshes: import('@aethervtt/shard-assets').AssetStore<Mesh, 'Mesh'>,
  materials: import('@aethervtt/shard-assets').AssetStore<MaterialAsset, 'Material'>,
): void {
  const meshRef = store.meshRefs[slot]
  const materialRef = store.materialRefs[slot]
  const material = materialRef ? materials.get(materialRef) : store.defaultMaterial
  const lod = store.lods[slot]
  if (lod && lod.levels.length > 0) {
    const set = material
      ? store.lodSetFor(lod, material, materialRef?.guid ?? undefined, meshes)
      : undefined
    if (!set) {
      store.assign(slot, -1)
      store.pending.add(slot)
      return
    }
    store.pending.delete(slot)
    store.assign(slot, -2 - set.index)
    return
  }
  const mesh = meshes.get(meshRef)
  if (!mesh || !material) {
    store.assign(slot, -1)
    // A null mesh ref is "draw nothing", not "waiting".
    if (meshRef?.guid !== undefined || !material) store.pending.add(slot)
    else store.pending.delete(slot)
    return
  }
  store.pending.delete(slot)
  store.assign(
    slot,
    store.batchFor(mesh, material, meshRef?.guid, materialRef?.guid ?? undefined).index,
  )
}

/** Frees a Mesh3d's slot when the component goes away (including on despawn). */
export function observeInstanceRemovals(world: World): void {
  world.observe(onRemove(Mesh3d), ({ entity, world }) => {
    if (!world.has(entity, InstanceSlot)) return
    const store = world.tryResource(Instances)
    const value = world.get(entity, InstanceSlot)
    if (store && value.slot > 0) store.release(value.slot - 1)
    const table = world.entityTable(entity)
    table.column(InstanceSlot, 'slot')[world.entityRow(entity)] = 0
  })
}
