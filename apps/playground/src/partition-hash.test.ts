import { World } from '@aethervtt/shard-core'
import { timeout } from '@aethervtt/shard-core/test-env'
import { cellHashOf } from '@aethervtt/shard-partition'
import { defineTown, ENGINE_COMPONENTS, HASH_CELLS } from '@aethervtt/shard-partition/testing'
import { type BrowserType, chromium, firefox, webkit } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { checkRequired, type PlaygroundServer, servePlayground } from './browser-tests'

void ENGINE_COMPONENTS
const town = defineTown({ name: 'hash-town', props: 4 })

const engines: [string, BrowserType][] = [
  ['chromium', chromium],
  ['firefox', firefox],
  ['webkit', webkit],
]

/** Spec 0112: a cell is the same bits in every engine (V8, SpiderMonkey, JavaScriptCore). */
describe('partition cell hashes across browsers', () => {
  let server: PlaygroundServer
  let node: string[]
  beforeAll(async () => {
    server = await servePlayground()
    const world = new World()
    node = []
    for (const [x, z, level] of HASH_CELLS)
      node.push(await cellHashOf(world, town, 7, 0, x, z, level))
  }, timeout(60_000))
  afterAll(async () => {
    await server?.close()
  })

  for (const [name, engine] of engines) {
    it(
      `${name} generates the same cells as Node`,
      async (ctx) => {
        let browser: Awaited<ReturnType<BrowserType['launch']>>
        try {
          browser = await engine.launch()
        } catch (error) {
          checkRequired(`Partition hashes (${name})`, String(error))
          return ctx.skip()
        }
        try {
          const page = await browser.newPage()
          await page.goto(`${server.base}/partition-hash.html`)
          await page.waitForFunction(
            () => 'partitionHashes' in globalThis || 'partitionHashError' in globalThis,
            undefined,
            { timeout: timeout(60_000) },
          )
          const error = await page.evaluate(
            () => (globalThis as { partitionHashError?: string }).partitionHashError,
          )
          expect(error).toBeUndefined()
          const hashes = await page.evaluate(
            () => (globalThis as { partitionHashes?: string[] }).partitionHashes,
          )
          expect(hashes).toEqual(node)
        } finally {
          await browser.close()
        }
      },
      timeout(120_000),
    )
  }
})
