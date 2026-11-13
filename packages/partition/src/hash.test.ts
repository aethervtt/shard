import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { netHarness } from '@aethervtt/shard-net/testing'
import { buildGeneratorWorker } from '@aethervtt/shard-node'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { configureProcgenHost, defineGenerator, procgen } from '@aethervtt/shard-procgen'
import { describe, expect, it } from 'vitest'
import { configureCommits, spawnTown, townPlugins } from './fixtures/apps'
import { ENGINE_COMPONENTS } from './fixtures/engine-components'
import { defineTown } from './fixtures/town'

void ENGINE_COMPONENTS

import { cellHashOf, cellParams } from './index'
import { partitionNet, partitionNetPlugin } from './net'
import { HASH_CELLS } from './testing'

const TOWN = defineTown({ name: 'hash-town', props: 4 })
const here = fileURLToPath(new URL('.', import.meta.url))
const root = resolve(here, '..')

/** 20 cells around the origin, at both levels. */
const CELLS = HASH_CELLS

async function hashes(world: World): Promise<string[]> {
  const out: string[] = []
  for (const [x, z, level] of CELLS) out.push(await cellHashOf(world, TOWN, 7, 0, x, z, level))
  return out
}

describe('cell hashes', () => {
  it('are the same on a server app and a client app, at each level', async () => {
    const h = await netHarness({
      clients: 1,
      plugins: () => townPlugins(),
      server: () => [partitionNetPlugin()],
      client: () => [partitionNetPlugin()],
      net: partitionNet(),
    })
    try {
      for (const app of [h.server, ...h.clients]) configureCommits(app.world, {})
      spawnTown(h.server.world, TOWN)
      const server = await hashes(h.server.world)
      const client = await hashes(h.clients[0]!.world)
      expect(client).toEqual(server)
      // Levels differ from each other, and cells from each other.
      expect(new Set(server).size).toBe(CELLS.length)
    } finally {
      await h.dispose()
    }
  })

  it(
    'are the same inline, on the worker pool, and in a second Node process',
    async () => {
      const inline = await hashes(new World())
      const out = mkdtempSync(join(tmpdir(), 'shard-partition-worker-'))
      const workers = createNodeWorkers(2)
      let jobs = 0
      const run = workers.run.bind(workers)
      workers.run = ((module: string, fn: string, args: readonly unknown[], o?: never) => {
        if (fn === 'runGeneratorJob') jobs++
        return run(module, fn, args, o)
      }) as typeof workers.run
      try {
        const bundle = await buildGeneratorWorker({
          root,
          entry: 'src/fixtures/town.ts',
          outDir: out,
        })
        configureProcgenHost({ workers, workerModule: bundle.url })
        const world = new World()
        const pooled = await hashes(world)
        expect(jobs).toBeGreaterThan(0)
        expect(pooled).toEqual(inline)
      } finally {
        configureProcgenHost({ workers: undefined, workerModule: undefined })
        await workers.dispose?.()
        rmSync(out, { recursive: true, force: true })
      }
      // A second Node process, running the TypeScript through tsx's loader (no shell: Windows too).
      const text = execFileSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx/esm'),
          join('src', 'fixtures', 'hash-cells.ts'),
          JSON.stringify(CELLS),
        ],
        { cwd: root, encoding: 'utf8' },
      )
      expect(JSON.parse(text)).toEqual(inline)
    },
    timeout(120_000),
  )

  it('fails a cell generator that calls Math.sin', async () => {
    const Bad = defineGenerator('test/SinCell', {
      params: { ...cellParams(['full']) },
      output: 'entities',
      deterministicMath: true,
      run: (_ctx, p) => [
        { name: 'a', components: { 'core/Transform': { translation: [Math.sin(p.x), 0, 0] } } },
      ],
    })
    const world = new World()
    const ref = procgen(world).entryFor({
      generator: Bad.name,
      params: { x: 1, z: 0, level: 'full' },
      seed: 1,
    } as never)
    const { assetServer } = await import('@aethervtt/shard-assets')
    const error = await assetServer(world)
      .load(ref.guid)
      .then(
        () => undefined,
        (e: unknown) => e as { code?: string; message?: string },
      )
    expect(error?.code ?? error?.message).toMatch(/nondeterministic|Math\.sin/)
  })
})
