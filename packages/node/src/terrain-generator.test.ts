import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { timeout } from '@aethervtt/shard-core/test-env'
import { createNodeWorkers } from '@aethervtt/shard-platform-node'
import { configureProcgenHost } from '@aethervtt/shard-procgen'
import {
  BAND_CAMERA,
  bakeNearPage,
  mainNoise,
  NearBake,
  terrainLayout,
} from '@aethervtt/shard-terrain'
import { groundSource, groundStack } from '@aethervtt/shard-terrain/testing'
import { afterAll, describe, expect, it } from 'vitest'
import { buildGeneratorWorker } from './generators'

const here = dirname(fileURLToPath(import.meta.url))
const workers = createNodeWorkers(3)
afterAll(() => workers.dispose())

describe('terrain generators in the generator worker module (0119)', () => {
  it(
    'runs near pages there with the main thread’s bytes',
    async () => {
      const { source, stack } = await groundStack(groundSource())
      const layout = terrainLayout(source)
      const out = mkdtempSync(join(tmpdir(), 'shard-near-worker-'))
      let jobs = 0
      const run = workers.run.bind(workers)
      workers.run = ((module: string, fn: string, args: readonly unknown[], o?: never) => {
        if (fn === 'runTask') jobs++
        return run(module, fn, args, o)
      }) as typeof workers.run
      try {
        // The terrain package's test generator, bundled as a project's code would be.
        const bundle = await buildGeneratorWorker({
          root: join(here, '../../terrain'),
          entry: 'src/heightfield/fixtures/ground.ts',
          outDir: out,
        })
        configureProcgenHost({ workers, workerModule: bundle.url })
        const near = new NearBake(stack, layout, undefined)
        const keys: [number, number, number][] = []
        for (let i = 0; i < 24; i++) keys.push([layout.depth, (i * 7) % 32, (i * 5) % 32])
        keys.push([0, 3, 2], [layout.depth - 1, 9, 4])
        const pooled = await Promise.all(
          keys.map(([d, x, z]) => near.request(d, x, z, BAND_CAMERA, 0)),
        )
        expect(jobs).toBe(keys.length)
        const noise = mainNoise()
        for (const [i, [d, x, z]] of keys.entries()) {
          const inline = bakeNearPage(noise, stack, layout, d, x, z)
          expect(pooled[i]!.heights).toEqual(inline.heights)
          expect(pooled[i]!.control).toEqual(inline.control)
          expect(pooled[i]!.normals).toEqual(inline.normals)
        }
      } finally {
        workers.run = run
        configureProcgenHost({ workers: undefined, workerModule: undefined })
        rmSync(out, { recursive: true, force: true })
      }
    },
    timeout(120_000),
  )
})
