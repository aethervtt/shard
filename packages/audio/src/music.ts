import { assetServer, defineDataType } from '@aethervtt/shard-assets'
import {
  type AssetRef,
  defineResource,
  type Infer,
  Rng,
  ShardError,
  t,
  type World,
} from '@aethervtt/shard-core'
import type {
  AudioAutomation,
  AudioPreparation,
  AudioRuntimeExtension,
} from '@aethervtt/shard-platform'
import { definePlugin } from '@aethervtt/shard-runtime'
import { type AudioClipAsset, AudioClips } from './clip'
import {
  type AudioLease,
  AudioTrace,
  acquireAudioGlobals,
  audioEvents,
  prepareAudio,
  releaseAudioGlobals,
} from './events'
import { AudioInspectors } from './inspection'
import { AudioConfig, audioState } from './mixer'
import { audioMusicMethods } from './music-methods'
import {
  AudioCurveFields,
  AudioParameterBank,
  AudioParameterFields,
  sampleAudioCurve,
  validateCurve,
  validateParameters,
} from './parameters'
import { audioNumber } from './validation'

export const MUSIC_PPQ = 960
export const MusicProgram = defineDataType(
  'audio/MusicProgram',
  {
    bpm: t.f64({ default: 120, min: 10, max: 400 }),
    numerator: t.u8({ default: 4, min: 1, max: 32 }),
    denominator: t.u8({ default: 4 }),
    entry: t.string({ required: true }),
    parameters: t.list(t.struct(AudioParameterFields)),
    globals: t.handle('audio/AudioParameters'),
    sections: t.list(
      t.struct({
        id: t.string({ required: true }),
        bars: t.u32({ default: 4, min: 1, max: 4096 }),
        markers: t.list(t.struct({ id: t.string({ required: true }), tick: t.u32() })),
        stems: t.list(
          t.struct({
            id: t.string({ required: true }),
            clip: t.handle('AudioClip', { required: true }),
            startSample: t.u32(),
            endSample: t.u32({ required: true }),
            rateConform: t.bool(),
            maxConformCents: t.f64({ default: 1, min: 0, max: 25 }),
            gainDb: t.f64({ min: -120, max: 12 }),
            bus: t.string({ default: 'music' }),
            curves: t.list(t.struct(AudioCurveFields)),
          }),
        ),
      }),
    ),
    transitions: t.list(
      t.struct({
        id: t.string({ required: true }),
        from: t.string({ required: true }),
        to: t.string({ required: true }),
        parameter: t.string(),
        min: t.f64({ default: -1e30 }),
        max: t.f64({ default: 1e30 }),
        priority: t.i32(),
        quantize: t.string({ default: 'bar' }),
        entryMarker: t.string(),
        fadeBeats: t.f64({ default: 1, min: 0, max: 128 }),
        curve: t.enum(['equal-power', 'linear']),
        reenter: t.bool(),
      }),
    ),
    stingers: t.list(
      t.struct({
        id: t.string({ required: true }),
        event: t.handle('audio/AudioEvent', { required: true }),
        cooldown: t.f64({ min: 0 }),
        overlap: t.enum(['reject', 'allow', 'replace']),
      }),
    ),
  },
  {
    extension: 'audio-music',
    lazyDependencies: true,
    validate: (value) => validateMusicProgram(value as MusicProgramDefinition),
  },
)
export type MusicProgramDefinition = Infer<typeof MusicProgram>
type SectionDefinition = MusicProgramDefinition['sections'][number]

export function musicBarTicks(
  program: Pick<MusicProgramDefinition, 'numerator' | 'denominator'>,
): number {
  return (MUSIC_PPQ * program.numerator * 4) / program.denominator
}
export function musicTimeAtTick(
  epoch: number,
  tick: number,
  bpm: number,
  sampleRate: number,
): number {
  return Math.round((epoch + ((tick / MUSIC_PPQ) * 60) / bpm) * sampleRate) / sampleRate
}
export function validateMusicProgram(program: MusicProgramDefinition): void {
  validateParameters(program.parameters)
  if (![1, 2, 4, 8, 16, 32].includes(program.denominator))
    throw new ShardError('audio/music-invalid', 'Unsupported meter denominator', {
      path: '/denominator',
    })
  if (!program.sections.length || program.sections.length > 64)
    throw new ShardError('audio/music-invalid', 'Programs require 1–64 sections')
  const sections = new Map<string, SectionDefinition>()
  for (const section of program.sections) {
    if (!section.id || sections.has(section.id))
      throw new ShardError('audio/music-invalid', 'Section IDs must be unique')
    sections.set(section.id, section)
    if (!section.stems.length || section.stems.length > 16)
      throw new ShardError('audio/music-invalid', 'Sections require 1–16 stems')
    const ids = new Set<string>()
    for (const stem of section.stems) {
      if (!stem.id || ids.has(stem.id) || !stem.clip || stem.endSample <= stem.startSample)
        throw new ShardError('audio/music-invalid', 'Invalid stem ID, reference or sample range', {
          path: `/sections/${section.id}/stems/${stem.id}`,
        })
      ids.add(stem.id)
      for (const curve of stem.curves) {
        validateCurve(curve.points, '/curves')
        if (
          curve.property !== 'gainDb' ||
          (!program.globals && !program.parameters.some((p) => p.name === curve.parameter))
        )
          throw new ShardError(
            'audio/music-invalid',
            'Stem curves must map a program parameter to gainDb',
          )
      }
    }
    ids.clear()
    for (const marker of section.markers) {
      if (!marker.id || ids.has(marker.id) || marker.tick >= section.bars * musicBarTicks(program))
        throw new ShardError('audio/music-invalid', 'Invalid marker ID or position')
      ids.add(marker.id)
    }
  }
  if (!sections.has(program.entry))
    throw new ShardError('audio/music-invalid', 'Entry section is missing')
  const ids = new Set<string>()
  for (const transition of program.transitions) {
    const from = sections.get(transition.from),
      to = sections.get(transition.to)
    if (
      !from ||
      !to ||
      !transition.id ||
      ids.has(transition.id) ||
      transition.min > transition.max ||
      (transition.parameter &&
        !program.globals &&
        !program.parameters.some((p) => p.name === transition.parameter)) ||
      (!['immediate', 'beat', 'bar'].includes(transition.quantize) &&
        !from.markers.some((m) => m.id === transition.quantize)) ||
      (transition.entryMarker && !to.markers.some((m) => m.id === transition.entryMarker))
    )
      throw new ShardError('audio/music-invalid', 'Invalid transition', {
        path: `/transitions/${transition.id}`,
      })
    ids.add(transition.id)
  }
  ids.clear()
  for (const stinger of program.stingers) {
    if (!stinger.id || ids.has(stinger.id) || !stinger.event)
      throw new ShardError('audio/music-invalid', 'Invalid stinger')
    ids.add(stinger.id)
  }
}

