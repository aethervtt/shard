import {
  affine,
  ChildOf,
  defineSystem,
  type Entity,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import type { Mesh } from '@aethervtt/shard-mesh'
import { LogResource } from '@aethervtt/shard-runtime'
import { GlobalTransform } from '@aethervtt/shard-transform'
import { BAKED_BIT, DEFORM_WORDS, type DeformStore, type MeshDeform } from './deform'
import {
  InstanceSlot,
  type InstanceStore,
  Instances,
  Lod,
  Mesh3d,
  MorphWeights,
  SkinnedMesh,
  SkinPose,
} from './instances'
import { defineOverlay } from './overlay-registry'
import { findModelRoot } from './paths'
import { MAX_JOINTS, type SkinAsset, Skins } from './skin-asset'
import { ComputedVisibility } from './visibility'

/** The mesh a slot draws (the first level of a LOD set), or undefined. */
function meshOfSlot(store: InstanceStore, slot: number): Mesh | undefined {
  const a = store.batchOf[slot]!
  if (a >= 0) return store.batches[a]!.mesh
  if (a <= -2) return store.batches[store.lodSets[-2 - a]!.batches[0]!]!.mesh
  return undefined
}

/**
 * Per joint, the farthest vertex it mainly moves, measured in joint space, plus how far morph
 * targets can push any vertex. Joints no vertex follows get -1 and don't count toward bounds.
 */
function jointRadii(mesh: Mesh, skin: SkinAsset): Float32Array {
  const count = skin.joints.length
  const radii = new Float32Array(count).fill(-1)
  const joints = mesh.joints!
  const weights = mesh.weights!
  const p = mesh.positions
  const ibm = skin.inverseBindMatrices
  for (let v = 0; v < mesh.vertexCount; v++) {
    let main = 0
    for (let k = 1; k < 4; k++) if (weights[v * 4 + k]! > weights[v * 4 + main]!) main = k
    const j = joints[v * 4 + main]!
    if (j >= count) continue
    const m = j * 16
    const x = p[v * 3]!
    const y = p[v * 3 + 1]!
    const z = p[v * 3 + 2]!
    const lx = ibm[m]! * x + ibm[m + 4]! * y + ibm[m + 8]! * z + ibm[m + 12]!
    const ly = ibm[m + 1]! * x + ibm[m + 5]! * y + ibm[m + 9]! * z + ibm[m + 13]!
    const lz = ibm[m + 2]! * x + ibm[m + 6]! * y + ibm[m + 10]! * z + ibm[m + 14]!
    const r = Math.sqrt(lx * lx + ly * ly + lz * lz)
    if (r > radii[j]!) radii[j] = r
  }
  let pad = 0
  for (const target of mesh.targets ?? []) {
    let reach = 0
    const d = target.positions
    for (let i = 0; i < d.length; i += 3) {
      const r = d[i]! * d[i]! + d[i + 1]! * d[i + 1]! + d[i + 2]! * d[i + 2]!
      if (r > reach) reach = r
    }
    pad += Math.sqrt(reach)
  }
  if (pad > 0) for (let j = 0; j < count; j++) if (radii[j]! >= 0) radii[j] = radii[j]! + pad
  return radii
}

/** The skin's joints under the mesh's model root, by path. Cold path. */
function resolveJoints(world: World, entity: Entity, skin: SkinAsset): Entity[] | undefined {
  if (skin.joints.length === 0) return undefined
  const found = findModelRoot(world, entity, skin.joints[0]!)
  if (!found) return undefined
  const out: Entity[] = []
  for (const path of skin.joints) {
    const e = found.paths.get(path)
    if (e === undefined) return undefined
    out.push(e)
  }
  return out
}

const a = new Float32Array(12)
const meshWorld = new Float32Array(12)
const meshInverse = new Float32Array(12)
const bounds = new Float32Array(6)
const topIndex = new Int32Array(8)
const topWeight = new Float32Array(8)

/** The SkinPose columns of the table prepare-deforms is visiting (set per table, no allocation). */
const poseColumns: {
  base: Uint32Array
  joints: Uint32Array
  morphBase: Uint32Array
  morphCount: Uint32Array
  sphere: Float32Array
} = {
  base: new Uint32Array(0),
  joints: new Uint32Array(0),
  morphBase: new Uint32Array(0),
  morphCount: new Uint32Array(0),
  sphere: new Float32Array(0),
}

interface DeformState {
  /** Frame at which to retry resolving an entity's joints. */
  retry: Map<Entity, number>
  warned: Set<string>
  frame: number
  /**
   * Per slot, for SkinPose rows (0115): the store layout + 1 its record was fully written at
   * (0: not cached), and the batch it was written for. A cached record only moves its sphere.
   */
  fullLayout: Int32Array
  fullBatch: Int32Array
}

/**
 * Writes joint matrices (`inverse(mesh) × joint × inverseBind`, so the instance transform still
 * applies), a pose-following cull sphere, and the active morph weights of every visible skinned or
 * morphed instance. Runs after instance slots are assigned, before culling.
 */
export const prepareDeforms = defineSystem({
  name: 'render/prepare-deforms',
  description:
    'Joint matrices, pose bounds, and morph weights of skinned and morphed meshes, uploaded for the vertex stage.',
  setup: (world) => ({
    skinned: world.query({
      with: [SkinnedMesh, InstanceSlot, GlobalTransform, ComputedVisibility],
    }),
    morphed: world.query({
      with: [MorphWeights, InstanceSlot, ComputedVisibility],
      without: [SkinnedMesh],
    }),
    state: {
      retry: new Map(),
      warned: new Set(),
      frame: 0,
      fullLayout: new Int32Array(256),
      fullBatch: new Int32Array(256),
    } as DeformState,
  }),
  run: ({ skinned, morphed, state }, world, ctx) => {
    const store = world.resource(Instances)
    const d = store.deform
    d.beginFrame()
    state.frame++
    const skins = world.tryResource(Skins)
    const records = d.records
    const since = ctx.lastRunTick
    if (state.fullLayout.length < d.capacity) {
      state.fullLayout = new Int32Array(d.capacity)
      state.fullBatch = new Int32Array(d.capacity)
    }
    for (let ti = 0; ti < skinned.tables.length; ti++) {
      const table = skinned.tables[ti]!
      const n = table.count
      if (n === 0) continue
      const slots = table.column(InstanceSlot, 'slot')
      const vis = table.column(ComputedVisibility, 'visible')
      const g = table.column(GlobalTransform, 'matrix')
      const skinRefs = table.column(SkinnedMesh, 'skin')
      const jointLists = table.column(SkinnedMesh, 'joints') as (Entity | null)[][]
      const weights = table.has(MorphWeights)
        ? (table.column(MorphWeights, 'weights') as number[][])
        : undefined
      // SkinPose rows other than 'joints' take their pose from the store, not joint entities.
      const sources = table.has(SkinPose) ? table.column(SkinPose, 'source') : undefined
      // Change ticks deciding whether a SkinPose row's cached record still holds.
      const poseTicks = sources ? table.changedTicks(SkinPose) : undefined
      const meshTicks = table.changedTicks(Mesh3d)
      const lodTicks = table.has(Lod) ? table.changedTicks(Lod) : undefined
      const visTicks = table.changedTicks(ComputedVisibility)
      const globalTicks = table.changedTicks(GlobalTransform)
      const weightTicks = table.has(MorphWeights) ? table.changedTicks(MorphWeights) : undefined
      if (sources) {
        poseColumns.base = table.column(SkinPose, 'base')
        poseColumns.joints = table.column(SkinPose, 'joints')
        poseColumns.morphBase = table.column(SkinPose, 'morphBase')
        poseColumns.morphCount = table.column(SkinPose, 'morphCount')
        poseColumns.sphere = table.column(SkinPose, 'sphere')
      }
      for (let i = 0; i < n; i++) {
        const slot = slots[i]! - 1
        if (slot < 0 || vis[i] === 0) continue
        const mesh = meshOfSlot(store, slot)
        if (!mesh) {
          d.clear(slot)
          continue
        }
        const o = slot * DEFORM_WORDS
        if (sources !== undefined && sources[i] !== 0) {
          // Cached (0115): nothing it was written from changed, and its morphs (if any) are a
          // persistent block. Only the sphere follows the slot's transform.
          if (
            state.fullLayout[slot] === d.layout + 1 &&
            state.fullBatch[slot] === store.batchOf[slot] &&
            poseTicks![i]! <= since &&
            meshTicks[i]! <= since &&
            (lodTicks === undefined || lodTicks[i]! <= since) &&
            visTicks[i]! <= since &&
            (records[o + 9] === 0 || poseColumns.morphBase[i] !== 0) &&
            (weightTicks === undefined ||
              weightTicks[i]! <= since ||
              poseColumns.morphBase[i] !== 0)
          ) {
            markLevelsUsed(store, slot, state.frame)
            d.meshData(mesh)
            if (sources[i] === 2 && records[o + 5] !== 0) d.bakedSlots++
            if (globalTicks[i]! > since) {
              writeSphere(d.recordF32, o, i, g)
              d.touch(slot)
            }
            continue
          }
          writeLevels(store, slot, o)
          const md = d.meshData(mesh)
          writeMeshFields(records, o, md)
          writeSkinPose(world, state, d, o, i, g, sources[i] === 2, weights?.[i], md)
          state.fullLayout[slot] = d.layout + 1
          state.fullBatch[slot] = store.batchOf[slot]!
          d.touch(slot)
          continue
        }
        writeLevels(store, slot, o)
        const md = d.meshData(mesh)
        writeMeshFields(records, o, md)
        const skin = skins?.get(skinRefs[i])
        let jointCount = 0
        if (skin && md.skinBase >= 0) {
          let joints = jointLists[i]!
          if (joints.length !== skin.joints.length) {
            const entity = table.entities[i]!
            const at = state.retry.get(entity) ?? 0
            if (at <= state.frame) {
              const resolved = resolveJoints(world, entity, skin)
              if (resolved) {
                jointLists[i] = resolved
                joints = resolved
                state.retry.delete(entity)
              } else {
                // Not spawned yet (or renamed): try again in a second, not every frame.
                state.retry.set(entity, state.frame + 60)
              }
            }
          }
          if (skin.joints.length > MAX_JOINTS) warnTooMany(world, state, skin)
          else if (joints.length === skin.joints.length) {
            jointCount = writeJoints(world, d, o, g, i * 12, skin, joints, md, mesh)
            if (jointCount < 0) {
              // A joint went away (respawn, despawn): resolve again next frame.
              jointLists[i] = []
              jointCount = 0
            }
          }
        }
        records[o + 5] = jointCount
        if (jointCount === 0) d.recordF32[o + 3] = 0
        writeMorph(d, o, weights?.[i], md)
        d.touch(slot)
      }
    }
    for (let ti = 0; ti < morphed.tables.length; ti++) {
      const table = morphed.tables[ti]!
      const n = table.count
      if (n === 0) continue
      const slots = table.column(InstanceSlot, 'slot')
      const vis = table.column(ComputedVisibility, 'visible')
      const weights = table.column(MorphWeights, 'weights') as number[][]
      for (let i = 0; i < n; i++) {
        const slot = slots[i]! - 1
        if (slot < 0 || vis[i] === 0) continue
        const mesh = meshOfSlot(store, slot)
        if (!mesh) {
          d.clear(slot)
          continue
        }
        const o = slot * DEFORM_WORDS
        writeLevels(store, slot, o)
        const md = d.meshData(mesh)
        writeMeshFields(records, o, md)
        records[o + 5] = 0
        d.recordF32[o + 3] = 0
        writeMorph(d, o, weights[i], md)
        d.touch(slot)
      }
    }
  },
})

/**
 * A SkinPose row's record (spec 0115): word 4 its pose rows or baked header, word 5 its joint
 * count (with BAKED_BIT), words 9-10 its persistent morph block (else this frame's MorphWeights),
 * and its sphere through the slot's GlobalTransform. No joint entities are read.
 */
function writeSkinPose(
  world: World,
  state: DeformState,
  d: DeformStore,
  o: number,
  i: number,
  g: Float32Array,
  baked: boolean,
  weights: readonly number[] | undefined,
  md: MeshDeform,
): void {
  const records = d.records
  const f = d.recordF32
  const c = poseColumns
  const joints = md.skinBase >= 0 ? c.joints[i]! : 0
  records[o + 4] = joints > 0 ? c.base[i]! : 0
  records[o + 5] = joints > 0 ? (baked ? (joints | BAKED_BIT) >>> 0 : joints) : 0
  if (baked && joints > 0) d.bakedSlots++
  const morphBase = c.morphBase[i]!
  if (morphBase !== 0) {
    let count = c.morphCount[i]!
    if (count > 8) count = 8
    // A pair naming a target this mesh lacks would read another mesh's deltas at level 0.
    const p = d.poses
    for (let k = 0; k < count; k++) {
      if (p[morphBase * 4 + k * 2]! >= md.targetCount) {
        warnMorphRange(world, state)
        count = 0
      }
    }
    records[o + 9] = count
    records[o + 10] = count > 0 ? morphBase : 0
  } else writeMorph(d, o, weights, md)
  if (joints === 0) {
    f[o + 3] = 0
    return
  }
  writeSphere(f, o, i, g)
}

/** A SkinPose row's model-space sphere through its GlobalTransform, into record words 0-3. */
function writeSphere(f: Float32Array, o: number, i: number, g: Float32Array): void {
  const s = poseColumns.sphere
  const so = i * 4
  const go = i * 12
  const cx = s[so]!
  const cy = s[so + 1]!
  const cz = s[so + 2]!
  f[o] = g[go]! * cx + g[go + 1]! * cy + g[go + 2]! * cz + g[go + 3]!
  f[o + 1] = g[go + 4]! * cx + g[go + 5]! * cy + g[go + 6]! * cz + g[go + 7]!
  f[o + 2] = g[go + 8]! * cx + g[go + 9]! * cy + g[go + 10]! * cz + g[go + 11]!
  const sx = g[go]! * g[go]! + g[go + 4]! * g[go + 4]! + g[go + 8]! * g[go + 8]!
  const sy = g[go + 1]! * g[go + 1]! + g[go + 5]! * g[go + 5]! + g[go + 9]! * g[go + 9]!
  const sz = g[go + 2]! * g[go + 2]! + g[go + 6]! * g[go + 6]! + g[go + 10]! * g[go + 10]!
  f[o + 3] = s[so + 3]! * Math.sqrt(sx > sy ? (sx > sz ? sx : sz) : sy > sz ? sy : sz)
}

function warnMorphRange(world: World, state: DeformState): void {
  if (state.warned.has('render/morph-target-range')) return
  state.warned.add('render/morph-target-range')
  world
    .tryResource(LogResource)
    ?.error(
      new ShardError(
        'render/morph-target-range',
        "A SkinPose morph block names a target the mesh doesn't have",
        { hint: "Pack only targets every part's mesh has; the part draws without morphs." },
      ),
    )
}

/**
 * Record word 11: the slot's LOD level table (each level's own skin and morph data), so a lower
 * level reads its own vertices' joints, weights, and deltas, not level 0's. 0 without Lod.
 */
/** Marks a LOD set's levels' mesh data used, once a frame (a repack drops unused meshes). */
function markLevelsUsed(store: InstanceStore, slot: number, frame: number): void {
  const a = store.batchOf[slot]!
  if (a > -2) return
  const set = store.lodSets[-2 - a]!
  if (set.usedFrame === frame) return
  set.usedFrame = frame
  const d = store.deform
  for (let k = 0; k < set.batches.length; k++) d.meshData(store.batches[set.batches[k]!]!.mesh)
}

function writeLevels(store: InstanceStore, slot: number, o: number): void {
  const d = store.deform
  const a = store.batchOf[slot]!
  if (a > -2) {
    d.records[o + 11] = 0
    return
  }
  const set = store.lodSets[-2 - a]!
  const n = set.batches.length
  // Every level first: packing one may repack the buffer, which moves the table.
  for (let k = 0; k < n; k++) d.meshData(store.batches[set.batches[k]!]!.mesh)
  const base = d.levelTable(set, n)
  for (let k = 0; k < n; k++) d.setLevel(base, k, d.meshData(store.batches[set.batches[k]!]!.mesh))
  d.records[o + 11] = base + 1
}

function writeMeshFields(records: Uint32Array, o: number, md: MeshDeform): void {
  records[o + 6] = md.skinBase >= 0 ? md.skinBase : 0
  records[o + 7] = md.morphBase >= 0 ? md.morphBase : 0
  records[o + 8] = md.vertexCount
}

function warnTooMany(world: World, state: DeformState, skin: SkinAsset): void {
  if (state.warned.has(skin.name)) return
  state.warned.add(skin.name)
  world
    .tryResource(LogResource)
    ?.error(
      new ShardError(
        'render/too-many-joints',
        `Skin "${skin.name}" has ${skin.joints.length} joints; skinning supports ${MAX_JOINTS}`,
        { hint: 'Split the mesh, or remove helper bones before exporting. It draws in bind pose.' },
      ),
    )
}

/**
 * Joint matrices for one instance, relative to the mesh, into this frame's poses, and the world
 * sphere around the posed joints. Returns the joint count, or -1 if a joint is gone.
 */
function writeJoints(
  world: World,
  d: DeformStore,
  o: number,
  g: Float32Array,
  go: number,
  skin: SkinAsset,
  joints: readonly (Entity | null)[],
  md: MeshDeform,
  mesh: Mesh,
): number {
  const count = joints.length
  for (let k = 0; k < 12; k++) meshWorld[k] = g[go + k]!
  if (!affine.invert(meshInverse, meshWorld)) return 0
  if (md.radiiFor !== skin) {
    md.radii = jointRadii(mesh, skin)
    md.radiiFor = skin
  }
  const radii = md.radii!
  const base = d.allocPoses(count * 3)
  const poses = d.poses
  const ibm = skin.inverseBindMatrices
  const inv = meshInverse
  bounds[0] = bounds[1] = bounds[2] = Number.POSITIVE_INFINITY
  bounds[3] = bounds[4] = bounds[5] = Number.NEGATIVE_INFINITY
  for (let j = 0; j < count; j++) {
    const entity = joints[j]
    if (entity === null || entity === undefined || !world.isAlive(entity)) return -1
    const table = world.entityTableUnchecked(entity)
    if (!table.has(GlobalTransform)) return -1
    const jw = table.column(GlobalTransform, 'matrix')
    const jo = world.entityRowUnchecked(entity) * 12
    const m = j * 16
    const out = (base + j * 3) * 4
    // A = joint (3x4) × inverseBind (4x4, column-major), then inverse(mesh) × A, row by row.
    for (let r = 0; r < 3; r++) {
      const j0 = jw[jo + r * 4]!
      const j1 = jw[jo + r * 4 + 1]!
      const j2 = jw[jo + r * 4 + 2]!
      const j3 = jw[jo + r * 4 + 3]!
      for (let c = 0; c < 4; c++) {
        a[r * 4 + c] =
          j0 * ibm[m + c * 4]! +
          j1 * ibm[m + c * 4 + 1]! +
          j2 * ibm[m + c * 4 + 2]! +
          j3 * ibm[m + c * 4 + 3]!
      }
    }
    for (let r = 0; r < 3; r++) {
      const i0 = inv[r * 4]!
      const i1 = inv[r * 4 + 1]!
      const i2 = inv[r * 4 + 2]!
      for (let c = 0; c < 4; c++) {
        poses[out + r * 4 + c] =
          i0 * a[c]! + i1 * a[4 + c]! + i2 * a[8 + c]! + (c === 3 ? inv[r * 4 + 3]! : 0)
      }
    }
    // Bounds: each joint's sphere, radius scaled by the joint's largest axis.
    const radius = radii[j]!
    if (radius < 0) continue
    const sx = jw[jo]! * jw[jo]! + jw[jo + 4]! * jw[jo + 4]! + jw[jo + 8]! * jw[jo + 8]!
    const sy = jw[jo + 1]! * jw[jo + 1]! + jw[jo + 5]! * jw[jo + 5]! + jw[jo + 9]! * jw[jo + 9]!
    const sz = jw[jo + 2]! * jw[jo + 2]! + jw[jo + 6]! * jw[jo + 6]! + jw[jo + 10]! * jw[jo + 10]!
    const wr = radius * Math.sqrt(Math.max(sx, sy, sz))
    const px = jw[jo + 3]!
    const py = jw[jo + 7]!
    const pz = jw[jo + 11]!
    if (px - wr < bounds[0]!) bounds[0] = px - wr
    if (py - wr < bounds[1]!) bounds[1] = py - wr
    if (pz - wr < bounds[2]!) bounds[2] = pz - wr
    if (px + wr > bounds[3]!) bounds[3] = px + wr
    if (py + wr > bounds[4]!) bounds[4] = py + wr
    if (pz + wr > bounds[5]!) bounds[5] = pz + wr
  }
  const f = d.recordF32
  d.records[o + 4] = base
  if (bounds[0]! <= bounds[3]!) {
    const ex = (bounds[3]! - bounds[0]!) * 0.5
    const ey = (bounds[4]! - bounds[1]!) * 0.5
    const ez = (bounds[5]! - bounds[2]!) * 0.5
    f[o] = bounds[0]! + ex
    f[o + 1] = bounds[1]! + ey
    f[o + 2] = bounds[2]! + ez
    f[o + 3] = Math.sqrt(ex * ex + ey * ey + ez * ez)
  } else {
    f[o + 3] = 0
  }
  return count
}

/** The heaviest (up to 8) morph weights as (target, weight) pairs in this frame's poses. */
function writeMorph(
  d: DeformStore,
  o: number,
  weights: readonly number[] | undefined,
  md: MeshDeform,
): void {
  let active = 0
  const n = weights ? Math.min(weights.length, md.targetCount) : 0
  for (let t = 0; t < n; t++) {
    const w = weights![t]!
    const mag = Math.abs(w)
    if (mag < 1e-5) continue
    // Insertion into the top 8 by magnitude.
    let k: number
    if (active < 8) k = active++
    else if (mag <= Math.abs(topWeight[7]!)) continue
    else k = 7
    while (k > 0 && Math.abs(topWeight[k - 1]!) < mag) {
      topWeight[k] = topWeight[k - 1]!
      topIndex[k] = topIndex[k - 1]!
      k--
    }
    topWeight[k] = w
    topIndex[k] = t
  }
  d.records[o + 9] = active
  if (active === 0) return
  const base = d.allocPoses(4)
  const poses = d.poses
  for (let k = 0; k < 8; k++) {
    poses[base * 4 + k * 2] = k < active ? topIndex[k]! : 0
    poses[base * 4 + k * 2 + 1] = k < active ? topWeight[k]! : 0
  }
  d.records[o + 10] = base
}

// --- overlay -------------------------------------------------------------------------

const JOINT = [1, 0.85, 0.2, 1]
const BONE = [0.3, 0.9, 1, 1]
const pa = new Float32Array(3)
const pb = new Float32Array(3)
const pc = new Float32Array(3)

function positionOf(world: World, entity: Entity, out: Float32Array): boolean {
  if (!world.isAlive(entity) || !world.has(entity, GlobalTransform)) return false
  const m = world.entityTable(entity).column(GlobalTransform, 'matrix')
  const o = world.entityRow(entity) * 12
  out[0] = m[o + 3]!
  out[1] = m[o + 7]!
  out[2] = m[o + 11]!
  return true
}

export const skeletonOverlay = defineOverlay({
  name: 'skeleton',
  description:
    'Skinned meshes’ joints (yellow) and bones to their parent joints (cyan), in the current pose.',
  draw(world, g, passes) {
    const q = world.query({ with: [SkinnedMesh] })
    for (const table of q.tables) {
      const lists = table.column(SkinnedMesh, 'joints') as (Entity | null)[][]
      for (let i = 0; i < table.count; i++) {
        if (!passes(table.entities[i]!)) continue
        const joints = lists[i]!
        const set = new Set(joints)
        for (const joint of joints) {
          if (joint === null || !positionOf(world, joint, pa)) continue
          // A small cross per joint: spheres cost 20x the lines with thousands of joints.
          for (let axis = 0; axis < 3; axis++) {
            pb[0] = pa[0]!
            pb[1] = pa[1]!
            pb[2] = pa[2]!
            pc[0] = pa[0]!
            pc[1] = pa[1]!
            pc[2] = pa[2]!
            pb[axis] = pb[axis]! - 0.015
            pc[axis] = pc[axis]! + 0.015
            g.line(pb, pc, JOINT)
          }
          const parent = world.has(joint, ChildOf) ? world.get(joint, ChildOf).parent : null
          if (parent !== null && set.has(parent) && positionOf(world, parent, pb)) {
            g.line(pb, pa, BONE)
          }
        }
      }
    }
  },
})
