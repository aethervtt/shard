import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t, World } from '@aethervtt/shard-core'
import { createMemoryStorage, type KeyValueStorage } from '@aethervtt/shard-platform'
import { createNodePlatform } from '@aethervtt/shard-platform-node'
import { describe, expect, it } from 'vitest'
import {
  compressRecord,
  decodeRecord,
  decodeStored,
  defineGenerator,
  encodeRecord,
  executeJob,
  generate,
  procgen,
  recordHash,
  requestOf,
} from '.'
import { LEDGER_KEY, StoredLedger } from './ledger'
import { runGeneratorJob } from './worker'

let runs = 0
/** About 20 KB of numbers: records of similar stored sizes. */
const Noise = defineGenerator('test/StoredNoise', {
  params: { count: t.u32({ default: 2000 }) },
  output: 'data',
  run(ctx, p) {
    runs++
    const out: number[] = []
    for (let i = 0; i < p.count; i++) out.push(Math.round(ctx.rng.range(0, 1e6)))
    return out
  },
})

const job = (seed: number) => ({ ...requestOf(Noise, {}, seed), deps: [], chain: [] })

async function until(done: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await done()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('timed out waiting')
}

const recordKeys = async (storage: KeyValueStorage) => storage.list('procgen/')

describe('stored records (0125)', () => {
  it('round-trips gzipped records and still reads uncompressed ones', async () => {
    const result = await executeJob(job(1))
    const packed = encodeRecord({ key: 'k', ...result, bytes: 0 })
    const stored = await compressRecord(packed)
    expect([stored[0], stored[1]]).toEqual([0x1f, 0x8b])
    expect(stored.byteLength).toBeLessThan(packed.byteLength / 2)
    const back = (await decodeStored(stored))!
    expect(await recordHash(back)).toBe(await recordHash(result))
    // Records written before 0125 decode as they are.
    expect(await recordHash((await decodeStored(packed))!)).toBe(await recordHash(result))
    expect(await decodeStored(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBeUndefined()
    await expect(decodeStored(stored.subarray(0, 40))).rejects.toThrow()
  })

  it('gzips on a worker when asked, and only then', async () => {
    const plain = await runGeneratorJob(job(2))
    expect(plain.stored).toBeUndefined()
    const { packed, stored } = await runGeneratorJob({ ...job(2), compress: true })
    const fromStored = (await decodeStored(stored!))!
    expect(await recordHash(fromStored)).toBe(await recordHash(decodeRecord(packed)!))
  })

  it('keeps its ledger in the storage: counted on load, oldest evicted, reads refresh', async () => {
    const storage = createMemoryStorage()
    let limit = 1000
    const put = async (ledger: StoredLedger, key: string, bytes: number) => {
      await storage.write(`procgen/${key}`, new Uint8Array(bytes))
      await ledger.add(key, bytes)
    }
    const first = new StoredLedger(storage, () => limit)
    await put(first, 'a', 100)
    await put(first, 'b', 100)
    await put(first, 'c', 100)
    await first.flush()

    limit = 350
    const second = new StoredLedger(storage, () => limit)
    await second.ready()
    expect(second.stats()).toEqual({ records: 3, bytes: 300 })
    await second.touch('a')
    await put(second, 'd', 100)
    // b went (least recently used); a stayed, since it was read.
    expect(await recordKeys(storage)).toEqual(['procgen/a', 'procgen/c', 'procgen/d'])
    expect(second.stats()).toEqual({ records: 3, bytes: 300 })
    await second.flush()
    const index = JSON.parse(new TextDecoder().decode(await storage.read(LEDGER_KEY)))
    expect(index.records.map((r: [string, number]) => r[0])).toEqual(['c', 'a', 'd'])
  })

  it('counts records the index lacks and drops indexed records that are gone', async () => {
    const storage = createMemoryStorage()
    await storage.write(
      LEDGER_KEY,
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          records: [
            ['gone', 50],
            ['kept', 70],
          ],
        }),
      ),
    )
    await storage.write('procgen/kept', new Uint8Array(70))
    await storage.write('procgen/orphan', new Uint8Array(30))
    const ledger = new StoredLedger(storage, () => 1000)
    await ledger.ready()
    expect(ledger.stats()).toEqual({ records: 2, bytes: 100 })
    // The orphan counts as least recently used: it goes first.
    const tight = new StoredLedger(storage, () => 100)
    await storage.write('procgen/new', new Uint8Array(20))
    await tight.add('new', 20)
    expect(await recordKeys(storage)).toEqual(['procgen/kept', 'procgen/new'])
  })

  it('a new runtime over the same storage counts, reads and evicts what an earlier one wrote', async () => {
    const storage = createMemoryStorage()
    const first = new World()
    procgen(first).configure({ storage })
    runs = 0
    await generate(first, Noise, {}, 1)
    await generate(first, Noise, {}, 2)
    await until(() => procgen(first).cacheStats().stored.records === 2)
    await procgen(first).flushStorage()
    const written = procgen(first).cacheStats().stored.bytes
    // Gzipped: 2000 six-digit numbers are about 14 KB of JSON.
    expect(written / 2).toBeLessThan(10_000)

    const second = new World()
    procgen(second).configure({ storage, storageSize: Math.round(written * 1.25) })
    const one = await generate(second, Noise, {}, 1)
    expect(procgen(second).lastResult(one.guid!)!.hit).toBe('disk')
    expect(runs).toBe(2)
    await generate(second, Noise, {}, 3)
    await until(async () => (await recordKeys(storage)).length === 2)
    const keys = await recordKeys(storage)
    const keyOf = (w: World, guid: string) => `procgen/${procgen(w).lastResult(guid)!.key}`
    // Seed 1 was read in this runtime, so seed 2 (the least recently used) went.
    expect(keys).toContain(keyOf(second, one.guid!))
    expect(procgen(second).cacheStats().stored.records).toBe(2)
  })

  it('writes gzipped records to disk and reads them back as disk hits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'shard-stored-'))
    try {
      const platform = createNodePlatform({ root, logTo: () => {} })
      const first = new World()
      procgen(first).configure({ fs: platform.fs })
      runs = 0
      const ref = await generate(first, Noise, {}, 9)
      const key = procgen(first).lastResult(ref.guid!)!.key!
      const path = `.shard/cache/generated/${key.slice(0, 2)}/${key}`
      await until(() => platform.fs.exists(path))
      await until(async () => (await platform.fs.readBytes(path)).byteLength > 0)
      const bytes = readFileSync(join(root, path))
      expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b])
      const second = new World()
      procgen(second).configure({ fs: platform.fs })
      const back = await generate(second, Noise, {}, 9)
      expect(procgen(second).lastResult(back.guid!)!.hit).toBe('disk')
      expect(runs).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