interface PreparedStem {
  definition: SectionDefinition['stems'][number]
  clip: AudioClipAsset
  lease: AudioPreparation
  rate: number
  curves: { parameter: number; global: boolean; points: Float64Array }[]
}
interface PreparedSection {
  definition: SectionDefinition
  stems: PreparedStem[]
  seconds: number
  ticks: number
}
export interface PreparedMusic {
  id: number
  key: string
  revision: string
  globals: AudioParameterBank
  releaseGlobals: () => void
  definition: MusicProgramDefinition
  sections: Map<string, PreparedSection>
  pending: Map<string, Promise<PreparedSection>>
  stingers: Map<string, AudioLease>
  released: boolean
  refs: number
  release(): void
}
interface StemVoice {
  id: number
  stem: PreparedStem
  gain: number
  command: AudioAutomation
}
export interface MusicRequest {
  id: number
  section: string
  quantize: string
  entryMarker: string
  fadeBeats: number
  curve: 'linear' | 'equal-power'
  late: 'next' | 'drop' | 'immediate-crossfade'
  state: 'preparing' | 'pending' | 'committed' | 'cancelled' | 'done' | 'failed'
  at: number
  tick: number
  generation: number
  error: string | null
  voices: StemVoice[]
  prepared: PreparedSection | null
}
export interface MusicTransport {
  id: number
  program: PreparedMusic
  section: PreparedSection
  epoch: number
  sectionStartTick: number
  rate: number
  parameters: AudioParameterBank
  voices: StemVoice[]
  retiring: { voices: StemVoice[]; at: number }[]
  pending: MusicRequest | null
  committed: MusicRequest | null
  paused: boolean
  phase: number
  generation: number
  lastCommand: number
  lastDecision: number
  stingers: { id: number; name: string; at: number; end: number; voices: number[] }[]
  cooldowns: Map<string, number>
  stopped: boolean
  lastWake: number
  misses: number
  persist: boolean
  rng: Rng
}
export interface MusicStateValue {
  programs: Map<number, PreparedMusic>
  transports: MusicTransport[]
  nextProgram: number
  nextTransport: number
  nextCommand: number
  lookahead: number
  interval: number
  commitLead: number
  trace: AudioTrace
  scratch: Float64Array
  wake: (() => void) | null
  disposed: boolean
}
export const AudioMusicState = defineResource<MusicStateValue>('audio/MusicState')

