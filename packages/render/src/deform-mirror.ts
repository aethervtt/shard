import { type Entity, ShardError, type World } from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { BAKED_BIT, DEFORM_WORDS, type DeformStore, JOINT_COUNT_MASK, NO_SKIN } from './deform'
import { INSTANCE_FLOATS, InstanceFlags, InstanceSlot, Instances } from './instances'

// The CPU mirror of `deform_vertex` (shaders.ts) and the instance transform, for tests (spec 0115):
// it reads the deform store's CPU arrays as prepare-deforms left them. Cold path; it allocates.

/** Blend weights and vec4 row bases of baked playback, as `baked_frames` computes them. */
export interface BakedFramesMirror {
  a0: number
  a1: number
  b0: number
  b1: number
  ka: number
  kb: number
  wb: number
}

function clipFrame(
  base: number,
  frames: number,
  start: number,
  speed: number,
  fps: number,
  once: boolean,
  clock: number,
  stride: number,
): [number, number, number] {
  const last = Math.max(frames - 1, 0)
  const x = (start + clock * speed) * fps
  let p = Math.min(Math.max(x, 0), last)
  if (!once) {
    const span = Math.max(last, 1)
    p = x - span * Math.floor(x / span)
  }
  const f0 = Math.min(Math.floor(p), last)
  const f1 = Math.min(f0 + 1, last)
  return [base + f0 * stride, base + f1 * stride, p - f0]
}

/** The frames a baked header at vec4 `header` picks at the store's clock. */
export function bakedFrames(
  poses: Float32Array,
  header: number,
  jointCount: number,
): BakedFramesMirror {
  const clock = poses[0]!
  const h = header * 4
  const fps = poses[h + 8]!
  const flags = poses[h + 11]! >>> 0
  const stride = jointCount * 3
  const [a0, a1, ka] = clipFrame(
    poses[h]!,
    poses[h + 1]!,
    poses[h + 2]!,
    poses[h + 3]!,
    fps,
    (flags & 1) !== 0,
    clock,
    stride,
  )
  const out: BakedFramesMirror = { a0, a1, b0: a0, b1: a1, ka, kb: 0, wb: 0 }
  if (poses[h + 5]! > 0) {
    const [b0, b1, kb] = clipFrame(
      poses[h + 4]!,
      poses[h + 5]!,
      poses[h + 6]!,
      poses[h + 7]!,
      fps,
      (flags & 2) !== 0,
      clock,
      stride,
    )
    out.b0 = b0
    out.b1 = b1
    out.kb = kb
    const duration = poses[h + 10]!
    out.wb = duration <= 0 ? 1 : Math.min(Math.max((clock - poses[h + 9]!) / duration, 0), 1)
  }
  return out
}

function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t
}

/** Row component `c` (0-3) of the vec4 at `o` (joint * 3 + row) under baked frames `f`. */
export function bakedRow(poses: Float32Array, f: BakedFramesMirror, o: number, c: number): number {
  const at = (i: number) => poses[(i + o) * 4 + c]!
  if (f.wb >= 1) return mix(at(f.b0), at(f.b1), f.kb)
  const a = mix(at(f.a0), at(f.a1), f.ka)
  if (f.wb <= 0) return a
  return mix(a, mix(at(f.b0), at(f.b1), f.kb), f.wb)
}

/** The mesh a slot draws at LOD `level` (its own mesh without a LOD set). */
function meshAtLevel(world: World, slot: number, level: number): Mesh | undefined {
  const store = world.resource(Instances)
  const a = store.batchOf[slot]!
  if (a >= 0) return store.batches[a]!.mesh
  if (a <= -2) {
    const set = store.lodSets[-2 - a]!
    const b = set.batches[Math.min(level, set.batches.length - 1)]
    return b === undefined ? undefined : store.batches[b]!.mesh
  }
  return undefined
}

/**
 * World-space positions of a skinned or morphed slot's vertices at LOD `level`, as the vertex stage
 * computes them (`deform_vertex`, then the instance transform): joints, persistent poses, and
 * baked playback, with morph pairs. Reads the deform store as prepare-deforms left it this frame.
 * Writes 3 floats per vertex into `out`; returns the vertex count.
 */
