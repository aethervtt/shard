import { ShardError } from '@aethervtt/shard-core'
import type {
  AudioAutomation,
  AudioBackend,
  AudioClipSource,
  AudioClock,
  AudioMixerGraph,
  AudioPresentation,
  AudioRuntimeExtension,
  AudioScheduledVoice,
  AudioSessionOptions,
  AudioSpatialDesc,
  AudioVoiceDesc,
  AudioVoiceParams,
} from '@aethervtt/shard-platform'
import { distanceGain, listenerRelative } from './spatial'

/** One voice the headless backend was asked to play, with what a Web Audio graph would make of it. */
export interface HeadlessVoice {
  id: number
  clip: string
  bus: string
  loop: boolean
  offset: number
  spatial: AudioSpatialDesc | null
  /** Latest parameters (volume × occlusion, pitch, position). */
  params: AudioVoiceParams
  sends: Map<string, number>
  envelope: number
  stopped: boolean
  /** Fade the stop asked for, in seconds. */
  fade: number
}

interface AutomationTrack {
  command: AudioAutomation
  start: number
  previous: AutomationTrack | null
}
const scratch = new Float64Array(2)

/**
 * The backend for Node, tests, and the CLI: no sound, just a record of every voice, and the gain
 * and pan the Web Audio graph (bus gain node, PannerNode) would compute for it.
 */
export class HeadlessAudioBackend implements AudioBackend, AudioRuntimeExtension {
  readonly runtime = this
  readonly capabilities = {
    scheduled: true,
    automation: true,
    mixer: true,
    media: false,
    meters: false,
    offline: false,
    sessions: false,
  }
  readonly clock: AudioClock
  private seconds = 0
  private readonly wakes = new Map<() => void, { interval: number; next: number }>()
  private readonly statuses = new Map<number, AudioPresentation>()
  private readonly schedules = new Map<number, { desc: AudioScheduledVoice; end: number }>()
  private readonly prepared = new Map<
    Uint8Array | string,
    { pins: number; bytes: number; encoded: number }
  >()
  private readonly voicePins = new Map<number, Uint8Array | string>()
  private budgetBytes: number
  private maxVoices: number
  private mixer: AudioMixerGraph | null = null
  private readonly mixValues = new Map<string, number>()
  private readonly automation = new Map<number, Map<string, AutomationTrack>>()

  constructor(options: AudioSessionOptions = {}) {
    this.budgetBytes = options.decodedBudgetBytes ?? 64 * 1024 * 1024
    this.maxVoices = options.maxVoices ?? 64
    this.clock = {
      now: () => this.seconds,
      wallNow: () => this.seconds,
      wake: (callback, interval) => {
        if (!Number.isFinite(interval) || interval <= 0)
          throw new ShardError('audio/invalid-range', 'Wake interval must be positive')
        this.wakes.set(callback, { interval, next: this.seconds + interval })
        return () => {
          this.wakes.delete(callback)
        }
      },
    }
  }