function musicState(world: World): MusicStateValue {
  return world.resource(AudioMusicState)
}
function runtimeOf(world: World): AudioRuntimeExtension {
  return audioState(world).backend.runtime!
}
function transportOf(world: World, id: number): MusicTransport {
  const transport = musicState(world).transports.find((item) => item.id === id && !item.stopped)
  if (!transport)
    throw new ShardError('audio/music-stale-command', 'Music transport is stopped or unknown')
  return transport
}
function releaseProgram(state: MusicStateValue, program: PreparedMusic): void {
  if (--program.refs > 0) return
  for (const section of program.sections.values())
    for (const stem of section.stems) stem.lease.release()
  for (const lease of program.stingers.values()) lease.release()
  program.releaseGlobals()
  program.sections.clear()
  program.stingers.clear()
  state.programs.delete(program.id)
}
export async function prepareMusicSection(
  world: World,
  program: PreparedMusic,
  id: string,
): Promise<PreparedSection> {
  const ready = program.sections.get(id)
  if (ready) return ready
  const pending = program.pending.get(id)
  if (pending) return pending
  const definition = program.definition.sections.find((section) => section.id === id)
  if (!definition) throw new ShardError('audio/music-invalid', `Unknown section ${id}`)
  const operation = (async () => {
    const stems: PreparedStem[] = [],
      ticks = definition.bars * musicBarTicks(program.definition),
      seconds = ((ticks / MUSIC_PPQ) * 60) / program.definition.bpm
    try {
      for (const stem of definition.stems) {
        const store = world.resource(AudioClips)
        if (!store.get(stem.clip)) await assetServer(world).load(stem.clip!)
        const source = store.get(stem.clip)
        if (!source || source.stream)
          throw new ShardError('audio/music-unprepared', 'Rhythmic stems require decoded clips')
        const clip = { ...source }
        const lease = await runtimeOf(world).prepare(clip)
        const record: PreparedStem = {
          definition: stem,
          clip,
          lease,
          rate: 1,
          curves: stem.curves.map((curve) => ({
            parameter: program.definition.parameters.some((p) => p.name === curve.parameter)
              ? program.definition.parameters.findIndex((p) => p.name === curve.parameter)
              : program.globals.index(curve.parameter),
            global: !program.definition.parameters.some((p) => p.name === curve.parameter),
            points: new Float64Array(curve.points.flat()),
          })),
        }
        stems.push(record)
        const sourceRate = source.sampleRate ?? lease.sampleRate
        clip.loopStart =
          Math.round((stem.startSample / sourceRate) * lease.sampleRate) / lease.sampleRate
        clip.loopEnd =
          Math.round((stem.endSample / sourceRate) * lease.sampleRate) / lease.sampleRate
        if (clip.loopEnd * lease.sampleRate > lease.samples || clip.loopEnd <= clip.loopStart)
          throw new ShardError('audio/music-invalid', 'Stem markers exceed decoded samples')
        record.rate = (clip.loopEnd - clip.loopStart) / seconds
        const cents = Math.abs(1200 * Math.log2(record.rate))
        if (
          Math.abs(record.rate - 1) > 1e-10 &&
          (!stem.rateConform || cents > stem.maxConformCents)
        )
          throw new ShardError(
            'audio/music-invalid',
            `Loop period needs ${cents.toFixed(6)} cents of explicit rate conform`,
            { path: `/sections/${id}/stems/${stem.id}` },
          )
      }
      if (musicState(world).disposed || program.refs === 0)
        throw new ShardError('audio/music-stale-command', 'Program released during preparation')
      const section = { definition, stems, seconds, ticks }
      program.sections.set(id, section)
      return section
    } catch (error) {
      for (const stem of stems) stem.lease.release()
      throw error
    } finally {
      program.pending.delete(id)
    }
  })()
  program.pending.set(id, operation)
  return operation
}

export async function prepareMusic(
  world: World,
  ref: MusicProgramDefinition | AssetRef | string,
): Promise<PreparedMusic> {
  const state = musicState(world),
    runtime = runtimeOf(world)
  if (!runtime.capabilities.scheduled || !runtime.capabilities.automation)
    throw new ShardError(
      'audio/unsupported-capability',
      'Adaptive music requires scheduled decoded playback and automation',
    )
  if (state.disposed || state.programs.size >= 32)
    throw new ShardError('audio/music-capacity', 'Music program capacity reached')
  let source: MusicProgramDefinition, key: string
  if (typeof ref === 'object' && 'sections' in ref) {
    source = ref
    key = 'inline'
  } else {
    const server = assetServer(world),
      store = world.resource(MusicProgram.store)
    const resolved = typeof ref === 'string' ? server.resolve(ref) : ref
    if (!store.get(resolved)) await server.load(ref)
    const value = store.get(typeof ref === 'string' ? server.resolve(ref) : ref)
    if (!value) throw new ShardError('audio/music-invalid', 'Music program asset is missing')
    source = value
    key = typeof ref === 'string' ? ref : (ref.guid ?? ref.path ?? '')
  }
  const definition = MusicProgram.deserialize(MusicProgram.serialize(source))
  validateMusicProgram(definition)
  const shared = definition.globals ? await acquireAudioGlobals(world, definition.globals) : null
  const id = state.nextProgram++
  const program: PreparedMusic = {
    id,
    key,
    globals: shared?.bank ?? new AudioParameterBank([]),
    releaseGlobals: () => {
      if (shared) releaseAudioGlobals(audioEvents(world), shared.key)
    },
    revision: JSON.stringify(MusicProgram.serialize(definition)),
    definition,
    sections: new Map(),
    pending: new Map(),
    stingers: new Map(),
    released: false,
    refs: 1,
    release() {
      if (!program.released) {
        program.released = true
        releaseProgram(state, program)
      }
    },
  }
  state.programs.set(id, program)
  try {
    await prepareMusicSection(world, program, definition.entry)
    return program
  } catch (error) {
    program.release()
    throw error
  }
}

