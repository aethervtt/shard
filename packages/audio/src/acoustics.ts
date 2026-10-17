import {
  defineComponent,
  defineResource,
  defineSystem,
  type Entity,
  PostUpdate,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { definePlugin, Time } from '@aethervtt/shard-runtime'
import { GlobalTransform, Transform } from '@aethervtt/shard-transform'
import { AudioMixState } from './mix'
import { AudioConfig, audioState, updateAudio } from './mixer'
import { audioNumber } from './validation'

export const ReverbZone = defineComponent(
  'audio/ReverbZone',
  {
    shape: t.enum(['sphere', 'box']),
    radius: t.f64({ default: 5, min: 0.00001, unit: 'm' }),
    halfExtents: t.vec3({ default: [5, 5, 5], min: 0.00001 }),
    blendDistance: t.f64({ default: 2, min: 0, unit: 'm' }),
    returnBus: t.string({ required: true }),
    wet: t.f64({ default: 1, min: 0, max: 1 }),
    priority: t.i32(),
    indoor: t.bool(),
  },
  {
    requires: [Transform],
    description:
      'Listener-based acoustic zone. Its return is prepared in the mixer; moving between zones never decodes on a frame.',
  },
)

export type AcousticQuery = (from: Float64Array, to: Float64Array, out: Float64Array) => void
interface ZoneRecord {
  entity: Entity | null
  bus: string
  weight: number
  priority: number
  indoor: boolean
}
interface ZoneSlot {
  entity: Entity | null
  bus: string
  weight: number
  target: number
  pending: Entity | null
  pendingBus: string
  pendingWeight: number
}
export interface AudioAcousticsValue {
  query: AcousticQuery | null
  maxQueries: number
  interval: number
  zones: ZoneRecord[]
  count: number
  discarded: number
  slots: ZoneSlot[]
  from: Float64Array
  to: Float64Array
  result: Float64Array
  queries: number
  buses: string[]
  time: number
}
export const AudioAcoustics = defineResource<AudioAcousticsValue>('audio/Acoustics')

/** Influence outside an axis-aligned box or sphere; one inside, continuous over the exterior blend. */
export function audioZoneInfluence(
  shape: 'box' | 'sphere',
  x: number,
  y: number,
  z: number,
  radius: number,
  hx: number,
  hy: number,
  hz: number,
  blend: number,
): number {
  let distance: number
  if (shape === 'sphere') distance = Math.max(0, Math.sqrt(x * x + y * y + z * z) - radius)
  else {
    const dx = Math.max(0, Math.abs(x) - hx),
      dy = Math.max(0, Math.abs(y) - hy),
      dz = Math.max(0, Math.abs(z) - hz)
    distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  return distance === 0 ? 1 : blend > 0 ? Math.max(0, 1 - distance / blend) : 0
}

export function updateZoneSlots(state: AudioAcousticsValue, delta: number): void {
  // Priority bands consume remaining influence; equal-priority zones normalize together.
  let remaining = 1,
    start = 0
  while (start < state.count) {
    let end = start,
      sum = 0
    while (end < state.count && state.zones[end]!.priority === state.zones[start]!.priority)
      sum += state.zones[end++]!.weight
    const scale = remaining / Math.max(1, sum)
    for (let i = start; i < end; i++) state.zones[i]!.weight *= scale
    remaining *= Math.max(0, 1 - sum)
    start = end
  }
  // Stable insertion sort, allocated records are reused.
  for (let i = 1; i < state.count; i++) {
    const zone = state.zones[i]!
    let j = i
    while (
      j > 0 &&
      (state.zones[j - 1]!.weight < zone.weight ||
        (state.zones[j - 1]!.weight === zone.weight && state.zones[j - 1]!.entity! > zone.entity!))
    ) {
      state.zones[j] = state.zones[j - 1]!
      j--
    }
    state.zones[j] = zone
  }
  for (let i = 0; i < state.slots.length; i++) {
    const slot = state.slots[i]!
    let current = 0
    for (let z = 0; z < state.count; z++)
      if (state.zones[z]!.entity === slot.entity) {
        current = state.zones[z]!.weight
        break
      }
    slot.target = current
    if (slot.pending !== null) {
      slot.pendingWeight = 0
      for (let z = 0; z < state.count; z++)
        if (state.zones[z]!.entity === slot.pending) slot.pendingWeight = state.zones[z]!.weight
      if (slot.pendingWeight === 0) {
        slot.pending = null
        slot.pendingBus = ''
      }
    }
  }
  for (let z = 0; z < Math.min(4, state.count); z++) {
    const zone = state.zones[z]!
    if (zone.weight <= 0) continue
    let assigned = false,
      weakest = -1
    for (let i = 0; i < 4; i++) {
      const slot = state.slots[i]!
      if (slot.entity === zone.entity || slot.pending === zone.entity) assigned = true
      if (slot.pending === null && (weakest < 0 || slot.target < state.slots[weakest]!.target))
        weakest = i
    }
    if (assigned || weakest < 0) continue
    const slot = state.slots[weakest]!
    if (slot.entity === null || zone.weight > slot.target + 0.05) {
      slot.pending = zone.entity
      slot.pendingBus = zone.bus
      slot.pendingWeight = zone.weight
    }
  }
  for (let i = 0; i < 4; i++) {
    const slot = state.slots[i]!,
      target = slot.pending !== null ? 0 : slot.target
    slot.weight +=
      Math.sign(target - slot.weight) * Math.min(Math.abs(target - slot.weight), delta / 0.1)
    if (slot.weight === 0) {
      if (slot.pending !== null) {
        slot.entity = slot.pending
        slot.bus = slot.pendingBus
        slot.target = slot.pendingWeight
        slot.pending = null
        slot.pendingBus = ''
      } else if (slot.target === 0) {
        slot.entity = null
        slot.bus = ''
      }
    }
  }
  state.discarded = Math.max(0, state.count - 4)
}

export const updateAudioAcoustics = defineSystem({
  name: 'audio/acoustics',
  setup: (world) => ({ zones: world.query({ with: [ReverbZone, GlobalTransform] }) }),
  run: ({ zones }, world) => {
    const state = world.resource(AudioAcoustics),
      audio = audioState(world),
      delta = world.resource(Time).delta
    const runtime = audio.backend.runtime!
    state.time += delta
    state.count = 0
    for (let t = 0; t < zones.tables.length; t++) {
      const table = zones.tables[t]!,
        matrix = table.column(GlobalTransform, 'matrix')
      const shape = table.column(ReverbZone, 'shape'),
        radius = table.column(ReverbZone, 'radius'),
        extents = table.column(ReverbZone, 'halfExtents')
      const blend = table.column(ReverbZone, 'blendDistance'),
        buses = table.column(ReverbZone, 'returnBus'),
        wet = table.column(ReverbZone, 'wet')
      const priority = table.column(ReverbZone, 'priority'),
        indoor = table.column(ReverbZone, 'indoor')
      for (let r = 0; r < table.count; r++) {
        const m = r * 12,
          e = r * 3
        const weight =
          audioZoneInfluence(
            shape[r] === 0 ? 'sphere' : 'box',
            audio.listener[3]! - matrix[m + 3]!,
            audio.listener[7]! - matrix[m + 7]!,
            audio.listener[11]! - matrix[m + 11]!,
            radius[r]!,
            extents[e]!,
            extents[e + 1]!,
            extents[e + 2]!,
            blend[r]!,
          ) * wet[r]!
        if (weight <= 0) continue
        if (state.count >= state.zones.length)
          throw new ShardError('audio/invalid-zone', 'Zone capacity exceeded')
        const zone = state.zones[state.count++]!
        zone.entity = table.entities[r]!
        zone.bus = buses[r]!
        zone.weight = weight
        zone.priority = priority[r]!
        zone.indoor = !!indoor[r]
      }
    }
    for (let i = 1; i < state.count; i++) {
      const zone = state.zones[i]!
      let j = i
      while (
        j > 0 &&
        (state.zones[j - 1]!.priority < zone.priority ||
          (state.zones[j - 1]!.priority === zone.priority &&
            state.zones[j - 1]!.entity! > zone.entity!))
      ) {
        state.zones[j] = state.zones[j - 1]!
        j--
      }
      state.zones[j] = zone
    }
    updateZoneSlots(state, delta)
    const mix = world.resource(AudioMixState)
    for (let i = 0; i < mix.fields.length; i++) {
      const field = mix.fields[i]!
      if (!field.field.startsWith('send/') || !state.buses.includes(field.bus)) continue
      let weight = 0
      for (let s = 0; s < 4; s++)
        if (field.field === `send/${state.slots[s]!.bus}`) weight += state.slots[s]!.weight
      field.factor = Math.min(1, weight)
    }
    state.queries = 0
    if (state.query) {
      // Oldest query first, then loudest and stable voice ID; no sort or per-query allocation.
      for (let q = 0; q < state.maxQueries; q++) {
        let best = -1
        for (let i = 0; i < audio.voices.length; i++) {
          const voice = audio.voices[i]!
          if (
            voice.id <= 0 ||
            voice.backend < 0 ||
            !voice.spatial ||
            state.time - voice.acousticAt < state.interval
          )
            continue
          const previous = best < 0 ? null : audio.voices[best]!
          if (
            !previous ||
            voice.acousticAt < previous.acousticAt ||
            (voice.acousticAt === previous.acousticAt &&
              (voice.gain > previous.gain ||
                (voice.gain === previous.gain && voice.id < previous.id)))
          )
            best = i
        }
        if (best < 0) break
        const voice = audio.voices[best]!
        state.from[0] = voice.x
        state.from[1] = voice.y
        state.from[2] = voice.z
        state.to[0] = audio.listener[3]!
        state.to[1] = audio.listener[7]!
        state.to[2] = audio.listener[11]!
        state.result[0] = 1
        state.query(state.from, state.to, state.result)
        audioNumber(state.result[0]!, 'transmission', 0, 1)
        voice.acousticTarget = state.result[0]!
        voice.acousticAt = state.time
        state.queries++
      }
    }
    for (let i = 0; i < audio.voices.length; i++) {
      const voice = audio.voices[i]!
      const target = state.query && voice.spatial ? voice.acousticTarget : 1
      voice.transmission +=
        (target - voice.transmission) *
        (1 - Math.exp(-delta / (target < voice.transmission ? 0.05 : 0.2)))
      voice.acousticGain = state.query ? 10 ** ((-18 * (1 - voice.transmission)) / 20) : 1
      if (state.query && voice.backend >= 0 && voice.spatial)
        runtime.automate(voice.backend, {
          property: 'lowpass',
          at: runtime.clock.now(),
          value: 800 * 25 ** voice.transmission,
          duration: 0.01,
        })
    }
  },
})

export function describeAudioAcoustics(world: World) {
  const state = world.resource(AudioAcoustics)
  return {
    provider: !!state.query,
    queries: state.queries,
    maxQueries: state.maxQueries,
    discarded: state.discarded,
    zones: state.zones.slice(0, state.count),
    slots: state.slots,
    voices: audioState(world)
      .voices.filter((v) => v.id > 0 && v.spatial)
      .map((v) => ({ id: v.id, transmission: v.transmission, age: state.time - v.acousticAt })),
  }
}
export function audioAcousticsPlugin(
  options: {
    query?: AcousticQuery
    maxQueriesPerFrame?: number
    maxZones?: number
    buses?: string[]
  } = {},
) {
  return definePlugin({
    name: 'audio/acoustics',
    dependencies: ['audio/mixer'],
    provides: [{ ReverbZone, AudioAcoustics }],
    build(app) {
      const maxQueries = options.maxQueriesPerFrame ?? 16,
        maxZones = options.maxZones ?? 128
      audioNumber(maxQueries, 'maxQueriesPerFrame', 0, 512)
      audioNumber(maxZones, 'maxZones', 4, 4096)
      if (options.query && app.world.resource(AudioConfig).occlusion)
        throw new ShardError(
          'audio/invalid-effect',
          'Choose either acoustic queries or the legacy occlusion callback',
        )
      app.world.insertResource(AudioAcoustics, {
        query: options.query ?? null,
        maxQueries,
        interval: 0.1,
        zones: Array.from({ length: maxZones }, () => ({
          entity: null,
          bus: '',
          weight: 0,
          priority: 0,
          indoor: false,
        })),
        count: 0,
        discarded: 0,
        slots: Array.from({ length: 4 }, () => ({
          entity: null,
          bus: '',
          weight: 0,
          target: 0,
          pending: null,
          pendingBus: '',
          pendingWeight: 0,
        })),
        from: new Float64Array(3),
        to: new Float64Array(3),
        result: new Float64Array(1),
        queries: 0,
        buses: options.buses ?? ['sfx', 'ambience', 'voice'],
        time: 0,
      })
      app.addSystems(PostUpdate, updateAudioAcoustics.after(updateAudio))
    },
  })
}
