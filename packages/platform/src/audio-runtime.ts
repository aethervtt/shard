import type { AudioClipSource, AudioVoiceDesc, AudioVoiceParams } from './index'

/** Optional, host-neutral extensions. Legacy AudioBackend implementations remain valid. */
export interface AudioCapabilities {
  scheduled: boolean
  automation: boolean
  mixer: boolean
  media: boolean
  meters: boolean
  offline: boolean
  sessions: boolean
}

export interface AudioClock {
  /** Seconds on the rendering clock, frozen while the context is suspended. */
  now(): number
  /** Independent of rendering frames. Returns an idempotent unsubscribe. */
  wake(callback: () => void, intervalSeconds: number): () => void
}

export interface AudioPreparation {
  readonly clip: AudioClipSource
  readonly decodedBytes: number
  readonly encodedBytes: number
  readonly sampleRate: number
  readonly samples: number
  readonly channels: number
  readonly released: boolean
  release(): void
}

export interface AudioMemory {
  encodedBytes: number
  decodedBytes: number
  budgetBytes: number
  loading: number
  pinned: number
  evictable: number
  voices: number
  nodes: number
  urls: number
}

export type AudioPresentationState =
  | 'preparing'
  | 'blocked'
  | 'scheduled'
  | 'rendering'
  | 'stopping'
  | 'ended'
  | 'failed'

export interface AudioPresentation {
  state: AudioPresentationState
  scheduledAt: number
  endedAt: number
  error: string | null
}

export interface AudioScheduledVoice extends AudioVoiceDesc {
  /** Absolute rendering-clock time. Omitted means immediate, preserving the old API. */
  when?: number
  /** Duration in output seconds, not clip seconds. */
  duration?: number
  lowpass?: number
  highpass?: number
}

export type AudioAutomationProperty = 'gain' | 'envelope' | 'pitch' | 'lowpass' | 'highpass'

export interface AudioAutomation {
  property: AudioAutomationProperty
  at: number
  value: number
  duration: number
  curve?: 'linear' | 'exponential' | 'equal-power-in' | 'equal-power-out'
}

export interface AudioSessionOptions {
  maxVoices?: number
  decodedBudgetBytes?: number
  maxDecodes?: number
  priority?: number
}

export interface AudioEffectDesc {
  id: string
  kind: 'lowpass' | 'highpass' | 'peaking' | 'compressor' | 'delay' | 'reverb'
  frequency: number
  q: number
  gainDb: number
  threshold: number
  ratio: number
  attack: number
  release: number
  seconds: number
  feedback: number
  tailSeconds: number
  ir?: AudioClipSource
}

export interface AudioSendDesc {
  target: string
  gain: number
  pre: boolean
}

export interface AudioBusDesc {
  id: string
  parent: string
  gain: number
  userGain: number
  effects: readonly AudioEffectDesc[]
  sends: readonly AudioSendDesc[]
  return: boolean
}

export interface AudioMixerGraph {
  buses: readonly AudioBusDesc[]
  maxNodes: number
}

export interface AudioMeter {
  available: boolean
  peak: number
  rms: number
  samples: number
  sampleRate: number
  at: number
}

export interface AudioRuntimeExtension {
  readonly capabilities: Readonly<AudioCapabilities>
  readonly clock: AudioClock
  readonly activeVoices: number
  prepare(clip: AudioClipSource): Promise<AudioPreparation>
  /** Reclaims unpinned cache entries. Active voices retain their own pins. */
  collect(): void
  memory(): AudioMemory
  play(desc: AudioScheduledVoice): number
  /** Waits until all requested source starts have been prepared and submitted, or rejects on failure. */
  flush(): Promise<void>
  presentation(id: number): Readonly<AudioPresentation> | undefined
  /** In-place route/loop/spatial edits; false asks the caller to recreate at the current phase. */
  reconfigure(id: number, desc: AudioVoiceDesc): boolean
  automate(id: number, command: AudioAutomation): void
  /** Cancels a scheduled start; stops an already audible voice, with a truthful result. */
  cancel(id: number): 'cancelled' | 'already-started' | 'ended'
  configureMixer(graph: AudioMixerGraph): Promise<void>
  setMixerValue(bus: string, field: string, value: number, rampSeconds: number): void
  meter(bus: string): AudioMeter
  /** Headless clocks are explicitly advanced; live clocks ignore this. */
  advance?(seconds: number): void
  update(id: number, params: AudioVoiceParams): void
}
