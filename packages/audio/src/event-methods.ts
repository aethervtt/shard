import { defineSchema, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import {
  audioEvents,
  describeAudioEvents,
  playAudioEvent,
  prepareAudio,
  setAudioParameter,
  stopAudioEvent,
} from './events'
import { parameterValue } from './method-values'
import { audioState } from './mixer'
export const audioEventMethods: AppMethod[] = [
  {
    name: 'audio.prepare',
    description: 'Prepare an event or collection and return a releasable lease.',
    params: defineSchema('audio/PrepareParams', { asset: t.string({ required: true }) }),
    handler: async ({ world }, p) => {
      const lease = await prepareAudio(world, p.asset as string)
      return {
        lease: lease.id,
        events: lease.events.map((event) => event.key),
        memory: audioState(world).backend.runtime!.memory(),
      }
    },
  },
  {
    name: 'audio.release',
    description: 'Release a preparation lease. Active instances retain their buffers.',
    params: defineSchema('audio/ReleaseParams', { lease: t.u32({ required: true }) }),
    handler: ({ world }, p) => {
      const lease = audioEvents(world).leases.get(p.lease as number)
      lease?.release()
      return { released: !!lease }
    },
  },
  {
    name: 'audio.play',
    description:
      'Start an authored event. Returns a logical instance ID; inspect presentation separately.',
    params: defineSchema('audio/EventPlayParams', {
      event: t.string({ required: true }),
      entity: t.entity(),
      pitchLinked: t.bool(),
      volume: t.f64({ default: 1, min: 0, description: 'Linear gain for every event layer.' }),
      parameters: t.json({ default: {} }),
      position: t.vec3(),
      clock: t.enum(['simulation', 'realtime']),
      persist: t.bool(),
    }),
    handler: ({ world }, p) => ({
      instance: playAudioEvent(world, p.event as string, {
        entity: typeof p.entity === 'number' && p.entity >= 0 ? p.entity : undefined,
        pitchLinked: p.pitchLinked as boolean,
        volume: p.volume as number,
        parameters: p.parameters as Record<string, number | string>,
        position: p.position as number[],
        clock: p.clock as 'simulation' | 'realtime',
        persist: p.persist as boolean,
      }),
    }),
  },
  {
    name: 'audio.stop',
    description: 'Stop an event instance with a release envelope.',
    params: defineSchema('audio/EventStopParams', {
      instance: t.u32({ required: true }),
      release: t.f64({ default: 0.02, min: 0 }),
    }),
    handler: ({ world }, p) => ({
      stopped: stopAudioEvent(world, p.instance as number, { release: p.release as number }),
    }),
  },
  {
    name: 'audio.parameter.set',
    description: 'Set a local event parameter, or a global parameter when instance is zero.',
    params: defineSchema('audio/ParameterParams', {
      instance: t.u32(),
      name: t.string({ required: true }),
      value: t.json({ required: true }),
    }),
    handler: ({ world }, p) => {
      setAudioParameter(
        world,
        (p.instance as number) || null,
        p.name as string,
        parameterValue(p.value),
      )
      return { updated: true }
    },
  },
  {
    name: 'audio.events.inspect',
    description: 'Inspect logical instances, parameters and bounded decision trace.',
    params: defineSchema('audio/EventsInspectParams', { cursor: t.u32() }),
    handler: ({ world }, p) => describeAudioEvents(world, p.cursor as number),
  },
]
