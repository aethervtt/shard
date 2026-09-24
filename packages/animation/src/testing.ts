import type { AssetRef, Entity, World } from '@shard/core'
import { ChildOf } from '@shard/core'
import { Mesh } from '@shard/mesh'
import {
  MaterialAsset,
  Materials,
  Mesh3d,
  Meshes,
  MeshMaterial,
  type SkinAsset,
  SkinnedMesh,
  Skins,
} from '@shard/render'
import { findEntityByPath, loadScene, type SceneEntity } from '@shard/scene'
import { animationLayer } from './api'
import { type AnimationChannel, type AnimationClipAsset, AnimationClips } from './clip'
import { AnimationPlayer } from './components'

/**
 * A procedural skinned creature for benchmarks and demos: arms of `segments` joints each, hanging
 * from a body, skinned by a tube mesh, with a clip that sways every joint. Five arms of twelve
 * are 60 joints.
 */
export interface Creature {
  /** The joint hierarchy as scene entities (the body and its arms), relative to the root. */
  skeleton: SceneEntity
  /** Joint paths relative to the root, in skin order. */
  joints: string[]
  mesh: Mesh
  skin: SkinAsset
  /** Every joint swaying, and the body bobbing: `duration` seconds, looping. */
  clip: AnimationClipAsset
}

export interface CreatureOptions {
  arms?: number
  segments?: number
  /** Length of one segment, in meters. */
  length?: number
  /** Vertices around the tube. */
  sides?: number
  duration?: number
}

