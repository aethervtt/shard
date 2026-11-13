import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PerformanceObserver } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { ByteWriter, createRowCodec, type Entity, type World } from '@aethervtt/shard-core'
import { budget, timeout } from '@aethervtt/shard-core/test-env'
import { anyOf, ownerInterest, Replicated, replicate } from '@aethervtt/shard-net'
import { netHarness } from '@aethervtt/shard-net/testing'
import { buildGeneratorWorker } from '@aethervtt/shard-node'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { configureProcgenHost, Generated } from '@aethervtt/shard-procgen'
import type { App } from '@aethervtt/shard-runtime'
import { InstancePart } from '@aethervtt/shard-scene'
import { Transform } from '@aethervtt/shard-transform'
import { describe, expect, it } from 'vitest'
import {
  cellOf,
  configureCommits,
  loadedCells,
  spawnSource,
  spawnTown,
  steps,
  townApp,
  townPlugins,
} from './fixtures/apps'
import { defineTown } from './fixtures/town'
import { CellBound, PartitionState, partitionSettled, StreamingSource, storedDelta } from './index'
import {
  applyCellDelta,
  CellDeltaEvent,
  partitionNet,
  partitionNetPlugin,
  streamInterest,
} from './net'
import { upkeep } from './runtime'

function cellPath(world: World, e: Entity): string {
  return world.get(e, InstancePart).path
}

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const WALK = defineTown({ name: 'walk-town', props: 12 })
const DENSE = defineTown({ name: 'dense-town', props: 30 })

/** Main-thread ms of each app.update, with GC pauses inside it subtracted. */
function frameTimer(app: App): number[] {
  const times: number[] = []
  const gcs: [number, number][] = []
  const observer = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) gcs.push([e.startTime, e.startTime + e.duration])
  })
  observer.observe({ entryTypes: ['gc'] })
  const update = app.update.bind(app)
  app.update = (delta: number, fixed?: number) => {
    const start = performance.now()
    update(delta, fixed)
    const end = performance.now()
    for (const e of observer.takeRecords()) gcs.push([e.startTime, e.startTime + e.duration])
    let gc = 0
    for (const [a, b] of gcs) gc += Math.max(0, Math.min(b, end) - Math.max(a, start))
    times.push(end - start - gc)
  }
  return times
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)] ?? 0
}

