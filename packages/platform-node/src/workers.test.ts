import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ShardError } from '@shard/core'
import { createInlineWorkers, defaultWorkerCount, workersOf } from '@shard/platform'
import { afterAll, describe, expect, it } from 'vitest'
import { createNodePlatform } from './index'
import { createNodeWorkers } from './workers'

const dir = mkdtempSync(join(tmpdir(), 'shard-workers-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// A worker module: plain JavaScript, as worker modules are.
const file = join(dir, 'jobs.mjs')
writeFileSync(
  file,
  `
import { threadId } from 'node:worker_threads'
export function square(values) {
  const out = new Float32Array(values.length)
  for (let i = 0; i < values.length; i++) out[i] = values[i] * values[i]
  return out
}
export async function slow(ms, tag) {
  await new Promise((r) => setTimeout(r, ms))
  return tag
}
export function thread() { return threadId }
export function crash() { process.exit(3) }
export function fail() {
  throw Object.assign(new Error('bad input'), { code: 'test/bad-input', hint: 'Pass a number.' })
}
`,
)
const url = pathToFileURL(file).href

describe('worker pool (worker_threads)', () => {
  const pool = createNodeWorkers(2)
  afterAll(() => pool.dispose())

  it('runs a module function on a worker and moves typed arrays both ways', async () => {
    const input = new Float32Array([1, 2, 3])
    const result = await pool.run<Float32Array>(url, 'square', [input], {
      transfer: [input.buffer],
    })
    expect([...result]).toEqual([1, 4, 9])
    expect(input.byteLength).toBe(0) // moved, not copied
    const ids = await Promise.all([0, 1, 2, 3].map(() => pool.run<number>(url, 'thread', [])))
    expect(ids.every((id) => id > 0)).toBe(true)
  })

  it('rejects with the error a job threw', async () => {
    const err = (await pool.run(url, 'fail', []).catch((e) => e)) as ShardError
    expect(err.code).toBe('test/bad-input')
    expect(err.hint).toBe('Pass a number.')
    const missing = (await pool.run(url, 'nope', []).catch((e) => e)) as ShardError
    expect(missing.code).toBe('platform/worker-no-export')
  })

  it('rejects with platform/worker-crashed when a worker dies, and replaces it', async () => {
    const err = (await pool.run(url, 'crash', []).catch((e) => e)) as ShardError
    expect(err.code).toBe('platform/worker-crashed')
    // The pool keeps working at full size.
    const tags = await Promise.all(
      ['a', 'b', 'c'].map((t) => pool.run<string>(url, 'slow', [5, t])),
    )
    expect(tags).toEqual(['a', 'b', 'c'])
  })

  it('starts high-priority jobs before queued normal ones', async () => {
    const one = createNodeWorkers(1)
    const order: string[] = []
    const track = (p: Promise<string>) => p.then((t) => void order.push(t))
    const running = track(one.run(url, 'slow', [30, 'first']))
    const queued = [
      track(one.run(url, 'slow', [1, 'normal-1'])),
      track(one.run(url, 'slow', [1, 'normal-2'])),
    ]
    const urgent = track(one.run(url, 'slow', [1, 'urgent'], { priority: 'high' }))
    await Promise.all([running, ...queued, urgent])
    expect(order).toEqual(['first', 'urgent', 'normal-1', 'normal-2'])
    one.dispose()
  })

  it('rejects queued and running jobs on dispose', async () => {
    const one = createNodeWorkers(1)
    const a = one.run(url, 'slow', [50, 'a']).catch((e) => (e as ShardError).code)
    const b = one.run(url, 'slow', [50, 'b']).catch((e) => (e as ShardError).code)
    one.dispose()
    expect(await a).toBe('platform/workers-disposed')
    expect(await b).toBe('platform/workers-disposed')
  })
})

describe('inline workers (size 0)', () => {
  it('runs jobs on the calling thread with the same results', async () => {
    const inline = createInlineWorkers()
    expect(inline.size).toBe(0)
    const result = await inline.run<Float32Array>(url, 'square', [new Float32Array([3])])
    expect([...result]).toEqual([9])
    expect(createNodeWorkers(0).size).toBe(0)
  })

  it('the node platform makes its pool on first use, and hosts without one fall back', async () => {
    const platform = createNodePlatform({ root: dir, workers: 0 })
    expect(platform.workers!.size).toBe(0)
    expect(workersOf({}).size).toBe(0)
    expect(defaultWorkerCount(1)).toBe(1)
    expect(defaultWorkerCount(4)).toBe(3)
    expect(defaultWorkerCount(32)).toBe(8)
  })
})