export function creature(options: CreatureOptions = {}): Creature {
  const arms = options.arms ?? 5
  const segments = options.segments ?? 12
  const length = options.length ?? 0.12
  const sides = options.sides ?? 8
  const duration = options.duration ?? 2
  const joints: string[] = []
  const restPose: SkinAsset['restPose'] = []
  // Arms leave the body at a slant, spread around it.
  const armRoots: SceneEntity[] = []
  for (let a = 0; a < arms; a++) {
    const angle = (a / arms) * Math.PI * 2
    let chain: SceneEntity | undefined
    // Built from the tip back, so each joint holds the next as its child.
    for (let s = segments - 1; s >= 0; s--) {
      const first = s === 0
      const tilt = first ? 0.7 : 0
      const rotation = first
        ? quatMul(axisAngle([0, 1, 0], -angle), axisAngle([0, 0, 1], -Math.PI / 2 + tilt))
        : [0, 0, 0, 1]
      const translation = first
        ? [Math.cos(angle) * 0.15, 0, Math.sin(angle) * 0.15]
        : [0, length, 0]
      chain = {
        name: `a${a}_${s}`,
        components: { 'core/Transform': { translation, rotation } },
        ...(chain ? { children: [chain] } : {}),
      }
    }
    armRoots.push(chain!)
  }
  for (let a = 0; a < arms; a++) {
    let path = 'Body'
    for (let s = 0; s < segments; s++) {
      path += `/a${a}_${s}`
      joints.push(path)
    }
  }
  const skeleton: SceneEntity = {
    name: 'Body',
    components: { 'core/Transform': { translation: [0, 0.9, 0] } },
    children: armRoots,
  }
  // World matrices at bind (column-major 4x4), by walking the same hierarchy.
  const world = new Map<string, number[]>()
  const walk = (e: SceneEntity, parent: number[], prefix: string) => {
    const t = (e.components?.['core/Transform'] ?? {}) as {
      translation?: number[]
      rotation?: number[]
    }
    const m = mul4(parent, trs(t.translation ?? [0, 0, 0], t.rotation ?? [0, 0, 0, 1]))
    const path = prefix ? `${prefix}/${e.name}` : e.name
    world.set(path, m)
    for (const c of e.children ?? []) walk(c, m, path)
  }
  walk(skeleton, identity(), '')
  const ibm = new Float32Array(joints.length * 16)
  joints.forEach((path, j) => {
    ibm.set(invert4(world.get(path)!), j * 16)
    const t = findEntity(skeleton, path)!.components!['core/Transform'] as {
      translation: number[]
      rotation: number[]
    }
    restPose.push({ translation: t.translation, rotation: t.rotation, scale: [1, 1, 1] })
  })
  // The mesh: a tapering tube along each arm, rings at every joint, weights blending neighbours.
  const positions: number[] = []
  const normals: number[] = []
  const jointIndex: number[] = []
  const weights: number[] = []
  const indices: number[] = []
  for (let a = 0; a < arms; a++) {
    const base = positions.length / 3
    const rings = segments + 1
    for (let r = 0; r < rings; r++) {
      const j = Math.min(r, segments - 1)
      const m = world.get(joints[a * segments + j]!)!
      const along = r === segments ? length : 0
      const radius = 0.07 * (1 - (r / rings) * 0.8)
      for (let k = 0; k < sides; k++) {
        const theta = (k / sides) * Math.PI * 2
        const local = [Math.cos(theta) * radius, along, Math.sin(theta) * radius]
        const p = apply(m, local, 1)
        const n = apply(m, [Math.cos(theta), 0, Math.sin(theta)], 0)
        positions.push(p[0]!, p[1]!, p[2]!)
        const len = Math.hypot(n[0]!, n[1]!, n[2]!)
        normals.push(n[0]! / len, n[1]! / len, n[2]! / len)
        // Between joint r-1 and r: the ring at a joint follows it, blended with its parent.
        const self = a * segments + j
        const parent = a * segments + Math.max(0, j - 1)
        const w = r === 0 || r === segments ? 1 : 0.75
        jointIndex.push(self, parent, 0, 0)
        weights.push(w, 1 - w, 0, 0)
      }
    }
    for (let r = 0; r < rings - 1; r++) {
      for (let k = 0; k < sides; k++) {
        const a0 = base + r * sides + k
        const a1 = base + r * sides + ((k + 1) % sides)
        const b0 = a0 + sides
        const b1 = a1 + sides
        indices.push(a0, b0, a1, a1, b0, b1)
      }
    }
  }
  const mesh = Mesh.create({
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    joints: Uint16Array.from(jointIndex),
    weights: Float32Array.from(weights),
    indices: Uint16Array.from(indices),
  })
  // The clip: waves travel down each arm; the body bobs.
  const keys = 31
  const times = Float32Array.from({ length: keys }, (_, k) => (k / (keys - 1)) * duration)
  const channels: AnimationChannel[] = []
  joints.forEach((path, j) => {
    const a = Math.floor(j / segments)
    const s = j % segments
    const values = new Float32Array(keys * 4)
    for (let k = 0; k < keys; k++) {
      const phase = (k / (keys - 1)) * Math.PI * 2 - s * 0.45 + a * 1.3
      const swing = 0.22 * Math.sin(phase)
      // Whole cycles only, so the last key matches the first and the loop has no seam.
      const twist = 0.12 * Math.cos(phase + a)
      const rest = restPose[j]!.rotation
      values.set(
        quatMul(rest, quatMul(axisAngle([0, 0, 1], swing), axisAngle([1, 0, 0], twist))),
        k * 4,
      )
    }
    channels.push({
      target: path,
      component: 'core/Transform',
      field: 'rotation',
      interpolation: 'linear',
      times,
      values,
      width: 4,
    })
  })
  const bob = new Float32Array(keys * 3)
  for (let k = 0; k < keys; k++)
    bob.set([0, 0.9 + 0.08 * Math.sin((k / (keys - 1)) * Math.PI * 4), 0], k * 3)
  channels.push({
    target: 'Body',
    component: 'core/Transform',
    field: 'translation',
    interpolation: 'linear',
    times,
    values: bob,
    width: 3,
  })
  return {
    skeleton,
    joints,
    mesh,
    skin: { name: 'creature', joints, restPose, inverseBindMatrices: ibm },
    clip: { name: 'sway', duration, channels, events: [] },
  }
}

