import {
  AnimationPlayer,
  AnimationSampling,
  createFlatPose,
  type FlatPose,
  Retarget,
} from '@aethervtt/shard-animation'
import {
  type AssetRef,
  type ComponentDef,
  type ComponentInit,
  defineResource,
  type Entity,
  findComponent,
  type JsonValue,
  type SchemaContext,
  ShardError,
  type World,
} from '@aethervtt/shard-core'
import { Instances, Meshes, SkinPose, Skins, Visibility } from '@aethervtt/shard-render'
import { LogResource } from '@aethervtt/shard-runtime'
import { SceneAssets, type SceneEntity, worldSchemaContext } from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import {
  Character,
  CharacterPart,
  CharacterTier,
  NO_LOOK,
  OFF,
  TIERS,
  type Tier,
} from './components'
import {
  addRadii,
  buildIndex,
  type CharacterRig,
  CharacterRigs,
  type MergedBody,
  mergedBody,
  minTierOf,
  type PartSource,
  refFromPath,
} from './rig'
import type { RigInstance } from './rigs'

/** One skinned node of a model, as its scene asset describes it. */
export interface CharacterPartSource extends PartSource {
  /** The model it came from (a Scene asset), for errors and describe. */
  model: AssetRef<'Scene'>
}

export interface PartsOptions {
  /** Part names to leave out (regions a worn item hides). */
  hide?: readonly string[]
}

/** A loaded model's skinned nodes, by name: what a character can wear. Cold path. */
export function partsOf(
  world: World,
  model: AssetRef<'Scene'>,
  options: PartsOptions = {},
): CharacterPartSource[] {
  const scene = world.resource(SceneAssets).get(model)
  if (!scene) {
    throw new ShardError('characters/unknown-rig', `Model ${model.path ?? model.guid} isn't loaded`)
  }
  const out: CharacterPartSource[] = []
  const hide = new Set(options.hide ?? [])
  const walk = (list: SceneEntity[]) => {
    for (const e of list) {
      const c = e.components
      if (c?.['render/Mesh3d'] && c['render/SkinnedMesh'] && !hide.has(e.name)) {
        out.push({
          name: e.name,
          components: c as Record<string, Record<string, JsonValue>>,
          model,
        })
      }
      if (e.children) walk(e.children)
    }
  }
  walk(scene.entities)
  return out
}

export interface SpawnCharacterOptions {
  /** A build of the rig, by name or index (default 0, the plain skeleton). */
  build?: string | number
  parts: readonly CharacterPartSource[]
  /** Free morph weights by name (the rig's shapes); the build adds its own. */
  morphs?: Readonly<Record<string, number>>
  transform?: {
    translation?: readonly number[]
    rotation?: readonly number[]
    scale?: readonly number[]
  }
  /** Keep it near (a player). */
  pin?: boolean
  /** The registered look it comes from (Character.look), so a replicated copy can compose it. */
  look?: number
  /** Compose onto this entity (a replicated root) instead of spawning one: adds what it lacks. */
  root?: Entity
}

/** What the tier systems keep per character. Internal. */
export interface CharacterState {
  entity: Entity
  rig: CharacterRig
  build: number
  parts: Entity[]
  /** Per part: its minTier index, and whether far draws the merged body instead. */
  partMin: Uint8Array
  partMerged: Uint8Array
  merged: Entity | null
  mergedInfo: MergedBody | null
  pose: FlatPose
  /** Per joint radii over this character's parts (bounds). */
  radii: Float32Array
  /** Persistent ranges in the deform store (vec4 indices), -1 when not held. */
  poseBase: number
  header: number
  morphBase: number
  morphCount: number
  /** Model-space sphere of the last sample. */
  sphere: Float32Array
  tier: number
  /** Time of the last tier change (s). */
  since: number
  /** Mid resample stagger. */
  phase: number
  /** Frames until the next mid sample. */
  wait: number
  rigInstance: RigInstance | null
  /** IK fade: 1 = full IK; leaving near waits for 0. */
  ik: number
  /** Selections in a row that began with the fade at 0. */
  ikIdle: number
  /** IK components on the root and its non-part children, and their own weights. */
  ikEntities: Entity[]
  ikDefs: ComponentDef[]
  ikBase: number[]
  simTier: number
  /** The NavTier last written (-1: none). */
  navTier: number
  pinned: boolean
  /** Entered near this frame: parts draw the flat pose until the player has sampled the rig. */
  joining: boolean
  /** Far playback: what the header shows, to rewrite only on change. */
  farClipA: number
  farClipB: number
  farKey: number
  morphWeights: number[]
}

