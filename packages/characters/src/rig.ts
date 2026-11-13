import {
  type AnimationClipAsset,
  AnimationClips,
  bakeClip,
  type FlatSkeleton,
  type JointMapAsset,
  JointMaps,
  type RETARGET_MODES,
} from '@aethervtt/shard-animation'
import { assetServer } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  affine,
  defineResource,
  type JsonValue,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { Mesh } from '@aethervtt/shard-mesh'
import { Instances, Meshes, type SkinAsset, Skins } from '@aethervtt/shard-render'
import { SceneAssets, type SceneEntity } from '@aethervtt/shard-scene'
import { TIERS, type Tier } from './components'

/** Morph targets with joint offsets, in Risen's `body.json` form (MakeHuman builds). */
export interface ShapeTable {
  /** Morph names in the meshes' target order. */
  morphs: string[]
  /** Per morph, per joint name: metres added to its rest translation, in its parent's frame. */
  bones?: Record<string, Record<string, readonly number[]>>
  /** Per morph: metres the skeleton's top joint rises (model up), times the weight. */
  pelvisLift?: Record<string, number>
}

export interface BuildOptions {
  name: string
  /** Weights of joint-moving morphs (shapes.bones) this build bakes. */
  morphs?: Record<string, number>
}

export interface CharacterRigOptions {
  name: string
  /** The model whose skin is the skeleton (a glTF's Scene asset), already loaded. */
  model: AssetRef<'Scene'>
  shapes?: ShapeTable
  builds?: BuildOptions[]
  /** Clips by name; `far.clips` are baked. */
  clips?: Record<string, AssetRef<'AnimationClip'>>
  /** Clips authored on another skeleton, as Retarget plays them (0034). */
  retarget?: {
    source: AssetRef<'Skin'>
    map?: AssetRef<'JointMap'>
    mode?: (typeof RETARGET_MODES)[number]
    align?: boolean
  }
  bakeFps?: number
  near?: { screen?: number }
  mid?: { screen?: number; rates?: [number, number] }
  far?: {
    screen?: number
    distance?: number
    shadows?: boolean
    /** Part names (`*` wildcards) drawn at far as one merged mesh. */
    merge?: string[]
    clips?: string[]
    /**
     * Bake with the root's ground travel and yaw taken out, for clips that travel (play them
     * with root motion at near). Off: as authored, which is what mid samples without root motion.
     */
    pin?: boolean
  }
  /** Per part name: the coarsest tier that draws it. */
  parts?: Record<string, { minTier?: Tier }>
}

/** A node on the way to a joint: what a rig spawns. */
export interface RigNode {
  name: string
  /** Path relative to the character root. */
  path: string
  /** Index of the parent rig node, or -1 (a child of the character root). */
  parent: number
  /** Joint index, or -1 for a node that isn't a joint. */
  joint: number
  /** Local rest TRS (10 floats: t, r, s). */
  trs: Float32Array
}

export interface BakedClip {
  name: string
  /** vec4 index of frame 0 in the deform store's poses. */
  base: number
  frames: number
  duration: number
}

export interface BuildBake {
  clips: BakedClip[]
  /** First vec4 and size of the whole bake in the persistent region. */
  base: number
  vec4s: number
  /** Model-space sphere around every baked frame (xyz, r). */
  sphere: Float32Array
}

export interface Build {
  name: string
  /** Weight per morph name (joint-moving morphs). */
  morphs: Map<string, number>
  /** 10 floats per joint: the rest pose with this build's offsets. */
  rest: Float32Array
  bake: BuildBake | undefined
}

export interface MergedBody {
  /** Mesh per level, most detailed first. */
  levels: AssetRef<'Mesh'>[]
  screenSizes: number[]
  material: AssetRef<'Material'> | null
  /** Patterns of the parts it stands for. */
  patterns: RegExp[]
}