export interface CreatureAssets {
  mesh: AssetRef
  skin: AssetRef
  clip: AssetRef
  material: AssetRef
}

/** Adds a creature's mesh, skin, clip, and a material to the world's stores. */
export function addCreatureAssets(
  world: World,
  c: Creature,
  color = [0.9, 0.5, 0.3, 1],
): CreatureAssets {
  const material = new MaterialAsset({ baseColor: color, roughness: 0.6, metallic: 0 })
  return {
    mesh: world.initResource(Meshes).add(c.mesh, 'creature-mesh'),
    skin: world.initResource(Skins).add(c.skin, 'creature-skin'),
    clip: world.initResource(AnimationClips).add(c.clip, 'creature-sway'),
    material: world.initResource(Materials).add(material, 'creature-material'),
  }
}

/**
 * Spawns creatures at `positions` (each its own root with an AnimationPlayer, time offset so they
 * don't move in step). Returns the roots.
 */
export function spawnCreatures(
  world: World,
  c: Creature,
  assets: CreatureAssets,
  positions: [number, number, number][],
): Entity[] {
  const id = `creatures-${Math.random().toString(36).slice(2)}`
  const { entities } = loadScene(
    world,
    {
      version: 1,
      entities: positions.map((translation, i) => ({
        name: `creature${i}`,
        components: { 'core/Transform': { translation, rotationEuler: [0, (i * 47) % 360, 0] } },
        children: [c.skeleton],
      })),
    },
    { id },
  )
  const roots: Entity[] = []
  positions.forEach((_, i) => {
    const root = entities.get(`creature${i}`)!
    const joints = c.joints.map((p) => findEntityByPath(world, `${id}:creature${i}/${p}`)!)
    world.spawn(
      [Mesh3d, { mesh: assets.mesh as never }],
      [MeshMaterial, { material: assets.material as never }],
      [SkinnedMesh, { skin: assets.skin as never, joints }],
      [ChildOf, { parent: root }],
    )
    world.add(root, AnimationPlayer, {
      layers: [animationLayer(assets.clip, { time: (i * 0.137) % c.clip.duration })],
    })
    roots.push(root)
  })
  return roots
}

// --- small matrix helpers (column-major 4x4) -------------------------------------------------

function findEntity(root: SceneEntity, path: string): SceneEntity | undefined {
  const parts = path.split('/')
  if (parts[0] !== root.name) return undefined
  let e: SceneEntity | undefined = root
  for (const name of parts.slice(1)) e = e?.children?.find((c) => c.name === name)
  return e
}

function axisAngle(axis: number[], angle: number): number[] {
  const s = Math.sin(angle / 2)
  return [axis[0]! * s, axis[1]! * s, axis[2]! * s, Math.cos(angle / 2)]
}

function quatMul(a: number[], b: number[]): number[] {
  return [
    a[3]! * b[0]! + a[0]! * b[3]! + a[1]! * b[2]! - a[2]! * b[1]!,
    a[3]! * b[1]! - a[0]! * b[2]! + a[1]! * b[3]! + a[2]! * b[0]!,
    a[3]! * b[2]! + a[0]! * b[1]! - a[1]! * b[0]! + a[2]! * b[3]!,
    a[3]! * b[3]! - a[0]! * b[0]! - a[1]! * b[1]! - a[2]! * b[2]!,
  ]
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
}

function trs(t: number[], q: number[]): number[] {
  const [x, y, z, w] = q as [number, number, number, number]
  return [
    1 - 2 * (y * y + z * z),
    2 * (x * y + w * z),
    2 * (x * z - w * y),
    0,
    2 * (x * y - w * z),
    1 - 2 * (x * x + z * z),
    2 * (y * z + w * x),
    0,
    2 * (x * z + w * y),
    2 * (y * z - w * x),
    1 - 2 * (x * x + y * y),
    0,
    t[0]!,
    t[1]!,
    t[2]!,
    1,
  ]
}