function stemGain(state: MusicStateValue, transport: MusicTransport, stem: PreparedStem): number {
  let db = stem.definition.gainDb
  for (let i = 0; i < stem.curves.length; i++) {
    const curve = stem.curves[i]!
    sampleAudioCurve(
      curve.points,
      (curve.global ? transport.program.globals : transport.parameters).values[curve.parameter]!,
      state.scratch,
      0,
    )
    db += state.scratch[0]!
  }
  return 10 ** (db / 20)
}
function startSection(
  world: World,
  transport: MusicTransport,
  section: PreparedSection,
  at: number,
  phase: number,
  fade: number,
  curve: 'linear' | 'equal-power',
): StemVoice[] {
  const runtime = runtimeOf(world),
    state = musicState(world),
    voices: StemVoice[] = []
  if (runtime.memory().voices + section.stems.length > world.resource(AudioConfig).maxVoices)
    throw new ShardError(
      'audio/music-capacity',
      'The entire section cannot fit the physical voice budget',
    )
  try {
    for (const stem of section.stems) {
      const gain = stemGain(state, transport, stem)
      const id = runtime.play({
        clip: stem.clip,
        bus: stem.definition.bus,
        loop: true,
        offset:
          stem.clip.loopStart +
          ((((phase / MUSIC_PPQ) * 60) / transport.program.definition.bpm) % section.seconds) *
            stem.rate,
        gain,
        pitch: stem.rate,
        when: at,
        spatial: null,
        x: 0,
        y: 0,
        z: 0,
      })
      voices.push({
        id,
        stem,
        gain,
        command: { property: 'gain', at, value: gain, duration: 0.01 },
      })
      if (fade) {
        runtime.automate(id, { property: 'envelope', at, value: 0, duration: 0 })
        runtime.automate(id, {
          property: 'envelope',
          at,
          value: 1,
          duration: fade,
          curve: curve === 'linear' ? 'linear' : 'equal-power-in',
        })
      }
    }
    return voices
  } catch (error) {
    for (const voice of voices) runtime.cancel(voice.id)
    throw error
  }
}

export function startMusic(
  world: World,
  program: PreparedMusic,
  options: { section?: string; persist?: boolean; at?: number; phase?: number } = {},
): number {
  const state = musicState(world),
    runtime = runtimeOf(world)
  if (program.released || state.transports.filter((t) => !t.stopped).length >= 8)
    throw new ShardError('audio/music-capacity', 'Program released or transport capacity reached')
  const section = program.sections.get(options.section ?? program.definition.entry)
  if (!section)
    throw new ShardError('audio/music-unprepared', 'Prepare the entry section before starting')
  const rate = section.stems[0]!.lease.sampleRate,
    phase = options.phase ?? 0
  const at = options.at ?? runtime.clock.now() + state.commitLead
  audioNumber(phase, 'phase')
  audioNumber(at, 'at', runtime.clock.now())
  const transport: MusicTransport = {
    id: state.nextTransport++,
    program,
    section,
    epoch: at - ((phase / MUSIC_PPQ) * 60) / program.definition.bpm,
    sectionStartTick: 0,
    rate,
    parameters: new AudioParameterBank(program.definition.parameters),
    voices: [],
    retiring: [],
    pending: null,
    committed: null,
    paused: false,
    phase,
    generation: 0,
    lastCommand: 0,
    lastDecision: -1,
    stingers: [],
    cooldowns: new Map(),
    stopped: false,
    lastWake: runtime.clock.now(),
    misses: 0,
    persist: options.persist ?? false,
    rng: new Rng(state.nextTransport),
  }
  transport.voices = startSection(world, transport, section, at, phase, 0, 'linear')
  program.refs++
  state.transports.push(transport)
  state.trace.write(0, at, 'music-start', transport.id, section.definition.id)
  return transport.id
}

function tickNow(transport: MusicTransport, now: number): number {
  return ((now - transport.epoch) * MUSIC_PPQ * transport.program.definition.bpm) / 60
}
function boundary(
  transport: MusicTransport,
  quantize: string,
  earliest: number,
): { tick: number; at: number } {
  const program = transport.program.definition
  const section = transport.committed?.prepared ?? transport.section
  const entry = transport.committed?.entryMarker
    ? section.definition.markers.find((m) => m.id === transport.committed!.entryMarker)!.tick
    : 0
  const sectionStartTick = transport.committed
    ? transport.committed.tick - entry
    : transport.sectionStartTick
  const earliestTick = tickNow(transport, earliest)
  let tick = earliestTick
  if (quantize === 'beat' || quantize === 'bar') {
    const unit = quantize === 'beat' ? MUSIC_PPQ : musicBarTicks(program)
    tick = sectionStartTick + Math.ceil((earliestTick - sectionStartTick) / unit - 1e-10) * unit
  } else if (quantize !== 'immediate') {
    const marker = section.definition.markers.find((m) => m.id === quantize)
    if (!marker)
      throw new ShardError('audio/music-invalid', `Unknown quantization marker ${quantize}`)
    const start = sectionStartTick + marker.tick
    tick =
      start + Math.max(0, Math.ceil((earliestTick - start) / section.ticks - 1e-10)) * section.ticks
  }
  return { tick, at: musicTimeAtTick(transport.epoch, tick, program.bpm, transport.rate) }
}

