import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShardError } from '@aethervtt/shard-core'
import { afterAll, describe, expect, it } from 'vitest'
import { createFileStorage } from './index'

const dir = mkdtempSync(join(tmpdir(), 'shard-storage-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('file storage', () => {
  const storage = createFileStorage(dir)

  it('reads back what it writes, under nested keys too', async () => {
    await storage.write('settings.json', new Uint8Array([1, 2]))
    await storage.write('saves/slot1.json', new Uint8Array([3]))
    expect(await storage.read('settings.json')).toEqual(new Uint8Array([1, 2]))
    expect(await storage.list('saves/')).toEqual(['saves/slot1.json'])
    expect(await storage.read('missing.json')).toBeUndefined()
  })

  it('rejects keys that leave the data folder', async () => {
    for (const key of ['../escape.json', 'saves/../../escape.json', join(tmpdir(), 'x.json')]) {
      await expect(storage.read(key)).rejects.toSatisfy(
        (err: ShardError) => err.code === 'platform/bad-storage-key',
      )
    }
  })

  it('allows names that only start with two dots', async () => {
    await storage.write('..notes.json', new Uint8Array([4]))
    expect(await storage.read('..notes.json')).toEqual(new Uint8Array([4]))
  })
})