export interface CharacterRig {
  name: string
  options: CharacterRigOptions
  skin: SkinAsset
  skinRef: AssetRef<'Skin'>
  skeleton: FlatSkeleton
  /** Joint indices by joint name (last path segment). */
  jointByName: Map<string, number>
  nodes: RigNode[]
  builds: Build[]
  /** Morphs with joint offsets: they come from builds, not per character. */
  movesJoints: Set<string>
  /** Per joint: the farthest vertex it mainly moves over the model's parts, or -1. */
  radii: Float32Array
  nearScreen: number
  midScreen: number
  midRates: [number, number]
  farScreen: number
  farDistance: number
  farShadows: boolean
  farClips: string[]
  bakeFps: number
  merged: MergedBody | undefined | null
  minTier: Map<string, Tier>
  /** The model's scene, for partsOf. */
  scene: SceneEntity[]
  /** Model-space sphere around the rest pose (before a character's first sample). */
  restSphere: Float32Array
  /** Baked clip index by clip guid (-1: not baked). */
  clipIndex: Map<string, number>
}

export const CharacterRigs = defineResource<Map<string, CharacterRig>>('characters/Rigs', {
  description: 'Character rigs by name: skeleton, builds, bakes, merged far body (0115).',
  init: () => new Map(),
})

const TRANSFORM = 'core/Transform'

function trsOf(e: SceneEntity): Float32Array {
  const t = (e.components?.[TRANSFORM] ?? {}) as Record<string, number[] | undefined>
  const out = new Float32Array(10)
  out.set(t.translation ?? [0, 0, 0], 0)
  out.set(t.rotation ?? [0, 0, 0, 1], 3)
  out.set(t.scale ?? [1, 1, 1], 7)
  return out
}

function skinRefOf(e: SceneEntity): string | undefined {
  const s = e.components?.['render/SkinnedMesh'] as { skin?: { path?: string } } | undefined
  return s?.skin?.path
}

function firstSkin(entities: SceneEntity[]): string | undefined {
  for (const e of entities) {
    const found = skinRefOf(e) ?? (e.children ? firstSkin(e.children) : undefined)
    if (found) return found
  }
  return undefined
}

/** A handle from a scene's `{ path }` JSON, resolved to the loaded asset's guid. */
export function refFromPath<K extends string>(type: K, path: string, world: World): AssetRef<K> {
  const entry = assetServer(world).entry({ path })
  return { type, guid: entry?.guid, path }
}

/**
 * Builds a rig from a loaded skinned model: its skeleton, builds, part rules and (with a renderer)
 * the bakes of its far clips. Cold path.
 */
