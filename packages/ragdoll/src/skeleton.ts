import {
  AnimationPlayer,
  type FlatSkeleton,
  flatRest,
  flatSkeleton,
} from '@aethervtt/shard-animation'
import { Character, CharacterStates } from '@aethervtt/shard-characters'
import { Children, type Entity, type World } from '@aethervtt/shard-core'
import { findModelRoot, type SkinAsset, SkinnedMesh, Skins } from '@aethervtt/shard-render'
import { Transform } from '@aethervtt/shard-transform'

/** The skeleton a ragdoll root drives: where it is, its rest, and its joint entities if any. */
export interface SkeletonView {
  /** The entity the skeleton's model space is relative to (its AnimationPlayer's). */
  owner: Entity
  skeleton: FlatSkeleton
  rest: Float32Array
  /** Joint entities in the skin's order, or null (a character below near has none). */
  joints: Entity[] | null
  /** A Shard character (0115): tiers, claims and frozen poses apply. */
  character: boolean
}

const plain = new WeakMap<SkinAsset, { skeleton: FlatSkeleton; rest: Float32Array }>()

/** A Shard character at the root or under it (breadth first), else undefined. */
function findCharacter(world: World, root: Entity): Entity | undefined {
  const queue = [root]
  for (let i = 0; i < queue.length && i < 64; i++) {
    const e = queue[i]!
    if (world.has(e, Character)) return e
    const kids = world.tryGet(e, Children)?.entities
    if (kids) for (const k of kids) if (k !== null && world.isAlive(k)) queue.push(k)
  }
  return undefined
}

/** The first skinned mesh with a skin at the root or under it. */
function findSkinned(world: World, root: Entity): Entity | undefined {
  const queue = [root]
  for (let i = 0; i < queue.length && i < 256; i++) {
    const e = queue[i]!
    if (world.has(e, SkinnedMesh) && world.get(e, SkinnedMesh).skin) return e
    const kids = world.tryGet(e, Children)?.entities
    if (kids) for (const k of kids) if (k !== null && world.isAlive(k)) queue.push(k)
  }
  return undefined
}

/**
 * The skeleton under a ragdoll root: a Shard character's rig (its build's rest, its rig's joints
 * while near), or a plain skinned model's. Cold path: callers cache what they need.
 */
export function skeletonOf(world: World, root: Entity): SkeletonView | undefined {
  const ch = findCharacter(world, root)
  if (ch !== undefined) {
    const st = world.tryResource(CharacterStates)?.get(ch)
    if (!st) return undefined
    return {
      owner: ch,
      skeleton: st.rig.skeleton,
      rest: st.rig.builds[st.build]!.rest,
      joints: st.rigInstance?.joints ?? null,
      character: true,
    }
  }
  const mesh = findSkinned(world, root)
  if (mesh === undefined) return undefined
  const sm = world.get(mesh, SkinnedMesh)
  const skin = world.tryResource(Skins)?.get(sm.skin!)
  if (!skin || skin.joints.length === 0) return undefined
  const found = findModelRoot(world, mesh, skin.joints[0]!)
  if (!found) return undefined
  let cached = plain.get(skin)
  if (!cached) {
    const skeleton = flatSkeleton(skin, (path) => {
      const e = found.paths.get(path)
      if (e === undefined || !world.has(e, Transform)) return undefined
      return world.get(e, Transform)
    })
    cached = { skeleton, rest: flatRest(skin) }
    plain.set(skin, cached)
  }
  const joints: Entity[] = []
  for (const path of skin.joints) {
    const e = found.paths.get(path)
    if (e === undefined) return undefined
    joints.push(e)
  }
  // The player owns model space; a model without one is its own root.
  let owner = found.root
  if (!world.has(owner, AnimationPlayer) && world.has(root, AnimationPlayer)) owner = root
  return { owner, ...cached, joints, character: false }
}
