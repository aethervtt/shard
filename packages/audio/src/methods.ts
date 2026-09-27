import { defineSchema, type Entity, findComponent, t, type World } from '@aethervtt/shard-core'
import type { AppMethod } from '@aethervtt/shard-runtime'
import { AudioBuses } from './components'
import { AudioConfig, type AudioLogEntry, audioState, busOf, clipLabel } from './mixer'

const round = (x: number, digits = 4) => Math.round(x * 10 ** digits) / 10 ** digits

function scenePath(world: World, entity: Entity | null): string | null {
  if (entity === null) return null
  const member = findComponent('scene/SceneMember')
  if (!member || !world.isAlive(entity)) return null
  return (world.tryGet(entity, member) as { path?: string } | undefined)?.path || null
}

/** What's playing: the context, the listener, buses with their gains, and every voice. */
export function describeAudio(world: World) {
  const state = audioState(world)
  const config = world.resource(AudioConfig)
  const buses = world.resource(AudioBuses)
  const L = state.listener
  const voices = state.voices.filter((v) => v.id > 0)
  return {
    backend: state.backend.kind,
    context: state.backend.state,
    listener:
      state.listenerEntity === null
        ? null
        : {
            entity: state.listenerEntity,
            path: scenePath(world, state.listenerEntity),
            position: [round(L[3]!), round(L[7]!), round(L[11]!)],
          },
    buses: Object.keys(buses).map((name) => {
      const bus = busOf(buses, name)!
      return {
        name,
        volume: bus.volume,
        muted: bus.muted,
        parent: bus.parent,
        gain: round(state.busGains.get(name) ?? 1),
        ducked: round(state.duckLevels.get(name) ?? 1),
        ...(bus.duck ? { duck: bus.duck } : {}),
      }
    }),
    voices: voices.map((v) => ({
      voice: v.id,
      clip: clipLabel(v),
      entity: v.entity,
      path: scenePath(world, v.entity),
      bus: v.bus,
      ...(v.busMissing ? { problem: `audio/unknown-bus: "${v.bus}" (mixed on master)` } : {}),
      state: v.state === 'active' && v.backend === -1 ? ('pending' as const) : v.state,
      gain: round(v.gain),
      pan: round(v.pan),
      distance: v.spatial ? round(v.distance, 3) : null,
      position: v.spatial ? [round(v.x, 3), round(v.y, 3), round(v.z, 3)] : null,
      time: round(v.time),
      elapsed: round(v.elapsed),
      duration: v.clip ? round(v.clip.duration) : null,
      loop: v.loop,
      pitch: round(v.rate),
      priority: v.priority,
    })),
    counts: {
      active: voices.filter((v) => v.state === 'active').length,
      virtual: voices.filter((v) => v.state === 'virtual').length,
      pending: voices.filter((v) => v.state === 'pending').length,
      maxVoices: config.maxVoices,
      maxVoicesPerClip: config.maxVoicesPerClip,
      dropped: state.dropped,
    },
  }
}

/** Voices started, stopped, and dropped from frame `since` on. */
export function audioLog(world: World, since = 0): AudioLogEntry[] {
  return audioState(world).log.filter((e) => e.frame >= since)
}

export const audioMethods: AppMethod[] = [
  {
    name: 'audio.describe',
    description:
      'What the audio plugin is playing: the backend and its context state (a browser keeps it suspended until a click or key press), the listener, buses (volume, muted, parent, final gain, duck level), and every voice: clip, source entity and path, bus, state (active, virtual: out of range or over the voice limit, keeping time; pending: clip loading), gain after volume, bus, and distance, equal-power pan (-1 left, +1 right), distance, clip time, elapsed seconds, pitch, and priority. Counts and the voice limits.',
    params: defineSchema('audio/DescribeParams', {}),
    handler: ({ world }) => describeAudio(world),
  },
  {
    name: 'audio.log',
    description:
      'Voices started, stopped, and dropped, by frame: { frame, event: start | stop | dropped, voice, clip, entity, path, bus, position, gain, pan, reason: ended | stopped | stolen | removed | voice-limit }. Gameplay tests assert on it.',
    params: defineSchema('audio/LogParams', {
      since: t.u32({ description: 'Only entries from this frame on.' }),
    }),
    handler: ({ world }, p) => ({ entries: audioLog(world, (p.since as number | undefined) ?? 0) }),
  },
]