export function createCharacterRig(world: World, options: CharacterRigOptions): CharacterRig {
  const scene = world.resource(SceneAssets).get(options.model)
  if (!scene) {
    throw new ShardError(
      'characters/unknown-rig',
      `Rig "${options.name}": its model isn't loaded`,
      {
        hint: 'Load the model (assets.load) before createCharacterRig.',
      },
    )
  }
  const skinPath = firstSkin(scene.entities)
  const skinRef = skinPath ? refFromPath('Skin', skinPath, world) : undefined
  const skin = skinRef ? world.tryResource(Skins)?.get(skinRef) : undefined
  if (!skin || !skinRef) {
    throw new ShardError(
      'characters/unknown-rig',
      `Rig "${options.name}": the model has no loaded skin`,
    )
  }
  const count = skin.joints.length
  const jointIndex = new Map<string, number>()
  for (let j = 0; j < count; j++) jointIndex.set(skin.joints[j]!, j)

  // Nodes on the way to each joint, depth-first, parents first.
  const nodes: RigNode[] = []
  const nodeOfJoint = new Int32Array(count).fill(-1)
  const visit = (entities: SceneEntity[], prefix: string, parent: number) => {
    for (const e of entities) {
      const path = prefix ? `${prefix}/${e.name}` : e.name
      let leadsToJoint = false
      for (const p of skin.joints) if (p === path || p.startsWith(`${path}/`)) leadsToJoint = true
      if (!leadsToJoint) continue
      const joint = jointIndex.get(path) ?? -1
      const index = nodes.length
      nodes.push({ name: e.name, path, parent, joint, trs: trsOf(e) })
      if (joint >= 0) nodeOfJoint[joint] = index
      if (e.children) visit(e.children, path, index)
    }
  }
  visit(scene.entities, '', -1)
  for (let j = 0; j < count; j++) {
    if (nodeOfJoint[j]! < 0) {
      throw new ShardError(
        'characters/skeleton-mismatch',
        `Rig "${options.name}": joint ${skin.joints[j]} isn't in the model's node tree`,
      )
    }
  }

  // Parents by joint; `pre` holds the non-joint ancestors of top joints.
  const parents = new Int16Array(count)
  const pre = new Float32Array(count * 12)
  const scratch = new Float32Array(12)
  for (let j = 0; j < count; j++) {
    affine.identityAt(pre, j * 12)
    let n = nodes[nodeOfJoint[j]!]!.parent
    while (n >= 0 && nodes[n]!.joint < 0) n = nodes[n]!.parent
    parents[j] = n < 0 ? -1 : nodes[n]!.joint
    if (parents[j]! >= 0) continue
    // Compose every non-joint ancestor, outermost first.
    const chain: number[] = []
    for (let a = nodes[nodeOfJoint[j]!]!.parent; a >= 0; a = nodes[a]!.parent) chain.unshift(a)
    for (const a of chain) {
      const trs = nodes[a]!.trs
      affine.fromTRSAt(scratch, 0, trs, 0, trs, 3, trs, 7)
      affine.multiplyAt(pre, j * 12, pre, j * 12, scratch, 0)
    }
  }
  const skeleton: FlatSkeleton = {
    paths: skin.joints,
    parents,
    pre,
    inverseBind: skin.inverseBindMatrices,
  }
  const jointByName = new Map<string, number>()
  for (let j = 0; j < count; j++) {
    const p = skin.joints[j]!
    jointByName.set(p.slice(p.lastIndexOf('/') + 1), j)
  }
  const restBase = new Float32Array(count * 10)
  for (let j = 0; j < count; j++) restBase.set(nodes[nodeOfJoint[j]!]!.trs, j * 10)

  const movesJoints = new Set<string>()
  const shapes = options.shapes
  for (const [morph, bones] of Object.entries(shapes?.bones ?? {})) {
    if (Object.keys(bones).length > 0 || (shapes?.pelvisLift?.[morph] ?? 0) !== 0)
      movesJoints.add(morph)
  }
  const rig: CharacterRig = {
    name: options.name,
    options,
    skin,
    skinRef,
    skeleton,
    jointByName,
    nodes,
    builds: [],
    movesJoints,
    radii: jointRadiiOf(world, scene.entities, skin),
    nearScreen: options.near?.screen ?? 0.15,
    midScreen: options.mid?.screen ?? 0.02,
    midRates: options.mid?.rates ?? [0.08, 0.04],
    farScreen: options.far?.screen ?? 0.002,
    farDistance: options.far?.distance ?? 600,
    farShadows: options.far?.shadows ?? true,
    farClips: options.far?.clips ?? Object.keys(options.clips ?? {}),
    bakeFps: options.bakeFps ?? 30,
    merged: options.far?.merge?.length ? undefined : null,
    minTier: new Map(
      Object.entries(options.parts ?? {}).map(([name, p]) => [name, p.minTier ?? 'off'] as const),
    ),
    scene: scene.entities,
    restSphere: new Float32Array(4),
    clipIndex: new Map(),
  }
  restSphereOf(rig, restBase)
  const buildList = [{ name: 'default' }, ...(options.builds ?? [])]
  for (const b of buildList) rig.builds.push(makeBuild(rig, b, restBase))
  world.resource(CharacterRigs).set(rig.name, rig)
  return rig
}

