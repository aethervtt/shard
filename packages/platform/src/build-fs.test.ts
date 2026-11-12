import type { ShardError } from '@aethervtt/shard-core'
import { describe, expect, it } from 'vitest'
import { buildFs } from './build-fs'
import type { PlatformFileSystem } from './index'

// ASCII only: the package has no DOM or Node types (TextEncoder).
const encode = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0))
const decode = (bytes: Uint8Array) => String.fromCharCode(...bytes)

/** A read-only file system over a map, recording the paths it was asked for. */
function memoryFs(files: Record<string, string>): PlatformFileSystem & { reads: string[] } {
  const reads: string[] = []
  const bytes = (path: string) => {
    reads.push(path)
    const text = files[path]
    if (text === undefined) throw new Error(`no ${path}`)
    return encode(text)
  }
  return {
    reads,
    writable: false,
    resolveUrl: (path) => `https://cdn.example/${path}`,
    readText: async (path) => decode(bytes(path)),
    readBytes: async (path) => bytes(path),
    writeText: async () => {},
    writeBytes: async () => {},
    exists: async (path) => path in files,
  }
}

describe('buildFs (0110)', () => {
  const files = {
    'scenes/main.scene.json': { url: 'f/aaa.json', size: 9, hash: 'aaa' },
    '.shard/cache/artifacts/bb/bbb.bin': { url: 'f/bbb.bin', size: 10, hash: 'bbb' },
  }

  it('reads project paths from their hashed files', async () => {
    const base = memoryFs({ 'f/aaa.json': '{"a":1}', 'f/bbb.bin': '0123456789' })
    const fs = buildFs(base, files)
    expect(await fs.readText('scenes/main.scene.json')).toBe('{"a":1}')
    expect(await fs.readText('./scenes/main.scene.json')).toBe('{"a":1}')
    expect(decode(await fs.readRange!('.shard/cache/artifacts/bb/bbb.bin', 2, 3))).toBe('234')
    expect(base.reads).toEqual(['f/aaa.json', 'f/aaa.json', 'f/bbb.bin'])
    expect(fs.resolveUrl!('scenes/main.scene.json')).toBe('https://cdn.example/f/aaa.json')
  })

  it('answers exists from the file map, fails on files it lacks, and refuses writes', async () => {
    const base = memoryFs({})
    const fs = buildFs(base, files)
    expect(await fs.exists('scenes/main.scene.json')).toBe(true)
    expect(await fs.exists('scenes/other.scene.json')).toBe(false)
    expect(base.reads).toEqual([])
    expect(fs.writable).toBe(false)
    const missing = await fs.readText('scenes/other.scene.json').catch((e: ShardError) => e)
    expect((missing as ShardError).code).toBe('platform/fs-not-found')
    expect((missing as ShardError).hint).toContain('export.include')
    const write = await fs.writeText('saves/a.json', '{}').catch((e: ShardError) => e)
    expect((write as ShardError).code).toBe('platform/fs-read-only')
  })
})
