import { ShardError } from '@aethervtt/shard-core'
import type { AudioClipSource, AudioPreparation } from '@aethervtt/shard-platform'

export interface PreparedAudio {
  buffer: AudioBuffer | null
  peak: number
  url: string | null
}

interface Entry {
  clip: AudioClipSource
  refs: number
  bytes: number
  touched: number
  url: string | null
  value: PreparedAudio | null
  promise: Promise<PreparedAudio>
}

/** Owned decode cache. Both preparation leases and physical voices pin entries. */
export class AudioCache {
  private readonly entries = new Map<object | string, Entry>()
  private readonly byteKeys = new WeakMap<Uint8Array, { decoded: object; media: object }>()
  private readonly queue: (() => void)[] = []
  private running = 0
  private stamp = 0
  private closed = false
  readonly context: BaseAudioContext
  readonly budgetBytes: number
  readonly maxDecodes: number

  constructor(context: BaseAudioContext, budgetBytes = 64 * 1024 * 1024, maxDecodes = 4) {
    if (
      !Number.isInteger(maxDecodes) ||
      maxDecodes < 1 ||
      !Number.isFinite(budgetBytes) ||
      budgetBytes <= 0
    )
      throw new ShardError(
        'audio/invalid-range',
        'Decode concurrency and memory budget must be positive',
      )
    this.context = context
    this.budgetBytes = budgetBytes
    this.maxDecodes = maxDecodes
  }

  private async slot(): Promise<void> {
    if (this.running < this.maxDecodes) {
      this.running++
      return
    }
    if (this.queue.length >= 2048)
      throw new ShardError('audio/capacity', 'Audio decode queue is full')
    await new Promise<void>((resolve) => this.queue.push(resolve))
  }

  private done(): void {
    const next = this.queue.shift()
    if (next) next()
    else this.running--
  }

