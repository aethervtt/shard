import type {
  AudioBackend,
  AudioSpatialDesc,
  AudioVoiceDesc,
  AudioVoiceParams,
} from '@shard/platform'
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
  stopped: boolean
  /** Fade the stop asked for, in seconds. */
  fade: number
}

const scratch = new Float64Array(2)

/**
 * The backend for Node, tests, and the CLI: no sound, just a record of every voice, and the gain
 * and pan the Web Audio graph (bus gain node, PannerNode) would compute for it.
 */
export class HeadlessAudioBackend implements AudioBackend {
  readonly kind = 'headless'
  readonly state = 'headless' as const
  /** Every voice ever played, in order. */
  readonly history: HeadlessVoice[] = []
  readonly buses = new Map<string, number>()
  readonly listener = new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0])
  private readonly byId = new Map<number, HeadlessVoice>()
  private next = 1

  play(desc: AudioVoiceDesc): number {
    const voice: HeadlessVoice = {
      id: this.next++,
      clip: desc.clip.id,
      bus: desc.bus,
      loop: desc.loop,
      offset: desc.offset,
      spatial: desc.spatial,
      params: { gain: desc.gain, pitch: desc.pitch, x: desc.x, y: desc.y, z: desc.z },
      stopped: false,
      fade: 0,
    }
    this.history.push(voice)
    this.byId.set(voice.id, voice)
    return voice.id
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
  }

  setListener(matrix: ArrayLike<number>): void {
    for (let i = 0; i < 12; i++) this.listener[i] = matrix[i]!
  }

  setBus(name: string, gain: number): void {
    this.buses.set(name, gain)
  }

  /** Voices playing now. */
  get active(): HeadlessVoice[] {
    return [...this.byId.values()]
  }

  /** What the graph outputs for a voice: gain after bus and distance, and equal-power pan. */
  measure(voice: HeadlessVoice): { gain: number; pan: number } {
    const bus = this.buses.get(voice.bus) ?? 1
    const s = voice.spatial
    if (!s) return { gain: voice.params.gain * bus, pan: 0 }
    listenerRelative(this.listener, voice.params.x, voice.params.y, voice.params.z, scratch)
    const d = distanceGain(
      s.distanceModel,
      scratch[0]!,
      s.refDistance,
      s.maxDistance,
      s.rolloffFactor,
    )
    return { gain: voice.params.gain * bus * d, pan: scratch[1]! }
  }
}

export function createHeadlessAudioBackend(): HeadlessAudioBackend {
  return new HeadlessAudioBackend()
}