export function requestMusicSection(
  world: World,
  id: number,
  section: string,
  options: {
    quantize?: string
    entryMarker?: string
    fadeBeats?: number
    curve?: 'linear' | 'equal-power'
    late?: MusicRequest['late']
    reenter?: boolean
  } = {},
): MusicRequest {
  const transport = transportOf(world, id),
    state = musicState(world),
    runtime = runtimeOf(world)
  reconcileMusic(world, transport, runtime.clock.now())
  if (transport.paused)
    throw new ShardError('audio/music-stale-command', 'Resume music before requesting a transition')
  const definition = transport.program.definition.sections.find((s) => s.id === section)
  if (!definition || (section === transport.section.definition.id && !options.reenter))
    throw new ShardError('audio/music-invalid', 'Destination is missing or needs explicit reentry')
  if (options.entryMarker && !definition.markers.some((m) => m.id === options.entryMarker))
    throw new ShardError('audio/music-invalid', 'Unknown destination entry marker')
  audioNumber(options.fadeBeats ?? 1, 'fadeBeats', 0, 128)
  const earliest = Math.max(
    runtime.clock.now() + state.commitLead,
    transport.epoch + 1 / transport.rate,
    (transport.committed?.at ?? -Infinity) + 1 / transport.rate,
  )
  const target = boundary(transport, options.quantize ?? 'bar', earliest)
  if (transport.pending) {
    transport.pending.state = 'cancelled'
    state.trace.write(
      0,
      runtime.clock.now(),
      'music-cancel',
      transport.pending.id,
      '',
      -1,
      'replaced',
    )
  }
  const request: MusicRequest = {
    id: state.nextCommand++,
    section,
    quantize: options.quantize ?? 'bar',
    entryMarker: options.entryMarker ?? '',
    fadeBeats: options.fadeBeats ?? 1,
    curve: options.curve ?? 'equal-power',
    late: options.late ?? 'next',
    state: 'preparing',
    ...target,
    generation: transport.generation,
    error: null,
    voices: [],
    prepared: null,
  }
  transport.pending = request
  const ready = transport.program.sections.get(section)
  if (ready) {
    request.prepared = ready
    request.state = 'pending'
  } else
    void prepareMusicSection(world, transport.program, section)
      .then((prepared) => {
        if (
          transport.stopped ||
          request.generation !== transport.generation ||
          request.state === 'cancelled'
        )
          return
        request.prepared = prepared
        request.state = 'pending'
      })
      .catch((error: unknown) => {
        if (request.state !== 'cancelled') {
          request.state = 'failed'
          request.error = error instanceof ShardError ? error.code : 'audio/music-unprepared'
        }
      })
  state.trace.write(0, request.at, 'music-request', request.id, section)
  return request
}

export function setMusicParameter(
  world: World,
  id: number,
  name: string,
  value: number | string,
): void {
  const transport = transportOf(world, id)
  const bank = transport.parameters.indices.has(name)
    ? transport.parameters
    : transport.program.globals
  bank.set(name, value)
}
function cancelSources(runtime: AudioRuntimeExtension, transport: MusicTransport): void {
  transport.generation++
  for (const voice of transport.voices) runtime.cancel(voice.id)
  for (const retiring of transport.retiring)
    for (const voice of retiring.voices) runtime.cancel(voice.id)
  for (const stinger of transport.stingers) for (const id of stinger.voices) runtime.cancel(id)
  if (transport.pending) transport.pending.state = 'cancelled'
  if (transport.committed) {
    for (const voice of transport.committed.voices) runtime.cancel(voice.id)
    transport.committed.state = 'cancelled'
  }
  transport.voices = []
  transport.retiring = []
  transport.stingers = []
  transport.pending = null
  transport.committed = null
}
export function pauseMusic(world: World, id: number): void {
  const transport = transportOf(world, id)
  if (transport.paused) return
  const now = runtimeOf(world).clock.now()
  reconcileMusic(world, transport, now)
  transport.phase =
    Math.max(0, tickNow(transport, now) - transport.sectionStartTick) % transport.section.ticks
  cancelSources(runtimeOf(world), transport)
  transport.paused = true
}
export function resumeMusic(world: World, id: number): void {
  const transport = transportOf(world, id)
  if (!transport.paused) return
  const at = runtimeOf(world).clock.now() + musicState(world).commitLead
  transport.epoch = at - ((transport.phase / MUSIC_PPQ) * 60) / transport.program.definition.bpm
  transport.sectionStartTick = 0
  transport.voices = startSection(
    world,
    transport,
    transport.section,
    at,
    transport.phase,
    0.01,
    'linear',
  )
  transport.paused = false
  transport.lastWake = runtimeOf(world).clock.now()
}
export function seekMusic(world: World, id: number, tick: number): void {
  audioNumber(tick, 'tick')
  const transport = transportOf(world, id),
    paused = transport.paused
  if (paused) cancelSources(runtimeOf(world), transport)
  else pauseMusic(world, id)
  transport.phase = tick % transport.section.ticks
  if (!paused) resumeMusic(world, id)
}
export function stopMusic(world: World, id: number): void {
  const transport = transportOf(world, id)
  cancelSources(runtimeOf(world), transport)
  transport.stopped = true
  releaseProgram(musicState(world), transport.program)
}
export function cancelMusicRequest(
  world: World,
  id: number,
  command: number,
): 'cancelled' | 'already-started' | 'ended' {
  const transport = transportOf(world, id),
    runtime = runtimeOf(world)
  if (transport.pending?.id === command) {
    transport.pending.state = 'cancelled'
    transport.pending = null
    return 'cancelled'
  }
  const stinger = transport.stingers.find((item) => item.id === command)
  if (stinger) {
    const audible = runtime.clock.now() >= stinger.at
    for (const voice of stinger.voices) audioState(world).backend.stop(voice, audible ? 0.02 : 0)
    stinger.end = runtime.clock.now()
    return audible ? 'already-started' : 'cancelled'
  }
  if (transport.committed?.id !== command) {
    if (transport.lastCommand !== command) return 'ended'
    // Promotion does not erase command identity. Cancel the audible destination with release.
    for (const voice of transport.voices) audioState(world).backend.stop(voice.id, 0.02)
    transport.voices = []
    transport.lastCommand = 0
    transport.phase =
      Math.max(0, tickNow(transport, runtime.clock.now()) - transport.sectionStartTick) %
      transport.section.ticks
    transport.paused = true
    return 'already-started'
  }
  const request = transport.committed,
    audible = runtime.clock.now() >= request.at
  for (const voice of request.voices) audioState(world).backend.stop(voice.id, audible ? 0.02 : 0)
  request.state = 'cancelled'
  transport.committed = null
  // Restore the outgoing section's gain; cancellation must also cancel its future fade.
  for (const voice of transport.voices)
    runtime.automate(voice.id, {
      property: 'envelope',
      at: runtime.clock.now(),
      value: 1,
      duration: 0.01,
    })
  return audible ? 'already-started' : 'cancelled'
}