function makeBuild(rig: CharacterRig, b: BuildOptions, restBase: Float32Array): Build {
  const rest = restBase.slice()
  const morphs = new Map<string, number>()
  const shapes = rig.options.shapes
  let lift = 0
  for (const [morph, weight] of Object.entries(b.morphs ?? {})) {
    if (shapes && !shapes.morphs.includes(morph)) {
      throw new ShardError(
        'characters/unknown-build',
        `Build "${b.name}" names morph "${morph}", which shapes lack`,
      )
    }
    morphs.set(morph, weight)
    for (const [joint, offset] of Object.entries(shapes?.bones?.[morph] ?? {})) {
      const j = rig.jointByName.get(joint)
      if (j === undefined) continue
      for (let k = 0; k < 3; k++) rest[j * 10 + k] = rest[j * 10 + k]! + weight * offset[k]!
    }
    lift += weight * (shapes?.pelvisLift?.[morph] ?? 0)
  }
  if (lift !== 0) {
    // Up in model space, into each top joint's parent frame (its non-joint ancestors, `pre`).
    const { parents, pre } = rig.skeleton
    for (let j = 0; j < parents.length; j++) {
      if (parents[j] !== -1) continue
      const o = j * 12
      // Solve pre3x3 · d = (0, lift, 0) by the inverse of the 3x3 block (cofactors).
      const a = pre[o]!
      const bb = pre[o + 1]!
      const c = pre[o + 2]!
      const d = pre[o + 4]!
      const e = pre[o + 5]!
      const f = pre[o + 6]!
      const g = pre[o + 8]!
      const h = pre[o + 9]!
      const i = pre[o + 10]!
      const det = a * (e * i - f * h) - bb * (d * i - f * g) + c * (d * h - e * g)
      if (Math.abs(det) < 1e-12) continue
      rest[j * 10] = rest[j * 10]! + (-(bb * i - c * h) * lift) / det
      rest[j * 10 + 1] = rest[j * 10 + 1]! + ((a * i - c * g) * lift) / det
      rest[j * 10 + 2] = rest[j * 10 + 2]! + (-(a * h - bb * g) * lift) / det
    }
  }
  return { name: b.name, morphs, rest, bake: undefined }
}

/** The sphere around the rest pose's joints, padded by their radii. */
function restSphereOf(rig: CharacterRig, rest: Float32Array): void {
  const { parents, pre } = rig.skeleton
  const count = parents.length
  const model = new Float32Array(count * 12)
  const local = new Float32Array(12)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (let j = 0; j < count; j++) {
    affine.fromTRSAt(local, 0, rest, j * 10, rest, j * 10 + 3, rest, j * 10 + 7)
    const p = parents[j]!
    if (p < 0) affine.multiplyAt(model, j * 12, pre, j * 12, local, 0)
    else affine.multiplyAt(model, j * 12, model, p * 12, local, 0)
    const r = Math.max(0, rig.radii[j]!)
    const x = model[j * 12 + 3]!
    const y = model[j * 12 + 7]!
    const z = model[j * 12 + 11]!
    minX = Math.min(minX, x - r)
    minY = Math.min(minY, y - r)
    minZ = Math.min(minZ, z - r)
    maxX = Math.max(maxX, x + r)
    maxY = Math.max(maxY, y + r)
    maxZ = Math.max(maxZ, z + r)
  }
  const s = rig.restSphere
  s[0] = (minX + maxX) / 2
  s[1] = (minY + maxY) / 2
  s[2] = (minZ + maxZ) / 2
  s[3] = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2
}

/** The build index by name. */
export function buildIndex(rig: CharacterRig, build: string | number | undefined): number {
  if (build === undefined) return 0
  if (typeof build === 'number') {
    if (build >= 0 && build < rig.builds.length) return build
  } else {
    const i = rig.builds.findIndex((b) => b.name === build)
    if (i >= 0) return i
  }
  throw new ShardError(
    'characters/unknown-build',
    `Rig "${rig.name}" has no build ${JSON.stringify(build)}`,
    {
      hint: `Builds: ${rig.builds.map((b) => b.name).join(', ')}`,
    },
  )
}