  advance(seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0)
      throw new ShardError('audio/invalid-range', 'Clock delta must be finite and nonnegative')
    this.seconds += seconds
    this.automation.forEach(this.advanceVoice)
    this.wakes.forEach(this.advanceWake)
    this.schedules.forEach(this.advanceSchedule)
  }

  // Map.forEach reuses these callbacks; Map entry iterators allocate tuples on every tick.
  private automationVoice: HeadlessVoice | null = null
  private readonly advanceVoice = (commands: Map<string, AutomationTrack>, id: number): void => {
    this.automationVoice = this.byId.get(id) ?? null
    if (this.automationVoice) commands.forEach(this.advanceProperty)
  }
  private readonly advanceProperty = (track: AutomationTrack, property: string): void => {
    const voice = this.automationVoice!
    this.sampleAutomation(track, this.seconds)
    if (property === 'envelope') voice.envelope = this.automationScratch[0]!
    else if (property === 'gain') voice.params.gain = this.automationScratch[0]!
    else if (property === 'pitch') voice.params.pitch = this.automationScratch[0]!
    if (this.seconds >= track.command.at) track.previous = null
  }
  private readonly advanceWake = (
    wake: { interval: number; next: number },
    callback: () => void,
  ): void => {
    if (this.seconds >= wake.next) {
      wake.next = this.seconds + wake.interval
      callback()
    }
  }
  private readonly advanceSchedule = (
    scheduled: { desc: AudioScheduledVoice; end: number },
    id: number,
  ): void => {
    const status = this.statuses.get(id)!
    if (this.seconds >= scheduled.end) this.stop(id)
    else if (this.seconds >= status.scheduledAt && status.state !== 'stopping')
      status.state = 'rendering'
  }

  private reserved = 0
  setDecodedBudget(bytes: number): void {
    if (!Number.isFinite(bytes) || bytes < this.memory().decodedBytes)
      throw new ShardError('audio/memory-budget', 'Budget is invalid or below resident PCM')
    this.budgetBytes = bytes
  }
  reserveVoices(count: number): () => void {
    if (
      !Number.isInteger(count) ||
      count < 1 ||
      this.byId.size + this.reserved + count > this.maxVoices
    )
      throw new ShardError('audio/capacity', 'Physical voice reservation cannot fit')
    const previous = this.reserved
    this.reserved += count
    let released = false
    return () => {
      if (!released) {
        released = true
        this.reserved = Math.min(previous, this.reserved)
      }
    }
  }

  async prepare(clip: AudioClipSource) {
    const key = clip.url ?? clip.bytes
    let record = this.prepared.get(key)
    const rate = clip.sampleRate ?? 48000
    const channels = clip.channels ?? 1
    const samples = Math.ceil(clip.duration * rate)
    if (!record) {
      const bytes = clip.stream ? 0 : samples * channels * 4
      if (this.memory().decodedBytes + bytes > this.budgetBytes) this.collect()
      if (this.memory().decodedBytes + bytes > this.budgetBytes) {
        throw new ShardError('audio/memory-budget', 'Prepared audio exceeds the decoded budget', {
          hint: 'Release unused preparation leases or increase decodedBudgetMiB.',
        })
      }
      record = { pins: 0, bytes, encoded: clip.bytes.byteLength }
      this.prepared.set(key, record)
    }
    record.pins++
    let released = false
    return {
      clip,
      decodedBytes: record.bytes,
      encodedBytes: clip.bytes.byteLength,
      sampleRate: rate,
      samples,
      channels,
      get released() {
        return released
      },
      release: () => {
        if (!released) {
          released = true
          record.pins--
        }
      },
    }
  }

  collect(): void {
    for (const [clip, record] of this.prepared) if (record.pins === 0) this.prepared.delete(clip)
  }

  memory() {
    let decodedBytes = 0
    let encodedBytes = 0
    let pinned = 0
    let evictable = 0
    for (const record of this.prepared.values()) {
      decodedBytes += record.bytes
      encodedBytes += record.encoded
      if (record.pins) pinned++
      else evictable++
    }
    return {
      decodedBytes,
      encodedBytes,
      effectBytes: 0,
      pinned,
      evictable,
      budgetBytes: this.budgetBytes,
      loading: 0,
      voices: this.byId.size,
      nodes: 0,
      urls: 0,
    }
  }

  get activeVoices(): number {
    return this.byId.size
  }

  async flush(): Promise<void> {}

  presentation(id: number) {
    return this.statuses.get(id)
  }

  reconfigure(id: number, desc: AudioVoiceDesc): boolean {
    const voice = this.byId.get(id)
    if (!voice) return false
    this.validateRoutes(desc)
    voice.sends.clear()
    for (const send of desc.sends ?? []) voice.sends.set(send.target, send.gain)
    voice.bus = desc.bus
    voice.loop = desc.loop
    voice.spatial = desc.spatial
    const schedule = this.schedules.get(id)
    if (schedule) {
      schedule.desc = { ...schedule.desc, ...desc }
      schedule.end = desc.loop
        ? Number.POSITIVE_INFINITY
        : this.seconds + Math.max(0, desc.clip.duration - desc.offset) / desc.pitch
    }
    return true
  }

  private readonly automationScratch = new Float64Array(1)
  private sampleAutomation(track: AutomationTrack, now: number): void {
    while (now < track.command.at && track.previous) track = track.previous
    const { command, start } = track
    if (now < command.at) {
      this.automationScratch[0] = start
      return
    }
    const t =
      command.duration > 0 ? Math.max(0, Math.min(1, (now - command.at) / command.duration)) : 1
    let value = start + (command.value - start) * t
    if (command.curve === 'equal-power-in')
      value = start + (command.value - start) * Math.sin((t * Math.PI) / 2)
    else if (command.curve === 'equal-power-out')
      value = command.value + (start - command.value) * Math.cos((t * Math.PI) / 2)
    else if (command.curve === 'exponential' && start > 0 && command.value > 0)
      value = start * (command.value / start) ** t
    this.automationScratch[0] = value
  }

  setVoiceSend(id: number, target: string, gain: number, seconds: number): void {
    if (!Number.isFinite(gain) || gain < 0 || gain > 16 || !Number.isFinite(seconds) || seconds < 0)
      throw new ShardError('audio/invalid-range', 'Invalid voice send automation')
    const voice = this.byId.get(id)
    if (!voice?.sends.has(target))
      throw new ShardError('audio/unknown-bus', `Missing voice send ${target}`)
    voice.sends.set(target, gain)
  }

  automate(id: number, command: AudioAutomation): void {
    const voice = this.byId.get(id)
    if (!voice) return
    let commands = this.automation.get(id)
    if (!commands) {
      commands = new Map()
      this.automation.set(id, commands)
    }
    const previous = commands.get(command.property)
    if (previous) this.sampleAutomation(previous, command.at)
    const start = previous
      ? this.automationScratch[0]!
      : command.property === 'gain'
        ? voice.params.gain
        : command.property === 'pitch'
          ? voice.params.pitch
          : command.property === 'envelope'
            ? voice.envelope
            : command.property === 'lowpass'
              ? 20000
              : 0
    // An immediate change replaces any future command. Future commands preserve the earlier curve.
    const track =
      previous && command.at <= this.seconds
        ? previous
        : { command: { ...command }, start, previous: previous ?? null }
    track.start = start
    if (track === previous) {
      Object.assign(track.command, command)
      track.command.curve = command.curve
      track.previous = null
    }
    commands.set(command.property, track)
    this.automationVoice = voice
    this.advanceProperty(track, command.property)
  }

  cancel(id: number): 'cancelled' | 'already-started' | 'ended' {
    const status = this.statuses.get(id)
    if (!status || status.state === 'ended') return 'ended'
    const result = this.seconds >= status.scheduledAt ? 'already-started' : 'cancelled'
    this.stop(id)
    return result
  }

  async configureMixer(graph: AudioMixerGraph): Promise<void> {
    this.mixer = graph
    this.mixValues.clear()
    for (const bus of graph.buses) {
      this.mixValues.set(`${bus.id}/gain`, bus.gain)
      this.mixValues.set(`${bus.id}/userGain`, bus.userGain)
    }
    this.refreshMix()
  }

  private refreshMix(): void {
    if (!this.mixer) return
    for (const bus of this.mixer.buses) {
      let current = bus,
        gain = 1,
        depth = 0
      while (true) {
        if (++depth > this.mixer.buses.length)
          throw new ShardError('audio/mixer-cycle', 'Mixer contains a cycle')
        gain *=
          (this.mixValues.get(`${current.id}/gain`) ?? 1) *
          (this.mixValues.get(`${current.id}/userGain`) ?? 1)
        if (!current.parent) break
        const next = this.mixer.buses.find((item) => item.id === current.parent)
        if (!next) throw new ShardError('audio/unknown-bus', `Unknown parent ${current.parent}`)
        current = next
      }
      this.buses.set(bus.id, gain)
    }
  }

  setMixerValue(bus: string, field: string, value: number): void {
    this.mixValues.set(`${bus}/${field}`, value)
    this.refreshMix()
  }

  meter(_bus: string) {
    return { available: false, peak: 0, rms: 0, samples: 0, sampleRate: 0, at: this.seconds }
  }

  dispose(): void {
    for (const id of this.byId.keys()) this.stop(id)
    this.wakes.clear()
    this.prepared.clear()
    this.buses.clear()
    this.statuses.clear()
    this.schedules.clear()
    this.mixer = null
  }
  readonly kind = 'headless'
  readonly state: AudioBackend['state'] = 'headless'
  /** Bounded completed/started history; materialized in order only when inspected. */
  private readonly records: HeadlessVoice[] = []
  private historyCursor = 0
  get history(): HeadlessVoice[] {
    if (this.records.length < 4096) return this.records.slice()
    const start = this.historyCursor % 4096
    return [...this.records.slice(start), ...this.records.slice(0, start)]
  }
  /** Ids of the clips preloadSound got ready, in order. */
  readonly preloaded: string[] = []
  readonly buses = new Map<string, number>()
  readonly listener = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  private readonly byId = new Map<number, HeadlessVoice>()
  private next = 1

  private validateRoutes(desc: AudioVoiceDesc): void {
    if (
      (desc.sends?.length ?? 0) > 8 ||
      new Set(desc.sends?.map((send) => send.target)).size !== (desc.sends?.length ?? 0)
    )
      throw new ShardError('audio/capacity', 'At most eight unique voice sends')
    for (const send of desc.sends ?? [])
      if (
        !Number.isFinite(send.gain) ||
        send.gain < 0 ||
        send.gain > 16 ||
        !this.mixer?.buses
          .find((bus) => bus.id === desc.bus)
          ?.sends.some((route) => route.target === send.target)
      )
        throw new ShardError('audio/unknown-bus', `Invalid voice send ${desc.bus}/${send.target}`)
  }

  play(desc: AudioScheduledVoice): number {
    this.validateRoutes(desc)
    if (this.byId.size >= this.maxVoices)
      throw new ShardError('audio/capacity', 'Physical voice limit reached', {
        hint: 'Stop or virtualize a voice before starting another.',
      })
    if (this.reserved > 0) this.reserved--
    const voice: HeadlessVoice = {
      id: this.next++,
      clip: desc.clip.id,
      bus: desc.bus,
      loop: desc.loop,
      offset: desc.offset,
      spatial: desc.spatial,
      params: { gain: desc.gain, pitch: desc.pitch, x: desc.x, y: desc.y, z: desc.z },
      sends: new Map(desc.sends?.map((send) => [send.target, send.gain])),
      envelope: 1,
      stopped: false,
      fade: 0,
    }
    if (this.records.length < 4096) this.records.push(voice)
    else this.records[this.historyCursor % 4096] = voice
    this.historyCursor++
    this.byId.set(voice.id, voice)
    const at = desc.when ?? this.seconds
    this.statuses.set(voice.id, {
      state: at > this.seconds ? 'scheduled' : 'rendering',
      scheduledAt: at,
      endedAt: -1,
      error: null,
    })
    // Immediate legacy voices are advanced by the engine. Scheduled voices have a backend clock.
    if (desc.when !== undefined)
      this.schedules.set(voice.id, {
        desc,
        end:
          desc.duration !== undefined
            ? at + desc.duration
            : desc.loop
              ? Number.POSITIVE_INFINITY
              : at + (desc.clip.duration - desc.offset) / desc.pitch,
      })
    const key = desc.clip.url ?? desc.clip.bytes
    const prepared = this.prepared.get(key)
    if (prepared) {
      prepared.pins++
      this.voicePins.set(voice.id, key)
    }
    if (this.statuses.size > 4096) {
      for (const [id, status] of this.statuses)
        if (status.state === 'ended') {
          this.statuses.delete(id)
          if (this.statuses.size <= 4096) break
        }
    }
    return voice.id
  }

  preload(clip: AudioClipSource): void {
    if (this.preloaded.length === 4096) this.preloaded.shift()
    this.preloaded.push(clip.id)
  }

  update(id: number, params: AudioVoiceParams): void {
    const p = this.byId.get(id)?.params
    if (!p) return
    p.gain = params.gain
    p.pitch = params.pitch
    p.x = params.x
    p.y = params.y
    p.z = params.z
  }

  stop(id: number, fade = 0): void {
    const voice = this.byId.get(id)
    if (!voice) return
    voice.stopped = true
    voice.fade = fade
    const schedule = this.schedules.get(id)
    if (fade > 0 && schedule && this.seconds >= this.statuses.get(id)!.scheduledAt) {
      this.automate(id, { property: 'envelope', at: this.seconds, value: 0, duration: fade })
      schedule.end = Math.min(schedule.end, this.seconds + fade)
      this.statuses.get(id)!.state = 'stopping'
      return
    }
    this.byId.delete(id)
    const status = this.statuses.get(id)
    if (status) {
      status.state = 'ended'
      status.endedAt = this.seconds
    }
    this.schedules.delete(id)
    this.automation.delete(id)
    const clip = this.voicePins.get(id)
    if (clip) {
      const prepared = this.prepared.get(clip)
      if (prepared) prepared.pins--
      this.voicePins.delete(id)
    }
  }

  setListener(matrix: ArrayLike<number>): void {
    for (let i = 0; i < 12; i++) this.listener[i] = matrix[i]!
  }

  setBus(name: string, gain: number): void {
    if (!this.mixer) this.buses.set(name, gain)
  }

  /** Voices playing now. */
  get active(): HeadlessVoice[] {
    return [...this.byId.values()]
  }

  /** What the graph outputs for a voice: gain after bus and distance, and equal-power pan. */
  measure(voice: HeadlessVoice): { gain: number; pan: number } {
    const bus = this.buses.get(voice.bus) ?? 1
    const s = voice.spatial
    if (!s) return { gain: voice.params.gain * voice.envelope * bus, pan: 0 }
    listenerRelative(this.listener, voice.params.x, voice.params.y, voice.params.z, scratch)
    const d = distanceGain(
      s.distanceModel,
      scratch[0]!,
      s.refDistance,
      s.maxDistance,
      s.rolloffFactor,
    )
    return { gain: voice.params.gain * voice.envelope * bus * d, pan: scratch[1]! }
  }
}

export function createHeadlessAudioBackend(): HeadlessAudioBackend {
  return new HeadlessAudioBackend()
}
