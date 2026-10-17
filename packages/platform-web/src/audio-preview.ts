import { ShardError } from '@aethervtt/shard-core'
import type {
  AudioAutomation,
  AudioMixerGraph,
  AudioScheduledVoice,
} from '@aethervtt/shard-platform'
import { createWebAudioBackend } from './audio'

export interface AudioRenderPlan {
  duration: number
  tailSeconds?: number
  sampleRate?: number
  channels?: 1 | 2
  mixer?: AudioMixerGraph
  voices: AudioScheduledVoice[]
  automation?: { voice: number; command: AudioAutomation }[]
  maxOutputBytes?: number
  decodedBudgetBytes?: number
}

/** Measurements use the floating-point render, before PCM16 quantization/clipping. */
export function measureAudioBuffer(buffer: AudioBuffer) {
  let peak = 0,
    square = 0,
    clipped = 0,
    nonfinite = 0
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel)
    for (let i = 0; i < data.length; i++) {
      const sample = data[i]!
      if (!Number.isFinite(sample)) {
        nonfinite++
        continue
      }
      peak = Math.max(peak, Math.abs(sample))
      square += sample * sample
      if (Math.abs(sample) > 1) clipped++
    }
  }
  return {
    peak,
    rms: Math.sqrt(square / (buffer.length * buffer.numberOfChannels)),
    clipped,
    nonfinite,
    sampleRate: buffer.sampleRate,
    channels: buffer.numberOfChannels,
    frames: buffer.length,
    duration: buffer.duration,
  }
}

export function audioBufferWav(buffer: AudioBuffer): Uint8Array {
  const channels = buffer.numberOfChannels,
    size = buffer.length * channels * 2
  const bytes = new Uint8Array(44 + size),
    view = new DataView(bytes.buffer)
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i)
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + size, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, buffer.sampleRate, true)
  view.setUint32(28, buffer.sampleRate * channels * 2, true)
  view.setUint16(32, channels * 2, true)
  view.setUint16(34, 16, true)
  text(36, 'data')
  view.setUint32(40, size, true)
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c)
    for (let i = 0; i < buffer.length; i++) {
      const value = Math.max(-1, Math.min(1, data[i]!))
      view.setInt16(
        44 + (i * channels + c) * 2,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      )
    }
  }
  return bytes
}

/** Same source/graph implementation as live playback. No sound card, microphone or GPU. */
export async function renderAudioPreview(plan: AudioRenderPlan) {
  const duration = plan.duration + (plan.tailSeconds ?? 0),
    sampleRate = plan.sampleRate ?? 48000,
    channels = plan.channels ?? 2
  const frames = Math.ceil(duration * sampleRate)
  if (
    !Number.isFinite(duration) ||
    plan.duration <= 0 ||
    duration > 60 ||
    !Number.isInteger(sampleRate) ||
    sampleRate < 8000 ||
    sampleRate > 96000 ||
    ![1, 2].includes(channels) ||
    frames * channels * 6 + 44 > (plan.maxOutputBytes ?? 64 * 1024 * 1024) ||
    plan.voices.length > 4096
  ) {
    throw new ShardError(
      'audio/preview-unavailable',
      'Preview exceeds its duration, rate, voice or output-memory limits',
    )
  }
  if (typeof OfflineAudioContext === 'undefined')
    throw new ShardError('audio/preview-unavailable', 'This host has no OfflineAudioContext')
  for (const voice of plan.voices)
    if (voice.clip.stream || !voice.clip.bytes.byteLength)
      throw new ShardError(
        'audio/preview-unavailable',
        'Preview requires local encoded bytes for decoded clips',
      )
  const context = new OfflineAudioContext(channels, frames, sampleRate)
  const backend = createWebAudioBackend({
    context,
    fixedListener: true,
    maxVoices: 4096,
    maxHostVoices: 4096,
    decodedBudgetBytes: plan.decodedBudgetBytes ?? 64 * 1024 * 1024,
  })
  try {
    const leases = await Promise.all(
      plan.voices.map((voice) => backend.runtime.prepare(voice.clip)),
    )
    if (plan.mixer) await backend.runtime.configureMixer(plan.mixer)
    const ids = plan.voices.map((voice) =>
      backend.runtime.play({
        ...voice,
        when: voice.when ?? 0,
        duration:
          voice.duration ??
          (voice.loop ? Math.max(0, plan.duration - (voice.when ?? 0)) : undefined),
      }),
    )
    await backend.runtime.flush()
    for (const item of plan.automation ?? []) {
      const id = ids[item.voice]
      if (id === undefined)
        throw new ShardError(
          'audio/preview-unavailable',
          `Automation refers to unknown voice ${item.voice}`,
        )
      backend.runtime.automate(id, item.command)
    }
    const trace = ids.map((id, index) => ({
      voice: index,
      clip: plan.voices[index]!.clip.id,
      requestedAt: plan.voices[index]!.when ?? 0,
      presentation: { ...backend.runtime.presentation(id)! },
    }))
    const buffer = await context.startRendering()
    const measured = measureAudioBuffer(buffer)
    if (measured.nonfinite)
      throw new ShardError(
        'audio/preview-unavailable',
        'Rendered signal contains nonfinite samples',
      )
    for (const lease of leases) lease.release()
    return {
      buffer,
      wav: audioBufferWav(buffer),
      measured,
      trace,
      capabilities: backend.runtime.capabilities,
      backend: {
        kind: 'web-audio-offline',
        userAgent: navigator.userAgent,
        sampleRate: context.sampleRate,
      },
    }
  } finally {
    backend.dispose?.()
  }
}