/** Per joint, the farthest vertex of the model's skinned parts it mainly moves (joint space). */
function jointRadiiOf(world: World, entities: SceneEntity[], skin: SkinAsset): Float32Array {
  const radii = new Float32Array(skin.joints.length).fill(-1)
  // Headless (no renderer): no meshes, and nothing draws, so no bounds to pad.
  const meshes = world.tryResource(Meshes)
  if (!meshes) return radii
  const walk = (list: SceneEntity[]) => {
    for (const e of list) {
      const m = e.components?.['render/Mesh3d'] as { mesh?: { path?: string } } | undefined
      if (m?.mesh?.path && skinRefOf(e)) {
        const mesh = meshes.get(refFromPath('Mesh', m.mesh.path, world))
        if (mesh) addRadii(radii, mesh, skin)
      }
      if (e.children) walk(e.children)
    }
  }
  walk(entities)
  return radii
}

/** Widens per-joint radii by a mesh's vertices. Cold path. */
export function addRadii(radii: Float32Array, mesh: Mesh, skin: SkinAsset): void {
  const joints = mesh.joints
  const weights = mesh.weights
  if (!joints || !weights) return
  const p = mesh.positions
  const ibm = skin.inverseBindMatrices
  for (let v = 0; v < mesh.vertexCount; v++) {
    let main = 0
    for (let k = 1; k < 4; k++) if (weights[v * 4 + k]! > weights[v * 4 + main]!) main = k
    const j = joints[v * 4 + main]!
    if (j >= radii.length) continue
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
}

/**
 * The build's bake: every far clip baked by the flat sampler into the deform store's persistent
 * region, once. Undefined without a renderer or clips. Cold path.
 */
export function ensureBake(world: World, rig: CharacterRig, build: number): BuildBake | undefined {
  const b = rig.builds[build]!
  if (b.bake) return b.bake
  const store = world.tryResource(Instances)?.deform
  if (!store || rig.farClips.length === 0) return undefined
  const clips = world.resource(AnimationClips)
  const retarget = retargetOf(world, rig)
  const baked: { name: string; clip: AnimationClipAsset; frames: number; rows: Float32Array }[] = []
  const sphere = new Float32Array(4)
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let minZ = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  let maxZ = Number.NEGATIVE_INFINITY
  for (const name of rig.farClips) {
    const ref = rig.options.clips?.[name]
    const clip = ref ? clips.get(ref) : undefined
    if (!clip) {
      throw new ShardError(
        'characters/unknown-rig',
        `Rig "${rig.name}": far clip "${name}" isn't loaded`,
      )
    }
    const result = bakeClip(
      world,
      rig.skeleton,
      b.rest,
      clip,
      rig.bakeFps,
      retarget,
      rig.radii,
      rig.options.far?.pin ?? false,
    )
    baked.push({ name, clip, frames: result.frames, rows: result.rows })
    const s = result.sphere
    minX = Math.min(minX, s[0]! - s[3]!)
    minY = Math.min(minY, s[1]! - s[3]!)
    minZ = Math.min(minZ, s[2]! - s[3]!)
    maxX = Math.max(maxX, s[0]! + s[3]!)
    maxY = Math.max(maxY, s[1]! + s[3]!)
    maxZ = Math.max(maxZ, s[2]! + s[3]!)
  }
  const joints = rig.skeleton.paths.length
  let vec4s = 0
  for (const c of baked) vec4s += c.frames * joints * 3
  const base = store.allocPersistent(vec4s)
  const out: BakedClip[] = []
  let at = base
  for (const c of baked) {
    store.poses.set(c.rows, at * 4)
    out.push({ name: c.name, base: at, frames: c.frames, duration: c.clip.duration })
    at += c.frames * joints * 3
  }
  store.markPersistent(base, vec4s)
  sphere[0] = (minX + maxX) / 2
  sphere[1] = (minY + maxY) / 2
  sphere[2] = (minZ + maxZ) / 2
  // Margin for parts (worn items) the rig's model doesn't have.
  sphere[3] = Math.sqrt((maxX - minX) ** 2 + (maxY - minY) ** 2 + (maxZ - minZ) ** 2) / 2 + 0.15
  b.bake = { clips: out, base, vec4s, sphere }
  return b.bake
}

/** The rig's retargeting, resolved (undefined while its assets aren't loaded). */
export function retargetOf(world: World, rig: CharacterRig) {
  const r = rig.options.retarget
  if (!r) return undefined
  const skin = world.tryResource(Skins)?.get(r.source)
  if (!skin) return undefined
  const map: JointMapAsset | undefined = r.map
    ? world.tryResource(JointMaps)?.get(r.map)
    : undefined
  return { skin, map, mode: r.mode ?? 'rotation-and-root', align: r.align ?? true }
}

/** Bytes every build's bake holds (for describe). */
export function bakeBytes(rig: CharacterRig): number {
  let n = 0
  for (const b of rig.builds) n += (b.bake?.vec4s ?? 0) * 16
  return n
}

// --- far merge -------------------------------------------------------------------------------

function pattern(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`)
}

export interface PartSource {
  name: string
  components: Record<string, Record<string, JsonValue>>
}

/**
 * The rig's merged far body: the `far.merge` parts of its model concatenated level by level, so a
 * far character draws them as one slot. Null when the rig merges nothing. Cold path, once.
 */
export function mergedBody(
  world: World,
  rig: CharacterRig,
  parts: PartSource[],
): MergedBody | null {
  if (rig.merged !== undefined) return rig.merged
  const patterns = (rig.options.far?.merge ?? []).map(pattern)
  const chosen = parts.filter((p) => patterns.some((re) => re.test(p.name)))
  if (chosen.length === 0) {
    rig.merged = null
    return null
  }
  const meshes = world.resource(Meshes)
  let material: AssetRef<'Material'> | null = null
  const levelsOf: Mesh[][] = []
  const sizesOf: number[][] = []
  const diameters: number[] = []
  for (const p of chosen) {
    const mat = (
      p.components['render/MeshMaterial'] as { material?: { path?: string } } | undefined
    )?.material?.path
    const ref = mat ? (refFromPath('Material', mat, world) as AssetRef<'Material'>) : null
    if (levelsOf.length === 0) material = ref
    else if ((ref?.guid ?? null) !== (material?.guid ?? null)) {
      throw new ShardError(
        'characters/merge-material',
        `Rig "${rig.name}": far.merge part "${p.name}" has another material than "${chosen[0]!.name}"`,
        { hint: 'Merge only parts that share one material.' },
      )
    }
    const lod = p.components['render/Lod'] as
      | { levels?: { mesh?: { path?: string }; screenSize?: number }[] }
      | undefined
    const mesh3d = (p.components['render/Mesh3d'] as { mesh?: { path?: string } }).mesh?.path
    const entries = lod?.levels?.length ? lod.levels : [{ mesh: { path: mesh3d }, screenSize: 0 }]
    const levels: Mesh[] = []
    const sizes: number[] = []
    for (const level of entries) {
      const mesh = meshes.get(refFromPath('Mesh', level.mesh!.path!, world))
      if (!mesh)
        throw new ShardError(
          'characters/unknown-rig',
          `Rig "${rig.name}": mesh of "${p.name}" isn't loaded`,
        )
      levels.push(mesh)
      sizes.push(level.screenSize ?? 0)
    }
    levelsOf.push(levels)
    sizesOf.push(sizes)
    diameters.push(diameterOf(levels[0]!))
  }
  const levelCount = Math.max(...levelsOf.map((l) => l.length))
  const refs: AssetRef<'Mesh'>[] = []
  const screenSizes: number[] = []
  for (let k = 0; k < levelCount; k++) {
    const pick = levelsOf.map((l) => l[Math.min(k, l.length - 1)]!)
    const merged = concatMeshes(pick, rig.name)
    refs.push(meshes.add(merged, `${rig.name}/far-body/LOD${k}`))
    if (k === levelCount - 1) screenSizes.push(0)
    else {
      // A part's size scales with its diameter: take the merged body's diameter over each part's,
      // and switch only once every part would have (the largest).
      const D = k === 0 ? diameterOf(merged) : diameterOf(meshes.get(refs[0]!)!)
      let size = 0
      for (let p = 0; p < sizesOf.length; p++) {
        const s = sizesOf[p]![Math.min(k, sizesOf[p]!.length - 1)]!
        if (diameters[p]! > 0) size = Math.max(size, (s * D) / diameters[p]!)
      }
      screenSizes.push(size)
    }
  }
  for (let k = 1; k < screenSizes.length; k++) {
    if (screenSizes[k]! > screenSizes[k - 1]!) screenSizes[k] = screenSizes[k - 1]!
  }
  rig.merged = { levels: refs, screenSizes, material, patterns }
  return rig.merged
}

