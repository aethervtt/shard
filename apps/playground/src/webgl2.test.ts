// The WebGL2 backend in real Chromium (0064): a lost context comes back, and a WebGPU session never
// fetches what only WebGL2 or the baseline tier needs. Needs Playwright's Chromium with WebGPU and
// WebGL2 (see browser-tests.ts).

import { budget, timeout } from '@aethervtt/shard-core/test-env'
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

/** Opens a demo and waits until it runs and has settled. */
async function open(page: Page, url: string): Promise<void> {
  const errors: string[] = []
  page.on('pageerror', (err) => errors.push(err.message))
  page.on('console', (m) => {
    if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errors.push(m.text())
  })
  await page.goto(url)
  await page
    .waitForFunction(
      () => {
        const g = globalThis as unknown as {
          playground?: { started: boolean; error?: string }
          describe?: () => Described
        }
        return g.playground?.error !== undefined || g.playground?.started === true
      },
      undefined,
      { timeout: timeout(60_000) },
    )
    .catch((err: Error) => {
      throw new Error(`${url} never drew: ${errors.join('; ') || err.message}`)
    })
  const error = await page.evaluate(
    () => (globalThis as { playground?: { error?: string } }).playground?.error,
  )
  expect(error).toBeUndefined()
  // Settled: ten frames in a row with nothing loading and no pipeline compiling (WebGL2 can take
  // seconds: Direct3D compiles heavy shaders slowly the first time).
  await page.waitForFunction(
    () => {
      const g = globalThis as unknown as {
        describe(): Described & {
          pipelinesCompiling: number
          drawsSkipped: number
          health: { issues: { code: string }[] }
        }
        __quiet?: number
        __frames?: number
      }
      const d = g.describe()
      const busy =
        d.pipelinesCompiling > 0 ||
        d.drawsSkipped > 0 ||
        d.health.issues.some((i) => i.code === 'render/loading')
      g.__quiet = busy ? 0 : (g.__quiet ?? 0) + 1
      g.__frames = (g.__frames ?? 0) + 1
      // A second first: a demo spawns its cameras and asks for pipelines over its first frames.
      return g.__frames >= 60 && g.__quiet >= 10
    },
    undefined,
    { timeout: timeout(60_000), polling: 'raf' },
  )
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

describe.skipIf(noWebGpu || noWebgl2)('picking on both backends (0064)', () => {
  it(
    'picks the same thing at 100 random pixels',
    async () => {
      let seed = 7
      const rand = () => {
        seed = (seed * 1103515245 + 12345) >>> 0
        return seed / 4294967296
      }
      const pixels = Array.from({ length: 100 }, () => [
        Math.floor(rand() * 640),
        Math.floor(rand() * 360),
      ])
      type Hit = { entity: number; distance: number } | undefined
      const picks = async (backend: string): Promise<Hit[]> => {
        const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
        try {
          const page = await context.newPage()
          // The render scale pinned: left automatic it settles from the first frames' times, so
          // each load renders (and picks) at its own resolution.
          await open(page, `${server.base}/?backend=${backend}&scale=1#tabletop`)
          // All at once: one pick pass answers them together, each pixel read back at its own
          // offset of one buffer.
          return await page.evaluate((px) => {
            const g = globalThis as unknown as {
              playground: { pick(x: number, y: number): Promise<Hit> }
            }
            return Promise.all(
              px.map(([x, y]) => g.playground.pick(x! * devicePixelRatio, y! * devicePixelRatio)),
            )
          }, pixels)
        } finally {
          await context.close()
        }
      }
      const webgpu = await picks('webgpu')
      const webgl2 = await picks('webgl2')
      expect(webgpu.filter(Boolean).length).toBeGreaterThan(50)
      for (let i = 0; i < pixels.length; i++) {
        const a = webgpu[i]
        const b = webgl2[i]
        const where = `pixel ${pixels[i]}: ${JSON.stringify([a, b])}`
        expect(b?.entity, where).toBe(a?.entity)
        if (a && b) expect(Math.abs(a.distance - b.distance), where).toBeLessThan(0.01 * a.distance)
      }
    },
    timeout(180_000),
  )
})

describe.skipIf(noWebgl2)('naga at load (0064)', () => {
  it(
    'loads in under 300 ms and translates a stage in under 20 ms (p95), unbaked',
    async () => {
      const context = await browser.newContext({ viewport: { width: 640, height: 360 } })
      try {
        const page = await context.newPage()
        // A fresh context: no IndexedDB from earlier sessions, so every stage is a miss.
        await open(page, `${server.base}/?backend=webgl2#lights`)
        const cache = await page.evaluate(
          () =>
            (
              globalThis as unknown as {
                describe(): { shaderCache: { nagaLoadMs: number; misses: { ms: number }[] } }
              }
            ).describe().shaderCache,
        )
        const times = cache.misses.map((m) => m.ms).sort((a, b) => a - b)
        const p95 = times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!
        process.stdout.write(
          `naga: loaded in ${cache.nagaLoadMs.toFixed(0)} ms; ${times.length} stages translated, p95 ${p95.toFixed(1)} ms\n`,
        )
        expect(times.length).toBeGreaterThan(4)
        expect(cache.nagaLoadMs).toBeLessThan(budget('gpu-webgl2/naga-load'))
        expect(p95).toBeLessThan(budget('gpu-webgl2/translate'))
      } finally {
        await context.close()
      }
    },
    timeout(120_000),
  )
})