  private async load(entry: Entry): Promise<PreparedAudio> {
    await this.slot()
    try {
      if (this.closed) throw new ShardError('audio/prepare-failed', 'The audio host was disposed')
      const clip = entry.clip
      if (clip.stream) {
        if (clip.url) return { buffer: null, peak: 1, url: clip.url }
        entry.url = URL.createObjectURL(new Blob([clip.bytes.slice().buffer]))
        return { buffer: null, peak: 1, url: entry.url }
      }
      const buffer = await this.context.decodeAudioData(clip.bytes.slice().buffer)
      const bytes = buffer.length * buffer.numberOfChannels * 4
      if (this.memory().decodedBytes - entry.bytes + bytes > this.budgetBytes) {
        throw new ShardError(
          'audio/memory-budget',
          'Decoded samples exceed the audio memory budget',
          {
            hint: 'Release unused collections, shorten clips, or increase decodedBudgetMiB.',
          },
        )
      }
      entry.bytes = bytes
      let peak = 0
      for (let c = 0; c < buffer.numberOfChannels; c++) {
        const samples = buffer.getChannelData(c)
        for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]!))
      }
      return { buffer, peak, url: null }
    } catch (cause) {
      if (cause instanceof ShardError) throw cause
      throw new ShardError('audio/decode-failed', `Cannot decode ${entry.clip.id}`, {
        cause,
        hint: 'Check the source file and codec support on this host. Try PCM WAV.',
      })
    } finally {
      this.done()
    }
  }

  private key(clip: AudioClipSource): object | string {
    let key: object | string
    if (clip.url) key = `${clip.stream ? 'media' : 'decoded'}:${clip.url}`
    else {
      let keys = this.byteKeys.get(clip.bytes)
      if (!keys) {
        keys = { decoded: {}, media: {} }
        this.byteKeys.set(clip.bytes, keys)
      }
      key = clip.stream ? keys.media : keys.decoded
    }
    return key
  }

  /** Already prepared sources can be scheduled synchronously as one reserved group. */
  acquireReady(clip: AudioClipSource): (AudioPreparation & { value: PreparedAudio }) | null {
    if (this.closed) return null
    const key = this.key(clip),
      entry = this.entries.get(key)
    if (!entry?.value) return null
    entry.refs++
    entry.touched = this.stamp++
    return this.lease(clip, key, entry, entry.value)
  }

  async acquire(clip: AudioClipSource): Promise<AudioPreparation & { value: PreparedAudio }> {
    if (this.closed) throw new ShardError('audio/prepare-failed', 'The audio host was disposed')
    const key = this.key(clip)
    let entry = this.entries.get(key)
    if (!entry) {
      const bytes = clip.stream
        ? 0
        : Math.ceil(clip.duration * this.context.sampleRate) * (clip.channels ?? 2) * 4
      this.evict(bytes)
      if (this.memory().decodedBytes + bytes > this.budgetBytes) {
        throw new ShardError(
          'audio/memory-budget',
          `Cannot prepare ${clip.id}: pinned audio fills the budget`,
          {
            hint: 'Release preparation leases or increase the decoded audio budget.',
          },
        )
      }
      entry = {
        clip,
        refs: 0,
        bytes,
        touched: this.stamp++,
        url: null,
        value: null,
        promise: Promise.resolve({ buffer: null, peak: 1, url: null }),
      }
      this.entries.set(key, entry)
      const pending = entry
      entry.promise = this.load(entry).then((value) => {
        pending.value = value
        return value
      })
    }
    const owned = entry
    owned.refs++
    owned.touched = this.stamp++
    let value: PreparedAudio
    try {
      value = await owned.promise
    } catch (error) {
      owned.refs--
      if (owned.refs === 0) this.remove(key, owned)
      throw error
    }
    if (this.closed) {
      owned.refs--
      this.remove(key, owned)
      throw new ShardError('audio/prepare-failed', 'Audio preparation was cancelled by disposal')
    }
    return this.lease(clip, key, owned, value)
  }

  private lease(
    clip: AudioClipSource,
    key: object | string,
    owned: Entry,
    value: PreparedAudio,
  ): AudioPreparation & { value: PreparedAudio } {
    let released = false
    return {
      clip,
      value,
      decodedBytes: owned.bytes,
      encodedBytes: clip.bytes.byteLength,
      sampleRate: value.buffer?.sampleRate ?? this.context.sampleRate,
      samples: value.buffer?.length ?? 0,
      channels: value.buffer?.numberOfChannels ?? clip.channels ?? 0,
      get released() {
        return released
      },
      release: () => {
        if (released) return
        released = true
        owned.refs--
        owned.touched = this.stamp++
        // Media URLs have no decode benefit from retaining them after the last owner.
        if (owned.refs === 0 && (clip.stream || this.closed)) this.remove(key, owned)
      },
    }
  }

  private remove(key: object | string, entry: Entry): void {
    if (entry.url) {
      URL.revokeObjectURL(entry.url)
      entry.url = null
    }
    if (this.entries.get(key) === entry) this.entries.delete(key)
  }

  private evict(required: number): void {
    const unused = [...this.entries]
      .filter(([, entry]) => entry.refs === 0)
      .sort((a, b) => a[1].touched - b[1].touched)
    for (const [key, entry] of unused) {
      if (this.memory().decodedBytes + required <= this.budgetBytes) break
      this.remove(key, entry)
    }
  }

  collect(): void {
    for (const [key, entry] of this.entries) if (!entry.refs) this.remove(key, entry)
  }

  dispose(): void {
    this.closed = true
    this.collect()
  }

  memory() {
    let decodedBytes = 0
    let encodedBytes = 0
    let pinned = 0
    let evictable = 0
    let urls = 0
    for (const entry of this.entries.values()) {
      decodedBytes += entry.bytes
      encodedBytes += entry.clip.bytes.byteLength
      if (entry.refs) pinned++
      else evictable++
      if (entry.url) urls++
    }
    return {
      decodedBytes,
      encodedBytes,
      pinned,
      evictable,
      urls,
      budgetBytes: this.budgetBytes,
      loading: this.running + this.queue.length,
    }
  }
}