function diameterOf(mesh: Mesh): number {
  const b = mesh.bounds
  const dx = b[3]! - b[0]!
  const dy = b[4]! - b[1]!
  const dz = b[5]! - b[2]!
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Concatenates meshes that share vertex attributes and morph targets. */
export function concatMeshes(list: Mesh[], name: string): Mesh {
  let vertices = 0
  let indices = 0
  for (const m of list) {
    vertices += m.vertexCount
    indices += m.indices ? m.indices.length : m.vertexCount
  }
  const has = (k: 'normals' | 'uvs' | 'tangents' | 'joints' | 'weights') => list.every((m) => m[k])
  const targets = list[0]!.targets?.length ?? 0
  for (const m of list) {
    if ((m.targets?.length ?? 0) !== targets) {
      throw new ShardError(
        'characters/merge-material',
        `Rig "${name}": merged parts have different morph targets`,
      )
    }
  }
  const positions = new Float32Array(vertices * 3)
  const normals = has('normals') ? new Float32Array(vertices * 3) : undefined
  const uvs = has('uvs') ? new Float32Array(vertices * 2) : undefined
  const tangents = has('tangents') ? new Float32Array(vertices * 4) : undefined
  const joints = has('joints') ? new Uint16Array(vertices * 4) : undefined
  const weights = has('weights') ? new Float32Array(vertices * 4) : undefined
  const index = new Uint32Array(indices)
  const morphs = Array.from({ length: targets }, () => ({
    positions: new Float32Array(vertices * 3),
    normals: list.every((m) => m.targets?.every((t) => t.normals))
      ? new Float32Array(vertices * 3)
      : undefined,
    tangents: list.every((m) => m.targets?.every((t) => t.tangents))
      ? new Float32Array(vertices * 3)
      : undefined,
  }))
  let v = 0
  let i = 0
  for (const m of list) {
    const n = m.vertexCount
    positions.set(m.positions.subarray(0, n * 3), v * 3)
    normals?.set(m.normals!.subarray(0, n * 3), v * 3)
    uvs?.set(m.uvs!.subarray(0, n * 2), v * 2)
    tangents?.set(m.tangents!.subarray(0, n * 4), v * 4)
    joints?.set(m.joints!.subarray(0, n * 4), v * 4)
    weights?.set(m.weights!.subarray(0, n * 4), v * 4)
    for (let t = 0; t < targets; t++) {
      const src = m.targets![t]!
      morphs[t]!.positions.set(src.positions.subarray(0, n * 3), v * 3)
      morphs[t]!.normals?.set(src.normals!.subarray(0, n * 3), v * 3)
      morphs[t]!.tangents?.set(src.tangents!.subarray(0, n * 3), v * 3)
    }
    if (m.indices) {
      const count = m.indices.length
      for (let k = 0; k < count; k++) index[i + k] = m.indices[k]! + v
      i += count
    } else {
      for (let k = 0; k < n; k++) index[i + k] = v + k
      i += n
    }
    v += n
  }
  return Mesh.create({
    positions,
    normals,
    uvs,
    tangents,
    joints,
    weights,
    indices: index,
    targets: targets > 0 ? morphs : undefined,
  })
}

/** The coarsest tier a part draws at, by its name. */
export function minTierOf(rig: CharacterRig, part: string): Tier {
  return rig.minTier.get(part) ?? TIERS[3]
}
