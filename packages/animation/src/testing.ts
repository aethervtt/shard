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
