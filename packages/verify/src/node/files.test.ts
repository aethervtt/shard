import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CaptureManifest } from '../run'
import { approveShot, compareRun, perfCheck } from './files'
import { encodePng, sha256 } from './png'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'shard-verify-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** A 64×32 image: flat color, with a dark bar at `bar` (x). */
function image(bar: number, alpha = 255): Uint8Array {
  const data = new Uint8Array(64 * 32 * 4)
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const o = (y * 64 + x) * 4
      const dark = x >= bar && x < bar + 4
      data.set(dark ? [20, 20, 30, alpha] : [120, 160, 110, alpha], o)
    }
  }
  return encodePng(data, 64, 32)
}

function write(file: string, data: string | Uint8Array) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, data)
}

/** A capture run with one shot per id, and returns its directory. */
function run(name: string, shots: Record<string, Uint8Array>): string {
  const root = join(dir, name)
  const manifest: CaptureManifest = {
    version: 1,
    url: 'http://localhost/verify.html',
    fixture: '/verify.html',
    date: new Date(0).toISOString(),
    shots: Object.entries(shots).map(([id, png]) => {
      write(join(root, `${id}.png`), png)
      const [browser, client, rest] = id.split('/') as [string, string, string]
      return {
        id,
        browser,
        client,
        shot: rest.split('@')[0]!,
        dpr: 1,
        scope: 'canvas' as const,
        width: 64,
        height: 32,
        hash: sha256(png),
        tolerance: {},
      }
    }),
    records: [],
    steps: [],
    skipped: [],
  }
  write(join(root, 'manifest.json'), JSON.stringify(manifest))
  return root
}

describe('shard approve (0062)', () => {
  it('refuses an approval without a reason, and changes nothing', async () => {
    const captures = run('latest', { 'chromium/main/grid@1x': image(10) })
    const approved = join(dir, 'approved')
    for (const reason of [undefined, '', '   ']) {
      await expect(
        approveShot({ captures, approved, shot: 'chromium/main/grid@1x', reason, by: 'test' }),
      ).rejects.toMatchObject({ code: 'verify/approval-needs-reason' })
    }
    expect(() => readFileSync(join(approved, 'approvals.json'))).toThrow()
  })

  it('copies the capture and records its hash and the reason', async () => {
    const png = image(10)
    const captures = run('latest', { 'chromium/main/grid@1x': png })
    const approved = join(dir, 'approved')
    const approval = await approveShot({
      captures,
      approved,
      shot: 'chromium/main/grid@1x',
      reason: 'First approved capture of the grid',
      by: 'Pat',
      date: new Date('2026-09-29T12:00:00Z'),
    })
    expect(approval).toEqual({
      shot: 'chromium/main/grid@1x',
      hash: sha256(png),
      reason: 'First approved capture of the grid',
      by: 'Pat',
      date: '2026-09-29T12:00:00.000Z',
    })
    expect(sha256(readFileSync(join(approved, 'chromium/main/grid@1x.png')))).toBe(sha256(png))
    expect(JSON.parse(readFileSync(join(approved, 'approvals.json'), 'utf8'))).toEqual({
      version: 1,
      approvals: [approval],
    })
  })

  it('names the shots a run has when asked for another', async () => {
    const captures = run('latest', { 'chromium/main/grid@1x': image(10) })
    await expect(
      approveShot({ captures, approved: join(dir, 'a'), shot: 'grid', reason: 'x', by: 't' }),
    ).rejects.toMatchObject({
      code: 'verify/unknown-shot',
      hint: 'Its shots: chromium/main/grid@1x.',
    })
  })
})

describe('shard compare (0062)', () => {
  it('passes unchanged shots, fails changed ones, and calls unapproved ones new', async () => {
    const approvedRun = run('first', {
      'chromium/main/a@1x': image(10),
      'chromium/main/b@1x': image(10),
    })
    const approved = join(dir, 'approved')
    for (const shot of ['chromium/main/a@1x', 'chromium/main/b@1x']) {
      await approveShot({ captures: approvedRun, approved, shot, reason: 'baseline', by: 't' })
    }
    const latest = run('latest', {
      'chromium/main/a@1x': image(10),
      'chromium/main/b@1x': image(12),
      'chromium/main/c@1x': image(10),
    })
    const result = await compareRun(latest, approved)
    expect(result.pass).toBe(false)
    expect(result.shots.map((s) => [s.id, s.status])).toEqual([
      ['chromium/main/a@1x', 'pass'],
      ['chromium/main/b@1x', 'fail'],
      ['chromium/main/c@1x', 'new'],
    ])
    const html = readFileSync(result.report, 'utf8')
    expect(html).toContain('1 changed, 1 new, 1 unchanged.')
    expect(html).toContain('diff/chromium/main/b@1x.png')
    expect(html).toMatch(/Approved \d{4}-\d\d-\d\d by t: baseline/)
    expect(readFileSync(join(latest, 'diff/chromium/main/b@1x.png')).length).toBeGreaterThan(0)
  })
})

describe('shard perf-check (0062)', () => {
  it('reads records from directories and applies the plan', async () => {
    const plan = join(dir, 'plan.json')
    write(
      plan,
      JSON.stringify({ url: 'http://x/', thresholds: { idle: { 'frameTime.p95': { max: 10 } } } }),
    )
    const record = {
      version: 1,
      renderer: 'shard',
      fixture: 'f',
      scenario: 'idle',
      device: { ua: 'x', gpu: 'y', dpr: 1, viewport: [10, 10] },
      renderScale: { mode: 'fixed', min: 1, max: 1 },
      coldStart: { total: 1, modules: 1, device: 1, pipelines: 1, assets: 1 },
      firstUsableFrame: 1,
      patchToFrame: { p50: 1, p95: 1, n: 1 },
      frameTime: { p50: 8, p95: 12, p99: 14, n: 10 },
      longTasks: { count: 0, totalMs: 0, maxMs: 0 },
      gpuMemory: { bytes: 0, byCategory: {} },
      download: { transferred: 0, decoded: 0 },
    }
    write(join(dir, 'records/idle/chromium@1x-main.json'), JSON.stringify(record))
    const result = await perfCheck(plan, [join(dir, 'records')])
    expect(result).toMatchObject({
      pass: false,
      records: 1,
      breaches: [{ value: 12, budget: 'max 10' }],
    })
    write(join(dir, 'records/bad.json'), JSON.stringify({ ...record, version: 3 }))
    await expect(perfCheck(plan, [join(dir, 'records')])).rejects.toMatchObject({
      code: 'verify/invalid-record',
    })
  })
})
