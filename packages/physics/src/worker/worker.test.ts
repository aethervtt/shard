import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { ShardError } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { afterEach, describe, expect, it } from 'vitest'
import golden from '../track/golden.json'
import { type TrackScene, trackHash, trackSceneFromJson } from '../track/index'
import { trayScene } from '../track/test-scenes'
import { createTrackClient, type TrackClient, type TrackWorkerLike } from './index'

const GOLDEN_HASH = Number.parseInt(golden.hash, 16)
const goldenScene = () => trackSceneFromJson(golden.scene)
/** 32 dice that never sleep, for 12,000 steps: about a second, far longer than any test waits. */
function endless(): TrackScene {
  const scene = trayScene(32, 3, 12_000)
  for (const b of scene.bodies) b.canSleep = false
  return scene
}
const tsx = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href

/** `test-worker.ts` in a worker thread, through the web Worker interface the client expects. */
function nodeWorker(): TrackWorkerLike {
  const worker = new Worker(new URL('./test-worker.ts', import.meta.url), {
    execArgv: ['--import', tsx],
  })
  const listeners: Record<string, ((event: never) => void)[]> = {
    message: [],
    error: [],
    messageerror: [],
  }
  const emit = (type: string, event: unknown) => {
    for (const listener of listeners[type]!) listener(event as never)
  }
  worker.on('message', (data) => emit('message', { data }))
  worker.on('error', (err: Error) => emit('error', { type: 'error', message: err.message }))
  return {
    postMessage: (message, transfer) => worker.postMessage(message, transfer as ArrayBuffer[]),
    addEventListener: (type: string, listener: (event: never) => void) =>
      void listeners[type]!.push(listener),
    terminate: () => void worker.terminate(),
  }
}

async function rejection(p: Promise<unknown>): Promise<ShardError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  )
  expect(err).toBeInstanceOf(ShardError)
  return err as ShardError
}

const clients: TrackClient[] = []
function client(spawn: 'inline' | 'worker'): TrackClient {
  const c = createTrackClient({ spawn: spawn === 'inline' ? 'inline' : nodeWorker })
  clients.push(c)
  return c
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose()
})

describe.each(['inline', 'worker'] as const)('track client (%s)', (spawn) => {
  it('records the golden track: the same hash across 10 runs', {
    timeout: timeout(30_000),
  }, async () => {
    const c = client(spawn)
    await c.ready()
    const hashes = new Set<string>()
    for (let i = 0; i < 10; i++) {
      const track = await c.record(goldenScene(), { contacts: golden.contacts })
      hashes.add(trackHash(track).toString(16).padStart(8, '0'))
    }
    expect([...hashes]).toEqual([golden.hash])
    expect(trackHash(await c.record(goldenScene(), { contacts: golden.contacts }))).toBe(
      GOLDEN_HASH,
    )
  })

  it('rejects within 10 ms of an abort, and the next recording succeeds', async () => {
    const c = client(spawn)
    await c.ready()
    const abort = new AbortController()
    const running = c.record(endless(), { signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 20))
    const abortedAt = performance.now()
    abort.abort()
    const err = await rejection(running)
    expect(performance.now() - abortedAt).toBeLessThan(budget(10))
    expect(err.code).toBe('physics/track-cancelled')
    // The worker stopped too: the next recording doesn't wait behind the endless one.
    const start = performance.now()
    const next = await c.record(goldenScene(), { contacts: golden.contacts })
    expect(performance.now() - start).toBeLessThan(budget(100))
    expect(trackHash(next)).toBe(GOLDEN_HASH)
  })

  it('rejects an unknown settle rule, then keeps working', async () => {
    const c = client(spawn)
    const err = await rejection(c.record(goldenScene(), { settle: { rule: 'nope' } }))
    expect(err.code).toBe('physics/unknown-settle-rule')
    expect((await c.record(goldenScene())).settled).toBe(true)
  })

  it('rejects pending recordings on dispose, and recordings after it', async () => {
    const c = client(spawn)
    const pending = c.record(endless())
    c.dispose()
    expect((await rejection(pending)).code).toBe('physics/track-cancelled')
    expect((await rejection(c.record(goldenScene()))).code).toBe('physics/track-client-disposed')
    expect(c.disposed).toBe(true)
  })
})

describe('track worker crashes', () => {
  it('rejects pending recordings with physics/worker-crashed, and respawns on the next call', async () => {
    const c = client('worker')
    await c.ready()
    const first = c.record(goldenScene(), { settle: { rule: 'crash' } })
    const second = c.record(goldenScene())
    expect((await rejection(first)).code).toBe('physics/worker-crashed')
    expect((await rejection(second)).code).toBe('physics/worker-crashed')
    expect(c.spawns).toBe(1)
    const track = await c.record(goldenScene(), { contacts: golden.contacts })
    expect(trackHash(track)).toBe(GOLDEN_HASH)
    expect(c.spawns).toBe(2)
  })
})
