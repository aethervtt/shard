import { defineSchema, type Entity, isPlainObject, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { effectError } from './document'
import {
  cancelEffect,
  describeEffects,
  Effects,
  pauseEffect,
  playEffect,
  prepareEffect,
} from './runtime'

export const effectMethods: AppMethod[] = [
  {
    name: 'effects.prepare',
    description:
      'Prepare a catalog asset or host-supplied sequence document. Returns a releasable preparation ID.',
    params: defineSchema('effects/PrepareParams', { source: t.json({ required: true }) }),
    handler: async ({ world }, p) => ({ preparation: (await prepareEffect(world, p.source)).id }),
  },
  {
    name: 'effects.release',
    description: 'Release a preparation; active instances retain their assets.',
    params: defineSchema('effects/ReleaseParams', { preparation: t.u32({ required: true }) }),
    handler: ({ world }, p) => {
      const plan = world.resource(Effects).plans.get(p.preparation as number)
      const released = !!plan && !plan.released
      plan?.release()
      return { released }
    },
  },
  {
    name: 'effects.play',
    description: 'Play a prepared sequence, binding borrowed targets to live entity IDs.',
    params: defineSchema('effects/PlayParams', {
      preparation: t.u32({ required: true }),
      bindings: t.json({ default: {} }),
      parameters: t.json({ default: {} }),
      seed: t.u32(),
      ownerEntity: t.entity(),
    }),
    handler: ({ world }, p) => {
      const plan = world.resource(Effects).plans.get(p.preparation as number)
      if (!plan) effectError('Unknown preparation', '/preparation', 'invalid-preparation')
      if (!isPlainObject(p.bindings) || !isPlainObject(p.parameters))
        effectError('Bindings and parameters must be objects')
      for (const value of Object.values(p.bindings))
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
          effectError('Binding must be an entity ID', '/bindings')
      return {
        instance: playEffect(world, plan, {
          bindings: p.bindings as Record<string, Entity>,
          parameters: p.parameters as Record<string, number>,
          seed: p.seed as number,
          ownerEntity:
            typeof p.ownerEntity === 'number' && p.ownerEntity >= 0 ? p.ownerEntity : undefined,
        }).id,
      }
    },
  },
  {
    name: 'effects.cancel',
    description: 'Cancel an active sequence and restore/release its presentation state.',
    params: defineSchema('effects/CancelParams', { instance: t.u32({ required: true }) }),
    handler: ({ world }, p) => ({ cancelled: cancelEffect(world, p.instance as number) }),
  },
  {
    name: 'effects.pause',
    description: 'Pause/resume this sequence, including its particles and authored audio.',
    params: defineSchema('effects/PauseParams', {
      instance: t.u32({ required: true }),
      paused: t.bool({ default: true }),
    }),
    handler: ({ world }, p) => ({
      updated: pauseEffect(world, p.instance as number, p.paused as boolean),
    }),
  },
  {
    name: 'effects.inspect',
    description:
      'Active sequences, prepared leases, target bindings and bounded cursor-based execution trace.',
    params: defineSchema('effects/InspectParams', { cursor: t.u32() }),
    handler: ({ world }, p) => describeEffects(world, p.cursor as number),
  },
]
