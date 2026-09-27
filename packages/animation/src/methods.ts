import {
  defineSchema,
  type Entity,
  findComponent,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { describeAnimator } from './animator'
import { AnimationClips } from './clip'
import { AnimationPlayer, RootMotion } from './components'
import { describeIk } from './ik'
import { describeBinding } from './player'

function scenePath(world: World, entity: Entity): string | null {
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

/** What a player is doing: layers, what didn't bind, and root motion. */
export function describePlayer(world: World, entity: Entity) {
  if (!world.isAlive(entity) || !world.has(entity, AnimationPlayer)) {
    throw new ShardError('animation/no-player', `Entity ${entity} has no AnimationPlayer`, {
      hint: 'animation.describe without an entity lists every player.',
    })
  }
  const player = world.get(entity, AnimationPlayer)
  const clips = world.resource(AnimationClips)
  const binding = describeBinding(world, entity)
  const motion = world.tryGet(entity, RootMotion)
  return {
    entity,
    path: scenePath(world, entity),
    layers: player.layers.map((layer, index) => {
      const clip = clips.get(layer.clip)
      return {
        index,
        clip: layer.clip?.path ?? layer.clip?.guid ?? null,
        name: clip?.name ?? null,
        loaded: clip !== undefined,
        time: layer.time,
        duration: clip?.duration ?? null,
        speed: layer.speed,
        weight: layer.weight,
        loop: layer.loop,
        blend: layer.blend,
        mask: layer.mask?.path ?? layer.mask?.guid ?? null,
        playing: layer.playing,
        fading: layer.fadeSpeed > 0 ? { to: layer.fadeTo, perSecond: layer.fadeSpeed } : null,
      }
    }),
    boundTargets: binding.bound,
    unboundChannels: binding.unbound,
    rootMotion: {
      mode: player.rootMotion,
      joint: player.rootJoint || binding.rootJoint,
      translation: motion?.translation ?? [0, 0, 0],
      rotation: motion?.rotation ?? [0, 0, 0, 1],
    },
    animator: describeAnimator(world, entity),
    retarget: binding.retarget,
    ik: describeIk(world, entity),
  }
}

export const animationMethods: AppMethod[] = [
  {
    name: 'animation.describe',
    description:
      "An entity's AnimationPlayer: its layers (clip, time, duration, weight, loop, blend, mask, fade), how many targets bound, channels whose target is missing, and this frame's root motion. With an Animator, its graph per layer: current state, the transition in progress and its progress, time in state, blend-space weights, and parameter values (and what each bound one reads). With a Retarget: the source skeleton, the root and hip-height ratio, and source joints that matched nothing. IK solvers under the player: kind, weight, distance (or angle) left to the target, FABRIK iterations, foot hits and how far the hips dropped, and any problem (ik/not-a-chain, ik/unknown-joint). Without an entity: every player, and every IK solver.",
    params: defineSchema('animation/DescribeParams', {
      entity: t.entity({ description: 'The player entity (or its scene path).' }),
    }),
    handler: ({ world }, p) => {
      const entity = p.entity as Entity | null
      if (entity !== null && entity !== undefined && entity >= 0)
        return describePlayer(world, entity)
      const players: ReturnType<typeof describePlayer>[] = []
      for (const table of world.query({ with: [AnimationPlayer] }).tables) {
        for (let i = 0; i < table.count; i++)
          players.push(describePlayer(world, table.entities[i]!))
      }
      return { players, ik: describeIk(world) }
    },
  },
]