export async function playMusicStinger(
  world: World,
  id: number,
  name: string,
  options: { quantize?: string } = {},
): Promise<{ id: number; at: number }> {
  const transport = transportOf(world, id),
    state = musicState(world),
    runtime = runtimeOf(world)
  if (transport.paused)
    throw new ShardError('audio/music-stale-command', 'Resume music before scheduling a stinger')
  const definition = transport.program.definition.stingers.find((s) => s.id === name)
  if (!definition) throw new ShardError('audio/music-invalid', `Unknown stinger ${name}`)
  const generation = transport.generation
  const requested = boundary(
    transport,
    options.quantize ?? 'beat',
    runtime.clock.now() + state.commitLead,
  )
  let lease = transport.program.stingers.get(name)
  if (!lease) {
    lease = await prepareAudio(world, definition.event!)
    if (transport.stopped || transport.generation !== generation) {
      lease.release()
      throw new ShardError('audio/music-stale-command', 'Transport changed during preparation')
    }
    const existing = transport.program.stingers.get(name)
    if (existing) {
      lease.release()
      lease = existing
    } else transport.program.stingers.set(name, lease)
  }
  const event = lease.events[0]!
  if (
    event.definition.mode !== 'oneshot' ||
    event.definition.layers.some(
      (layer, i) =>
        layer.loop ||
        layer.trigger !== 'start' ||
        layer.condition.parameter ||
        layer.curves.length ||
        layer.selector === 'switch' ||
        event.clips[i]!.some((clip) => clip.stream),
    )
  )
    throw new ShardError(
      'audio/music-invalid',
      'Stingers need finite decoded start layers without runtime gates or curves',
    )
  const now = runtime.clock.now(),
    last = transport.cooldowns.get(name) ?? -Infinity
  if (
    now - last < definition.cooldown ||
    (definition.overlap === 'reject' &&
      transport.stingers.some((s) => s.name === name && s.end > now))
  )
    throw new ShardError('audio/music-capacity', 'Stinger cooldown or overlap limit')
  if (definition.overlap === 'replace') {
    for (let i = transport.stingers.length - 1; i >= 0; i--) {
      const stinger = transport.stingers[i]!
      if (stinger.name !== name) continue
      for (const voice of stinger.voices) runtime.cancel(voice)
      transport.stingers.splice(i, 1)
    }
  }
  if (
    transport.stingers.length >= 32 ||
    runtime.memory().voices + event.definition.layers.length > world.resource(AudioConfig).maxVoices
  )
    throw new ShardError('audio/music-capacity', 'Entire stinger cannot fit')
  const target =
    requested.at < now + state.commitLead
      ? boundary(transport, options.quantize ?? 'beat', now + state.commitLead)
      : requested
  if (target.at !== requested.at) {
    transport.misses++
    state.trace.write(0, now, 'music-late', id, name, -1, 'stinger-readiness')
  }
  const command = state.nextCommand++,
    voices: number[] = []
  let end = target.at
  try {
    for (let i = 0; i < event.definition.layers.length; i++) {
      const layer = event.definition.layers[i]!,
        choices = event.clips[i]!
      let choice = 0
      if (layer.selector === 'sequence') choice = event.histories[i]!.sequence++ % choices.length
      else if (layer.selector !== 'single') {
        const history = event.histories[i]!
        const exclude = layer.selector === 'no-repeat'
        let total = 0
        for (let c = 0; c < layer.choices.length; c++)
          if (!exclude || !history.previous.includes(c)) total += layer.choices[c]!.weight
        let pick = transport.rng.float() * total
        for (; choice < choices.length - 1; choice++) {
          if (exclude && history.previous.includes(choice)) continue
          pick -= layer.choices[choice]!.weight
          if (pick < 0) break
        }
      }
      if (layer.selector === 'no-repeat') {
        const history = event.histories[i]!
        history.previous[history.cursor++ % history.previous.length] = choice
      }
      const clip = choices[choice]!,
        pitch =
          2 **
          ((layer.pitchSemitones +
            transport.rng.range(layer.pitchRandom[0], layer.pitchRandom[1])) /
            12)
      const gain =
        10 ** ((layer.gainDb + transport.rng.range(layer.gainRandom[0], layer.gainRandom[1])) / 20)
      const at = target.at + layer.delay,
        duration = layer.duration || clip.duration / pitch
      const voice = runtime.play({
        clip,
        bus: layer.bus || event.definition.bus,
        when: at,
        duration,
        offset: 0,
        loop: false,
        gain: layer.attack ? 0 : gain,
        pitch,
        spatial: null,
        x: 0,
        y: 0,
        z: 0,
      })
      voices.push(voice)
      if (layer.attack)
        runtime.automate(voice, { property: 'gain', at, value: gain, duration: layer.attack })
      if (layer.release)
        runtime.automate(voice, {
          property: 'envelope',
          at: at + Math.max(0, duration - layer.release),
          value: 0,
          duration: Math.min(duration, layer.release),
        })
      end = Math.max(end, at + duration)
      state.trace.write(0, at, 'music-stinger-layer', command, layer.id, choice)
    }
  } catch (error) {
    for (const voice of voices) runtime.cancel(voice)
    throw error
  }
  transport.stingers.push({ id: command, name, at: target.at, end, voices })
  transport.cooldowns.set(name, now)
  return { id: command, at: target.at }
}