function mul4(a: number[], b: number[]): number[] {
  const out = new Array<number>(16).fill(0)
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!
  return out
}

/** Inverse of a rigid transform (rotation + translation). */
function invert4(m: number[]): number[] {
  const out = identity()
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out[c * 4 + r] = m[r * 4 + c]!
  for (let r = 0; r < 3; r++)
    out[12 + r] = -(out[r]! * m[12]! + out[4 + r]! * m[13]! + out[8 + r]! * m[14]!)
  return out
}

function apply(m: number[], v: number[], w: number): number[] {
  return [0, 1, 2].map(
    (r) => m[r]! * v[0]! + m[4 + r]! * v[1]! + m[8 + r]! * v[2]! + m[12 + r]! * w,
  )
}

// --- bipeds ----------------------------------------------------------------------------------

/**
 * A procedural humanoid: hips, spine, chest, neck, head, arms, and legs with feet and toes, a
 * tube mesh skinned rigidly to each bone, and walk and idle clips that keep its feet on the
 * ground. For IK and retargeting tests and demos.
 */
export interface Biped {
  skeleton: SceneEntity
  /** Joint paths relative to the root, in skin order. */
  joints: string[]
  /** Path of a joint by its base name and side: path('UpLeg', 'L'). */
  path(base: string, side?: 'L' | 'R'): string
  /**
   * A model-space direction in a joint's own frame at rest (twisted rigs roll every joint): the
   * head's forward is localAxis('Head', undefined, [0, 0, -1]).
   */
  localAxis(base: string, side: 'L' | 'R' | undefined, direction: number[]): number[]
  mesh: Mesh
  skin: SkinAsset
  /** One stride cycle (1 s): walks `speed` m/s toward -Z (hips travel: use root motion). */
  walk: AnimationClipAsset
  /** Breathing in place (2 s). */
  idle: AnimationClipAsset
  /** Height of the ankle above the sole (for FootPlacement offsets), m. */
  ankle: number
  /** Hip height at rest, m. */
  hipHeight: number
  scale: number
}

export interface BipedOptions {
  /** 1: about 1.8 m tall. */
  scale?: number
  /** 'prefix': LeftUpLeg, LeftArm…; 'suffix': UpLeg_L, UpperArm_L… */
  names?: 'prefix' | 'suffix'
  /** Bind every joint with its own roll (bones along +Y, like DCC exports) instead of world-aligned. */
  twisted?: boolean
  /** A name for the skin and clips. */
  name?: string
}

interface BoneDef {
  base: string
  side?: 'L' | 'R'
  parent: number
  /** Joint position at rest (scale 1), and where its tube ends. */
  at: number[]
  end: number[]
  radius: number
}

const BIPED_SPEED = 1.35

