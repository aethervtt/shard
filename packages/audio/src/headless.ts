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
  envelope: number
  stopped: boolean
  /** Fade the stop asked for, in seconds. */
  fade: number
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
  private readonly prepared = new Map<AudioClipSource, { pins: number; bytes: number }>()
  private readonly voicePins = new Map<number, AudioClipSource>()
  private budgetBytes: number
  private maxVoices: number
  private mixer: AudioMixerGraph | null = null
  private readonly mixValues = new Map<string, number>()
  private readonly automation = new Map<
    number,
    Map<string, { command: AudioAutomation; start: number }>
  >()

  constructor(options: AudioSessionOptions = {}) {
    this.budgetBytes = options.decodedBudgetBytes ?? 64 * 1024 * 1024
    this.maxVoices = options.maxVoices ?? 64
    this.clock = {
      now: () => this.seconds,
      wake: (callback, interval) => {
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
    for (const [id, commands] of this.automation) {
      const voice = this.byId.get(id)
      if (!voice) continue
      for (const [property, automation] of commands) {
        const value = this.automationValue(automation, this.seconds)
        if (property === 'envelope') voice.envelope = value
        else if (property === 'gain') voice.params.gain = value
        else if (property === 'pitch') voice.params.pitch = value
      }
    }
    for (const [callback, wake] of this.wakes)
      if (this.seconds >= wake.next) {
        wake.next = this.seconds + wake.interval
        callback()
      }
    for (const [id, scheduled] of this.schedules) {
      const status = this.statuses.get(id)!
      if (this.seconds >= scheduled.end) this.stop(id)
      else if (this.seconds >= status.scheduledAt) status.state = 'rendering'
    }
  }

  async prepare(clip: AudioClipSource) {
    let record = this.prepared.get(clip)
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
      record = { pins: 0, bytes }
      this.prepared.set(clip, record)
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
    for (const [clip, record] of this.prepared) {
      decodedBytes += record.bytes
      encodedBytes += clip.bytes.byteLength
      if (record.pins) pinned++
      else evictable++
    }
    return {
      decodedBytes,
      encodedBytes,
      pinned,
      evictable,
      budgetBytes: this.budgetBytes,
      loading: 0,
      voices: this.byId.size,
      nodes: 0,
      urls: 0,
    }
  }

  async flush(): Promise<void> {}

  presentation(id: number) {
    return this.statuses.get(id)
  }

  reconfigure(id: number, desc: AudioVoiceDesc): boolean {
    const voice = this.byId.get(id)
    if (!voice) return false
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

  private automationValue(
    automation: { command: AudioAutomation; start: number },
    now: number,
  ): number {
    const { command, start } = automation
    if (now < command.at) return start
    const t =
      command.duration > 0 ? Math.max(0, Math.min(1, (now - command.at) / command.duration)) : 1
    if (command.curve === 'equal-power-in')
      return start + (command.value - start) * Math.sin((t * Math.PI) / 2)
    if (command.curve === 'equal-power-out')
      return command.value + (start - command.value) * Math.cos((t * Math.PI) / 2)
    if (command.curve === 'exponential' && start > 0 && command.value > 0)
      return start * (command.value / start) ** t
    return start + (command.value - start) * t
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
    const start = previous
      ? this.automationValue(previous, command.at)
      : command.property === 'gain'
        ? voice.params.gain
        : command.property === 'pitch'
          ? voice.params.pitch
          : command.property === 'lowpass'
            ? 20000
            : 0
    commands.set(command.property, { command: { ...command }, start })
    const value = this.automationValue({ command, start }, this.seconds)
    if (command.property === 'envelope') voice.envelope = value
    else if (command.property === 'gain') voice.params.gain = value
    else if (command.property === 'pitch') voice.params.pitch = value
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
  readonly state = 'headless' as const
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

  play(desc: AudioScheduledVoice): number {
    if (this.byId.size >= this.maxVoices)
      throw new ShardError('audio/capacity', 'Physical voice limit reached', {
        hint: 'Stop or virtualize a voice before starting another.',
      })
    const voice: HeadlessVoice = {
      id: this.next++,
      clip: desc.clip.id,
      bus: desc.bus,
      loop: desc.loop,
      offset: desc.offset,
      spatial: desc.spatial,
      params: { gain: desc.gain, pitch: desc.pitch, x: desc.x, y: desc.y, z: desc.z },
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
    const prepared = this.prepared.get(desc.clip)
    if (prepared) {
      prepared.pins++
      this.voicePins.set(voice.id, desc.clip)
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
