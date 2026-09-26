import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assetServer } from '@shard/assets'
import { NoiseGraph, NoiseGraphs, noisePlugin, noiseStats } from '@shard/noise'
import { createNodePlatform } from '@shard/platform-node'
import { compareGolden } from '@shard/render/testing'
import { App } from '@shard/runtime'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decodePng } from './png'
import { createProtocolServer, type ProtocolServer } from './server'

const here = dirname(fileURLToPath(import.meta.url))
const example = resolve(here, '../../../examples/star-explorer/assets/noise/planet.noise.json')
const root = mkdtempSync(join(tmpdir(), 'shard-noise-protocol-'))
const GRAPH = 'assets/noise/planet.noise.json'

let app: App
let server: ProtocolServer

beforeAll(async () => {
  mkdirSync(join(root, 'assets/noise'), { recursive: true })
  cpSync(example, join(root, GRAPH))
  app = new App().addPlugin(noisePlugin)
  await app.init()
  await assetServer(app.world)
    .configure({ platform: createNodePlatform({ root, logTo: () => {} }) })
    .scan()
  server = createProtocolServer(app)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

async function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const r = await server.handle({ jsonrpc: '2.0', id: 1, method, params })
  if (r!.error) throw new Error(JSON.stringify(r!.error))
  return r!.result as T
}

describe('noise over the protocol', () => {
  it('asset.preview of the example graph matches the golden image, on a plane and a sphere', async () => {
    for (const domain of ['plane', 'sphere']) {
      const shot = await call<{ data: string; width: number; height: number }>('asset.preview', {
        asset: GRAPH,
        options: { domain, seed: 7, size: 128 },
      })
      expect(shot.width).toBe(128)
      const image = await decodePng(Uint8Array.from(atob(shot.data), (c) => c.charCodeAt(0)))
      // The CPU kernel is deterministic, so the image is exact.
      const golden = compareGolden(here, `noise-planet-${domain}`, image)
      expect(golden.max).toBe(0)
    }
  })

  it('previews an intermediate node on its own', async () => {
    const full = await call<{ data: string }>('asset.preview', {
      asset: GRAPH,
      options: { size: 64 },
    })
    const mask = await call<{ data: string }>('asset.preview', {
      asset: GRAPH,
      options: { size: 64, node: 'mask' },
    })
    expect(mask.data).not.toBe(full.data)
  })

  it('noise.stats gives the numbers noiseStats does, weighted by area on a sphere', async () => {
    const stats = await call<ReturnType<typeof noiseStats>>('noise.stats', {
      graph: GRAPH,
      seed: 7,
      domain: 'sphere',
      resolution: 48,
      thresholds: [0],
    })
    const graph = [...app.world.resource(NoiseGraphs).values()][0]!
    expect(stats).toEqual(
      noiseStats(graph, 7, { kind: 'sphere', resolution: 48 }, { thresholds: [0] }),
    )
    expect(stats.samples).toBe(6 * 48 * 48)
    expect(stats.histogram.bins.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 5)
    // The same numbers the playground's #noise page reports in a browser.
    expect([stats.min, stats.max, stats.mean, stats.below[0]!.fraction]).toEqual(
      PLANET_SPHERE_STATS,
    )
  })

  it('noise.sample answers at points, around an origin, and for inline graphs', async () => {
    const { values } = await call<{ values: number[] }>('noise.sample', {
      graph: GRAPH,
      seed: 7,
      points: [
        [0, 0, 1],
        [0.5, 0.5, 0.5],
      ],
    })
    expect(values).toHaveLength(2)
    const around = await call<{ values: number[] }>('noise.sample', {
      graph: GRAPH,
      seed: 7,
      origin: [0, 0, 1],
      points: [[0, 0, 0]],
    })
    expect(around.values[0]).toBeCloseTo(values[0]!, 5)
    const inline = await call<{ values: number[] }>('noise.sample', {
      graph: { output: 'k', nodes: { k: { constant: 0.25 } } },
      points: [[1, 2, 3]],
    })
    expect(inline.values).toEqual([0.25])
    const r = await server.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'noise.sample',
      params: { graph: { output: 'a', nodes: { a: { add: ['a', 1] } } }, points: [] },
    })
    expect((r!.error!.data as { code: string }).code).toBe('noise/cycle')
    expect(NoiseGraph).toBeDefined()
  })
})

/** min, max, mean, and fraction below 0 of the example planet at seed 7 (sphere, 48 per face). */
const PLANET_SPHERE_STATS = [-0.703918, 1.446697, 0.029498, 0.476848]
