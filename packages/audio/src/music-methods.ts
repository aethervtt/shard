import { defineSchema, t } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { parameterValue } from './method-values'
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