export const CharacterStates = defineResource<Map<Entity, CharacterState>>('characters/States', {
  description:
    'Per character: rig, build, parts, pose and deform ranges, tier bookkeeping. Internal.',
  init: () => new Map(),
})

const IDENTITY_T = [0, 0, 0]
const IDENTITY_R = [0, 0, 0, 1]
const IDENTITY_S = [1, 1, 1]

/** The part components a character takes from its model's node (as decoded values). */
const PART_COMPONENTS = ['render/Mesh3d', 'render/MeshMaterial', 'render/Lod', 'render/SkinnedMesh']

/**
 * Spawns a character: a root (Character, CharacterTier, AnimationPlayer) and one child per part,
 * with no joint entities. Tier selection gives it a representation from the next selection on.
 */
export function spawnCharacter(
  world: World,
  rigName: string | CharacterRig,
  options: SpawnCharacterOptions,
): Entity {
  const rig =
    typeof rigName === 'string'
      ? world.resource(CharacterRigs).get(rigName)
      : (rigName as CharacterRig)
  if (!rig) {
    throw new ShardError('characters/unknown-rig', `No character rig "${String(rigName)}"`, {
      hint: 'Create it with createCharacterRig first.',
    })
  }
  const build = buildIndex(rig, options.build)
  const morphWeights = characterMorphs(world, rig, build, options.morphs)
  const t = options.transform ?? {}
  const inits: ComponentInit[] = [
    [
      Transform,
      {
        translation: [...(t.translation ?? IDENTITY_T)],
        rotation: [...(t.rotation ?? IDENTITY_R)],
        scale: [...(t.scale ?? IDENTITY_S)],
      },
    ],
    [Character, { rig: rig.name, build, look: options.look ?? NO_LOOK }],
    [CharacterTier, { tier: 'off', pin: options.pin ?? false }],
    [AnimationPlayer, { layers: [] }],
    [AnimationSampling, { mode: 'none' }],
  ]
  const r = rig.options.retarget
  if (r) {
    inits.push([
      Retarget,
      {
        source: r.source,
        map: r.map ?? null,
        mode: r.mode ?? 'rotation-and-root',
        align: r.align ?? true,
      },
    ])
  }
  let root: Entity
  if (options.root === undefined) root = world.spawn(...(inits as [ComponentInit]))
  else {
    root = options.root
    for (const init of inits) {
      const [def, value] = init as readonly [ComponentDef, Record<string, unknown>]
      if (!world.has(root, def)) world.add(root, def, value as never)
    }
  }

  const ctx = worldSchemaContext(world)
  // Headless (no renderer): a character is its root; parts are what clients draw.
  const meshes = world.tryResource(Meshes)
  const radii = rig.radii.slice()
  const parts: Entity[] = []
  const partMin: number[] = []
  const partMerged: number[] = []
  const merged =
    rig.merged === null ? null : mergedBody(world, rig, partsOf(world, rig.options.model))
  for (const part of options.parts) {
    const values: ComponentInit[] = []
    for (const name of PART_COMPONENTS) {
      const json = part.components[name]
      if (!json) continue
      const def = findComponent(name) as ComponentDef
      values.push([def, fromJson(def, json as Record<string, unknown>, ctx)])
    }
    checkSkin(world, rig, part)
    const mesh3d = part.components['render/Mesh3d'] as { mesh?: { path?: string } }
    const mesh = mesh3d.mesh?.path
      ? meshes?.get(refFromPath('Mesh', mesh3d.mesh.path, world))
      : undefined
    if (mesh) addRadii(radii, mesh, rig.skin)
    const minTier = minTierOf(rig, part.name)
    const entity = world.spawn(
      [Transform, { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
      [Visibility, { mode: 'hidden' }],
      [CharacterPart, { name: part.name, minTier }],
      [SkinPose, { source: 'pose' }],
      ...(values as [ComponentInit]),
    )
    if (mesh?.targets?.length) setMorphs(world, entity, mesh.targets.length, morphWeights)
    parts.push(entity)
    partMin.push(TIERS.indexOf(minTier))
    partMerged.push(merged?.patterns.some((re) => re.test(part.name)) ? 1 : 0)
  }
  let mergedEntity: Entity | null = null
  if (merged && partMerged.includes(1)) {
    const levels = merged.levels.map((mesh, k) => ({ mesh, screenSize: merged.screenSizes[k]! }))
    mergedEntity = world.spawn(
      [Transform, { translation: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] }],
      [Visibility, { mode: 'hidden' }],
      [CharacterPart, { name: 'far-body', minTier: 'off', merged: true }],
      [SkinPose, { source: 'baked' }],
      [findComponent('render/Mesh3d')!, { mesh: merged.levels[0]! }],
      [findComponent('render/Lod')!, { levels }],
      [findComponent('render/SkinnedMesh')!, { skin: rig.skinRef }],
      ...(merged.material
        ? [[findComponent('render/MeshMaterial')!, { material: merged.material }] as ComponentInit]
        : []),
    )
    const mergedMesh = meshes?.get(merged.levels[0]!)
    if (mergedMesh?.targets?.length)
      setMorphs(world, mergedEntity, mergedMesh.targets.length, morphWeights)
  }
  const state: CharacterState = {
    entity: root,
    rig,
    build,
    parts,
    partMin: Uint8Array.from(partMin),
    partMerged: Uint8Array.from(partMerged),
    merged: mergedEntity,
    mergedInfo: merged,
    pose: createFlatPose(rig.skeleton, rig.builds[build]!.rest),
    radii,
    poseBase: -1,
    header: -1,
    morphBase: -1,
    morphCount: 0,
    sphere: new Float32Array(4),
    tier: OFF,
    since: Number.NEGATIVE_INFINITY,
    phase: root & 3,
    wait: 0,
    rigInstance: null,
    ik: 0,
    ikIdle: 0,
    ikEntities: [],
    ikDefs: [],
    ikBase: [],
    simTier: 2,
    navTier: -1,
    pinned: options.pin ?? false,
    joining: false,
    farClipA: -1,
    farClipB: -1,
    farKey: Number.NaN,
    morphWeights,
  }
  packMorphs(world, state)
  world.resource(CharacterStates).set(root, state)
  return root
}

/** A component's value from its scene JSON (handles resolved through the world's assets). */
function fromJson(
  def: ComponentDef,
  json: Record<string, unknown>,
  ctx: SchemaContext,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const name in def.fields) {
    const field = def.fields[name]!
    out[name] = json[name] === undefined ? field.defaultValue() : field.fromJson(json[name], ctx)
  }
  return out
}