function bipedBones(): BoneDef[] {
  const bones: BoneDef[] = [
    { base: 'Hips', parent: -1, at: [0, 0.95, 0], end: [0, 1.05, 0], radius: 0.13 },
    { base: 'Spine', parent: 0, at: [0, 1.05, 0], end: [0, 1.25, 0], radius: 0.12 },
    { base: 'Chest', parent: 1, at: [0, 1.25, 0], end: [0, 1.46, 0], radius: 0.14 },
    { base: 'Neck', parent: 2, at: [0, 1.48, 0], end: [0, 1.58, 0], radius: 0.05 },
    { base: 'Head', parent: 3, at: [0, 1.58, 0], end: [0, 1.8, 0], radius: 0.1 },
  ]
  for (const side of ['L', 'R'] as const) {
    const x = side === 'L' ? -1 : 1
    const shoulder = bones.length
    bones.push(
      {
        base: 'Shoulder',
        side,
        parent: 2,
        at: [0.06 * x, 1.42, 0],
        end: [0.18 * x, 1.42, 0],
        radius: 0.05,
      },
      {
        base: 'UpperArm',
        side,
        parent: shoulder,
        at: [0.19 * x, 1.42, 0],
        end: [0.21 * x, 1.14, 0],
        radius: 0.045,
      },
      {
        base: 'LowerArm',
        side,
        parent: shoulder + 1,
        at: [0.21 * x, 1.14, 0],
        end: [0.22 * x, 0.88, 0],
        radius: 0.038,
      },
      {
        base: 'Hand',
        side,
        parent: shoulder + 2,
        at: [0.22 * x, 0.88, 0],
        end: [0.22 * x, 0.76, -0.02],
        radius: 0.035,
      },
    )
    const leg = bones.length
    bones.push(
      {
        base: 'UpLeg',
        side,
        parent: 0,
        at: [0.1 * x, 0.9, 0],
        end: [0.1 * x, 0.5, 0],
        radius: 0.07,
      },
      {
        base: 'Leg',
        side,
        parent: leg,
        at: [0.1 * x, 0.5, 0],
        end: [0.1 * x, 0.08, 0],
        radius: 0.055,
      },
      {
        base: 'Foot',
        side,
        parent: leg + 1,
        at: [0.1 * x, 0.08, 0],
        end: [0.1 * x, 0.03, -0.13],
        radius: 0.04,
      },
      {
        base: 'Toe',
        side,
        parent: leg + 2,
        at: [0.1 * x, 0.03, -0.13],
        end: [0.1 * x, 0.02, -0.2],
        radius: 0.022,
      },
    )
  }
  return bones
}