describe('streaming budgets', () => {
  it(
    'walks 1 km through the town: cells load, unload and change level within the frame budget',
    async () => {
      const out = mkdtempSync(join(tmpdir(), 'shard-partition-walk-'))
      const workers = createNodeWorkers(2)
      const bundle = await buildGeneratorWorker({
        root,
        entry: 'src/fixtures/town.ts',
        outDir: out,
      })
      configureProcgenHost({ workers, workerModule: bundle.url })
      const h = await netHarness({
        clients: 1,
        plugins: () => townPlugins({ physics: true }),
        server: () => [partitionNetPlugin()],
        client: () => [partitionNetPlugin()],
        net: partitionNet({ replicate: [replicate(Transform, { mode: 'interpolate' })] }),
        serverNet: {
          interest: anyOf(ownerInterest(), streamInterest()),
          players: {
            spawn(world, { peer }) {
              world.spawn(
                [Transform, { translation: [32, 1, 32] }],
                [StreamingSource, {}],
                [Replicated, { owner: peer }],
              )
            },
          },
        },
      })
      try {
        for (const app of [h.server, ...h.clients]) configureCommits(app.world, { commit: 'ready' })
        spawnTown(h.server.world, WALK)
        await h.connect()
        const server = h.server.world
        const client = h.clients[0]!.world
        // Settle the start (the first cells around a player can't hide behind anything).
        for (let i = 0; i < 600; i++) {
          await partitionSettled(server)
          await partitionSettled(client)
          h.step(1)
          await new Promise((r) => setImmediate(r))
        }
        const serverFrames = frameTimer(h.server)
        const clientFrames = frameTimer(h.clients[0]!)
        const player = [...server.query({ with: [StreamingSource, Replicated] }).tables][0]!
          .entities[0]! as Entity
        const streaming: number[] = []
        const commits: [number, number][] = []
        const seen = { server: new Set<string>(), client: new Set<string>() }
        const levels = new Map<string, string>()
        let swaps = 0
        let unloads = 0
        let x = 32
        for (let frame = 0; frame < 2000; frame++) {
          x += 0.5
          server.add(player, Transform, { translation: [x, 1, 32] })
          h.step(1)
          // Let pool results land between frames, as an event loop does.
          await new Promise((r) => setImmediate(r))
          for (const [world, s] of [
            [server, seen.server],
            [client, seen.client],
          ] as [World, Set<string>][]) {
            const rt = world.resource(PartitionState).instances.values().next().value
            if (!rt) continue
            streaming.push(rt.ms)
            if (rt.committed > 0) commits.push([rt.commitMs, rt.committed])
            const now = loadedCells(world)
            for (const k of s) if (!(k in now)) unloads++
            s.clear()
            for (const k of Object.keys(now)) s.add(k)
            if (world === client) {
              for (const [k, v] of Object.entries(now)) {
                if (levels.has(k) && levels.get(k) !== v) swaps++
                levels.set(k, v)
              }
            }
          }
        }
        // The walk did what it's meant to: load, unload and swap, on both sides.
        expect(loadedCells(server)['0:16,0']).toBe('full')
        expect(loadedCells(client)['0:16,0']).toBe('full')
        expect(unloads).toBeGreaterThan(20)
        expect(swaps).toBeGreaterThan(10)
        if (process.env.SHARD_PERF_LOG) {
          console.log(
            JSON.stringify({
              server: { max: Math.max(...serverFrames), p95: p95(serverFrames) },
              client: { max: Math.max(...clientFrames), p95: p95(clientFrames) },
              stream: { p95: p95(streaming), max: Math.max(...streaming) },
              commit: {
                max: Math.max(...commits.map(([ms]) => ms)),
                perEntity: commits.map(([ms, n]) => ms / n).reduce((a, b) => Math.max(a, b), 0),
                maxEntities: Math.max(...commits.map(([, n]) => n)),
              },
              unloads,
              swaps,
            }),
          )
        }
        expect(Math.max(...serverFrames)).toBeLessThanOrEqual(budget('partition/walk-frame'))
        expect(Math.max(...clientFrames)).toBeLessThanOrEqual(budget('partition/walk-frame'))
        expect(p95(streaming)).toBeLessThanOrEqual(budget('partition/stream'))
        expect(Math.max(...commits.map(([ms]) => ms))).toBeLessThanOrEqual(
          budget('partition/cell-commit'),
        )
      } finally {
        configureProcgenHost({ workers: undefined, workerModule: undefined })
        workers.dispose()
        await h.dispose()
        rmSync(out, { recursive: true, force: true })
      }
    },
    timeout(240_000),
  )

  it('recomputes 100 changed entities’ delta keys within the per-tick budget', async () => {
    const app = await townApp()
    const world = app.world
    spawnTown(world, DENSE)
    spawnSource(world, 32, 32)
    await steps(app, 8)
    const generated = world.query({ with: [InstancePart, Generated] })
    const bound = world.query({ with: [CellBound] })
    const props: Entity[] = []
    for (const key of ['0:0,0', '0:1,0']) {
      for (const [path, e] of cellOf(world, key)!.entities) {
        if (path.includes('/prop-') && props.length < 100) props.push(e)
      }
    }
    expect(props).toHaveLength(100)
    const times: number[] = []
    for (let rep = 0; rep < 30; rep++) {
      for (const e of props) world.add(e, Transform, { translation: [rep, 0, rep] })
      const start = performance.now()
      upkeep(world, generated, bound)
      times.push(performance.now() - start)
      // As the scheduler does after a system: later writes get a newer tick.
      world.incrementTick()
    }
    const delta = storedDelta(world, DENSE, '0:0,0')!
    expect(delta.entries.get(cellPath(world, props[0]!))).toEqual({
      'core/Transform': { translation: [29, 0, 29] },
    })
    times.sort((a, b) => a - b)
    if (process.env.SHARD_PERF_LOG) console.log(JSON.stringify({ deltaUpdate: times[15] }))
    expect(times[15]).toBeLessThanOrEqual(budget('partition/delta-update'))
    app.dispose()
  })

  it('applies a 100-entry delta on a client within budget, and an untouched cell costs under 32 bytes', async () => {
    const h = await netHarness({
      clients: 1,
      plugins: () => townPlugins(),
      server: () => [partitionNetPlugin()],
      client: () => [partitionNetPlugin()],
      net: partitionNet({ replicate: [replicate(Transform, { mode: 'interpolate' })] }),
      serverNet: {
        players: {
          spawn(world, { peer }) {
            world.spawn(
              [Transform, { translation: [32, 1, 32] }],
              [StreamingSource, {}],
              [Replicated, { owner: peer }],
            )
          },
        },
      },
    })
    try {
      for (const app of [h.server, ...h.clients]) configureCommits(app.world, {})
      spawnTown(h.server.world, DENSE)
      await h.connect()
      for (let i = 0; i < 60; i++) {
        await Promise.all([h.server, ...h.clients].map((a) => partitionSettled(a.world)))
        h.step(1)
      }
      const client = h.clients[0]!.world
      const cell = cellOf(client, '0:0,0')!
      const paths = [...cell.entities.keys()].filter((p) => p.includes('/prop-')).slice(0, 100)
      expect(paths).toHaveLength(100)
      const times: number[] = []
      for (let rep = 0; rep < 30; rep++) {
        const entries: Record<string, unknown> = {}
        for (const p of paths) entries[p] = { 'core/Transform': { translation: [rep, 0, rep] } }
        const start = performance.now()
        applyCellDelta(client, {
          grid: 0,
          x: 0,
          z: 0,
          rev: 1000 + rep,
          full: false,
          entries: entries as never,
          drop: [],
        })
        times.push(performance.now() - start)
      }
      times.sort((a, b) => a - b)
      if (process.env.SHARD_PERF_LOG) console.log(JSON.stringify({ deltaApply: times[15] }))
      expect(times[15]).toBeLessThanOrEqual(budget('partition/delta-apply'))
      expect(client.get(cell.entities.get(paths[0]!)!, Transform).translation).toEqual([29, 0, 29])

      const codec = createRowCodec(CellDeltaEvent.schema)
      const w = new ByteWriter(64)
      codec.encode({ grid: 0, x: 12, z: -7, rev: 0, full: true, entries: {}, drop: [] }, w)
      // Plus the event's index and the section header in the reliable message.
      expect(w.length + 2).toBeLessThan(32)
    } finally {
      await h.dispose()
    }
  })
})
