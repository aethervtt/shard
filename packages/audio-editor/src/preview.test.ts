import { HeadlessAudioBackend } from '@aethervtt/shard-audio'
import { describe, expect, it, vi } from 'vitest'
import { createMemoryAudioHost } from './memory'
import { createAttachedAudioPreview, createIsolatedAudioPreview } from './preview'
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
