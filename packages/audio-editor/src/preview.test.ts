import { HeadlessAudioBackend } from '@aethervtt/shard-audio'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryAudioHost } from './memory'
import { createAttachedAudioPreview, createIsolatedAudioPreview } from './preview'
import { createPreviewRuntime } from './preview-runtime'
import type { AudioDocument } from './types'

function wav() {
  const bytes = new Uint8Array(44 + 16000)
  const view = new DataView(bytes.buffer)
  for (const [offset, text] of [
    [0, 'RIFF'],
    [8, 'WAVE'],
    [12, 'fmt '],
    [36, 'data'],
  ] as const)
    for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i)
  view.setUint32(4, bytes.length - 8, true)
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, 8000, true)
  view.setUint32(28, 16000, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  view.setUint32(40, 16000, true)
  for (let i = 0; i < 8000; i++)
    view.setInt16(44 + i * 2, Math.round(Math.sin(i * 0.25) * 8192), true)
  return bytes
}
const event: AudioDocument = {
  id: 'user-event-opaque',
  name: 'Test',
  type: 'audio/AudioEvent',
  revision: 'draft:2',
  value: {
    mode: 'sustain',
    layers: [{ id: 'loop', loop: true, choices: [{ clip: { guid: 'user-audio-opaque' } }] }],
  },
}
function fixture() {
  const release = vi.fn()
  const host = createMemoryAudioHost({
    documents: [event],
    assets: [
      {
        id: 'user-audio-opaque',
        name: 'Audio',
        type: 'AudioClip',
        revision: 'asset:1',
        content: { bytes: wav(), release },
      },
    ],
  })
  const backend = new HeadlessAudioBackend()
  Object.assign(backend.capabilities, { sessions: true })
  const children: HeadlessAudioBackend[] = []
  const root = Object.assign(backend, {
    createSession: () => {
      const child = new HeadlessAudioBackend()
      children.push(child)
      return child
    },
  })
  const dispose = vi.spyOn(root, 'dispose')
  return { host, root, children, dispose, release }
}

