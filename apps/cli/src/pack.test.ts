import { buildFs, type PlatformFileSystem } from '@aethervtt/shard-platform'
import { describe, expect, it } from 'vitest'
import { packFiles } from './pack'

/** Files of every kind a pack stores: deflated JSON, a raw PNG, a raw terrain page, a tiny one. */
function sample(): Map<string, Uint8Array> {
  const json = new TextEncoder().encode(JSON.stringify({ entities: Array(400).fill({ a: 1 }) }))
  const noise = new Uint8Array(3000).map((_, i) => (i * 7919) % 251)
  return new Map([
    ['scenes/main.scene.json', json],
    ['.shard/cache/artifacts/aa/aa.png', noise.slice(0, 2000)],
    ['.shard/cache/terrain/t1/pages.bin', new Uint8Array(5000).fill(3)],
    ['.shard/catalog.json', new TextEncoder().encode('{}')],
    ['.shard/cache/artifacts/bb/bb.bin', noise],
  ])
}

/** A file system over in-memory files, counting ranged and whole reads. */
function memoryFs(files: Map<string, Uint8Array>) {
  const reads = { whole: 0, ranged: 0 }
  const fs: PlatformFileSystem = {
    writable: false,
    readText: async (p) => new TextDecoder().decode(files.get(p)),
    readBytes: async (p) => {
      reads.whole++
      return files.get(p)!
    },
    readRange: async (p, offset, length) => {
      reads.ranged++
      return files.get(p)!.subarray(offset, offset + length)
    },
    writeText: async () => {},
    writeBytes: async () => {},
    exists: async (p) => files.has(p),
  }
  return { fs, reads }
}

describe('asset packs (0110)', () => {
  it('reads every file back byte-identical, whole and by range, deflated or raw', async () => {
    const files = sample()
    const { packs, entries } = packFiles(files)
    expect(packs).toHaveLength(1)
    expect(entries['scenes/main.scene.json']!.encoding).toBe('deflate')
    expect(entries['.shard/cache/artifacts/aa/aa.png']!.encoding).toBe('raw')
    // Read by range (0071): never deflated, even though it would shrink.
    expect(entries['.shard/cache/terrain/t1/pages.bin']!.encoding).toBe('raw')
    for (const e of Object.values(entries)) expect(e.offset % 16).toBe(0)

    const { fs: base, reads } = memoryFs(new Map([['f/p0.shardpak', packs[0]!]]))
    const fs = buildFs(base, entries, ['f/p0.shardpak'])
    for (const [path, bytes] of files) {
      expect(await fs.readBytes(path), path).toEqual(bytes)
      expect(await fs.readRange!(path, 10, 100), path).toEqual(bytes.subarray(10, 110))
    }
    expect(await fs.readText('.shard/catalog.json')).toBe('{}')
    expect(fs.resolveUrl!('scenes/main.scene.json')).toBeUndefined()
    // Everything came out of the pack by range: the pack is never read whole.
    expect(reads.whole).toBe(0)
    expect(reads.ranged).toBeGreaterThan(0)
  })

  it('starts a new pack at the limit, and writes a header tools can read alone', async () => {
    const files = sample()
    const { packs, entries } = packFiles(files, 4096)
    expect(packs.length).toBeGreaterThan(1)
    const head = packs[0]!
    expect(new TextDecoder().decode(head.subarray(0, 4))).toBe('SHPK')
    const view = new DataView(head.buffer, head.byteOffset)
    expect(view.getUint32(4, true)).toBe(1)
    const index = JSON.parse(
      new TextDecoder().decode(head.subarray(12, 12 + view.getUint32(8, true))),
    )
    for (const [path, entry] of Object.entries(index)) expect(entries[path]).toEqual(entry)

    const urls = packs.map((_, i) => `f/p${i}.shardpak`)
    const { fs: base } = memoryFs(new Map(packs.map((p, i) => [urls[i]!, p])))
    const fs = buildFs(base, entries, urls)
    for (const [path, bytes] of files) expect(await fs.readBytes(path), path).toEqual(bytes)
  })
})