function setMorphs(world: World, entity: Entity, targets: number, weights: number[]): void {
  const def = findComponent('render/MorphWeights')!
  const list = new Array<number>(targets).fill(0)
  for (let k = 0; k < targets && k < weights.length; k++) list[k] = weights[k]!
  world.add(entity, def, { weights: list })
}

/** The character's morph weights in the rig's shape order: its build's, then its free ones. */
function characterMorphs(
  world: World,
  rig: CharacterRig,
  build: number,
  free: Readonly<Record<string, number>> | undefined,
): number[] {
  const names = rig.options.shapes?.morphs ?? []
  const out = new Array<number>(names.length).fill(0)
  for (const [name, w] of rig.builds[build]!.morphs) {
    const i = names.indexOf(name)
    if (i >= 0) out[i] = w
  }
  for (const [name, w] of Object.entries(free ?? {})) {
    const i = names.indexOf(name)
    if (i < 0) {
      throw new ShardError('characters/unknown-build', `Rig "${rig.name}" has no morph "${name}"`)
    }
    if (rig.movesJoints.has(name)) {
      world
        .tryResource(LogResource)
        ?.log('warn', `Morph "${name}" moves joints: set it through a build`, {
          code: 'characters/morph-moves-joints',
          hint: `Add a build with { "morphs": { "${name}": ${w} } } to the rig, and spawn with that build.`,
        })
      continue
    }
    out[i] = w
  }
  return out
}

