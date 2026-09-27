import { type AssetRef, type Entity, ShardError, type World } from '@aethervtt/shard-core'
import { AnimationLayer, type AnimationLayerValue, AnimationPlayer } from './components'

/**
 * A complete layer for code that builds players (list items written from code get no defaults):
 * `animationLayer(walk, { weight: 0.5 })`.
 */
export function animationLayer(
  clip: AssetRef | null,
  fields: Partial<Omit<AnimationLayerValue, 'clip'>> = {},
): AnimationLayerValue {
  return {
    ...AnimationLayer.defaultValue(),
    ...fields,
    clip: clip as AssetRef<'AnimationClip'> | null,
  }
}

export interface CrossfadeOptions {
  loop?: AnimationLayerValue['loop']
  speed?: number
  mask?: AssetRef | null
  /** Where the new clip starts, in seconds. */
  time?: number
}

/**
 * Starts `clip` as a new layer that fades in over `seconds` while every other layer fades out (and
 * is removed at 0). At `seconds` the pose is the new clip's. Returns the new layer's index.
 */
export function crossfade(
  world: World,
  entity: Entity,
  clip: AssetRef,
  seconds: number,
  options: CrossfadeOptions = {},
): number {
  if (!world.has(entity, AnimationPlayer)) {
    throw new ShardError('animation/no-player', `Entity ${entity} has no AnimationPlayer`, {
      hint: 'Add animation/AnimationPlayer to the model root first.',
    })
  }
  const { layers, ...rest } = world.get(entity, AnimationPlayer)
  const instant = !(seconds > 0)
  const kept = instant ? [] : layers
  for (const layer of kept) {
    layer.fadeTo = 0
    layer.fadeSpeed = Math.max(layer.weight, 1e-6) / seconds
  }
  kept.push(
    animationLayer(clip, {
      time: options.time ?? 0,
      speed: options.speed ?? 1,
      weight: instant ? 1 : 0,
      loop: options.loop ?? 'loop',
      mask: (options.mask ?? null) as AssetRef<'AnimationMask'> | null,
      fadeTo: 1,
      fadeSpeed: instant ? 0 : 1 / seconds,
    }),
  )
  world.set(entity, AnimationPlayer, { ...rest, layers: kept })
  return kept.length - 1
}

/** Replaces every layer with one playing `clip` at full weight. */
export function play(
  world: World,
  entity: Entity,
  clip: AssetRef,
  options: CrossfadeOptions = {},
): number {
  return crossfade(world, entity, clip, 0, options)
}
