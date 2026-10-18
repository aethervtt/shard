import type { Platform } from '@aethervtt/shard-platform'
import { describe, expect, it } from 'vitest'
import { openAudioProject } from './project'

function host(writable = true) {
  const files = new Map([
    ['shard.json', JSON.stringify({ name: 'audio-project', assetRoots: ['data'] })],
    [
      'data/room.audio-mixer.json',
      '{ "buses": [{"id":"master","parent":""}], "hostField": true }\n',
    ],
    ['data/room.audio-mixer.json.meta', '{"guid":"opaque-mixer"}'],
  ])
  let writes = 0
  const platform = {
    fs: {
      writable,
      readText: async (path: string) => {
        const value = files.get(path)
        if (value === undefined) throw new Error('missing')
        return value
      },
      exists: async (path: string) =>
        files.has(path) || [...files.keys()].some((key) => key.startsWith(`${path}/`)),
      remove: async (path: string) => {
        files.delete(path)
      },
      list: async (dir: string) =>
        [...files.keys()]
          .filter((path) => path.startsWith(`${dir}/`))
          .map((path) => ({ name: path.slice(dir.length + 1), kind: 'file' as const })),
      writeText: async (path: string, value: string) => {
        writes++
        files.set(path, value)
      },
    },
  } as unknown as Platform
  return { files, platform, writes: () => writes }
}

describe('project audio host', () => {
  it('creates sources by explicit type and reopens opaque IDs from sidecars', async () => {
    const fixture = host(),
      project = await openAudioProject(fixture.platform)
    const original = await project.documents.read('opaque-mixer')
    const document = { ...original, id: 'new:opaque-id', name: 'Rain / indoors', revision: '' }
    const [saved] = await project.documents.commit!([{ document, expectedRevision: null }])
    expect(saved!.name).toBe('Rain-indoors.audio-mixer.json')
    expect(JSON.parse(fixture.files.get('data/Rain-indoors.audio-mixer.json.meta')!).guid).toBe(
      document.id,
    )
    project.dispose()
    const reopened = await openAudioProject(fixture.platform)
    expect((await reopened.documents.read(document.id)).value).toEqual(document.value)
    await expect(
      reopened.documents.commit!([{ document, expectedRevision: null }]),
    ).rejects.toMatchObject({ code: 'audio-editor/conflict' })
    reopened.dispose()
  })
  it('preserves no-op source bytes, unrelated fields and GUID aliases; detects stale writes', async () => {
    const fixture = host(),
      project = await openAudioProject(fixture.platform)
    const original = fixture.files.get('data/room.audio-mixer.json')
    const doc = await project.documents.read('opaque-mixer')
    expect((await project.documents.read('data/room.audio-mixer.json')).value).toEqual(doc.value)
    await project.documents.commit!([{ document: doc, expectedRevision: doc.revision }])
    expect(fixture.writes()).toBe(0)
    expect(fixture.files.get('data/room.audio-mixer.json')).toBe(original)
    const changed = {
      ...doc,
      value: { ...doc.value, buses: [{ id: 'master', parent: '', gainDb: -3 }] },
    }
    await project.documents.commit!([{ document: changed, expectedRevision: doc.revision }])
    expect((await project.documents.read(doc.id)).value.hostField).toBe(true)
    await expect(
      project.documents.commit!([{ document: doc, expectedRevision: doc.revision }]),
    ).rejects.toMatchObject({ code: 'audio-editor/conflict' })
    expect(fixture.writes()).toBe(1)
    project.dispose()
    await expect(project.documents.read(doc.id)).rejects.toMatchObject({
      code: 'audio-editor/disposed',
    })
  })
  it('rejects atomic batches before writes and exposes read-only hosts honestly', async () => {
    const fixture = host(),
      project = await openAudioProject(fixture.platform)
    const doc = await project.documents.read('opaque-mixer')
    const change = { document: doc, expectedRevision: doc.revision }
    await expect(project.documents.commit!([change, change])).rejects.toMatchObject({
      code: 'audio-editor/unsupported-capability',
    })
    expect(fixture.writes()).toBe(0)
    const readOnly = await openAudioProject(host(false).platform)
    expect(readOnly.documents.commit).toBeUndefined()
    await expect(
      project.assets.resolve('https://untrusted.invalid/audio.wav'),
    ).rejects.toMatchObject({ code: 'audio-editor/asset-unavailable' })
    project.dispose()
    readOnly.dispose()
  })
})
