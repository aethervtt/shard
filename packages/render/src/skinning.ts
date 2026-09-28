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
import { DEFORM_WORDS, type DeformStore, type MeshDeform } from './deform'
import { InstanceSlot, type InstanceStore, Instances, MorphWeights, SkinnedMesh } from './instances'
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

interface DeformState {
  /** Frame at which to retry resolving an entity's joints. */
  retry: Map<Entity, number>
  warned: Set<string>
  frame: number
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
    state: { retry: new Map(), warned: new Set(), frame: 0 } as DeformState,
  }),
  run: ({ skinned, morphed, state }, world) => {
    const store = world.resource(Instances)
    const d = store.deform
    d.beginFrame()
    state.frame++
    const skins = world.tryResource(Skins)
    const records = d.records
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
      for (let i = 0; i < n; i++) {
        const slot = slots[i]! - 1
        if (slot < 0 || vis[i] === 0) continue
        const mesh = meshOfSlot(store, slot)
        if (!mesh) {
          d.clear(slot)
          continue
        }
        const md = d.meshData(mesh)
        const o = slot * DEFORM_WORDS
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
        const md = d.meshData(mesh)
        const o = slot * DEFORM_WORDS
        writeMeshFields(records, o, md)
        records[o + 5] = 0
        d.recordF32[o + 3] = 0
        writeMorph(d, o, weights[i], md)
        d.touch(slot)
      }
    }
  },
})

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
