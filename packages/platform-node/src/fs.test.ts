import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ShardError } from '@aethervtt/shard-core'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodePlatform } from './index'

const dir = mkdtempSync(join(tmpdir(), 'shard-fs-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('node file service', () => {
  const fs = createNodePlatform({ root: dir }).fs

  it('reads a range of a file (0071 packs), short at its end', async () => {
    const data = new Uint8Array(1000).map((_, i) => i & 0xff)
    await fs.writeBytes('cache/a.pack', data)
    expect(await fs.readRange!('cache/a.pack', 300, 50)).toEqual(data.subarray(300, 350))
    expect(await fs.readRange!('cache/a.pack', 990, 50)).toEqual(data.subarray(990))
    await expect(fs.readRange!('cache/missing.pack', 0, 4)).rejects.toSatisfy(
      (err: ShardError) => err.code === 'platform/fs-not-found',
    )
  })
})