export function biped(options: BipedOptions = {}): Biped {
  const scale = options.scale ?? 1
  const style = options.names ?? 'suffix'
  const bones = bipedBones()
  const nameOf = (b: BoneDef) =>
    b.side === undefined
      ? b.base
      : style === 'prefix'
        ? `${b.side === 'L' ? 'Left' : 'Right'}${b.base}`
        : `${b.base}_${b.side}`
  // World rest rotations: identity, or bones along +Y rolled per joint.
  const worldRot = bones.map((b, i) => {
    if (!options.twisted) return [0, 0, 0, 1]
    const d = normalize3(sub3(b.end, b.at))
    return quatMul(fromTo3([0, 1, 0], d), axisAngle([0, 1, 0], 0.6 + i * 0.9))
  })
  const paths: string[] = []
  for (const b of bones) paths.push(b.parent < 0 ? nameOf(b) : `${paths[b.parent]}/${nameOf(b)}`)
  const at = (b: BoneDef) => b.at.map((v) => v * scale)
  // Local rest: parent⁻¹ · world.
  const rest = bones.map((b, i) => {
    const p = b.parent
    const pr = p < 0 ? [0, 0, 0, 1] : worldRot[p]!
    const pp = p < 0 ? [0, 0, 0] : at(bones[p]!)
    return {
      translation: rotate3(conj(pr), sub3(at(b), pp)),
      rotation: quatMul(conj(pr), worldRot[i]!),
      scale: [1, 1, 1],
    }
  })
  // The scene tree.
  const entities: SceneEntity[] = bones.map((b, i) => ({
    name: nameOf(b),
    components: {
      'core/Transform': { translation: rest[i]!.translation, rotation: rest[i]!.rotation },
    },
  }))
  bones.forEach((b, i) => {
    if (b.parent < 0) return
    const parent = entities[b.parent]!
    parent.children = [...(parent.children ?? []), entities[i]!]
  })
  // Inverse bind matrices from the world rest pose.
  const ibm = new Float32Array(bones.length * 16)
  bones.forEach((b, i) => {
    ibm.set(invert4(mul4(translation4(at(b)), trs([0, 0, 0], worldRot[i]!))), i * 16)
  })
  // The mesh: one tube per bone, rigid to its joint.
  const positions: number[] = []
  const normals: number[] = []
  const jointIndex: number[] = []
  const weights: number[] = []
  const indices: number[] = []
  const sides = 8
  bones.forEach((b, j) => {
    const a = at(b)
    const e = b.end.map((v) => v * scale)
    const axis = normalize3(sub3(e, a))
    const ref = Math.abs(axis[1]!) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = normalize3(cross3(axis, ref))
    const v = cross3(axis, u)
    const base = positions.length / 3
    const r = b.radius * scale
    for (let ring = 0; ring < 2; ring++) {
      const c = ring === 0 ? a : e
      const rr = ring === 0 ? r : r * 0.85
      for (let k = 0; k < sides; k++) {
        const th = (k / sides) * Math.PI * 2
        const n = [0, 1, 2].map((q) => u[q]! * Math.cos(th) + v[q]! * Math.sin(th))
        positions.push(c[0]! + n[0]! * rr, c[1]! + n[1]! * rr, c[2]! + n[2]! * rr)
        normals.push(n[0]!, n[1]!, n[2]!)
        jointIndex.push(j, 0, 0, 0)
        weights.push(1, 0, 0, 0)
      }
    }
    for (let k = 0; k < sides; k++) {
      const a0 = base + k
      const a1 = base + ((k + 1) % sides)
      indices.push(a0, a0 + sides, a1, a1, a0 + sides, a1 + sides)
    }
    // Caps.
    const capA = positions.length / 3
    positions.push(...a)
    normals.push(...axis.map((x) => -x))
    const capB = capA + 1
    positions.push(...e)
    normals.push(...axis)
    jointIndex.push(j, 0, 0, 0, j, 0, 0, 0)
    weights.push(1, 0, 0, 0, 1, 0, 0, 0)
    for (let k = 0; k < sides; k++) {
      const a0 = base + k
      const a1 = base + ((k + 1) % sides)
      indices.push(capA, a1, a0, capB, a0 + sides, a1 + sides)
    }
  })
  const mesh = Mesh.create({
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    joints: Uint16Array.from(jointIndex),
    weights: Float32Array.from(weights),
    indices: Uint16Array.from(indices),
  })
  const index = (base: string, side?: 'L' | 'R') =>
    bones.findIndex((b) => b.base === base && b.side === side)
  const name = options.name ?? `biped${options.twisted ? '-twisted' : ''}`
  const skin: SkinAsset = { name, joints: paths, restPose: rest, inverseBindMatrices: ibm }
  const pose: BipedPose = { bones, worldRot, scale, paths }
  return {
    skeleton: entities[0]!,
    joints: paths,
    path: (base, side) => paths[index(base, side)]!,
    localAxis: (base, side, direction) => rotate3(conj(worldRot[index(base, side)]!), direction),
    mesh,
    skin,
    walk: bipedClip(pose, `${name}-walk`, 1, 25, walkDelta, BIPED_SPEED),
    idle: bipedClip(pose, `${name}-idle`, 2, 21, idleDelta, 0),
    ankle: 0.08 * scale,
    hipHeight: 0.95 * scale,
    scale,
  }
}

interface BipedPose {
  bones: BoneDef[]
  worldRot: number[][]
  scale: number
  paths: string[]
}

/**
 * Each joint's turn from rest in the model's frame (pitch about X, yaw about Y), at phase φ of the
 * cycle. The clip turns these into local rotations for whatever bind orientations the rig has.
 */
type Delta = (b: BoneDef, phi: number) => number[]

