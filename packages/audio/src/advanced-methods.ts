import { defineSchema, ShardError, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import {
  audioEvents,
  describeAudioEvents,
  playAudioEvent,
  prepareAudio,
  setAudioParameter,
  stopAudioEvent,
} from './events'
import { acquireAudioSnapshot, releaseAudioSnapshot, setAudioSnapshotWeight } from './mix'
import { audioState } from './mixer'
import {
  cancelMusicRequest,
  describeMusic,
  pauseMusic,
  playMusicStinger,
  prepareMusic,
  requestMusicSection,
  resumeMusic,
  seekMusic,
  setMusicParameter,
  startMusic,
  stopMusic,
} from './music'

function parameterValue(value: unknown): number | string {
  if (typeof value !== 'number' && typeof value !== 'string')
    throw new ShardError('audio/unknown-parameter', 'Parameter values must be numbers or labels')
  return value
}
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
      parameters: t.json({ default: {} }),
      position: t.vec3(),
      clock: t.enum(['simulation', 'realtime']),
      persist: t.bool(),
    }),
    handler: ({ world }, p) => ({
      instance: playAudioEvent(world, p.event as string, {
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
    name: 'audio.parameter',
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
    params: defineSchema('audio/EventsInspectParams', {}),
    handler: ({ world }) => describeAudioEvents(world),
  },
]
export const audioMixMethods: AppMethod[] = [
  {
    name: 'audio.snapshot.acquire',
    description: 'Acquire an independently releasable snapshot handle.',
    params: defineSchema('audio/SnapshotAcquireParams', {
      asset: t.string({ required: true }),
      weight: t.f64({ default: 1, min: 0, max: 1 }),
    }),
    handler: async ({ world }, p) => ({
      snapshot: await acquireAudioSnapshot(world, p.asset as string, p.weight as number),
    }),
  },
  {
    name: 'audio.snapshot.set',
    description: 'Change one snapshot handle weight.',
    params: defineSchema('audio/SnapshotSetParams', {
      snapshot: t.u32({ required: true }),
      weight: t.f64({ min: 0, max: 1 }),
    }),
    handler: ({ world }, p) => {
      setAudioSnapshotWeight(world, p.snapshot as number, p.weight as number)
      return { updated: true }
    },
  },
  {
    name: 'audio.snapshot.release',
    description: 'Release one snapshot, preserving other handles and user settings.',
    params: defineSchema('audio/SnapshotReleaseParams', { snapshot: t.u32({ required: true }) }),
    handler: ({ world }, p) => ({ released: releaseAudioSnapshot(world, p.snapshot as number) }),
  },
  {
    name: 'audio.meters',
    description: 'Measured browser bus peak/RMS, or available:false on headless hosts.',
    params: defineSchema('audio/MetersParams', { bus: t.string({ default: 'master' }) }),
    handler: ({ world }, p) => audioState(world).backend.runtime!.meter(p.bus as string),
  },
]
export const audioMusicMethods: AppMethod[] = [
  {
    name: 'audio.music.start',
    description: 'Prepare an entry section and start an adaptive music transport.',
    params: defineSchema('audio/MusicStartParams', {
      asset: t.string({ required: true }),
      persist: t.bool(),
    }),
    handler: async ({ world }, p) => {
      const program = await prepareMusic(world, p.asset as string)
      try {
        return { transport: startMusic(world, program, { persist: p.persist as boolean }) }
      } finally {
        program.release()
      }
    },
  },
  {
    name: 'audio.music.parameter',
    description: 'Set a music program parameter.',
    params: defineSchema('audio/MusicParameterParams', {
      transport: t.u32({ required: true }),
      name: t.string({ required: true }),
      value: t.json({ required: true }),
    }),
    handler: ({ world }, p) => {
      setMusicParameter(world, p.transport as number, p.name as string, parameterValue(p.value))
      return { updated: true }
    },
  },
  {
    name: 'audio.music.transition',
    description:
      'Request a quantized section transition. Returns its command ID and chosen boundary.',
    params: defineSchema('audio/MusicTransitionParams', {
      transport: t.u32({ required: true }),
      section: t.string({ required: true }),
      quantize: t.string({ default: 'bar' }),
      fadeBeats: t.f64({ default: 1, min: 0 }),
      reenter: t.bool(),
    }),
    handler: ({ world }, p) => {
      const request = requestMusicSection(world, p.transport as number, p.section as string, {
        quantize: p.quantize as string,
        fadeBeats: p.fadeBeats as number,
        reenter: p.reenter as boolean,
      })
      return { command: request.id, at: request.at, tick: request.tick, state: request.state }
    },
  },
  {
    name: 'audio.music.stinger',
    description: 'Prepare and schedule a finite decoded stinger.',
    params: defineSchema('audio/MusicStingerParams', {
      transport: t.u32({ required: true }),
      stinger: t.string({ required: true }),
      quantize: t.string({ default: 'beat' }),
    }),
    handler: ({ world }, p) =>
      playMusicStinger(world, p.transport as number, p.stinger as string, {
        quantize: p.quantize as string,
      }),
  },
  ...(['pause', 'resume', 'stop'] as const).map(
    (action): AppMethod => ({
      name: `audio.music.${action}`,
      description: `${action} a music transport and invalidate stale scheduled work where needed.`,
      params: defineSchema(`audio/Music${action}Params`, { transport: t.u32({ required: true }) }),
      handler: ({ world }, p) => {
        ;({ pause: pauseMusic, resume: resumeMusic, stop: stopMusic })[action](
          world,
          p.transport as number,
        )
        return { updated: true }
      },
    }),
  ),
  {
    name: 'audio.music.seek',
    description: 'Seek in integer 960-PPQ ticks, cancelling previous starts and stingers.',
    params: defineSchema('audio/MusicSeekParams', {
      transport: t.u32({ required: true }),
      tick: t.u32(),
    }),
    handler: ({ world }, p) => {
      seekMusic(world, p.transport as number, p.tick as number)
      return { updated: true }
    },
  },
  {
    name: 'audio.music.cancel',
    description: 'Cancel a scheduled command and report whether it already started.',
    params: defineSchema('audio/MusicCancelParams', {
      transport: t.u32({ required: true }),
      command: t.u32({ required: true }),
    }),
    handler: ({ world }, p) => ({
      result: cancelMusicRequest(world, p.transport as number, p.command as number),
    }),
  },
  {
    name: 'audio.music.inspect',
    description: 'Inspect transport phase, active stems, readiness, deadlines and trace.',
    params: defineSchema('audio/MusicInspectParams', {}),
    handler: ({ world }) => describeMusic(world),
  },
]
