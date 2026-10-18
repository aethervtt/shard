import { describe, expect, it, vi } from 'vitest'
import { createMemoryAudioHost } from './memory'
import { createAudioWaveformCache } from './waveform'

function fixture() {
  const release = vi.fn()
  const host = createMemoryAudioHost({
    assets: ['a', 'b', 'c'].map((id) => ({
      id,
      name: id,
      type: 'AudioClip',
      revision: '1',
      content: { bytes: new Uint8Array([1]), release },
    })),
  })
  const decode = vi.fn(async () => ({
    channels: [new Float32Array([-0.5, 0.2, -0.1, 0.75])],
    sampleRate: 4,
  }))
  return { host, release, decode }
}

describe('bounded waveform cache', () => {
  it('decodes only explicitly requested assets, preserves extrema and evicts least recently used envelopes', async () => {
    const { host, release, decode } = fixture()
    const cache = createAudioWaveformCache(host.assets, { maxBytes: 32, decode })
    await host.assets.list({})
    expect(decode).not.toHaveBeenCalled()
    const first = await cache.get('a', 2)
    expect([...first.peaks]).toEqual([-0.5, expect.closeTo(0.2), expect.closeTo(-0.1), 0.75])
    expect(first.duration).toBe(1)
    await cache.get('b', 2)
    expect(await cache.get('a', 2)).toBe(first)
    await cache.get('c', 2)
    expect(cache.bytes).toBe(32)
    await cache.get('b', 2)
    expect(decode).toHaveBeenCalledTimes(4)
    expect(release).toHaveBeenCalledTimes(4)
    cache.dispose()
    expect(cache.bytes).toBe(0)
  })

  it('does not cache late decoding after close and releases its authorized lease', async () => {
    const { host, release } = fixture()
    let finish: (() => void) | undefined
    const cache = createAudioWaveformCache(host.assets, {
      decode: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        return { channels: [new Float32Array([1])], sampleRate: 1 }
      },
    })
    const pending = cache.get('a', 1)
    while (!finish) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    cache.dispose()
    finish()
    await expect(pending).rejects.toMatchObject({ code: 'audio-editor/disposed' })
    expect(release).toHaveBeenCalledOnce()
    expect(cache.count).toBe(0)
  })

  it('scope changes invalidate envelopes even when opaque IDs and revisions are reused', async () => {
    const { host, decode } = fixture()
    let scope = 'world-1'
    const assets = {
      ...host.assets,
      get scope() {
        return scope
      },
    }
    const cache = createAudioWaveformCache(assets, { decode })
    await cache.get('a', 2)
    scope = 'world-2'
    await cache.get('a', 2)
    expect(decode).toHaveBeenCalledTimes(2)
    expect(cache.count).toBe(1)
    cache.dispose()
  })
})