function walkDelta(b: BoneDef, phi: number): number[] {
  const sign = b.side === 'R' ? -1 : 1
  const s = Math.sin(phi) * sign
  const c = Math.cos(phi) * sign
  switch (b.base) {
    case 'UpLeg':
      return axisAngle([1, 0, 0], 0.42 * s + 0.08)
    case 'Leg': {
      // The knee folds on the swing (leg moving forward).
      const swing = Math.max(0, c)
      return axisAngle([1, 0, 0], -0.12 - 0.85 * swing * swing)
    }
    case 'Foot':
      return axisAngle([1, 0, 0], 0.1 - 0.25 * s)
    case 'UpperArm':
      return axisAngle([1, 0, 0], -0.32 * s)
    case 'LowerArm':
      return axisAngle([1, 0, 0], 0.35 + 0.1 * Math.max(0, -s))
    case 'Spine':
      return axisAngle([0, 1, 0], 0.07 * Math.sin(phi))
    case 'Chest':
      return axisAngle([0, 1, 0], -0.12 * Math.sin(phi))
    case 'Head':
      return axisAngle([0, 1, 0], 0.05 * Math.sin(phi))
    default:
      return [0, 0, 0, 1]
  }
}

function idleDelta(b: BoneDef, phi: number): number[] {
  const breath = Math.sin(phi)
  switch (b.base) {
    case 'Chest':
      return axisAngle([1, 0, 0], -0.03 * breath)
    case 'Head':
      return axisAngle([1, 0, 0], 0.02 * breath)
    case 'UpperArm':
      return axisAngle([0, 0, 1], (b.side === 'L' ? -1 : 1) * (0.06 + 0.02 * breath))
    case 'LowerArm':
      return axisAngle([1, 0, 0], 0.2)
    case 'Leg':
      return axisAngle([1, 0, 0], -0.05)
    case 'UpLeg':
      return axisAngle([1, 0, 0], 0.025)
    case 'Foot':
      return axisAngle([1, 0, 0], 0.025)
    default:
      return [0, 0, 0, 1]
  }
}

/**
 * A clip from per-joint deltas: rotations for every joint, and the hips' translation, lowered each
 * key so the lowest sole touches y = 0 and traveling `speed` m/s toward -Z.
 */
function bipedClip(
  pose: BipedPose,
  name: string,
  duration: number,
  keys: number,
  delta: Delta,
  speed: number,
): AnimationClipAsset {
  const { bones, worldRot, scale, paths } = pose
  const times = Float32Array.from({ length: keys }, (_, k) => (k / (keys - 1)) * duration)
  const rotations = bones.map(() => new Float32Array(keys * 4))
  const hips = new Float32Array(keys * 3)
  for (let k = 0; k < keys; k++) {
    const phi = (k / (keys - 1)) * Math.PI * 2
    // Model-space turns down the hierarchy: G_j = G_parent · δ_j, world W_j = G_j · R_j.
    const G: number[][] = []
    const P: number[][] = []
    bones.forEach((b, j) => {
      const d = delta(b, phi)
      const g = b.parent < 0 ? d : quatMul(G[b.parent]!, d)
      G.push(g)
      // local = R_parent⁻¹ · δ · R_j (the parent's turn is already in its own local).
      const pr = b.parent < 0 ? [0, 0, 0, 1] : worldRot[b.parent]!
      rotations[j]!.set(quatMul(conj(pr), quatMul(d, worldRot[j]!)), k * 4)
      // Positions with the hips at the origin: parent + G_parent · (rest offset).
      if (b.parent < 0) P.push([0, 0, 0])
      else {
        const off = sub3(
          b.at.map((v) => v * scale),
          bones[b.parent]!.at.map((v) => v * scale),
        )
        const p = rotate3(G[b.parent]!, off)
        P.push(P[b.parent]!.map((v, q) => v + p[q]!))
      }
    })
    // The lowest sole: under each ankle and each toe.
    let lowest = Infinity
    bones.forEach((b, j) => {
      if (b.base === 'Foot') lowest = Math.min(lowest, P[j]![1]! - 0.08 * scale)
      if (b.base === 'Toe') lowest = Math.min(lowest, P[j]![1]! - 0.02 * scale)
    })
    hips.set([0, -lowest, -speed * scale * times[k]!], k * 3)
  }
  const channels: AnimationChannel[] = bones.map((_, j) => ({
    target: paths[j]!,
    component: 'core/Transform',
    field: 'rotation',
    interpolation: 'linear' as const,
    times,
    values: rotations[j]!,
    width: 4,
  }))
  channels.push({
    target: paths[0]!,
    component: 'core/Transform',
    field: 'translation',
    interpolation: 'linear',
    times,
    values: hips,
    width: 3,
  })
  return { name, duration, channels, events: [] }
}