/** The 8 heaviest morph weights, packed once into a persistent block every part points at. */
function packMorphs(world: World, s: CharacterState): void {
  const store = world.tryResource(Instances)?.deform
  if (!store) return
  const w = s.morphWeights
  const order = w.map((_, i) => i).filter((i) => Math.abs(w[i]!) >= 1e-5)
  order.sort((a, b) => Math.abs(w[b]!) - Math.abs(w[a]!))
  const active = Math.min(8, order.length)
  s.morphCount = active
  if (active === 0) return
  s.morphBase = store.allocPersistent(4)
  const poses = store.poses
  for (let k = 0; k < 8; k++) {
    poses[s.morphBase * 4 + k * 2] = k < active ? order[k]! : 0
    poses[s.morphBase * 4 + k * 2 + 1] = k < active ? w[order[k]!]! : 0
  }
  store.markPersistent(s.morphBase, 4)
}

function checkSkin(world: World, rig: CharacterRig, part: CharacterPartSource): void {
  const s = part.components['render/SkinnedMesh'] as { skin?: { path?: string } }
  const path = s.skin?.path
  const ref = path ? refFromPath('Skin', path, world) : undefined
  if (ref?.guid === rig.skinRef.guid) return
  const skins = world.tryResource(Skins)
  const skin = ref ? skins?.get(ref) : undefined
  const ok =
    skin !== undefined &&
    skin.joints.length === rig.skin.joints.length &&
    skin.joints.every(
      (p, j) =>
        p.slice(p.lastIndexOf('/') + 1) ===
        rig.skin.joints[j]!.slice(rig.skin.joints[j]!.lastIndexOf('/') + 1),
    ) &&
    skin.inverseBindMatrices.every((v, k) => Math.abs(v - rig.skin.inverseBindMatrices[k]!) <= 1e-4)
  if (!ok) {
    throw new ShardError(
      'characters/skeleton-mismatch',
      `Part "${part.name}" isn't skinned to rig "${rig.name}"'s skeleton`,
      {
        hint: 'Parts need the same joint names, in order, and the same inverse bind matrices (within 1e-4).',
      },
    )
  }
}

/** Frees a character's deform ranges and pooled rig (its entity is going away). */
export function forgetCharacter(
  world: World,
  entity: Entity,
  release: (s: CharacterState) => void,
): void {
  const states = world.tryResource(CharacterStates)
  const s = states?.get(entity)
  if (!s) return
  release(s)
  // Parts aren't children of the root (they'd be propagated hidden or not): they go with it.
  for (const part of s.parts) if (world.isAlive(part)) world.despawn(part)
  if (s.merged !== null && world.isAlive(s.merged)) world.despawn(s.merged)
  const store = world.tryResource(Instances)?.deform
  if (store && s.morphBase >= 0) store.freePersistent(s.morphBase, 4)
  states!.delete(entity)
}

export type { Tier }