function reconcileMusic(world: World, transport: MusicTransport, now: number): void {
  const state = musicState(world)
  const committed = transport.committed
  if (committed && now >= committed.at) {
    transport.retiring.push({
      voices: transport.voices,
      at: committed.at + (committed.fadeBeats * 60) / transport.program.definition.bpm,
    })
    transport.voices = committed.voices
    transport.section = committed.prepared!
    const marker = committed.entryMarker
      ? transport.section.definition.markers.find((m) => m.id === committed.entryMarker)!.tick
      : 0
    transport.sectionStartTick = committed.tick - marker
    transport.lastCommand = committed.id
    committed.state = 'done'
    transport.committed = null
    state.trace.write(0, committed.at, 'music-transition', committed.id, committed.section)
  }
}

export function updateMusic(world: World): void {
  const state = musicState(world),
    runtime = runtimeOf(world),
    now = runtime.clock.now()
  for (let i = 0; i < state.transports.length; i++) {
    const transport = state.transports[i]!
    if (transport.stopped || transport.paused) continue
    transport.parameters.update(Math.max(0, now - transport.lastWake))
    transport.lastWake = now
    let write = 0
    for (let j = 0; j < transport.retiring.length; j++) {
      const retired = transport.retiring[j]!
      if (now >= retired.at) {
        for (let v = 0; v < retired.voices.length; v++) runtime.cancel(retired.voices[v]!.id)
      } else transport.retiring[write++] = retired
    }
    transport.retiring.length = write
    write = 0
    for (let j = 0; j < transport.stingers.length; j++)
      if (transport.stingers[j]!.end > now) transport.stingers[write++] = transport.stingers[j]!
    transport.stingers.length = write
    reconcileMusic(world, transport, now)
    for (let v = 0; v < transport.voices.length; v++) {
      const voice = transport.voices[v]!,
        gain = stemGain(state, transport, voice.stem)
      if (gain !== voice.gain && !transport.committed) {
        voice.command.at = now
        voice.command.value = gain
        runtime.automate(voice.id, voice.command)
        voice.gain = gain
      }
    }
    const decision = Math.floor(tickNow(transport, now) / MUSIC_PPQ)
    if (!transport.pending && !transport.committed && decision > transport.lastDecision) {
      transport.lastDecision = decision
      let chosen: MusicProgramDefinition['transitions'][number] | null = null
      const transitions = transport.program.definition.transitions
      for (let r = 0; r < transitions.length; r++) {
        const rule = transitions[r]!
        if (
          rule.from !== transport.section.definition.id ||
          (rule.to === rule.from && !rule.reenter)
        )
          continue
        const value = rule.parameter
          ? (transport.parameters.indices.has(rule.parameter)
              ? transport.parameters
              : transport.program.globals
            ).values[
              (transport.parameters.indices.has(rule.parameter)
                ? transport.parameters
                : transport.program.globals
              ).index(rule.parameter)
            ]!
          : 0
        if (rule.parameter && (value < rule.min || value > rule.max)) continue
        if (
          !chosen ||
          rule.priority > chosen.priority ||
          (rule.priority === chosen.priority && rule.id < chosen.id)
        )
          chosen = rule
      }
      if (chosen)
        requestMusicSection(world, transport.id, chosen.to, {
          quantize: chosen.quantize,
          entryMarker: chosen.entryMarker,
          fadeBeats: chosen.fadeBeats,
          curve: chosen.curve,
          reenter: chosen.reenter,
        })
    }
    const request = transport.pending
    if (
      !request ||
      transport.committed ||
      request.state === 'failed' ||
      request.state === 'cancelled'
    )
      continue
    if (!request.prepared) {
      request.prepared = transport.program.sections.get(request.section) ?? null
      if (request.prepared) request.state = 'pending'
    }
    if (request.at - state.commitLead < now - 1 / transport.rate) {
      transport.misses++
      state.trace.write(0, now, 'music-late', request.id, request.section)
      if (request.late === 'drop') {
        request.state = 'cancelled'
        transport.pending = null
        continue
      }
      const next = boundary(
        transport,
        request.late === 'immediate-crossfade' ? 'immediate' : request.quantize,
        now + state.commitLead + 1 / transport.rate,
      )
      request.at = next.at
      request.tick = next.tick
    }
    if (!request.prepared || request.at > now + state.lookahead) continue
    const phase = request.entryMarker
      ? request.prepared.definition.markers.find((m) => m.id === request.entryMarker)!.tick
      : 0
    const fade = (request.fadeBeats * 60) / transport.program.definition.bpm
    try {
      request.voices = startSection(
        world,
        transport,
        request.prepared,
        request.at,
        phase,
        fade,
        request.curve,
      )
      for (let v = 0; v < transport.voices.length; v++)
        runtime.automate(transport.voices[v]!.id, {
          property: 'envelope',
          at: request.at,
          value: 0,
          duration: fade,
          curve: request.curve === 'linear' ? 'linear' : 'equal-power-out',
        })
      request.state = 'committed'
      transport.committed = request
      transport.pending = null
      state.trace.write(0, request.at, 'music-commit', request.id, request.section)
    } catch (error) {
      for (const voice of request.voices) runtime.cancel(voice.id)
      for (const voice of transport.voices)
        runtime.automate(voice.id, { property: 'envelope', at: now, value: 1, duration: 0.01 })
      request.state = 'failed'
      request.error = error instanceof ShardError ? error.code : 'audio/music-unprepared'
      transport.pending = null
      state.trace.write(0, now, 'music-reject', request.id, request.section, -1, request.error)
    }
  }
  let count = 0
  for (let i = 0; i < state.transports.length; i++)
    if (!state.transports[i]!.stopped) state.transports[count++] = state.transports[i]!
  state.transports.length = count
}