describe('isolated host-backed audition', () => {
  it('bounds retained preparations and admits new auditions after Stop releases them', async () => {
    const { host, root, children } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    const collection: AudioDocument = {
      id: 'collection',
      name: 'Collection',
      type: 'audio/AudioCollection',
      revision: 'draft:1',
      value: { clips: [{ guid: 'user-audio-opaque' }] },
    }
    for (let i = 0; i < 256; i++) await preview.play(collection)
    await expect(preview.play(collection)).rejects.toMatchObject({
      code: 'audio/capacity',
      hint: expect.stringContaining('Stop'),
    })
    preview.stop()
    expect(children[0]!.memory().pinned).toBe(0)
    await expect(preview.play(collection)).resolves.toHaveProperty('prepared', true)
    await preview.dispose()
  })

  it('retains playing revisions when unrelated documents save and future plays resolve new clip revisions', async () => {
    const { host, root, release } = fixture()
    const metadata = host.assets.get
    let revision = 'asset:1'
    host.assets.get = async (id, signal) => ({ ...(await metadata(id, signal)), revision })
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const original = preview.inspect() as { voices: { clip: string }[] }
    await host.documents.commit!([
      { document: { ...event, id: 'unrelated', revision: '' }, expectedRevision: null },
    ])
    expect(preview.inspect()).toMatchObject({ counts: { active: 1 } })
    revision = 'asset:2'
    await preview.play(event)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const next = preview.inspect() as { voices: { clip: string }[] }
    expect(next.voices).toHaveLength(2)
    expect(next.voices[0]!.clip).toBe(original.voices[0]!.clip)
    expect(next.voices[1]!.clip).not.toBe(original.voices[0]!.clip)
    expect(release).toHaveBeenCalledTimes(2)
    await preview.dispose()
  })

  it('releases pinned playback immediately when the host rotates its access scope', async () => {
    const { host, root, children, dispose } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    const close = vi.spyOn(children[0]!, 'dispose')
    Object.defineProperty(host.assets, 'scope', { value: 'revoked-project' })
    expect(preview.inspect()).toMatchObject({ state: 'idle' })
    expect(close).toHaveBeenCalled()
    expect(children[0]!.memory().pinned).toBe(0)
    expect(dispose).not.toHaveBeenCalled()
    await preview.dispose()
  })

  it.each([true, false])(
    'disposes sessions even when browser resume never settles (borrowed=%s)',
    async (borrowed) => {
      const { host, root, children, dispose } = fixture()
      Object.assign(root, { resume: () => new Promise<void>(() => {}) })
      const runtime = await createPreviewRuntime({
        ...host,
        ...(borrowed ? { backend: root } : { createBackend: () => root }),
      })
      const close = vi.spyOn(children[0]!, 'dispose')
      await runtime.play(event)
      await runtime.dispose()
      expect(close).toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledTimes(borrowed ? 0 : 1)
      expect(children[0]!.memory().pinned).toBe(0)
    },
  )

  it('reports a rejected browser resume without an unhandled promise or losing disposal', async () => {
    const { host, root, dispose } = fixture()
    Object.assign(root, { resume: () => Promise.reject(new Error('No audio device')) })
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    expect(preview.inspect()).toMatchObject({
      auditionError: { code: 'audio-editor/playback-blocked' },
    })
    await preview.dispose()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('rejects a nonisolatable host backend before replacing its handlers or disposing it', async () => {
    const { host } = fixture()
    const onError = vi.fn()
    const backend = Object.assign(new HeadlessAudioBackend(), { onError })
    const dispose = vi.spyOn(backend, 'dispose')
    const preview = createIsolatedAudioPreview({ ...host, backend })
    await expect(preview.play(event)).rejects.toMatchObject({
      code: 'audio-editor/unsupported-capability',
    })
    await preview.dispose()
    expect(backend.onError).toBe(onError)
    expect(dispose).not.toHaveBeenCalled()
  })

  it('pins concurrent unsaved revisions independently without saving host documents', async () => {
    const { host, root } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    const next = structuredClone(event)
    next.value.layers = [
      { id: 'quiet', loop: true, gainDb: -20, choices: [{ clip: { guid: 'user-audio-opaque' } }] },
    ]
    await Promise.all([preview.play(event), preview.play(next)])
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const inspected = preview.inspect() as {
      voices: { gain: number }[]
      counts: { active: number }
    }
    expect(inspected.counts.active).toBe(2)
    expect(inspected.voices.map((voice) => voice.gain).sort()).toEqual([0.1, 1])
    expect((await host.documents.read(event.id)).value).toEqual(event.value)
    await preview.dispose()
  })

  it('preserves the host import normalization and clip loop settings during preparation', async () => {
    const { host, root } = fixture()
    const original = host.assets.resolve
    host.assets.resolve = async (id, signal) => ({
      ...(await original(id, signal)),
      settings: { normalize: true, loopStart: 0.125, loopEnd: 0.5 },
    })
    const prepare = vi.fn()
    const create = root.createSession
    root.createSession = () => {
      const child = create()
      const originalPrepare = child.prepare.bind(child)
      child.prepare = (clip) => {
        prepare(clip)
        return originalPrepare(clip)
      }
      return child
    }
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    expect(prepare).toHaveBeenCalledWith(
      expect.objectContaining({ normalize: true, loopStart: 0.125, loopEnd: 0.5 }),
    )
    await preview.dispose()
  })

  it('reuses authorized immutable clip revisions across repeated audition without duplicate decode leases', async () => {
    const { host, root, children, release } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    preview.inspect()
    const bytes = children[0]!.memory().decodedBytes
    await preview.play(event)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(preview.inspect()).toMatchObject({ counts: { active: 2 } })
    expect(children[0]!.memory().decodedBytes).toBe(bytes)
    expect(release).toHaveBeenCalledOnce()
    await preview.dispose()
  })

  it('stays silent until Play and registers an unsaved document using authorized opaque IDs', async () => {
    const { host, root, children, dispose, release } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    expect(children).toHaveLength(0)
    expect(preview.inspect()).toMatchObject({ state: 'idle' })
    const result = await preview.play(event)
    expect(result).toHaveProperty('instance')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    const inspected = preview.inspect() as {
      counts: { active: number }
      voices: { clip: string }[]
    }
    expect(inspected.counts.active).toBe(1)
    expect(inspected.voices[0]!.clip).toContain('user-audio-opaque')
    expect(release).toHaveBeenCalledOnce()
    expect((await host.documents.read(event.id)).revision).toBe('draft:2')
    await preview.stop()
    expect(children[0]!.memory().pinned).toBe(0)
    await preview.dispose()
    await preview.dispose()
    expect(dispose).not.toHaveBeenCalled()
  })

  it('rejects pasted URL references without fetching them or replacing the current voice', async () => {
    const { host, root } = fixture()
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    await preview.play(event)
    const invalid = structuredClone(event)
    invalid.value.layers = [
      { id: 'bad', choices: [{ clip: { guid: 'https://untrusted.invalid/sound.wav' } }] },
    ]
    await expect(preview.play(invalid)).rejects.toMatchObject({
      code: 'audio-editor/asset-unavailable',
    })
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(preview.inspect()).toMatchObject({ counts: { active: 1 } })
    await preview.dispose()
  })

  it('releases late resolver content without producing sound after disposal', async () => {
    const { host, root, children, release } = fixture()
    let complete: (() => void) | undefined
    const original = host.assets.resolve
    host.assets.resolve = async (id) => {
      await new Promise<void>((resolve) => {
        complete = resolve
      })
      return original(id)
    }
    const preview = createIsolatedAudioPreview({ ...host, backend: root })
    const pending = preview.play(event)
    while (!complete) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await preview.dispose()
    complete()
    await expect(pending).rejects.toMatchObject({ code: 'audio-editor/disposed' })
    expect(release).toHaveBeenCalledOnce()
    expect(children[0]!.active).toHaveLength(0)
  })
})

describe('runtime attachment capabilities', () => {
  it('Stop cancels a pending play without stopping a newer owned instance when the old call returns', async () => {
    let finish: ((value: unknown) => void) | undefined
    let starts = 0
    const call = vi.fn(async (name: string, _params: Record<string, unknown>) => {
      if (name !== 'audio.play') return {}
      if (++starts === 1)
        return new Promise<unknown>((resolve) => {
          finish = resolve
        })
      return { instance: 2 }
    })
    const preview = createAttachedAudioPreview({
      target: 'game',
      call,
      liveControl: true,
      applyDraft: async () => 'draft',
    })
    const old = preview.play(event)
    while (!finish) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await preview.stop()
    await preview.play(event)
    finish({ instance: 1 })
    await expect(old).rejects.toMatchObject({ code: 'audio-editor/disposed' })
    expect(call.mock.calls.filter(([name]) => name === 'audio.stop')).toEqual([
      ['audio.stop', { instance: 1, release: 0 }],
    ])
    await preview.dispose()
    expect(call).toHaveBeenLastCalledWith('audio.stop', { instance: 2, release: 0 })
  })

  it('surfaces a lost attachment and stops a late owned play after disposal', async () => {
    const lost = createAttachedAudioPreview({
      target: 'gone',
      call: async () => {
        throw new Error('Disconnected')
      },
    })
    await expect(lost.inspect()).rejects.toThrow('Disconnected')
    await lost.dispose()
    let finish: ((value: unknown) => void) | undefined
    const call = vi.fn(async (name: string) => {
      if (name === 'audio.play')
        return new Promise<unknown>((resolve) => {
          finish = resolve
        })
      return {}
    })
    const preview = createAttachedAudioPreview({
      target: 'game',
      call,
      liveControl: true,
      applyDraft: async () => 'draft',
    })
    const pending = preview.play(event)
    while (!finish) await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await preview.dispose()
    finish({ instance: 87 })
    await expect(pending).rejects.toMatchObject({ code: 'audio-editor/disposed' })
    expect(call).toHaveBeenLastCalledWith('audio.stop', { instance: 87, release: 0 })
  })

  it('defaults to read-only and never emulates unsaved-draft application', async () => {
    const call = vi.fn(async () => ({}))
    const preview = createAttachedAudioPreview({ target: 'game-1', call })
    await preview.inspect()
    await expect(preview.play(event)).rejects.toMatchObject({ code: 'audio-editor/read-only' })
    expect(call.mock.calls).toHaveLength(1)
    const live = createAttachedAudioPreview({ target: 'game-1', call, liveControl: true })
    await expect(live.play(event)).rejects.toMatchObject({
      code: 'audio-editor/unsupported-capability',
    })
    await live.dispose()
    await preview.dispose()
    expect(call.mock.calls).toHaveLength(1)
  })

  it('stops only editor-owned instances and rejects controls targeting unrelated voices', async () => {
    const call = vi.fn(async (name: string, _params: Record<string, unknown>) =>
      name === 'audio.play' ? { instance: 42 } : {},
    )
    const preview = createAttachedAudioPreview({
      target: 'game',
      call,
      liveControl: true,
      applyDraft: async () => 'draft-ref',
    })
    await preview.play(event)
    await expect(preview.command!('audio.stop', { instance: 99 })).rejects.toMatchObject({
      code: 'audio-editor/unsupported-capability',
    })
    await preview.dispose()
    expect(call.mock.calls.at(-1)).toEqual(['audio.stop', { instance: 42, release: 0 }])
    expect(call.mock.calls).toHaveLength(2)
  })
})
