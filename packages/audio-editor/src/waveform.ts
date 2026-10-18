import { ShardError } from '@aethervtt/shard-core'
import type { AudioAssetCatalog, AudioWaveform } from './types'

export type AudioWaveformDecoder = (
  bytes: Uint8Array,
  signal?: AbortSignal,
) => Promise<{
  channels: readonly Float32Array[]
  sampleRate: number
}>

async function browserDecode(bytes: Uint8Array) {
  if (typeof OfflineAudioContext === 'undefined')
    throw new ShardError(
      'audio-editor/unsupported-capability',
      'Waveform decoding is unavailable',
      {
        hint: 'Supply a waveform decoder in this host.',
      },
    )
  const context = new OfflineAudioContext(1, 1, 48000)
  const buffer = await context.decodeAudioData(Uint8Array.from(bytes).buffer)
  return {
    channels: Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
    sampleRate: buffer.sampleRate,
  }
}

/** Metadata listing never calls this cache. A requested waveform owns only its envelope. */
export function createAudioWaveformCache(
  assets: AudioAssetCatalog,
  options: { maxBytes?: number; decode?: AudioWaveformDecoder } = {},
) {
  const maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
    throw new ShardError('audio-editor/invalid-document', 'Waveform cache size must be nonnegative')
  const entries = new Map<string, { id: string; waveform: AudioWaveform }>()
  const controller = new AbortController()
  let size = 0
  let generation = 0
  let scope = assets.scope
  let disposed = false
  const clear = () => {
    entries.clear()
    size = 0
    generation++
  }
  const unsubscribe = assets.subscribe?.(() => clear())
  const assertLive = (signal?: AbortSignal) => {
    if (disposed || signal?.aborted)
      throw new ShardError('audio-editor/disposed', 'Waveform request was cancelled', {
        hint: 'Request a waveform from an active editor session.',
      })
  }
  return {
    get bytes() {
      return size
    },
    get count() {
      return entries.size
    },
    clear,
    async get(id: string, bins: number, signal?: AbortSignal, channel = 0): Promise<AudioWaveform> {
      assertLive(signal)
      if (
        !Number.isSafeInteger(bins) ||
        bins < 1 ||
        bins > 65536 ||
        !Number.isSafeInteger(channel) ||
        channel < 0
      )
        throw new ShardError(
          'audio-editor/invalid-document',
          'Invalid waveform resolution or channel',
        )
      if (scope !== assets.scope) {
        scope = assets.scope
        clear()
      }
      const request = generation
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
      const metadata = await assets.get(id, combined)
      assertLive(combined)
      const key = JSON.stringify([scope, id, metadata.revision, channel, bins])
      const cached = entries.get(key)
      if (cached) {
        entries.delete(key)
        entries.set(key, cached)
        return cached.waveform
      }
      const content = await assets.resolve(id, combined)
      try {
        assertLive(combined)
        if (!content.bytes)
          throw new ShardError(
            'audio-editor/unsupported-capability',
            'Waveforms require authorized encoded bytes',
            {
              path: id,
              hint: 'Have the host asset resolver provide bytes for waveform requests.',
            },
          )
        const decoded = await (options.decode ?? browserDecode)(content.bytes, combined)
        assertLive(combined)
        if (scope !== assets.scope || request !== generation)
          throw new ShardError(
            'audio-editor/asset-unavailable',
            'Asset scope or revision changed during decoding',
            { path: id },
          )
        const samples = decoded.channels[channel]
        if (!samples || !Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0)
          throw new ShardError(
            'audio-editor/asset-unavailable',
            'Requested waveform channel is unavailable',
            { path: id },
          )
        const peaks = new Float32Array(bins * 2)
        for (let bin = 0; bin < bins; bin++) {
          const start = Math.floor((bin * samples.length) / bins)
          const end = Math.min(
            samples.length,
            Math.max(start + 1, Math.floor(((bin + 1) * samples.length) / bins)),
          )
          let min = 0
          let max = 0
          for (let index = start; index < end; index++) {
            const value = samples[index]!
            if (Number.isFinite(value)) {
              min = Math.min(min, value)
              max = Math.max(max, value)
            }
          }
          peaks[bin * 2] = min
          peaks[bin * 2 + 1] = max
        }
        const waveform = {
          peaks,
          duration: samples.length / decoded.sampleRate,
          sampleRate: decoded.sampleRate,
        }
        if (peaks.byteLength <= maxBytes) {
          while (size + peaks.byteLength > maxBytes) {
            const oldest = entries.keys().next().value
            if (oldest === undefined) break
            size -= entries.get(oldest)!.waveform.peaks.byteLength
            entries.delete(oldest)
          }
          // A concurrent request can have completed the same revision while decoding.
          size -= entries.get(key)?.waveform.peaks.byteLength ?? 0
          entries.set(key, { id, waveform })
          size += peaks.byteLength
        }
        return waveform
      } finally {
        content.release?.()
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      controller.abort()
      unsubscribe?.()
      clear()
    },
  }
}