export function describeMusic(world: World) {
  const state = musicState(world),
    now = runtimeOf(world).clock.now()
  for (const transport of state.transports)
    if (!transport.stopped && !transport.paused) reconcileMusic(world, transport, now)
  return {
    lookahead: state.lookahead,
    commitLead: state.commitLead,
    interval: state.interval,
    transports: state.transports
      .filter((t) => !t.stopped)
      .map((t) => ({
        id: t.id,
        program: t.program.key,
        section: t.section.definition.id,
        bpm: t.program.definition.bpm,
        epoch: t.epoch,
        tick: t.paused
          ? t.phase
          : Math.max(0, tickNow(t, now) - t.sectionStartTick) % t.section.ticks,
        paused: t.paused,
        stems: t.voices.map((v) => ({
          id: v.id,
          stem: v.stem.definition.id,
          gain: v.gain,
          rate: v.stem.rate,
          presentation: runtimeOf(world).presentation(v.id),
        })),
        misses: t.misses,
        pending: t.pending
          ? { id: t.pending.id, at: t.pending.at, state: t.pending.state, error: t.pending.error }
          : null,
        committed: t.committed
          ? { id: t.committed.id, at: t.committed.at, section: t.committed.section }
          : null,
      })),
    trace: state.trace.read(),
  }
}

export function audioMusicPlugin(
  options: { lookahead?: number; interval?: number; commitLead?: number } = {},
) {
  return definePlugin({
    name: 'audio/music',
    dependencies: ['audio/events'],
    provides: [{ MusicProgram, AudioMusicState }],
    build(app) {
      app.world.initResource(AudioInspectors).set('music', describeMusic)
      app.addMethod(...audioMusicMethods)
      const lookahead = options.lookahead ?? 0.1,
        interval = options.interval ?? 0.025,
        commitLead = options.commitLead ?? 0.02
      audioNumber(commitLead, 'commitLead', 0.001, 1)
      audioNumber(interval, 'interval', 0.001, 1)
      audioNumber(lookahead, 'lookahead', commitLead + interval, 2)
      app.world.initResource(MusicProgram.store)
      const state: MusicStateValue = {
        programs: new Map(),
        transports: [],
        nextProgram: 1,
        nextTransport: 1,
        nextCommand: 1,
        lookahead,
        interval,
        commitLead,
        trace: new AudioTrace(),
        scratch: new Float64Array(1),
        wake: null,
        disposed: false,
      }
      app.world.insertResource(AudioMusicState, state)
      state.wake = runtimeOf(app.world).clock.wake(() => updateMusic(app.world), interval)
    },
    dispose(app) {
      const state = musicState(app.world)
      state.disposed = true
      state.wake?.()
      for (const transport of state.transports)
        if (!transport.stopped) stopMusic(app.world, transport.id)
      for (const program of state.programs.values()) program.release()
    },
  })
}
