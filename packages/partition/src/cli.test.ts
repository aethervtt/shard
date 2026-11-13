import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import { describe, expect, it } from 'vitest'

const here = fileURLToPath(new URL('.', import.meta.url))
const bin = resolve(here, '../../../apps/cli/bin/shard.mjs')
const project = resolve(here, '../fixtures/streamed-town')

function shard(args: string[]) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: project,
    encoding: 'utf8',
    timeout: 180_000,
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

describe('shard CLI on a streamed project (0113)', () => {
  it(
    'run --net streams a server and two clients, and two runs print the same hashes',
    () => {
      const args = ['run', '--net', 'clients=2', '--frames', '600', '--json']
      const a = shard(args)
      expect(a.code, a.stderr).toBe(0)
      const first = JSON.parse(a.stdout)
      // Each client generated its own town around its own player.
      for (const c of first.clients) expect(c.entities).toBeGreaterThan(1000)
      // Nothing from around the other player: differences name only each client's own player.
      for (const d of first.differences as string[])
        expect(d).toMatch(/net id (1|2) core\/Transform/)
      const second = JSON.parse(shard(args).stdout)
      expect(second.server.hash).toBe(first.server.hash)
      expect(second.clients.map((c: { hash: string }) => c.hash)).toEqual(
        first.clients.map((c: { hash: string }) => c.hash),
      )
    },
    timeout(240_000),
  )

  it('partition gen hashes a cell at a level, the same inline and on the pool', () => {
    const r = shard([
      'partition',
      'gen',
      'town',
      '--cell',
      '3,-2',
      '--level',
      'far',
      '--seed',
      '7',
      '--compare',
      '--json',
    ])
    expect(r.code, r.stderr).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(out.pooled).toBe(true)
    expect(out.inline).toBe(out.hash)
    expect(out.entities).toBeGreaterThan(0)
  })
})
