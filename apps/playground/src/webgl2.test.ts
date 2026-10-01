// The WebGL2 backend in real Chromium (0064): a lost context comes back, and a WebGPU session never
// fetches what only WebGL2 or the baseline tier needs. Needs Playwright's Chromium with WebGPU and
// WebGL2 (see browser-tests.ts).

import { timeout } from '@aethervtt/shard-core/test-env'
import { browserLaunch } from '@aethervtt/shard-verify/node'
import { type Browser, chromium, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  checkRequired,
  type PlaygroundServer,
  servePlayground,
  webGpuUnavailable,
  webgl2Unavailable,
} from './browser-tests'

const server: PlaygroundServer = await servePlayground()
const noWebgl2 = await webgl2Unavailable(`${server.base}/`)
checkRequired('WebGL2 backend', noWebgl2)
const noWebGpu = await webGpuUnavailable(`${server.base}/`)
checkRequired('WebGL2 backend (zero cost on WebGPU)', noWebGpu)

let browser: Browser
beforeAll(async () => {
  if (!noWebgl2 || !noWebGpu) browser = await chromium.launch(browserLaunch('chromium', 1))
})
afterAll(async () => {
  await browser?.close()
  await server.close()
})

interface Described {
  backend: string
  tier: string
  health: { state: string }
  stats: Record<string, { drawCalls: number }>
}

/** Opens a demo and waits until it runs and draws. */
async function open(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await page.waitForFunction(
    () => {
      const g = globalThis as unknown as {
        playground?: { started: boolean; error?: string }
        describe?: () => Described
      }
      if (g.playground?.error !== undefined) return true
      if (!g.playground?.started || !g.describe) return false
      const d = g.describe()
      return Object.values(d.stats).some((s) => s.drawCalls > 0)
    },
    undefined,
    { timeout: timeout(60_000) },
  )
  const error = await page.evaluate(
    () => (globalThis as { playground?: { error?: string } }).playground?.error,
  )
  expect(error).toBeUndefined()
}

const describeRender = (page: Page) =>
  page.evaluate(() => (globalThis as unknown as { describe(): Described }).describe())

describe.skipIf(noWebgl2)('WebGL2 context loss (0064)', () => {
  it(
    'goes ok → lost → ok when the context is lost and restored, and draws again',
    async () => {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
      try {
        const page = await context.newPage()
        await open(page, `${server.base}/?backend=webgl2#scene`)
        expect(await describeRender(page)).toMatchObject({
          backend: 'webgl2',
          health: { state: 'ok' },
        })
        // The canvas's context: the one the device runs on.
        await page.evaluate(() => {
          const gl = (document.getElementById('viewport') as HTMLCanvasElement).getContext(
            'webgl2',
          )!
          ;(globalThis as { lose?: WEBGL_lose_context }).lose =
            gl.getExtension('WEBGL_lose_context')!
          ;(globalThis as { lose?: WEBGL_lose_context }).lose!.loseContext()
        })
        await page.waitForFunction(
          () =>
            (globalThis as unknown as { describe(): Described }).describe().health.state === 'lost',
          undefined,
          { timeout: timeout(10_000) },
        )
        await page.evaluate(() =>
          (globalThis as { lose?: WEBGL_lose_context }).lose!.restoreContext(),
        )
        await page.waitForFunction(
          () => {
            const d = (globalThis as unknown as { describe(): Described }).describe()
            return d.health.state === 'ok' && Object.values(d.stats).some((s) => s.drawCalls > 0)
          },
          undefined,
          { timeout: timeout(20_000) },
        )
        expect(await describeRender(page)).toMatchObject({ backend: 'webgl2', tier: 'baseline' })
      } finally {
        await context.close()
      }
    },
    timeout(120_000),
  )
})

/** What only WebGL2 or the baseline tier loads: the shim, naga, and baseline strategy modules. */
const BASELINE_ONLY = [/\/gpu-webgl2\//, /shard_naga\.wasm/, /\/src\/baseline\//]

describe.skipIf(noWebGpu || noWebgl2)('zero cost on WebGPU (0064)', () => {
  it(
    'a WebGPU session requests nothing baseline-only; a WebGL2 one does',
    async () => {
      const requested = async (url: string) => {
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
        try {
          const page = await context.newPage()
          const urls: string[] = []
          page.on('request', (request) => urls.push(request.url()))
          await open(page, url)
          return urls
        } finally {
          await context.close()
        }
      }
      const baselineOnly = (urls: string[]) =>
        urls.filter((u) => BASELINE_ONLY.some((pattern) => pattern.test(u)))
      for (const demo of ['scene', 'post', 'sprites', 'particles', 'tabletop']) {
        const webgpu = await requested(`${server.base}/?backend=webgpu#${demo}`)
        expect(baselineOnly(webgpu), demo).toEqual([])
      }
      // The check sees them when they do load.
      const webgl2 = await requested(`${server.base}/?backend=webgl2#scene`)
      expect(baselineOnly(webgl2).length).toBeGreaterThan(0)
    },
    timeout(180_000),
  )
})
