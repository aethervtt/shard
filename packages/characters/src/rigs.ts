import { AnimationStateResource } from '@aethervtt/shard-animation'
import { ChildOf, defineResource, type Entity, type World } from '@aethervtt/shard-core'
import { SkinnedMesh } from '@aethervtt/shard-render'
import { SceneMember } from '@aethervtt/shard-scene'
import { propagateSubtree, Transform } from '@aethervtt/shard-transform'
import type { CharacterRig } from './rig'
import type { CharacterState } from './spawn'

/** One set of joint entities (and their non-joint ancestors) at the rig's paths. */
export interface RigInstance {
  rig: CharacterRig
  /** Per rig node. */
  entities: Entity[]
  /** Per joint, in the skin's order. */
  joints: Entity[]
  /** Nodes whose parent is the character root. */
  tops: Entity[]
}

export interface RigPoolState {
  free: Map<CharacterRig, RigInstance[]>
  /** Rigs ever made, by rig (describe). */
  made: Map<CharacterRig, number>
  inUse: number
}

export const RigPool = defineResource<RigPoolState>('characters/RigPool', {
  description: 'Joint rigs not in use, per character rig (0115). Internal.',
  init: () => ({ free: new Map(), made: new Map(), inUse: 0 }),
})

/** Spawns one rig's entities, parked (no parent above its top nodes). Cold path. */
function makeRig(world: World, rig: CharacterRig): RigInstance {
  const entities: Entity[] = []
  const joints = new Array<Entity>(rig.skeleton.paths.length)
  const tops: Entity[] = []
  for (const node of rig.nodes) {
    const trs = node.trs
    const transform = [
      Transform,
      {
        translation: [trs[0]!, trs[1]!, trs[2]!],
        rotation: [trs[3]!, trs[4]!, trs[5]!, trs[6]!],
        scale: [trs[7]!, trs[8]!, trs[9]!],
      },
    ] as const
    const member = [SceneMember, { scene: 'characters/rig', path: node.path }] as const
    const entity =
      node.parent < 0
        ? world.spawn(transform, member)
        : world.spawn(transform, member, [ChildOf, { parent: entities[node.parent]! }])
    entities.push(entity)
    if (node.joint >= 0) joints[node.joint] = entity
    if (node.parent < 0) tops.push(entity)
  }
  const pool = world.resource(RigPool)
  pool.made.set(rig, (pool.made.get(rig) ?? 0) + 1)
  return { rig, entities, joints, tops }
}

/**
 * Gives a character a rig in its build's rest pose, under its root. Its player binds to the rig
 * from the next sample, reading that rest pose (retargeting corrects against it), so the caller
 * keeps drawing the flat pose until then. Cold path (a swap).
 */
export function checkoutRig(world: World, s: CharacterState): RigInstance {
  const pool = world.resource(RigPool)
  const list = pool.free.get(s.rig)
  const inst = list?.pop() ?? makeRig(world, s.rig)
  pool.inUse++
  // The build's rest pose: what the player's binding reads as rest.
  const local = s.rig.builds[s.build]!.rest
  for (let n = 0; n < s.rig.nodes.length; n++) {
    const node = s.rig.nodes[n]!
    const e = inst.entities[n]!
    const table = world.entityTableUnchecked(e)
    const row = world.entityRowUnchecked(e)
    const tr = table.column(Transform, 'translation')
    const ro = table.column(Transform, 'rotation')
    const sc = table.column(Transform, 'scale')
    const src = node.joint >= 0 ? local : node.trs
    const o = node.joint >= 0 ? node.joint * 10 : 0
    tr[row * 3] = src[o]!
    tr[row * 3 + 1] = src[o + 1]!
    tr[row * 3 + 2] = src[o + 2]!
    ro[row * 4] = src[o + 3]!
    ro[row * 4 + 1] = src[o + 4]!
    ro[row * 4 + 2] = src[o + 5]!
    ro[row * 4 + 3] = src[o + 6]!
    sc[row * 3] = src[o + 7]!
    sc[row * 3 + 1] = src[o + 8]!
    sc[row * 3 + 2] = src[o + 9]!
    table.markChanged(Transform, row)
  }
  for (const top of inst.tops) {
    world.add(top, ChildOf, { parent: s.entity })
    propagateSubtree(world, top)
  }
  for (const part of s.parts) world.set(part, SkinnedMesh, { joints: inst.joints })
  // The player's binding held the previous rig's entities.
  world.tryResource(AnimationStateResource)?.bindings.delete(s.entity)
  s.rigInstance = inst
  return inst
}

/** Takes a character's rig back into the pool; its parts stop skinning by joints. Cold path. */
export function returnRig(world: World, s: CharacterState): void {
  const inst = s.rigInstance
  if (!inst) return
  s.rigInstance = null
  for (const part of s.parts) if (world.isAlive(part)) world.set(part, SkinnedMesh, { joints: [] })
  for (const top of inst.tops) if (world.isAlive(top)) world.remove(top, ChildOf)
  world.tryResource(AnimationStateResource)?.bindings.delete(s.entity)
  const pool = world.resource(RigPool)
  pool.inUse--
  let list = pool.free.get(s.rig)
  if (!list) {
    list = []
    pool.free.set(s.rig, list)
  }
  list.push(inst)
}

/** Joint entities that exist (in use and pooled), for the joint-count criterion. */
export function jointEntityCount(world: World): number {
  const pool = world.tryResource(RigPool)
  if (!pool) return 0
  let n = 0
  for (const [rig, made] of pool.made) n += made * rig.skeleton.paths.length
  return n
}