export function deformedPositions(
  world: World,
  meshEntity: Entity,
  out: Float32Array,
  level = 0,
): number {
  const slot = world.get(meshEntity, InstanceSlot).slot - 1
  if (slot < 0) {
    throw new ShardError('render/no-slot', `Entity ${meshEntity} has no instance slot yet`, {
      hint: 'Run a frame after spawning it.',
    })
  }
  const store = world.resource(Instances)
  const d: DeformStore = store.deform
  const mesh = meshAtLevel(world, slot, level)
  if (!mesh || mesh.positions.length === 0) {
    throw new ShardError(
      'render/no-positions',
      `Slot ${slot}'s level ${level} mesh has no CPU positions`,
    )
  }
  const n = mesh.vertexCount
  if (out.length < n * 3) {
    throw new ShardError('render/out-too-small', `out holds ${out.length} floats; ${n * 3} needed`)
  }
  const positions = mesh.positions
  const inst = store.f32
  const io = slot * INSTANCE_FLOATS
  const flags = store.u32[io + 13]!
  const records = d.records
  const o = slot * DEFORM_WORDS
  const words = d.vertexData
  const wordF = d.vertexF32
  const poses = d.poses
  const deforms = (flags & (InstanceFlags.Skinned | InstanceFlags.Morph)) !== 0
  let skinBase = records[o + 6]!
  let morphBase = records[o + 7]!
  let vertexCount = records[o + 8]!
  let targetCount = Number.POSITIVE_INFINITY
  if (level > 0 && records[o + 11]! !== 0) {
    const row = records[o + 11]! - 1 + level * 4
    skinBase = words[row]!
    morphBase = words[row + 1]!
    vertexCount = words[row + 2]!
    targetCount = words[row + 3]!
  }
  const jointBase = records[o + 4]!
  const word5 = records[o + 5]!
  const jointCount = word5 & JOINT_COUNT_MASK
  const baked = (word5 & BAKED_BIT) !== 0
  const skinned = (flags & InstanceFlags.Skinned) !== 0 && jointCount > 0 && skinBase !== NO_SKIN
  const frames = skinned && baked ? bakedFrames(poses, jointBase, jointCount) : undefined
  const morphCount = records[o + 9]!
  const weightsBase = records[o + 10]!
  const r = new Float64Array(12)
  for (let v = 0; v < n; v++) {
    let px = positions[v * 3]!
    let py = positions[v * 3 + 1]!
    let pz = positions[v * 3 + 2]!
    if (deforms && v < vertexCount) {
      for (let k = 0; k < morphCount; k++) {
        const pair = (weightsBase + (k >> 1)) * 4 + (k & 1) * 2
        const target = poses[pair]! >>> 0
        if (target >= targetCount) continue
        const w = poses[pair + 1]!
        const m = morphBase + (target * vertexCount + v) * 9
        px += wordF[m]! * w
        py += wordF[m + 1]! * w
        pz += wordF[m + 2]! * w
      }
      if (skinned) {
        const s = skinBase + v * 6
        const j01 = words[s]!
        const j23 = words[s + 1]!
        const joints = [j01 & 0xffff, j01 >>> 16, j23 & 0xffff, j23 >>> 16]
        r.fill(0)
        for (let i = 0; i < 4; i++) {
          const w = wordF[s + 2 + i]!
          const j = Math.min(joints[i]!, jointCount - 1)
          if (frames) {
            if (w === 0) continue
            for (let row = 0; row < 3; row++) {
              for (let c = 0; c < 4; c++) {
                r[row * 4 + c] = r[row * 4 + c]! + bakedRow(poses, frames, j * 3 + row, c) * w
              }
            }
          } else {
            const m = (jointBase + j * 3) * 4
            for (let k = 0; k < 12; k++) r[k] = r[k]! + poses[m + k]! * w
          }
        }
        const x = px
        const y = py
        const z = pz
        px = r[0]! * x + r[1]! * y + r[2]! * z + r[3]!
        py = r[4]! * x + r[5]! * y + r[6]! * z + r[7]!
        pz = r[8]! * x + r[9]! * y + r[10]! * z + r[11]!
      }
    }
    out[v * 3] = inst[io]! * px + inst[io + 1]! * py + inst[io + 2]! * pz + inst[io + 3]!
    out[v * 3 + 1] = inst[io + 4]! * px + inst[io + 5]! * py + inst[io + 6]! * pz + inst[io + 7]!
    out[v * 3 + 2] = inst[io + 8]! * px + inst[io + 9]! * py + inst[io + 10]! * pz + inst[io + 11]!
  }
  return n
}
