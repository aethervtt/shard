import {
  defineResource,
  defineSchema,
  type Entity,
  type Infer,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import { AudioEvent } from './event-assets'
import {
  AudioEventsState,
  AudioTransport,
  audioEvents,
  playAudioEvent,
  prepareAudio,
  stopAudioEvent,
} from './events'
import { AudioState, audioState, endVoice, newVoice } from './mixer'
import {
  AudioMusicState,
  describeMusic,
  MusicProgram,
  pauseMusic,
  prepareMusic,
  requestMusicSection,
  startMusic,
  stopMusic,
  updateMusic,
} from './music'

export const CheckpointSchema = defineSchema('audio/CheckpointData', {
  seed: t.u32(),
  ordinal: t.u32(),
  nextEvent: t.u32({ default: 1 }),
  transport: t.struct({ paused: t.bool(), timeScale: t.f64({ default: 1, min: 0, max: 16 }) }),
  globals: t.list(t.struct({ key: t.string(), values: t.list(t.f64()), targets: t.list(t.f64()) })),
  events: t.list(
    t.struct({
      definition: t.struct(AudioEvent.fields),
      source: t.handle('audio/AudioEvent'),
      entity: t.string(),
      clock: t.enum(['simulation', 'realtime']),
      pitchLinked: t.bool(),
      position: t.vec3(),
      ordinal: t.u32(),
      rng: t.list(t.u32()),
      decisionTime: t.f64(),
      sampleTime: t.f64(),
      values: t.list(t.f64()),
      targets: t.list(t.f64()),
      layers: t.list(
        t.struct({
          selected: t.i32(),
          cursor: t.f64(),
          age: t.f64(),
          active: t.bool(),
          gate: t.bool(),
          triggered: t.bool(),
          gainDb: t.f64(),
          pitchSemitones: t.f64(),
        }),
      ),
      histories: t.list(
        t.struct({ previous: t.list(t.i32()), cursor: t.u32(), sequence: t.u32() }),
      ),
    }),
  ),
  music: t.list(
    t.struct({
      definition: t.struct(MusicProgram.fields),
      key: t.string(),
      revision: t.string(),
      section: t.string(),
      phase: t.f64(),
      paused: t.bool(),
      values: t.list(t.f64()),
      targets: t.list(t.f64()),
      destination: t.string(),
      rng: t.list(t.u32()),
    }),
  ),
})
export const AudioCheckpoint = defineResource<Infer<typeof CheckpointSchema>>('audio/Checkpoint', {
  schema: CheckpointSchema,
  persist: true,
  init: () => CheckpointSchema.deserialize({}),
})

/** Explicit synchronous checkpoint boundary. Never stores backend timestamps or transient sounds. */
export function captureAudioCheckpoint(
  world: World,
  entityRef: (entity: Entity) => string | null = () => null,
): void {
  const state = world.tryResource(AudioEventsState)
  if (!state) return
  const data = world.initResource(AudioCheckpoint)
  data.seed = state.seed
  data.ordinal = state.ordinal
  data.nextEvent = state.nextId
  data.transport = { ...world.resource(AudioTransport) }
  data.globals = [...state.globalBanks].map(([key, bank]) => ({
    key,
    values: [...bank.values],
    targets: [...bank.targets],
  }))
  data.events = []
  for (const instance of state.instances) {
    if (
      !instance?.options.persist ||
      !instance.plan ||
      instance.plan.definition.mode !== 'sustain' ||
      instance.state === 'ended' ||
      instance.state === 'failed'
    )
      continue
    const entity = instance.entity === null ? '' : entityRef(instance.entity)
    if (entity === null) continue
    data.events.push({
      definition: AudioEvent.deserialize(AudioEvent.serialize(instance.plan.definition)),
      source: instance.plan.source ? { ...instance.plan.source, type: 'audio/AudioEvent' } : null,
      entity,
      clock: instance.clock,
      pitchLinked: instance.pitchLinked,
      position: [instance.x, instance.y, instance.z],
      ordinal: instance.ordinal,
      rng: instance.rng.getState(),
      decisionTime: instance.decisionTime,
      sampleTime: instance.sampleTime,
      values: [...instance.parameters!.values],
      targets: [...instance.parameters!.targets],
      layers: instance.layers.map((layer) => ({
        selected: layer.selected,
        cursor: layer.voice?.time ?? layer.cursor,
        age: layer.age,
        active: !!layer.voice && layer.voice.id > 0,
        gate: layer.gate,
        triggered: layer.triggered,
        gainDb: layer.gainDb,
        pitchSemitones: layer.pitchSemitones,
      })),
      histories: instance.plan.histories.map((history) => ({
        previous: [...history.previous],
        cursor: history.cursor,
        sequence: history.sequence,
      })),
    })
  }
  data.music = []
  const music = world.tryResource(AudioMusicState)
  if (!music) return
  updateMusic(world)
  const description = describeMusic(world)
  for (const transport of music.transports) {
    if (!transport.persist || transport.stopped) continue
    const phase = description.transports.find((t) => t.id === transport.id)!.tick
    data.music.push({
      definition: MusicProgram.deserialize(MusicProgram.serialize(transport.program.definition)),
      key: transport.program.key,
      revision: transport.program.revision,
      section: transport.section.definition.id,
      phase,
      paused: transport.paused,
      values: [...transport.parameters.values],
      targets: [...transport.parameters.targets],
      destination: transport.committed?.section ?? '',
      rng: transport.rng.getState(),
    })
  }
}

/** Runs before scene teardown so detached voices and stale async completions cannot survive a load. */
export function resetAudioForLoad(world: World): void {
  const state = world.tryResource(AudioEventsState)
  if (state) {
    state.generation++
    for (const instance of state.instances)
      if (instance) stopAudioEvent(world, instance.id, { release: 0 })
    for (const lease of state.leases.values()) lease.release()
    state.cooldowns.clear()
  }
  const music = world.tryResource(AudioMusicState)
  if (music) {
    for (const transport of music.transports) if (!transport.stopped) stopMusic(world, transport.id)
    for (const program of music.programs.values()) program.release()
  }
  const audio = world.tryResource(AudioState)
  if (audio)
    for (const voice of audio.voices) if (voice.id > 0) endVoice(world, audio, voice, 'stopped')
}

export async function restoreAudioCheckpoint(
  world: World,
  resolveEntity: (ref: string) => Entity | undefined = () => undefined,
): Promise<ShardError[]> {
  const data = world.tryResource(AudioCheckpoint),
    state = world.tryResource(AudioEventsState),
    warnings: ShardError[] = []
  if (!data || !state) return warnings
  state.seed = data.seed
  state.ordinal = data.ordinal
  state.nextId = Math.max(state.nextId, data.nextEvent)
  Object.assign(world.resource(AudioTransport), data.transport)
  for (const saved of data.events) {
    try {
      const entity = saved.entity ? resolveEntity(saved.entity) : undefined
      if (saved.entity && entity === undefined)
        throw new ShardError('audio/stale-handle', `Saved emitter ${saved.entity} no longer exists`)
      const lease = await prepareAudio(world, saved.definition)
      try {
        const id = playAudioEvent(world, saved.definition, {
          entity,
          position: saved.position,
          clock: saved.clock,
          pitchLinked: saved.pitchLinked,
          persist: true,
        })
        const instance = audioEvents(world).instances.find((value) => value?.id === id)!
        instance.ordinal = saved.ordinal
        instance.rng.setState(saved.rng)
        instance.decisionTime = saved.decisionTime
        instance.sampleTime = saved.sampleTime
        instance.parameters!.values.set(saved.values)
        instance.parameters!.targets.set(saved.targets)
        for (let i = 0; i < saved.layers.length; i++) {
          const previous = saved.layers[i]!,
            layer = instance.layers[i]!,
            definition = layer.definition
          Object.assign(layer, {
            selected: previous.selected,
            cursor: previous.cursor,
            age: previous.age,
            gate: previous.gate,
            triggered: previous.triggered,
            gainDb: previous.gainDb,
            pitchSemitones: previous.pitchSemitones,
          })
          if (previous.active && previous.selected >= 0) {
            const audio = audioState(world),
              voice = newVoice(audio, null, audio.frame)
            voice.managed = true
            voice.virtualizable = true
            voice.clip = instance.plan!.clips[i]![previous.selected]!
            voice.bus = definition.bus || instance.plan!.definition.bus
            voice.loop = definition.loop
            voice.priority = instance.plan!.definition.priority
            voice.spatial = definition.spatial
            voice.minDistance = definition.minDistance
            voice.maxDistance = definition.maxDistance
            voice.rolloff = definition.rolloff
            voice.rolloffFactor = definition.rolloffFactor
            voice.panning = definition.panning
            voice.pitch =
              2 ** ((definition.pitchSemitones + previous.pitchSemitones) / 12) *
              (saved.pitchLinked ? data.transport.timeScale : 1)
            voice.time = previous.cursor
            voice.x = saved.position[0]
            voice.y = saved.position[1]
            voice.z = saved.position[2]
            layer.voice = voice
            audio.voices.push(voice)
          }
          const history = instance.plan!.histories[i]!,
            stored = saved.histories[i]!
          history.previous.set(stored.previous)
          history.cursor = stored.cursor
          history.sequence = stored.sequence
        }
      } finally {
        lease.release()
      }
    } catch (cause) {
      warnings.push(
        new ShardError('audio/restore', 'Sustained audio could not be restored', { cause }),
      )
    }
  }
  state.ordinal = data.ordinal
  for (const global of data.globals) {
    const bank = state.globalBanks.get(global.key)
    if (bank && bank.values.length === global.values.length) {
      bank.values.set(global.values)
      bank.targets.set(global.targets)
    }
  }
  if (world.tryResource(AudioMusicState))
    for (const saved of data.music) {
      try {
        const program = await prepareMusic(world, saved.definition)
        try {
          // Candidate preparation uses the same admission path; release its temporary transport.
          let section = saved.section,
            phase = saved.phase
          if (!program.definition.sections.some((s) => s.id === section)) {
            section = program.definition.entry
            phase = 0
            warnings.push(
              new ShardError('audio/music-restore', 'Saved section is missing; restarting entry'),
            )
          }
          const { prepareMusicSection } = await import('./music')
          await prepareMusicSection(world, program, section)
          const id = startMusic(world, program, { section, phase, persist: true })
          const transport = world.resource(AudioMusicState).transports.find((t) => t.id === id)!
          transport.parameters.values.set(saved.values)
          transport.parameters.targets.set(saved.targets)
          transport.rng.setState(saved.rng)
          if (saved.destination)
            requestMusicSection(world, id, saved.destination, { quantize: 'bar' })
          if (saved.paused) pauseMusic(world, id)
        } finally {
          program.release()
        }
      } catch (cause) {
        warnings.push(
          new ShardError('audio/music-restore', 'Music could not be restored', { cause }),
        )
      }
    }
  state.lastClock = audioState(world).backend.runtime!.clock.now()
  return warnings
}
