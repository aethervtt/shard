// Every playground demo in real Chromium: it starts, draws something, and reports no GPU errors or
// page errors. Needs Playwright's Chromium and a WebGPU adapter (see browser-tests.ts).

import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch, decodePng } from '@aethervtt/shard-verify/node'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  type PlaygroundServer,
  servePlayground,
  webGpuUnavailable,
} from './browser-tests'
import { DEMOS } from './demos'

const server: PlaygroundServer = await servePlayground()
const skip = await webGpuUnavailable(`${server.base}/`)
checkRequired('Playground demo', skip)

let browser: Browser
beforeAll(async () => {
  if (!skip) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  await server.close()
})

interface DemoRun {
  error: string | undefined
  pageErrors: string[]
  gpuErrors: string[]
  colors: number
}

/**
 * Opens a demo, waits for it to start and for its pipelines to finish compiling (or `settleMs` to
 * pass: some demos stream work forever), then reads its GPU errors and what the canvas shows.
 */
async function run(page: Page, demo: string, settleMs: number): Promise<DemoRun> {
  const pageErrors: string[] = []
  page.on('pageerror', (err) => pageErrors.push(err.message))
  page.on('console', (message) => {
    // The dev server has no favicon; that 404 isn't the demo's.
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) {
      pageErrors.push(message.text())
    }
  })
  await page.goto(`${server.base}/#${demo}`)
  await page.waitForFunction(() => {
    const p = (globalThis as { playground?: { started: boolean; error?: string } }).playground
    return p?.started || p?.error !== undefined
  })
  const state = await page.evaluate(async (ms) => {
    const g = globalThis as unknown as {
      playground: { error?: string }
      describe(): {
        pipelinesCompiling: number
        drawsSkipped: number
        recentErrors: { code: string; message: string }[]
      }
    }
    if (g.playground.error !== undefined) return { error: g.playground.error, gpuErrors: [] }
    const end = performance.now() + ms
    let quiet = 0
    let frames = 0
    // At least a second of frames: a demo spawns and requests pipelines over its first frames.
    while (performance.now() < end && (quiet < 10 || frames < 60)) {
      frames++
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const d = g.describe()
      quiet = d.pipelinesCompiling === 0 && d.drawsSkipped === 0 ? quiet + 1 : 0
    }
    const errors = g.describe().recentErrors.map((e) => `${e.code}: ${e.message}`)
    return { error: undefined, gpuErrors: errors }
  }, settleMs)
  const shot = await decodePng(new Uint8Array(await page.locator('#viewport').screenshot()))
  // Distinct colors, quantized to 4 bits a channel: a blank or single-color canvas has one or two.
  const seen = new Set<number>()
  const d = shot.data
  for (let i = 0; i < d.length; i += 4) {
    seen.add(((d[i]! >> 4) << 8) | ((d[i + 1]! >> 4) << 4) | (d[i + 2]! >> 4))
  }
  return { ...state, pageErrors, colors: seen.size }
}

describe.skipIf(skip)('playground demos on WebGPU', () => {
  for (const demo of DEMOS) {
    it(
      `${demo} starts, draws, and reports no errors`,
      async () => {
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
        try {
          const result = await run(await context.newPage(), demo, 20_000)
          expect(result.error).toBeUndefined()
          expect(result.pageErrors).toEqual([])
          expect(result.gpuErrors).toEqual([])
          expect(result.colors).toBeGreaterThan(8)
        } finally {
          await context.close()
        }
      },
      timeout(90_000),
    )
  }
})
