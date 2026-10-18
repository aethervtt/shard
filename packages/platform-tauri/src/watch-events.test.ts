import { describe, expect, it } from 'vitest'
import { projectFileChanges } from './watch-events'

describe('native project watch events', () => {
  it('ignores reads and access timestamps, preventing invalidate/read feedback loops', () => {
    for (const type of [
      { access: { kind: 'open', mode: 'read' } },
      { access: { kind: 'close', mode: 'read' } },
      { modify: { kind: 'metadata', mode: 'access-time' } },
    ] as const)
      expect(
        projectFileChanges('/project', {
          type,
          paths: ['/project/audio/event.audio-event.json'],
          attrs: {},
        }),
      ).toEqual([])
  })

  it('preserves content changes, creation and deletion with project-relative paths', () => {
    for (const [type, kind] of [
      [{ modify: { kind: 'data', mode: 'content' } }, 'modify'],
      [{ create: { kind: 'file' } }, 'create'],
      [{ remove: { kind: 'file' } }, 'remove'],
    ] as const)
      expect(
        projectFileChanges('/project', { type, paths: ['/project/audio/clip.wav'], attrs: {} }),
      ).toEqual([{ kind, path: 'audio/clip.wav' }])
  })

  it('normalizes Windows watch paths to the catalog slash form', () => {
    for (const root of ['C:\\project\\', 'C:/project'])
      expect(
        projectFileChanges(root, {
          type: { modify: { kind: 'data', mode: 'content' } },
          paths: ['C:\\project\\audio\\clip.wav', 'C:\\project-other\\clip.wav'],
          attrs: {},
        }),
      ).toEqual([
        { kind: 'modify', path: 'audio/clip.wav' },
        { kind: 'modify', path: 'C:/project-other/clip.wav' },
      ])
  })
})