export interface BipedAssets {
  mesh: AssetRef
  skin: AssetRef
  walk: AssetRef
  idle: AssetRef
  material: AssetRef
}

/** Adds a biped's mesh, skin, clips, and a material to the world's stores. */
export function addBipedAssets(world: World, b: Biped, color = [0.8, 0.8, 0.85, 1]): BipedAssets {
  const material = new MaterialAsset({ baseColor: color, roughness: 0.55, metallic: 0 })
  const tag = `${b.skin.name}-${Math.random().toString(36).slice(2, 7)}`
  return {
    mesh: world.initResource(Meshes).add(b.mesh, `${tag}-mesh`),
    skin: world.initResource(Skins).add(b.skin, `${tag}-skin`),
    walk: world.initResource(AnimationClips).add(b.walk, `${tag}-walk`),
    idle: world.initResource(AnimationClips).add(b.idle, `${tag}-idle`),
    material: world.initResource(Materials).add(material, `${tag}-material`),
  }
}

export interface SpawnedBiped {
  root: Entity
  /** The joint entity at a path relative to the root. */
  joint(path: string): Entity
}

/**
 * Spawns a biped at `translation` (its root, with the skeleton and skinned mesh under it). Add an
 * AnimationPlayer to `root` to animate it.
 */
export function spawnBiped(
  world: World,
  b: Biped,
  assets: BipedAssets,
  translation: [number, number, number],
  yawDegrees = 0,
  name = 'biped',
): SpawnedBiped {
  const id = `${name}-${Math.random().toString(36).slice(2)}`
  const { entities } = loadScene(
    world,
    {
      version: 1,
      entities: [
        {
          name,
          components: { 'core/Transform': { translation, rotationEuler: [0, yawDegrees, 0] } },
          children: [b.skeleton],
        },
      ],
    },
    { id },
  )
  const root = entities.get(name)!
  const joint = (path: string) => findEntityByPath(world, `${id}:${name}/${path}`)!
  world.spawn(
    [Mesh3d, { mesh: assets.mesh as never }],
    [MeshMaterial, { material: assets.material as never }],
    [SkinnedMesh, { skin: assets.skin as never, joints: b.joints.map(joint) }],
    [ChildOf, { parent: root }],
  )
  return { root, joint }
}

function sub3(a: number[], b: number[]): number[] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!]
}

function cross3(a: number[], b: number[]): number[] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!,
  ]
}

function normalize3(a: number[]): number[] {
  const l = Math.hypot(a[0]!, a[1]!, a[2]!) || 1
  return [a[0]! / l, a[1]! / l, a[2]! / l]
}

function conj(q: number[]): number[] {
  return [-q[0]!, -q[1]!, -q[2]!, q[3]!]
}

function rotate3(q: number[], v: number[]): number[] {
  const r = quatMul(quatMul(q, [v[0]!, v[1]!, v[2]!, 0]), conj(q))
  return [r[0]!, r[1]!, r[2]!]
}

function fromTo3(a: number[], b: number[]): number[] {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!
  if (d < -0.99999) return [1, 0, 0, 0]
  const c = cross3(a, b)
  const q = [c[0]!, c[1]!, c[2]!, 1 + d]
  const l = Math.hypot(...q)
  return q.map((x) => x / l)
}

function translation4(t: number[]): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, t[0]!, t[1]!, t[2]!, 1]
}
